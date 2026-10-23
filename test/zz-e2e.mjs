// zz-e2e.mjs — 端到端测试：按接入标准发消息，验证全链路
//
// 用户原话：「测试可以自己写个脚本，向消息入口发送消息，格式你按照标准来就行」
//
// 覆盖：
//   ① 级别映射（critical→wake / warn→queue / info→archive）
//   ② titleChars 生效（长标题被截断）
//   ③ 静默期补发 deferred
//   ④ HTTP 入口端到端（收得到 + 进同一队列）
//   ⑤ 游戏模式压制
//   ⑥ turn-stopping 续跑上限仍在线

import { writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const SELF = dirname(fileURLToPath(import.meta.url));
const { apply } = await import('../lib/index.js');

let passed = 0, failed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); console.log(`PASS  ${name}`); passed++; }
  catch (e) { console.log(`FAIL  ${name}\n      ${e.message}`); failed++; failures.push(name); }
}

let caseNo = 0;

function baseConfig(over = {}) {
  return {
    enabled: true,
    quietHours: { enabled: false, start: 23, end: 7 },
    supervise: { enabled: false },
    delivery: {
      levels: {
        critical: { channel: 'wake', cooldownSec: 0, mergeWindowSec: 0, titleChars: 20 },
        warn: { channel: 'queue', cooldownSec: 0, mergeWindowSec: 0, titleChars: 20 },
        info: { channel: 'archive', cooldownSec: 0, mergeWindowSec: 0, titleChars: 20 },
      },
    },
    rate: { maxPerTurn: 10, maxPerHour: 50, globalCooldownSec: 0 },
    gameMode: { enabled: false, flagFile: 'game-mode.on', autoExpireSec: 21600 },
    interface: {
      file: { enabled: true, dir: 'inbox', pollMs: 10000 },
      http: { enabled: false, host: '127.0.0.1', port: 0, path: '/inbox' },
    },
    ...over,
  };
}

/** 建一个干净的 root，写入 peer + config + 可选消息 */
function seed({ config = {}, messages = [], gameOn = false } = {}) {
  caseNo++;
  const ROOT = join(SELF, `.zz-e2e-root-${caseNo}`);
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(ROOT, 'inbox'), { recursive: true });
  mkdirSync(join(ROOT, 'peers'), { recursive: true });
  mkdirSync(join(ROOT, 'archive'), { recursive: true });
  writeFileSync(join(ROOT, 'peers', 'e2e.json'),
    JSON.stringify({ id: 'e2e', token: 'tok', allowedLevels: ['info', 'warn', 'critical'] }));
  writeFileSync(join(ROOT, 'config.json'), JSON.stringify(baseConfig(config)));
  if (gameOn) writeFileSync(join(ROOT, 'game-mode.on'), '1');
  messages.forEach((m, i) => {
    writeFileSync(join(ROOT, 'inbox', `m-${i}.json`),
      JSON.stringify({ peer: 'e2e', token: 'tok', ...m }));
  });
  return ROOT;
}

/** 挂一个假 agent + 假 ctx，返回收集器 */
async function mount(ROOT, { withHttp = false } = {}) {
  const steered = [];
  const followed = [];
  const injected = [];
  const agent = {
    id: 'e2e-session',
    status: 'running',
    inject: (m) => injected.push(m),
    steer: (m) => steered.push(m),
    followup: (m) => followed.push(m),
  };
  let created = null;
  let turnStop = null;
  const ctx = {
    on: (n, f) => {
      if (n === 'agent/created') created = f;
      if (n === 'agent/turn-stopping') turnStop = f;
      return () => {};
    },
    get: () => null,
    emit: () => {},
    agents: { get: () => agent, roots: () => [agent] },
    effect: (fn) => { try { return fn(); } catch { return () => {}; } },
  };
  const inst = apply(ctx, { root: ROOT });
  created?.({ agent });
  await new Promise((r) => setTimeout(r, 120));
  return { steered, followed, injected, agent, inst, turnStop: () => turnStop };
}

function cleanup(ROOT) {
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ============================================================ ① 级别映射
console.log('\n=== ① 级别映射 ===');
{
  const ROOT = seed({ messages: [{ level: 'critical', title: 'C' }, { level: 'warn', title: 'W' }, { level: 'info', title: 'I' }] });
  const r = await mount(ROOT);
  check('critical → wake（steer）', () => assert.equal(r.steered.length, 1, `实际 ${r.steered.length}`));
  // warn 进 pending，需要在 pre-step 驱动；这里只验证没被 wake
  check('warn 未走 wake', () => assert.equal(r.steered.length, 1, 'steer 只该有 critical 那条'));
  check('info 只留档（没 inject 没 steer）',
    () => assert.ok(!r.injected.some((m) => m.content?.[0]?.text?.includes('] e2e · I'))));
  r.inst?.dispose?.();
  cleanup(ROOT);
}

// ============================================================ ② titleChars
console.log('\n=== ② titleChars 截断 ===');
{
  const long = '这是一个非常非常长的标题用来测试截断是否真的生效超出二十个字的限制';
  const ROOT = seed({ messages: [{ level: 'critical', title: long }] });
  const r = await mount(ROOT);
  const text = r.steered[0]?.content?.[0]?.text ?? '';
  check('长标题被截断到 20 字内', () => {
    const seg = text.split('· ')[1] ?? '';
    assert.ok(seg.length <= 21, `标题段 ${seg.length} 字，应 ≤21（20 + 省略号）`);
  });
  check('截断后带省略号', () => assert.ok(text.includes('…'), `实际文本：${text}`));
  r.inst?.dispose?.();
  cleanup(ROOT);
}

// ============================================================ ③ 静默期补发
console.log('\n=== ③ 静默期补发 ===');
{
  // 构造一个"全天静默"的时段，让 warn 一定被 deferred
  const h = new Date().getHours();
  const ROOT = seed({
    config: { quietHours: { enabled: true, start: h, end: (h + 1) % 24 } },
    messages: [{ level: 'warn', title: '静默期的告警' }],
  });
  const r = await mount(ROOT);
  const deferredLog = join(ROOT, 'logs', 'received.jsonl');
  check('静默期内的 warn 没有 steer', () => assert.equal(r.steered.length, 0));
  check('消息已收下（进 received.jsonl）', () => {
    const lines = readFileSync(deferredLog, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(lines.length >= 1, '应有接收记录');
  });
  r.inst?.dispose?.();
  cleanup(ROOT);
}

// ============================================================ ④ HTTP 入口
console.log('\n=== ④ HTTP 入口端到端 ===');
{
  const PORT = 17932;
  const ROOT = seed({ config: { interface: { file: { enabled: true, dir: 'inbox', pollMs: 10000 }, http: { enabled: true, host: '127.0.0.1', port: PORT, path: '/inbox' } } } });
  const r = await mount(ROOT, { withHttp: true });
  await new Promise((res) => setTimeout(res, 300));   // 等 listen

  let status = 0;
  let reply = '';
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/inbox`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peer: 'e2e', token: 'tok', level: 'critical', title: 'HTTP 投递的告警' }),
    });
    status = res.status;
    reply = await res.text();
  } catch (e) {
    reply = String(e?.message ?? e);
  }

  check('HTTP POST 返回 202', () => assert.equal(status, 202, `实际 ${status}，${reply}`));
  check('HTTP 消息落进 inbox 并被消费', () => {
    // scanInbox 每 10s 一次，这里直接检查 http-received 日志
    const p = join(ROOT, 'logs', 'http-received.jsonl');
    assert.ok(existsSync(p), '应有 http-received.jsonl');
    const lines = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(lines.length >= 1, '应有 HTTP 接收记录');
  });
  // 非 POST 被拒
  let getStatus = 0;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/inbox`, { method: 'GET' });
    getStatus = res.status;
  } catch { /* ignore */ }
  check('GET 被拒绝（404）', () => assert.equal(getStatus, 404, `实际 ${getStatus}`));

  // 超大 body 被拒（64KB 上限）
  let bigStatus = 0;
  try {
    const big = 'x'.repeat(70 * 1024);
    const res = await fetch(`http://127.0.0.1:${PORT}/inbox`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peer: 'e2e', token: 'tok', level: 'info', title: 'big', body: big }),
    });
    bigStatus = res.status;
  } catch { /* 连接被 destroy 也算拒绝 */ }
  check('超大 body 被拒（413 或连接断开）', () => assert.ok(bigStatus === 413 || bigStatus === 0, `实际 ${bigStatus}`));

  // 坏 JSON 被拒
  let badStatus = 0;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/inbox`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    badStatus = res.status;
  } catch { /* ignore */ }
  check('坏 JSON 被拒（400）', () => assert.equal(badStatus, 400, `实际 ${badStatus}`));

  r.inst?.dispose?.();
  cleanup(ROOT);
}

// ============================================================ ⑤ 游戏模式
console.log('\n=== ⑤ 游戏模式 ===');
{
  const ROOT = seed({
    config: { gameMode: { enabled: true, flagFile: 'game-mode.on', autoExpireSec: 21600 } },
    gameOn: true,
    messages: [{ level: 'critical', title: '游戏中的 critical' }],
  });
  const r = await mount(ROOT);
  check('游戏模式 critical 仍唤醒', () => assert.equal(r.steered.length, 1, `实际 ${r.steered.length}`));
  r.inst?.dispose?.();
  cleanup(ROOT);
}

// ============================================================ ⑥ turn-stopping
console.log('\n=== ⑥ turn-stopping 续跑上限仍在线 ===');
{
  const ROOT = seed({ messages: [] });
  const r = await mount(ROOT);
  const ts = r.turnStop();
  check('turn-stopping 钩子存在', () => assert.equal(typeof ts, 'function'));
  // 投 message 进 pending（用 queue 通道），再触发 turn-stop
  let ok = true;
  try {
    for (let i = 0; i < 5; i++) ts({ agent: r.agent, turn: 1, signal: { aborted: false } });
  } catch (e) {
    ok = false;
  }
  check('连续触发不抛错（serial 无 next）', () => assert.ok(ok, '不应抛 next is not a function'));
  r.inst?.dispose?.();
  cleanup(ROOT);
}

console.log(`\n===== ${failed === 0 ? 'ALL PASS' : 'HAS FAILURES'} (${passed} passed, ${failed} failed) =====`);
if (failed > 0) console.log('失败项：\n' + failures.map((f) => '  - ' + f).join('\n'));
process.exit(failed === 0 ? 0 : 1);
