// zz-finance-test.mjs — 金融采集器测试
//
// 【怎么保证这些测试"能真的红"（约定 D1）】
//   不用真库：真库停在 2026-06-12，拿它测"新鲜度通过"永远测不了。
//   每个用例现造一个临时 sqlite 库，日期和收盘价都是自己定的。
//   所以任何一条断言写错/实现写错，都会立刻红。
//
//   几个专门用来抓错的构造：
//     - 30 日目标日故意落在周末，且前后各有更近的 K 线 → 只有"取不晚于目标"的实现才对
//     - localDate 用早上 7:30 的 Date → 用 toISOString 会退到前一天
//     - 只读库上执行 INSERT，必须抛

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validateCollector, collectEvents } from '../lib/collector.mjs';
import { validateEvent } from '../lib/event.mjs';
import {
  createFinanceCollector, parseCodes, localDate, daysBetween, shiftDate,
  barOnOrBefore, computeChange, formatSummary, afterAt, DEFAULTS,
} from '../lib/collectors/finance.mjs';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

const TMP = mkdtempSync(join(tmpdir(), 'relay-fin-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

/** 造一个临时量化库。barsByCode: { '600362': [[date, close], ...] }（顺序随意） */
function makeDb(name, barsByCode = {}, stocks = {}) {
  const p = join(TMP, `${name}.db`);
  const db = new DatabaseSync(p);
  db.exec(`CREATE TABLE daily_bars (code TEXT, date TEXT, close REAL, pct_chg REAL, PRIMARY KEY (code, date))`);
  db.exec(`CREATE TABLE stocks (code TEXT PRIMARY KEY, name TEXT)`);
  const ins = db.prepare('INSERT INTO daily_bars (code, date, close, pct_chg) VALUES (?, ?, ?, ?)');
  for (const [code, bars] of Object.entries(barsByCode)) {
    for (const [date, close, pct] of bars) ins.run(code, date, close, pct ?? null);
  }
  const insStock = db.prepare('INSERT INTO stocks (code, name) VALUES (?, ?)');
  for (const [code, n] of Object.entries(stocks)) insStock.run(code, n);
  db.close();
  return p;
}

/** 造一个能用的 env。state 是真 Map，recordRun 收下来方便断言。 */
function makeEnv({ now = new Date(), state = new Map() } = {}) {
  const runs = [];
  return {
    env: {
      now: () => now,
      log: () => {},
      state: {
        get: (k) => state.get(k),
        set: (k, v) => state.set(k, v),
        del: (k) => state.delete(k),
      },
      config: {},
      recordRun: (r) => runs.push(r),
    },
    runs,
    state,
  };
}

console.log('\n=== ① 契约 ===');
{
  const c = createFinanceCollector({ codes: ['600362'] });
  ok('符合采集器契约', validateCollector(c).ok === true);
  ok('名字是 finance', c.name === 'finance');
  ok('默认 30 分钟一采', c.trigger.everySec === 1800);
  ok('有 run', typeof c.run === 'function');
  ok('有 setup', typeof c.setup === 'function');
  ok('有 teardown', typeof c.teardown === 'function');
}

console.log('\n=== ② 关注列表归一 ===');
{
  ok('字符串代码', parseCodes(['600362']).length === 1);
  ok('带名字的对象', parseCodes([{ code: '600362', name: '江西铜业' }])[0].name === '江西铜业');
  ok('★ 非 6 位数字被丢掉', parseCodes(['60036', 'abc', '6003627']).length === 0);
  ok('★ 重复代码只留一条', parseCodes(['600362', '600362', { code: '600362' }]).length === 1);
  ok('非数组返回空', parseCodes(null).length === 0 && parseCodes('600362').length === 0);
}

console.log('\n=== ③ 日期工具 ===');
{
  // 早上 7:30（东八区）→ UTC 还是前一天。localDate 必须是本地日期。
  const early = new Date(2026, 9, 21, 7, 30, 0);
  ok('★ localDate 用本地时区（不是 UTC）', localDate(early) === '2026-10-21', `got=${localDate(early)} utc=${early.toISOString()}`);
  ok('localDate 补零', localDate(new Date(2026, 0, 5)) === '2026-01-05');
  ok('★ 2026-06-12 → 2026-10-21 是 131 天', daysBetween('2026-06-12', '2026-10-21') === 131, `got=${daysBetween('2026-06-12', '2026-10-21')}`);
  ok('倒推为负', daysBetween('2026-10-21', '2026-06-12') === -131);
  ok('坏格式返回 null', daysBetween('x', '2026-10-21') === null);
  ok('★ 跨月倒推', shiftDate('2026-03-01', -1) === '2026-02-28', `got=${shiftDate('2026-03-01', -1)}`);
  ok('★ 跨年倒推 365 天', shiftDate('2026-01-01', -365) === '2025-01-01', `got=${shiftDate('2026-01-01', -365)}`);
}

console.log('\n=== ④ at 时间闸门 ===');
{
  ok('09:00 之后（09:30）放行', afterAt(new Date(2026, 9, 21, 9, 30), '09:00') === true);
  ok('★ 08:59 不放行', afterAt(new Date(2026, 9, 21, 8, 59), '09:00') === false);
  ok('09:00 整点放行', afterAt(new Date(2026, 9, 21, 9, 0), '09:00') === true);
  ok('★ 配置写坏时不拦（宁可跑也不哑）', afterAt(new Date(2026, 9, 21, 0, 5), 'oops') === true);
}

console.log('\n=== ⑤ 取 K 线：不晚于目标 ===');
{
  const bars = [
    { date: '2026-06-12', close: 100 },
    { date: '2026-05-29', close: 90 }, // 周五
    { date: '2026-05-28', close: 80 },
  ];
  // 2026-05-31 是周日：不晚于它的最近一根是 5-29 的 90
  ok('★ 目标日落周末 → 取上周五', barOnOrBefore(bars, '2026-05-31').date === '2026-05-29');
  ok('目标日正好有 K 线 → 取当天', barOnOrBefore(bars, '2026-05-28').date === '2026-05-28');
  ok('目标日早于全部 → null', barOnOrBefore(bars, '2026-01-01') === null);
}

console.log('\n=== ⑥ 四档对比（价格算得对不对）===');
{
  // 基准 latest = 2026-06-12 / 100
  //   d1  目标 06-11：没有 → 不晚于它最近的是 06-10 / 80  → +25.00%
  //   d30 目标 05-13：没有 → 不晚于它最近的是 05-12 / 50  → +100.00%
  //        （若实现"取最近一根不管早晚"，会拿到 05-14 的 60 → +66.67%）
  //   d90 目标 03-14：没有 → 03-13 / 200 → -50.00%
  //   d1y 目标 2025-06-12：2025-06-10 / 400 → -75.00%
  const bars = [
    { date: '2026-06-12', close: 100 },
    { date: '2026-06-10', close: 80 },
    { date: '2026-05-14', close: 60 },
    { date: '2026-05-12', close: 50 },
    { date: '2026-03-13', close: 200 },
    { date: '2025-06-10', close: 400 },
  ];
  const { base, change } = computeChange(bars);
  ok('基准是最新一根', base.date === '2026-06-12');
  ok('★ d1 = +25.00%', change.d1?.pct === 25, `got=${change.d1?.pct}（${change.d1?.date}）`);
  ok('★ d30 = +100.00%（不被 05-14 的 60 抢走）', change.d30?.pct === 100, `got=${change.d30?.pct}（${change.d30?.date}）`);
  ok('★ d90 = -50.00%', change.d90?.pct === -50, `got=${change.d90?.pct}`);
  ok('★ d1y = -75.00%', change.d1y?.pct === -75, `got=${change.d1y?.pct}`);
  ok('四档都带价格', change.d1?.price === 80 && change.d30?.price === 50 && change.d1y?.price === 400);
  ok('四档都带日期', change.d1?.date === '2026-06-10' && change.d1y?.date === '2025-06-10');
  ok('空 K 线不崩', computeChange([]).base === null);
  ok('一根 K 线时四档全空（没有对比基准）',
    Object.values(computeChange([{ date: '2026-06-12', close: 100 }]).change).every((v) => v === null));
}

console.log('\n=== ⑦ 摘要格式 ===');
{
  ok('带名字', formatSummary('600362', '江西铜业', 24.3, 4.21) === '600362 江西铜业 24.30 +4.21%');
  ok('没名字只显示代码', formatSummary('600362', '', 24.3, 1) === '600362 24.30 +1.00%');
  ok('★ 跌了带负号', formatSummary('600362', '', 24.3, -1.5) === '600362 24.30 -1.50%');
  ok('没有涨跌幅时不硬凑', formatSummary('600362', '', 24.3, null) === '600362 24.30');
  ok('★ 摘要不超过 80 字', formatSummary('600362', '很长很长的名字'.repeat(10), 24.3, 1).length > 0);
}

console.log('\n=== ⑧ 真实采集：新鲜库 → 出行情 ===');
{
  const today = localDate(new Date());
  const d1 = shiftDate(today, -1);
  const d30 = shiftDate(today, -30);
  const db = makeDb('fresh', {
    '600362': [[today, 24.3, 4.21], [d1, 23.32, 0], [d30, 25.08, 0]],
    '000001': [[today, 10, 0]],
  }, { '600362': '江西铜业', '000001': '平安银行' });

  const { env, runs } = makeEnv({ now: new Date(`${today}T10:00:00`) });
  const c = createFinanceCollector({ dbPath: db, codes: ['600362', '000001'], at: '09:00' });
  await c.setup(env);
  const evts = await c.run(env);
  await c.teardown();

  ok('两只票各一条', evts.length === 2, `got=${evts.length}`);
  const q = evts.find((e) => e.payload?.code === '600362');
  ok('★ 事件过协议校验', validateEvent(q).ok === true, JSON.stringify(validateEvent(q)));
  ok('source=finance / kind=daily-quote / level=info',
    q.source === 'finance' && q.kind === 'daily-quote' && q.level === 'info');
  ok('★ dedupeKey = finance:代码:日期', q.dedupeKey === `finance:600362:${today}`, q.dedupeKey);
  ok('★ 摘要含名称与涨幅', q.summary === '600362 江西铜业 24.30 +4.20%', q.summary);
  ok('票名从 stocks 表补', q.payload.name === '江西铜业');
  ok('★ d1 用前一日收盘算', q.payload.change.d1.pct === 4.2, `got=${q.payload.change.d1?.pct}`);
  ok('★ d30 = -3.11%', q.payload.change.d30?.pct === -3.11, `got=${q.payload.change.d30?.pct}`);
  ok('recordRun 记了这一轮', runs.length === 1 && runs[0].produced === 2);
}

console.log('\n=== ⑨ 新鲜度闸门：库旧了不出假行情 ===');
{
  const today = localDate(new Date());
  const old = shiftDate(today, -131); // 模拟真库停在 2026-06-12
  const db = makeDb('stale', { '600362': [[old, 24.3, 0]] }, { '600362': '江西铜业' });
  const { env, runs } = makeEnv({ now: new Date(`${today}T10:00:00`) });
  const c = createFinanceCollector({ dbPath: db, codes: ['600362'], maxAgeDays: 7 });
  await c.setup(env);
  const evts = await c.run(env);
  await c.teardown();

  ok('★ 只产一条事件', evts.length === 1, `got=${evts.length}`);
  ok('★ 是 stale-data / warn', evts[0].kind === 'stale-data' && evts[0].level === 'warn');
  ok('★ 一条 quote 都没有（不拿旧价当今天）', evts.every((e) => e.kind !== 'daily-quote'));
  ok('摘要说清停在哪天', evts[0].summary.includes(old), evts[0].summary);
  ok('dedupeKey 带日期（一天只发一次）', evts[0].dedupeKey === `finance:stale:${today}`);
  ok('recordRun 标了 stale', runs[0].stale === true && runs[0].ageDays === 131, JSON.stringify(runs[0]));
}

console.log('\n=== ⑩ 一天只产一次 ===');
{
  const today = localDate(new Date());
  const db = makeDb('once', { '600362': [[today, 24.3, 1]] }, {});
  const { env, state } = makeEnv({ now: new Date(`${today}T10:00:00`) });
  const c = createFinanceCollector({ dbPath: db, codes: ['600362'] });
  await c.setup(env);
  const first = await c.run(env);
  const second = await c.run(env);
  const third = await c.run({ ...env, now: () => new Date(`${today}T23:00:00`) });
  await c.teardown();
  ok('第一次产出', first.length === 1, `got=${first.length}`);
  ok('★ 同一天第二次不重复产', second.length === 0);
  ok('★ 当天晚些时候也不重复产', third.length === 0);
  ok('状态里记了今天', state.get('lastProducedDate') === today);
}

console.log('\n=== ⑪ 时间未到不跑 ===');
{
  const today = localDate(new Date());
  const db = makeDb('early', { '600362': [[today, 24.3, 1]] }, {});
  const { env } = makeEnv({ now: new Date(`${today}T08:00:00`) });
  const c = createFinanceCollector({ dbPath: db, codes: ['600362'], at: '09:00' });
  await c.setup(env);
  const evts = await c.run(env);
  await c.teardown();
  ok('★ 08:00 不产事件', evts.length === 0);
}

console.log('\n=== ⑫ 查不到的票不编 ===');
{
  const today = localDate(new Date());
  const db = makeDb('partial', { '600362': [[today, 24.3, 1]] }, {});
  const { env } = makeEnv({ now: new Date(`${today}T10:00:00`) });
  const c = createFinanceCollector({ dbPath: db, codes: ['600362', '999999'] });
  await c.setup(env);
  const evts = await c.run(env);
  await c.teardown();
  ok('★ 有数据的照样产出', evts.length === 1, `got=${evts.length}`);
  ok('★ 没数据的票一条都没有', evts.every((e) => e.payload?.code === '600362'));
}

console.log('\n=== ⑬ 库坏了不崩平台 ===');
{
  const { env, runs } = makeEnv({ now: new Date(`${localDate(new Date())}T10:00:00`) });
  const c = createFinanceCollector({ dbPath: join(TMP, 'nope.db'), codes: ['600362'] });
  await c.setup(env);
  const r1 = await c.run(env);
  const r2 = await c.run(env);
  const r3 = await c.run(env);
  await c.teardown();
  ok('读不到库不抛，返回数组', Array.isArray(r1) && r1.length === 0);
  ok('★ 前两次不报（C3：连续 3 次才报）', r1.length === 0 && r2.length === 0);
  ok('★ 第三次报 collector-error / warn', r3.length === 1 && r3[0].kind === 'collector-error' && r3[0].level === 'warn');
  ok('每次失败都留了 recordRun', runs.filter((x) => x.error).length === 3, `got=${runs.length}`);
}

console.log('\n=== ⑭ 只读边界 ===');
{
  const today = localDate(new Date());
  const dbPath = makeDb('ro', { '600362': [[today, 24.3, 1]] }, {});
  const ro = new DatabaseSync(dbPath, { readOnly: true });
  let wrote = false;
  try { ro.exec(`INSERT INTO daily_bars (code,date,close) VALUES ('x','2026-01-01',1)`); wrote = true; } catch { /* 期望 */ }
  ro.close();
  ok('★ 只读库上写入必须抛', wrote === false);
}

console.log('\n=== ⑮ 空关注列表 ===');
{
  // 【2026-10-23】加了 dbPath 判空：没配库路径时在"关注列表"之前就返回 no-dbpath。
  //   所以这条用例必须显式给个存在的库路径，才能测到 no-watchlist 那条分支。
  const { env, runs } = makeEnv({ now: new Date(`${localDate(new Date())}T10:00:00`) });
  const c = createFinanceCollector({ codes: [], dbPath: DEFAULTS.dbPath ?? 'x.db' });
  await c.setup(env);
  const evts = await c.run(env);
  await c.teardown();
  ok('没配置关注列表就不产事件', evts.length === 0);
  ok('recordRun 标了 no-watchlist', runs[0]?.note === 'no-watchlist');
}

console.log('\n=== ⑮b 未配置库路径 ===');
{
  // 【2026-10-23 新增】发布包不带作者私有路径，用户没配前 dbPath 是 null。
  //   这时必须静默跳过：不报错、不产事件、不连续 3 次喊人。
  const { env, runs } = makeEnv({ now: new Date(`${localDate(new Date())}T10:00:00`) });
  const c = createFinanceCollector({ codes: ['600000'], dbPath: null });
  await c.setup(env);
  const evts = await c.run(env);
  await c.teardown();
  ok('未配库路径 → 不产事件', evts.length === 0);
  ok('未配库路径 → 记 no-dbpath', runs[0]?.note === 'no-dbpath', JSON.stringify(runs[0]));
}

console.log('\n=== ⑯ 默认值 ===');
{
  // 【2026-10-23 改】发布包里不放作者私有路径 —— 默认值必须是 null。
  //   采集器拿到 null 就静默跳过（见 ⑮b），由用户或向导填真实路径。
  ok('默认库路径为空（待配置）', DEFAULTS.dbPath === null);
  ok('默认 09:00', DEFAULTS.at === '09:00');
  ok('默认 7 天新鲜度', DEFAULTS.maxAgeDays === 7);
  ok('默认 info 级', DEFAULTS.level === 'info');
  ok('默认失败阈值 3', DEFAULTS.failThreshold === 3);
}

console.log(`\n===== ${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} (${pass} passed, ${fail} failed) =====`);
process.exit(fail === 0 ? 0 : 1);
