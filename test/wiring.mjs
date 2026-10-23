// 接线端到端测试：真实的 relay 收件链路。
//
// 【2026-10-23 重写】
//   原版建立在「monitor 独立进程」之上 —— 读 peers/monitor.json、模拟它投递。
//   但 monitor 已退役（维护者 同意 A 方案，功能由内置 system 采集器覆盖），
//   peers/monitor.json 被删，于是整个测试 ENOENT 崩溃。
//
//   新版不依赖任何外部进程：自己建一个临时 peer（zz-wire-test），
//   走同一套「配对 → 投递 → 校验 → 归档」链路。
//   验证的东西没变：**两端真的连上了**，而不是函数能调通。
//   而且不再绑定任何具体业务对象 —— 以后 monitor 删了也不用再改测试。

import { strict as assert } from 'node:assert';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync, existsSync, rmSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
};

// ---- 全程用隔离目录，绝不碰真实数据目录 ----
const TESTROOT = join(HERE, '.zz-wiring-root');
rmSync(TESTROOT, { recursive: true, force: true });
for (const d of ['inbox', 'peers', 'archive']) mkdirSync(join(TESTROOT, d), { recursive: true });

// 自建一个测试 peer（不用真实的 monitor / selfcheck）
const PEER_ID = 'zz-wire-test';
const TOKEN = randomBytes(16).toString('hex');
writeFileSync(
  join(TESTROOT, 'peers', `${PEER_ID}.json`),
  JSON.stringify({
    id: PEER_ID,
    token: TOKEN,
    allowedLevels: ['info', 'warn', 'critical'],
    note: '接线测试自建 peer',
    createdAt: new Date().toISOString(),
  }, null, 2),
  'utf8',
);

writeFileSync(join(TESTROOT, 'config.json'), JSON.stringify({
  enabled: true,
  supervise: { enabled: false },
  interface: { file: { enabled: true, dir: 'inbox', pollMs: 10000 }, http: { enabled: false } },
  delivery: {
    levels: {
      critical: { channel: 'wake', cooldownSec: 0, mergeWindowSec: 0, titleChars: 20 },
      warn: { channel: 'queue', cooldownSec: 0, mergeWindowSec: 0, titleChars: 20 },
      info: { channel: 'archive', cooldownSec: 0, mergeWindowSec: 0, titleChars: 20 },
    },
  },
  rate: { maxPerTurn: 10, maxPerHour: 50, globalCooldownSec: 0 },
}));
process.on('exit', () => { try { rmSync(TESTROOT, { recursive: true, force: true }); } catch { /* */ } });

console.log('\n--- 接线前置检查 ---');

check('测试 peer 已配对', () => {
  const p = join(TESTROOT, 'peers', `${PEER_ID}.json`);
  assert.ok(existsSync(p), `${p} 应存在`);
  const j = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(j.id, PEER_ID);
  assert.ok(typeof j.token === 'string' && j.token.length > 0, 'token 应非空');
});

check('relay 源码目录存在 lib/index.js', () => {
  assert.ok(existsSync(join(ROOT, 'lib', 'index.js')));
});

// ---- 投递一条合法消息 ----
console.log('\n--- 投递合法消息 ---');

const msg = {
  peer: PEER_ID,
  token: TOKEN,
  level: 'warn',
  title: '内存占用 90.1% 超过阈值 85%',
  body: JSON.stringify({ memoryPercent: 90.1 }),
  at: new Date().toISOString(),
};
writeFileSync(join(TESTROOT, 'inbox', `warn-${Date.now()}.json`), JSON.stringify(msg, null, 2));

const events = [];
const ctx = {
  on: (n, f) => { events.push({ name: n, fn: f }); return () => {}; },
  get: () => null,
  emit: () => {},
  agents: { get: () => undefined, roots: () => [] },
  effect: (f) => f(),
};

const { apply } = await import('../lib/index.js');
apply(ctx, { root: TESTROOT });

await new Promise((r) => setTimeout(r, 250));

console.log('\n--- 验证 relay 收到 ---');

check('relay 收到了消息', () => {
  const p = join(TESTROOT, 'logs', 'received.jsonl');
  assert.ok(existsSync(p), 'received.jsonl 应存在（在 logs/ 下）');
  const lines = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(lines.length >= 1, '应有至少一条');
  const m = lines[lines.length - 1];
  assert.equal(m.peer, PEER_ID);
  assert.equal(m.level, 'warn');
  assert.ok(m.title.includes('内存'), `标题应含「内存」，实际 ${m.title}`);
});

check('inbox 已被清空（处理完）', () => {
  const left = readdirSync(join(TESTROOT, 'inbox')).filter((f) => f.endsWith('.json'));
  assert.equal(left.length, 0, `还剩 ${left.join(',')}`);
});

check('消息进了 archive', () => {
  const files = readdirSync(join(TESTROOT, 'archive'));
  assert.ok(files.length >= 1, '应归档');
});

check('没有被拒收', () => {
  const p = join(TESTROOT, 'logs', 'rejected.jsonl');
  if (!existsSync(p)) return;
  const lines = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 0, `不应有拒收，实际 ${lines.length} 条：${lines.join('|')}`);
});

// ---- 反向验证：错 token 必须被拒 ----
console.log('\n--- 反向验证：错 token 必须被拒 ---');

writeFileSync(
  join(TESTROOT, 'inbox', `bad-${Date.now()}.json`),
  JSON.stringify({ ...msg, token: 'wrong-token' }, null, 2),
);

const ctx2 = {
  on: () => () => {},
  get: () => null,
  emit: () => {},
  agents: { get: () => undefined, roots: () => [] },
  effect: (f) => f(),
};
apply(ctx2, { root: TESTROOT });
await new Promise((r) => setTimeout(r, 250));

check('错 token 被拒收', () => {
  const p = join(TESTROOT, 'logs', 'rejected.jsonl');
  assert.ok(existsSync(p), 'rejected.jsonl 应存在');
  const lines = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(lines.some((r) => r.reason === 'token-mismatch'), '应有 token-mismatch');
});

// ---- 反向验证：未配对 peer 必须被拒 ----
console.log('\n--- 反向验证：未配对 peer 必须被拒 ---');

writeFileSync(
  join(TESTROOT, 'inbox', `unknown-${Date.now()}.json`),
  JSON.stringify({ peer: 'zz-nobody', token: 'x', level: 'warn', title: '不该被收' }, null, 2),
);

const ctx3 = {
  on: () => () => {},
  get: () => null,
  emit: () => {},
  agents: { get: () => undefined, roots: () => [] },
  effect: (f) => f(),
};
apply(ctx3, { root: TESTROOT });
await new Promise((r) => setTimeout(r, 250));

check('未配对 peer 被拒收', () => {
  const p = join(TESTROOT, 'logs', 'rejected.jsonl');
  const lines = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(lines.length >= 2, `应有至少 2 条拒收，实际 ${lines.length}`);
  assert.ok(lines.some((r) => r.peer === 'zz-nobody' || String(r.file ?? '').includes('unknown')),
    `应有 zz-nobody 的拒收记录，实际 ${JSON.stringify(lines.slice(-2))}`);
});

console.log(`\n===== ${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} (${pass} passed, ${fail} failed) =====`);
process.exit(fail === 0 ? 0 : 1);
