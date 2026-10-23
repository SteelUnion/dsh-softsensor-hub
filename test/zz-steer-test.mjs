// zz-steer-test.mjs — steer 主动通知功能测试
// 用 zz-* 命名，不碰真实 peers/monitor.json（dsh编码手册 §5.1 ⑥）
//
// 【设计】apply() 会立即扫一次 inbox。所以每个用例：
//   1. 建全新 root
//   2. 写好 peers / config / inbox 文件
//   3. 再 apply —— 首轮扫描就能扫到

import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const SELF = dirname(fileURLToPath(import.meta.url));
const { apply } = await import('../lib/index.js');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS  ${name}`); passed++; }
  catch (e) { console.log(`FAIL  ${name}\n      ${e.message}`); failed++; }
}

let caseNo = 0;

/**
 * 跑一个场景。
 * @param {object} opts
 * @param {string} opts.level        消息级别
 * @param {object|null} opts.cfgExtra 额外 config
 * @param {boolean} opts.gameOn      是否开游戏模式
 * @param {boolean} opts.hasAgent    是否能拿到 agent
 * @param {string[]} opts.preFiles   额外预置 inbox 文件名（用于限流测试）
 */
async function scenario({ level, cfgExtra = {}, gameOn = false, hasAgent = true, preFiles = [] }) {
  caseNo++;
  const ROOT = join(SELF, `.zz-steer-root-${caseNo}`);
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(ROOT, 'inbox'), { recursive: true });
  mkdirSync(join(ROOT, 'peers'), { recursive: true });
  mkdirSync(join(ROOT, 'archive'), { recursive: true });

  writeFileSync(
    join(ROOT, 'peers', 'zz-steer-peer.json'),
    JSON.stringify({ id: 'zz-steer-peer', token: 'tk', allowedLevels: ['info', 'warn', 'critical'] }),
  );
  writeFileSync(
    join(ROOT, 'config.json'),
    JSON.stringify({
      enabled: true,
      quietHours: { enabled: false },
      supervise: { enabled: false },
      // 新配置格式：级别 → 通道映射（2026-10-20 重构）
      delivery: {
        levels: {
          critical: { channel: 'wake', cooldownSec: 300, mergeWindowSec: 60, titleChars: 20 },
          warn: { channel: 'queue', cooldownSec: 300, mergeWindowSec: 300, titleChars: 20 },
          info: { channel: 'archive', cooldownSec: 0, mergeWindowSec: 0, titleChars: 20 },
        },
      },
      rate: { maxPerTurn: 2, maxPerHour: 5, globalCooldownSec: 0 },
      gameMode: { enabled: true, flagFile: 'game-mode.on', autoExpireSec: 21600 },
      ...cfgExtra,
    }),
  );
  if (gameOn) writeFileSync(join(ROOT, 'game-mode.on'), '1');

  // 预置若干条（限流用）
  for (const [i, p] of preFiles.entries()) {
    writeFileSync(join(ROOT, 'inbox', `zz-pre-${i}.json`), JSON.stringify({ peer: 'zz-steer-peer', token: 'tk', ...p }));
  }
  // 本次要测的那条
  writeFileSync(
    join(ROOT, 'inbox', 'zz-target.json'),
    JSON.stringify({ peer: 'zz-steer-peer', token: 'tk', level, title: `测试 ${level}` }),
  );

  const steered = [];
  const injected = [];
  const fakeAgent = { id: 'zz-session', inject: (m) => injected.push(m), steer: (m) => steered.push(m) };

  let preSteps = [];
  let created = null;
  const ctx = {
    on: (n, f) => {
      if (n === 'agent/pre-step') preSteps.push(f);
      if (n === 'agent/created') created = f;
      return () => {};
    },
    get: () => null,
    emit: () => {},
    agents: { get: () => (hasAgent ? fakeAgent : undefined), roots: () => (hasAgent ? [fakeAgent] : []) },
  };

  const inst = apply(ctx, { root: ROOT });
  created?.({ agent: fakeAgent });   // 让 sessionId 有值

  // apply 首轮已扫；等待微任务把异步部分跑完
  await new Promise((r) => setTimeout(r, 60));

  // 驱动一轮 pre-step，让 pending 走 inject。
  // 【关键】relay 注册了**两个** pre-step handler（注入 + 提问），必须都调。
  for (const fn of preSteps) {
    await fn({ agent: fakeAgent, messages: [], signal: { aborted: false }, step: 1 }, () => ({ kind: 'continue', messages: [] }));
  }

  inst?.dispose?.().catch?.(() => {});
  rmSync(ROOT, { recursive: true, force: true });
  return { steered, injected };
}

// ============ 用例 ============

console.log('\n--- critical 走 steer ---');
{
  const r = await scenario({ level: 'critical' });
  check('critical 走了 steer', () => assert.equal(r.steered.length, 1, `应 steer 1，实际 ${r.steered.length}`));
  check('steer 消息有 id', () => assert.ok(typeof r.steered[0]?.id === 'string' && r.steered[0].id.length > 0, 'id 必须非空字符串'));
  check('steer 的 role 是 user', () => assert.equal(r.steered[0]?.role, 'user'));
  check('steer 的 source.kind 是 schedule', () => assert.equal(r.steered[0]?.source?.kind, 'schedule', '绝不能是 user'));
  check('critical 没同时走 inject', () => assert.equal(r.injected.length, 0, `inject 应为 0，实际 ${r.injected.length}`));
}

console.log('\n--- warn 走 inject ---');
{
  const r = await scenario({ level: 'warn' });
  check('warn 没有 steer', () => assert.equal(r.steered.length, 0, `steer 应为 0，实际 ${r.steered.length}`));
  check('warn 进了 inject', () => assert.equal(r.injected.length, 1, `inject 应为 1，实际 ${r.injected.length}`));
}

console.log('\n--- info 只留档，不注入 ---');
{
  const r = await scenario({ level: 'info', cfgExtra: {} });
  check('info 不 steer', () => assert.equal(r.steered.length, 0));
  check('info 不进 inject', () => assert.equal(r.injected.length, 0, `info 应只留档，实际 inject ${r.injected.length}`));
}

console.log('\n--- 游戏模式：warn 被压制 ---');
{
  const r = await scenario({ level: 'warn', gameOn: true });
  check('游戏模式下 warn 不 steer', () => assert.equal(r.steered.length, 0, `steer 应为 0，实际 ${r.steered.length}`));
}

console.log('\n--- 游戏模式：critical 仍放行 ---');
{
  const r = await scenario({ level: 'critical', gameOn: true });
  check('游戏模式下 critical 仍 steer', () => assert.equal(r.steered.length, 1, `steer 应为 1，实际 ${r.steered.length}`));
}

console.log('\n--- 拿不到 agent 时降级 inject ---');
{
  const r = await scenario({ level: 'critical', hasAgent: false });
  check('拿不到 agent 不 steer', () => assert.equal(r.steered.length, 0));
  check('拿不到 agent 降级 inject', () => assert.equal(r.injected.length, 1, `应降级 inject 1 条，实际 ${r.injected.length}`));
}

console.log('\n--- 配置改成 critical→queue 时走 inject（映射生效）---');
{
  const r = await scenario({
    level: 'critical',
    cfgExtra: {
      delivery: {
        levels: {
          critical: { channel: 'queue', cooldownSec: 300, mergeWindowSec: 60, titleChars: 20 },
          warn: { channel: 'queue', cooldownSec: 300, mergeWindowSec: 300, titleChars: 20 },
          info: { channel: 'archive', cooldownSec: 0, mergeWindowSec: 0, titleChars: 20 },
        },
      },
    },
  });
  check('映射为 queue 时不 steer', () => assert.equal(r.steered.length, 0));
  check('映射为 queue 时走 inject', () => assert.equal(r.injected.length, 1));
}

console.log('\n--- 限流：每轮最多 2 次 ---');
{
  const r = await scenario({
    level: 'critical',
    preFiles: [
      { level: 'critical', title: '限流A' },
      { level: 'critical', title: '限流B' },
      { level: 'critical', title: '限流C' },
    ],
  });
  check('超过 maxPerTurn 后不再 steer', () => assert.ok(r.steered.length <= 2, `steer 应 ≤2，实际 ${r.steered.length}`));
}

// ============ turn-stopping 测试 ============

/**
 * 专测 turn-stopping 的场景。
 * apply 之后手动触发 turn-stopping 钩子，看它有没有把 critical 插进去。
 */
async function turnStopScenario({ queuedCriticals = 1, limit = 2 } = {}) {
  caseNo++;
  const ROOT = join(SELF, `.zz-steer-root-${caseNo}`);
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(ROOT, 'inbox'), { recursive: true });
  mkdirSync(join(ROOT, 'peers'), { recursive: true });
  mkdirSync(join(ROOT, 'archive'), { recursive: true });
  writeFileSync(join(ROOT, 'peers', 'zz-steer-peer.json'),
    JSON.stringify({ id: 'zz-steer-peer', token: 'tk', allowedLevels: ['info', 'warn', 'critical'] }));
  writeFileSync(join(ROOT, 'config.json'), JSON.stringify({
    enabled: true, quietHours: { enabled: false }, supervise: { enabled: false },
    // critical→queue：让 critical 全部落到 pending，再交给 turn-stopping 处理
    delivery: {
      levels: {
        critical: { channel: 'queue', cooldownSec: 0, mergeWindowSec: 0, titleChars: 20 },
        warn: { channel: 'queue', cooldownSec: 0, mergeWindowSec: 0, titleChars: 20 },
        info: { channel: 'archive', cooldownSec: 0, mergeWindowSec: 0, titleChars: 20 },
      },
    },
    rate: { maxPerTurn: 10, maxPerHour: 20, globalCooldownSec: 0 },
    gameMode: { enabled: false },
  }));

  const steered = [];
  const injected = [];
  const fakeAgent = {
    id: 'zz-s', status: 'running',
    inject: (m) => injected.push(m),
    steer: (m) => steered.push(m),
    followup: () => {},
  };

  const preSteps = [];
  let created = null;
  let turnStop = null;
  const ctx = {
    on: (n, f) => {
      if (n === 'agent/pre-step') preSteps.push(f);
      if (n === 'agent/created') created = f;
      if (n === 'agent/turn-stopping') turnStop = f;
      return () => {};
    },
    get: () => null, emit: () => {},
    agents: { get: () => fakeAgent, roots: () => [fakeAgent] },
    effect: (fn) => { try { return fn(); } catch { return () => {}; } },
  };

  // 投 N 条 critical（steer 关着，全进 pending）
  for (let i = 0; i < queuedCriticals; i++) {
    writeFileSync(join(ROOT, 'inbox', `zz-ts-${i}.json`),
      JSON.stringify({ peer: 'zz-steer-peer', token: 'tk', level: 'critical', title: `自检 ${i}` }));
  }

  const inst = apply(ctx, { root: ROOT });
  created?.({ agent: fakeAgent });
  await new Promise((r) => setTimeout(r, 60));

  const result = { steered, injected, turnStopRegistered: typeof turnStop === 'function' };
  // 连续触发 turn-stopping，验证续跑上限
  let calls = 0;
  for (let i = 0; i < limit + 2; i++) {
    if (typeof turnStop !== 'function') break;
    const before = steered.length;
    // 【serial 模式】只传 payload，不传 next —— 与 cordis 的 serial 分发一致。
    // 传 next 会掩盖"回调误用 next"的 bug（2026-10-20 实测踩过：
    // 测试传了 next，生产环境不传，于是 next() 抛 "next is not a function"）。
    await turnStop({ agent: fakeAgent, turn: 1, signal: { aborted: false } });
    if (steered.length > before) calls++;
    await new Promise((r) => setTimeout(r, 10));
  }
  result.steerCalls = calls;

  inst?.dispose?.().catch?.(() => {});
  rmSync(ROOT, { recursive: true, force: true });
  return result;
}

console.log('\n--- turn-stopping 已挂载 ---');
{
  const r = await turnStopScenario();
  check('turn-stopping 钩子已注册', () => assert.equal(r.turnStopRegistered, true, '应注册 agent/turn-stopping'));
}
console.log('\n--- turn-stopping 把 critical 插进回合 ---');
{
  const r = await turnStopScenario({ queuedCriticals: 1 });
  check('turn-stopping 里调了 steer', () => assert.ok(r.steerCalls >= 1, `应至少 steer 1 次，实际 ${r.steerCalls}`));
}
console.log('\n--- turn-stopping 续跑上限（核心保护）---');
{
  // 每次 turn-stopping 前重新塞 pending 是不可能的，所以用 limit 场景：
  // 连触发 4 次，但内部 TURN_STOP_MAX=2，最多只该续 2 次
  const r = await turnStopScenario({ queuedCriticals: 5, limit: 4 });
  check('续跑不超过上限 2 次', () => assert.ok(r.steerCalls <= 2, `steer 应 ≤2（TURN_STOP_MAX），实际 ${r.steerCalls}`));
}

console.log(`\n===== ${failed === 0 ? 'ALL PASS' : 'HAS FAILURES'} (${passed} passed, ${failed} failed) =====`);
process.exit(failed === 0 ? 0 : 1);
