// 监管链路的测试。
// 验证：对端死了能发现、只问一次、且**绝不执行启动动作**。

import { strict as assert } from 'node:assert';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, existsSync, rmSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs';

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

// 清场
for (const d of ['peers-down.jsonl', 'received.jsonl', 'rejected.jsonl']) {
  const p = join(ROOT, d);
  if (existsSync(p)) rmSync(p, { force: true });
}

const peersDir = join(ROOT, 'peers');
if (!existsSync(peersDir)) mkdirSync(peersDir, { recursive: true });

// ---------------------------------------------------------------- 隔离
//
// 测试必须不受真实配对影响：真实的 monitor.json 也带着 supervise，
// 它同样会触发提问，把「只问一次」的计数弄成 2。
//
// 做法：把真实配对临时挪到 stash 目录，测试结束再挪回来。
// 比直接删除安全 —— 万一中途崩了，文件还在 stash 里能捞回来。
const STASH = join(ROOT, 'peers-stash-test');
if (existsSync(STASH)) rmSync(STASH, { recursive: true, force: true });
mkdirSync(STASH, { recursive: true });
const stashed = [];
for (const f of readdirSync(peersDir)) {
  if (!f.endsWith('.json')) continue;
  renameSync(join(peersDir, f), join(STASH, f));
  stashed.push(f);
}

function restorePeers() {
  for (const f of stashed) {
    const from = join(STASH, f);
    if (existsSync(from)) renameSync(from, join(peersDir, f));
  }
  if (existsSync(STASH)) rmSync(STASH, { recursive: true, force: true });
}
process.on('exit', restorePeers);

// 造一个「已死」的 pid 文件：写一个几乎不可能存在的 pid
const deadPidFile = join(ROOT, 'test-dead.pid');
writeFileSync(deadPidFile, '999999', 'utf8');

// 心跳文件：设成很久以前
const staleMetrics = join(ROOT, 'test-metrics.jsonl');
writeFileSync(staleMetrics, JSON.stringify({ at: '2020-01-01T00:00:00Z', memoryPercent: 50 }) + '\n', 'utf8');

writeFileSync(
  join(peersDir, 'zz-test-monitor.json'),
  JSON.stringify({
    id: 'zz-test-monitor',
    token: 'tok',
    allowedLevels: ['info', 'warn', 'critical'],
    note: '资源监视器',
    supervise: {
      enabled: true,
      checkEverySec: 1,
      alivePidFile: deadPidFile,
      metricsFile: staleMetrics,
      staleAfterSec: 60,
      askOnDown: true,
    },
  }),
);

// 记录中枢有没有尝试提问
let askedCount = 0;
let askedPayload = null;
let startAttempted = false;

// 记录注册的钩子，供测试手动派发。
//
// 为什么要这个：中枢在 0.2.x 起把「提问」拆成两步——
//   supervise() 只入队（定时器里没有 agent，直接 ask 会 NO_PROVIDER），
//   真正的 ask() 在 agent/pre-step 里带着活 agent 发出。
// 所以测试必须能派发 pre-step，才能走完
//   supervise() → 入队 → pre-step → ask()
// 这条完整链路。只断言 questionQueue.length 是假通过。
const handlers = {};

// ctx 的形状按真实 cordis 来：服务是**直接挂在 ctx 上**的，
// 不是通过 ctx.get() 拿。声明 inject 之后才有这个属性。
const ctx = {
  on: (event, fn) => {
    (handlers[event] ??= []).push(fn);
    return () => {};
  },
  userQuestions: {
    ask: async (payload) => {
      askedCount++;
      askedPayload = payload;
    },
  },
  // 中枢绝不应该去拿这些 —— 拿了就说明它想动手
  get: (name) => {
    if (name === 'tools' || name === 'shell') {
      startAttempted = true;
      return { exec: () => { startAttempted = true; } };
    }
    return null;
  },
  emit: () => {},
};

/** 手动派发一次 agent/pre-step，模拟 DSH 走到下一轮。 */
function firePreStep() {
  const fakeAgent = { inject: () => {}, steer: () => {}, followup: () => {} };
  const signal = new AbortController().signal;
  for (const h of handlers['agent/pre-step'] ?? []) {
    h({ agent: fakeAgent, messages: [], signal, step: 1 }, () => {});
  }
}

const mod = await import('../lib/index.js');
const { apply } = mod;

// ---- 接口契约检查：这一类错误不重启 DSH 就抓不到，所以放进单测 ----
console.log('\n--- 接口契约 ---');

check('导出了 inject 声明', () => {
  assert.ok(Array.isArray(mod.inject), '必须导出 inject 数组，否则 ctx.userQuestions 会抛注入门错误');
});

check('inject 里声明了 userQuestions', () => {
  assert.ok(mod.inject.includes('userQuestions'), `inject = ${JSON.stringify(mod.inject)}`);
});

check('inject 不包含能动手的服务', () => {
  for (const bad of ['tools', 'shell', 'agents']) {
    assert.ok(!mod.inject.includes(bad), `不应声明 ${bad} —— 中枢不能动手`);
  }
});

apply(ctx, {});

// 等待监管跑起来（checkEverySec:1，但定时器是 60 秒一次 alive check）
// 为了测试，直接等一次扫描 + 手动触发。定时器 10 秒扫 inbox、60 秒查 alive。
// 这里等 11 秒确保 inbox 扫描跑过，但 alive 在首轮不会跑（lastAliveAt=0 时会跑）。
await new Promise((r) => setTimeout(r, 1200));

check('中枢没有尝试获取执行能力', () => {
  assert.equal(startAttempted, false, '中枢不应碰 tools/shell');
});

// 监管的 alive 检查在首轮会执行（lastAliveAt 初始为 0）
await new Promise((r) => setTimeout(r, 200));

// 派发一次 pre-step：让入队的问题真正走到 ask()。
// 不派发就等于只验证了「入队」这个中间状态，是假通过。
firePreStep();
await new Promise((r) => setTimeout(r, 100)); // 等 askInBackground 的异步链跑完

check('发现对端停机后调用了提问', () => {
  assert.ok(askedCount >= 1, `应当至少问一次，实际 ${askedCount}`);
});

check('提问内容说明是哪个对端', () => {
  assert.ok(askedPayload !== null, '应有提问载荷');
  const q = JSON.stringify(askedPayload);
  assert.ok(q.includes('monitor'), '应提到 monitor');
});

check('提问提供了可选项', () => {
  assert.ok(askedPayload?.questions?.[0]?.options?.length >= 2, '应有至少两个选项');
});

check('提问格式符合 ask(request) 契约', () => {
  // dsh-user-questions 的 ask(request) 只认 questions / agent / signal。
  // 多塞一个 source 字段不会报错，但说明写的时候在猜 —— 这里钉死。
  assert.ok(Array.isArray(askedPayload.questions), '必须有 questions 数组');
  const q = askedPayload.questions[0];
  assert.equal(typeof q.id, 'string', 'question.id 必须是字符串');
  assert.equal(typeof q.question, 'string', 'question.question 必须是字符串');
  assert.ok(Array.isArray(q.options), 'question.options 必须是数组');
  assert.ok(!('source' in askedPayload), 'ask(request) 不接受 source 字段');
});

check('提问携带了活 agent（否则应答器会 NO_PROVIDER）', () => {
  // 实测缺陷：定时器线程里直接 ask() 没有 agent，
  // 应答器以 "no user-questions answerer accepted the request" 拒绝，
  // 6 次告警全部埋进 alerts-local.jsonl，用户一次都没看到。
  // ask() 里是 `if (agent !== void 0) this.assertLiveRoot(agent)` +
  // `scopeTarget(agent, agent)`，没有 agent 就走不到带作用域的 waterfall。
  assert.ok(askedPayload.agent, 'ask 请求必须带 agent');
});

check('提问携带了 signal（取消语义完整）', () => {
  // ask() 第一行就是 `if (request.signal?.aborted) throw abortedQuestion()`。
  // 不传 signal，用户取消会话时这次提问不会中止。
  assert.ok(askedPayload.signal, 'ask 请求必须透传 pre-step 的 signal');
});

check('只问一次（同一次停机不重复打扰）', () => {
  assert.equal(askedCount, 1, `应只问 1 次，实际 ${askedCount}`);
});

check('停机记录被写入', () => {
  const p = join(ROOT, 'peers-down.jsonl');
  assert.ok(existsSync(p), 'peers-down.jsonl 应存在');
  const lines = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(lines.length >= 1, '应有停机记录');
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.peer, 'zz-test-monitor');
});

check('停机记录被限流（不会刷屏）', () => {
  // 实测教训：不限流时一次停机 3 分钟刷出 23 条，日志被噪音淹掉。
  const p = join(ROOT, 'peers-down.jsonl');
  const lines = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(lines.length <= 3, `记录条数 ${lines.length} 过多，限流可能失效`);
});

check('中枢源码中确实没有启动逻辑', () => {
  const src = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8');
  const code = src
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => !l.startsWith('//') && !l.startsWith('*'))
    .join('\n');
  assert.ok(!code.includes('daemon start'), '不应含启动命令');
  assert.ok(!code.includes('spawn'), '不应含 spawn');
});

// 清理测试文件。
// 只清自己造的 zz-test-*，**绝不动 peers/monitor.json**（那是真实配对，
// 别的测试依赖它 —— 曾经因为在这里删掉它，导致 wiring 测试找不到配对）。
for (const f of [deadPidFile, staleMetrics]) {
  if (existsSync(f)) rmSync(f, { force: true });
}
const testPeer = join(peersDir, 'zz-test-monitor.json');
if (existsSync(testPeer)) rmSync(testPeer, { force: true });

console.log(`\n===== ${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} (${pass} passed, ${fail} failed) =====`);
process.exit(fail === 0 ? 0 : 1);
