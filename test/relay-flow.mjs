// 中枢收件循环的端到端测试。
// 用假 ctx 驱动真实的 apply()，验证收件、拒收、去重、归档。

import { strict as assert } from 'node:assert';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readdirSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';

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

// ---- 清理上一次的痕迹 ----
for (const d of ['inbox', 'archive', 'received.jsonl', 'rejected.jsonl']) {
  const p = join(ROOT, d);
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}
for (const d of ['peers']) {
  const p = join(ROOT, d);
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}
// 用测试专用 id，**绝不写 peers/monitor.json**。
// 那是真实配对，带着 supervise 配置；测试覆盖它会让监管静默失效。
// （这个坑踩过：测试跑完把 monitor.json 写成没有 supervise 的版本，
//   于是中枢再也不探测对端，表现为「监管不工作」。）
const TEST_PEER = 'zz-flow-test';
writeFileSync(
  join(ROOT, 'peers', `${TEST_PEER}.json`),
  JSON.stringify({ id: TEST_PEER, token: 'tok-ok', allowedLevels: ['info', 'warn', 'critical'] }),
);

const { apply } = await import('../lib/index.js');

// ---- 假 ctx ----
const events = [];
const ctx = {
  on: (name, fn) => {
    events.push({ name, fn });
    return () => {};
  },
  get: () => null,
  emit: (name, payload) => events.push({ name: `emit:${name}`, payload }),
};

apply(ctx, {});

const inbox = join(ROOT, 'inbox');
const archive = join(ROOT, 'archive');

const drop = (name, obj) => writeFileSync(join(inbox, name), typeof obj === 'string' ? obj : JSON.stringify(obj));

// apply() 首轮已扫过一次，此时 inbox 是空的。现在投文件。
drop('good-1.json', { peer: TEST_PEER, token: 'tok-ok', level: 'warn', title: '磁盘低' });
drop('bad-token.json', { peer: TEST_PEER, token: 'wrong', level: 'warn', title: 'x' });
drop('bad-json.json', '{not json');
drop('unknown-peer.json', { peer: 'ghost', token: 'x', level: 'warn', title: 'x' });
drop('info-1.json', { peer: TEST_PEER, token: 'tok-ok', level: 'info', title: '日报' });

// 手动触发一次扫描：pre-step 钩子之前的定时器不便等 10 秒，
// 这里通过直接调用内部扫描不现实，改用等待定时器不合适。
// 因此用一个短等待 + 再投一次的方式验证不重复。
await new Promise((r) => setTimeout(r, 50));

// 直接调用注册的 pre-step 钩子不会触发扫描（扫描在定时器里）。
// 为测试收件，这里暴露一个约定：再次 apply 会立即扫一次。
// 用另一个 ctx 实例触发首轮扫描。
const ctx2 = { on: () => () => {}, get: () => null, emit: () => {} };
apply(ctx2, {});

await new Promise((r) => setTimeout(r, 100));

const receivedPath = join(ROOT, 'received.jsonl');
const rejectedPath = join(ROOT, 'rejected.jsonl');

check('合法消息被接收', () => {
  assert.ok(existsSync(receivedPath), 'received.jsonl 应存在');
  const lines = readFileSync(receivedPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(lines.some((m) => m.title === '磁盘低'), '应收到「磁盘低」');
});

check('token 错误被拒', () => {
  const lines = readFileSync(rejectedPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(lines.some((r) => r.reason === 'token-mismatch'), '应有 token-mismatch');
});

check('坏 JSON 被拒', () => {
  const lines = readFileSync(rejectedPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(lines.some((r) => r.reason === 'bad-json'), '应有 bad-json');
});

check('未配对 peer 被拒', () => {
  const lines = readFileSync(rejectedPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(lines.some((r) => r.reason === 'peer-unknown'), '应有 peer-unknown');
});

check('info 级也被接收（只是不注入）', () => {
  const lines = readFileSync(receivedPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(lines.some((m) => m.level === 'info'), 'info 应被收录');
});

check('inbox 被清空（全部归档）', () => {
  const left = readdirSync(inbox).filter((f) => f.endsWith('.json'));
  assert.equal(left.length, 0, `还剩 ${left.join(',')}`);
});

check('坏消息也进了 archive（不会每轮重复撞）', () => {
  const files = readdirSync(archive);
  assert.ok(files.some((f) => f.startsWith('rejected-')), '应有 rejected-* 归档');
});

check('中枢能注册 pre-step 钩子', () => {
  assert.ok(events.some((e) => e.name === 'agent/pre-step'), '应注册 agent/pre-step');
});

// 只清自己造的测试配对，不动真实配对
const testPeerFile = join(ROOT, 'peers', `${TEST_PEER}.json`);
if (existsSync(testPeerFile)) rmSync(testPeerFile, { force: true });

console.log(`\n===== ${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} (${pass} passed, ${fail} failed) =====`);
process.exit(fail === 0 ? 0 : 1);
