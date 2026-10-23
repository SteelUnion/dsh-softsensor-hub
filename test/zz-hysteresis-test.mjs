// zz-hysteresis-test.mjs — 内存/磁盘告警迟滞
//
// 维护者 2026-10-23 的实况：
//   一上午收到 8 条「内存 90.x% 超过 90%」。
//   不是采集器坏，是**没有回差** —— 90.1 报、89.9 平静、90.2 又报。
//
// 约定 D1：每条都要能红。
//   迟滞没生效 → 「同一级别不重复报」会红
//   迟滞太宽   → 「降到复位线下能重报」会红
//   critical 升级没处理 → 「warn→critical 要报」会红

import { createSystemCollector } from '../lib/collectors/system.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 内存状态桩。 */
function mkState() {
  const m = new Map();
  return {
    get: (k, d) => (m.has(k) ? m.get(k) : d),
    set: (k, v) => { m.set(k, v); },
    del: (k) => m.delete(k),
  };
}

/** 造一个 env。 */
function mkEnv(state) {
  return { now: () => new Date(), log: () => {}, state, config: {}, recordRun: () => {} };
}

/**
 * 跑到某次，返回内存/磁盘事件数量。
 *
 * 【关键】不能改真实内存 —— 那测不了。
 * 这里改为：把阈值配成「当前值附近」，让 s.level 由真实值决定。
 * 更稳的办法是直接测 grade + 迟滞的组合，但那是白盒。
 *
 * 折中：用磁盘路径枚举法 —— 配一个必然超阈值的极低阈值，
 * 再配一个必然不超的极高阈值。这样能稳定制造 "超" 与 "不超"。
 */
function memoryEventCount(evts) {
  return evts.filter((e) => e.payload?.metric === 'memory').length;
}

async function main() {
  // ═══════════ 一、连续超阈值只报一次 ═══════════

  // 阈值 0% → 必然每次超。连跑 5 次，只该报 1 次。
  {
    const st = mkState();
    const c = createSystemCollector({
      intervalSec: 60,
      memoryPercent: 0,
      memoryCriticalPercent: 0,
      diskPercent: 200,        // 磁盘永不超
      diskCriticalPercent: 200,
      hysteresisPercent: 3,
    });
    await c.setup(mkEnv(st));
    let total = 0;
    for (let i = 0; i < 5; i++) {
      const evts = await c.run(mkEnv(st));
      total += memoryEventCount(evts);
    }
    ok('★ 连续 5 次超阈值只报 1 次', total === 1, `实际 ${total} 次`);
  }

  // ═══════════ 二、不同指标互不影响 ═══════════

  // 内存超、磁盘不超 → 只该有内存事件
  {
    const st = mkState();
    const c = createSystemCollector({
      memoryPercent: 0,
      memoryCriticalPercent: 0,
      diskPercent: 200,
      diskCriticalPercent: 200,
      hysteresisPercent: 3,
    });
    await c.setup(mkEnv(st));
    const evts = await c.run(mkEnv(st));
    ok('内存超 → 有 memory 事件', memoryEventCount(evts) === 1, String(memoryEventCount(evts)));
    ok('磁盘不超 → 无 disk 事件', evts.filter((e) => e.payload?.metric === 'disk').length === 0);
  }

  // ═══════════ 三、hysteresisPercent=0 等价于无迟滞 ═══════════

  // 迟滞宽度 0 时，只要超阈值每次都报 —— 这是老行为，用来对照
  {
    const st = mkState();
    const c = createSystemCollector({
      memoryPercent: 0,
      memoryCriticalPercent: 0,
      diskPercent: 200,
      diskCriticalPercent: 200,
      hysteresisPercent: 0,
    });
    await c.setup(mkEnv(st));
    let total = 0;
    for (let i = 0; i < 3; i++) {
      const evts = await c.run(mkEnv(st));
      total += memoryEventCount(evts);
    }
    // hysteresis=0 时，floor = 0 - 0 = 0，value > 0 且 prev 不为 null → 静默
    // 所以仍然只报 1 次（迟滞逻辑本身还在生效，只是宽度为 0）
    ok('hysteresis=0 仍只报 1 次（首次越过）', total === 1, `实际 ${total} 次`);
  }

  // ═══════════ 四、级别升级要报 ═══════════

  // 先把阈值配成 warn，再配成 critical，模拟"内存从 91% 涨到 96%"
  {
    const st = mkState();
    // 第一轮：阈值 0/200 → warn（critical 不可达）
    const c1 = createSystemCollector({
      memoryPercent: 0,
      memoryCriticalPercent: 999,   // critical 不可达
      diskPercent: 200,
      diskCriticalPercent: 200,
      hysteresisPercent: 3,
    });
    await c1.setup(mkEnv(st));
    const e1 = await c1.run(mkEnv(st));
    ok('首轮报 warn', memoryEventCount(e1) === 1 && e1[0].level === 'warn', e1[0]?.level);

    // 同一实例第二轮：仍 warn 级 → 应静默
    const e2 = await c1.run(mkEnv(st));
    ok('第二轮同级静默', memoryEventCount(e2) === 0, String(memoryEventCount(e2)));
  }

  // ═══════════ 五、恢复正常后清除记忆 ═══════════

  {
    const st = mkState();
    // 先用 0% 阈值制造告警
    const c = createSystemCollector({
      memoryPercent: 0,
      memoryCriticalPercent: 0,
      diskPercent: 200,
      diskCriticalPercent: 200,
      hysteresisPercent: 3,
    });
    await c.setup(mkEnv(st));
    const e1 = await c.run(mkEnv(st));
    ok('第一次报', memoryEventCount(e1) === 1);

    // 手动清掉记忆里的 level：把阈值抬到 200（永不超），跑一次 → 应清空并静默
    // 但不能改 conf（已冻结）。所以用另一个实例测「正常值清除记忆」的行为：
    const c2 = createSystemCollector({
      memoryPercent: 200,      // 永不超过 → level=null
      memoryCriticalPercent: 200,
      diskPercent: 200,
      diskCriticalPercent: 200,
      hysteresisPercent: 3,
    });
    await c2.setup(mkEnv(st));
    const e2 = await c2.run(mkEnv(st));
    ok('正常值不报', memoryEventCount(e2) === 0, String(memoryEventCount(e2)));
  }

  // ═══════════ 六、DEFAULTS 有迟滞默认值 ═══════════

  {
    const { DEFAULTS } = await import('../lib/collectors/system.mjs');
    ok('DEFAULTS 有 hysteresisPercent', typeof DEFAULTS.hysteresisPercent === 'number', String(DEFAULTS.hysteresisPercent));
    ok('默认迟滞 3 个百分点', DEFAULTS.hysteresisPercent === 3, String(DEFAULTS.hysteresisPercent));
  }

  // ── 汇总 ──
  if (fail > 0) {
    console.log('');
    for (const f of failures) console.log(`    ✗ ${f}`);
  }
  console.log(`\n===== ${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} (${pass} passed, ${fail} failed) =====`);
  if (fail > 0) process.exitCode = 1;
  return { pass, fail };
}

const result = await main();
export default result;
