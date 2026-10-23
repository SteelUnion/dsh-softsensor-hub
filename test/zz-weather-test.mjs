// zz-weather-test.mjs — 天气采集器测试
//
// 约定 D1：每条都要能红。
// 最重要的三条（都是真踩过的）：
//   ① 「完全不变」不能报骤变 —— 第一次实现拿"今天最低 − 昨天最高"，
//      导致 8~13 对 8~13 报出「骤降 5℃」。这条如果放松，会天天误报。
//   ② 6 小时闸门：距上次取数不足 refreshHours 必须什么都不做。
//   ③ 位置定过就不再跟着 IP 变（维护者 原话：「不会出现 ip 切换了，地址就马上跟着换」）。

import {
  createWeatherCollector,
  computeSwing,
  gradeSwing,
  weatherCodeZh,
  parseLocations,
  localDate,
  buildDailyEvent,
  buildSwingEvent,
  DEFAULTS,
} from '../lib/collectors/weather.mjs';

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

const NOW = new Date('2026-10-23T08:00:00+08:00');
const HOUR = 3_600_000;

/** 内存状态桩。 */
function mkState(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    get: (k, d) => (m.has(k) ? m.get(k) : d),
    set: (k, v) => { m.set(k, v); },
    del: (k) => m.delete(k),
    _map: m,
  };
}

/** 网络桩：返回可控的天气。 */
function mkApi(over = {}) {
  return {
    fetchWeather: async () => ({
      current: { tempC: 5.3, feelsC: 0.1, humidity: 55, code: 0, windKmh: 18, at: '2026-10-23T08:00' },
      daily: { date: '2026-10-23', maxC: 15.3, minC: 5.5, code: 3, precipProb: 16 },
      forecast: [{ date: '2026-10-24', maxC: 12.4, minC: 4.2, code: 3, precipProb: 20 }],
    }),
    geocode: async (name) => ({ name, lat: 45.75, lon: 126.65 }),
    locateByIp: async () => ({ name: '哈尔滨', lat: 45.75, lon: 126.65 }),
    ...over,
  };
}

/** 造一个 env。 */
function mkEnv(state, now = NOW) {
  const runs = [];
  return {
    now: () => now,
    log: () => {},
    state,
    config: {},
    recordRun: (r) => runs.push(r),
    _runs: runs,
  };
}

async function main() {
  // ═══════════ 一、温差判据（最重要）═══════════

  // ① 完全不变 → 0，不报
  {
    const r = computeSwing({ minC: 8, maxC: 13 }, { minC: 8, maxC: 13 });
    ok('完全不变 delta=0', r?.delta === 0, JSON.stringify(r));
    ok('完全不变 不报警', gradeSwing(r.delta) === null);
  }

  // ② 昼夜温差大但两天一样 → 不报（这是第一次实现的 bug）
  {
    const r = computeSwing({ minC: 0, maxC: 20 }, { minC: 0, maxC: 20 });
    ok('大昼夜温差不变 → 0', r?.delta === 0, JSON.stringify(r));
    ok('大昼夜温差不变 不报警', gradeSwing(r.delta) === null);
  }

  // ③ 真骤降
  {
    const r = computeSwing({ minC: -2, maxC: 3 }, { minC: 8, maxC: 14 });
    ok('骤降 delta=-11', r?.delta === -11, JSON.stringify(r));
    ok('骤降方向 drop', r?.kind === 'drop');
    ok('骤降 critical', gradeSwing(r.delta) === 'critical');
  }

  // ④ 真骤升
  {
    const r = computeSwing({ minC: 15, maxC: 22 }, { minC: -1, maxC: 4 });
    ok('骤升 delta=18', r?.delta === 18, JSON.stringify(r));
    ok('骤升方向 rise', r?.kind === 'rise');
    ok('骤升 critical', gradeSwing(r.delta) === 'critical');
  }

  // ⑤ 小幅
  {
    const r = computeSwing({ minC: 9, maxC: 14 }, { minC: 8, maxC: 13 });
    ok('小幅 +1', r?.delta === 1, JSON.stringify(r));
    ok('小幅 不报警', gradeSwing(r.delta) === null);
  }

  // ⑥ 阈值边界（5 warn / 8 critical）
  {
    ok('−5 → warn', gradeSwing(-5) === 'warn');
    ok('−4.9 → null', gradeSwing(-4.9) === null);
    ok('−8 → critical', gradeSwing(-8) === 'critical');
    ok('−7.9 → warn', gradeSwing(-7.9) === 'warn');
    ok('+5 → warn（升温同阈值）', gradeSwing(5) === 'warn');
  }

  // ⑦ 缺数据 → null，不猜
  {
    ok('today=null → null', computeSwing(null, { minC: 1, maxC: 2 }) === null);
    ok('prev=null → null', computeSwing({ minC: 1, maxC: 2 }, null) === null);
    ok('缺字段 → null', computeSwing({ minC: 1 }, { minC: 1, maxC: 2 }) === null);
    ok('NaN → null', computeSwing({ minC: NaN, maxC: 2 }, { minC: 1, maxC: 2 }) === null);
  }

  // ⑧ 自定义阈值生效
  {
    ok('自定义 warn=1', gradeSwing(1.5, { warnC: 1, criticalC: 3 }) === 'warn');
    ok('自定义 critical=3', gradeSwing(3, { warnC: 1, criticalC: 3 }) === 'critical');
  }

  // ═══════════ 二、6 小时闸门 ═══════════

  // ① 从没取过 → 立刻取
  {
    const s = mkState();
    const c = createWeatherCollector({ locations: ['哈尔滨'], geoIp: false }, mkApi());
    await c.setup(mkEnv(s));
    const evts = await c.run(mkEnv(s));
    ok('首次运行会取数', evts.length > 0, `events=${evts.length}`);
    ok('写了 lastFetchAt', typeof s.get('weather:lastFetchAt', null) === 'number');
  }

  // ② 刚取过（1 小时前）→ 不取
  {
    const s = mkState({ 'weather:lastFetchAt': NOW.getTime() - 1 * HOUR });
    const c = createWeatherCollector({ locations: ['哈尔滨'], geoIp: false }, mkApi());
    await c.setup(mkEnv(s));
    const evts = await c.run(mkEnv(s));
    ok('1 小时前取过 → 不取', evts.length === 0, `events=${evts.length}`);
  }

  // ③ 5.9 小时前 → 不取（差一点不够）
  {
    const s = mkState({ 'weather:lastFetchAt': NOW.getTime() - 5.9 * HOUR });
    const c = createWeatherCollector({ locations: ['哈尔滨'], geoIp: false }, mkApi());
    await c.setup(mkEnv(s));
    ok('5.9 小时 → 不取', (await c.run(mkEnv(s))).length === 0);
  }

  // ④ 正好 6 小时 → 取
  {
    const s = mkState({ 'weather:lastFetchAt': NOW.getTime() - 6 * HOUR });
    const c = createWeatherCollector({ locations: ['哈尔滨'], geoIp: false }, mkApi());
    await c.setup(mkEnv(s));
    ok('正好 6 小时 → 取', (await c.run(mkEnv(s))).length > 0);
  }

  // ⑤ 关机 20 小时后开机 → 取（这就是"下午 4 点才开机"那一幕）
  {
    const s = mkState({ 'weather:lastFetchAt': NOW.getTime() - 20 * HOUR });
    const c = createWeatherCollector({ locations: ['哈尔滨'], geoIp: false }, mkApi());
    await c.setup(mkEnv(s));
    ok('关机 20 小时 → 开机补取', (await c.run(mkEnv(s))).length > 0);
  }

  // ⑥ refreshHours 可配
  {
    const s = mkState({ 'weather:lastFetchAt': NOW.getTime() - 3 * HOUR });
    const c = createWeatherCollector({ locations: ['哈尔滨'], geoIp: false, refreshHours: 2 }, mkApi());
    await c.setup(mkEnv(s));
    ok('refreshHours=2 → 3 小时会取', (await c.run(mkEnv(s))).length > 0);
  }

  // ═══════════ 三、位置解析 ═══════════

  // ① config 有位置 → 用它
  {
    const s = mkState();
    const c = createWeatherCollector({ locations: ['哈尔滨'], geoIp: true }, mkApi());
    await c.setup(mkEnv(s));
    await c.run(mkEnv(s));
    const locs = s.get('weather:locations', null);
    ok('落 state', Array.isArray(locs) && locs.length === 1, JSON.stringify(locs));
    ok('城市名对', locs?.[0]?.name === '哈尔滨');
    ok('带坐标', Number.isFinite(locs?.[0]?.lat));
  }

  // ② 没 config → 走 IP
  {
    const s = mkState();
    const c = createWeatherCollector({ locations: [], geoIp: true }, mkApi());
    await c.setup(mkEnv(s));
    await c.run(mkEnv(s));
    const locs = s.get('weather:locations', null);
    ok('IP 定位生效', locs?.[0]?.via === 'ip', JSON.stringify(locs));
  }

  // ③ IP 失败 → 北京兜底 + warn 事件
  {
    const s = mkState();
    const api = mkApi({ locateByIp: async () => { throw new Error('no network'); } });
    const c = createWeatherCollector({ locations: [], geoIp: true, fallbackCity: '北京' }, api);
    await c.setup(mkEnv(s));
    const evts = await c.run(mkEnv(s));
    const fb = evts.find((e) => e.kind === 'location-fallback');
    ok('IP 失败产 warn', fb !== undefined && fb.level === 'warn', JSON.stringify(evts.map((e) => e.kind)));
    ok('兜底是北京', s.get('weather:locations', null)?.[0]?.name === '北京');
  }

  // ④ 位置定过 → 不再跟 IP 变（维护者 的核心要求）
  {
    // 已有 state（上次定为哈尔滨），这次 IP 会返回上海
    const s = mkState({ 'weather:locations': [{ name: '哈尔滨', lat: 45.75, lon: 126.65, primary: true, via: 'ip' }] });
    const api = mkApi({ locateByIp: async () => ({ name: '上海', lat: 31.2, lon: 121.5 }) });
    const c = createWeatherCollector({ locations: [], geoIp: true }, api);
    await c.setup(mkEnv(s));
    await c.run(mkEnv(s));
    ok('位置不跟着 IP 变', s.get('weather:locations')?.[0]?.name === '哈尔滨', s.get('weather:locations')?.[0]?.name);
  }

  // ⑤ geoIp=false 且无 config → 用 fallbackCity，不调 IP
  {
    const s = mkState();
    let called = false;
    const api = mkApi({ locateByIp: async () => { called = true; return { name: 'X', lat: 1, lon: 1 }; } });
    const c = createWeatherCollector({ locations: [], geoIp: false, fallbackCity: '北京' }, api);
    await c.setup(mkEnv(s));
    await c.run(mkEnv(s));
    ok('geoIp=false 不调 IP', called === false);
    ok('用兜底城市', s.get('weather:locations')?.[0]?.name === '北京');
  }

  // ═══════════ 四、历史与清理 ═══════════

  // ① 写一天的记录
  {
    const s = mkState();
    const c = createWeatherCollector({ locations: ['哈尔滨'], geoIp: false }, mkApi());
    await c.setup(mkEnv(s));
    await c.run(mkEnv(s));
    const rec = s.get('weather:day:哈尔滨/2026-10-23', null);
    ok('写了当天记录', rec !== null, JSON.stringify(rec));
    ok('记录带城市', rec?.city === '哈尔滨');
    ok('记录带日期', rec?.date === '2026-10-23');
    ok('记录带 daily', rec?.daily?.maxC === 15.3);
  }

  // ② 第二天有昨天数据 → 能判温差
  {
    const s = mkState({
      'weather:lastFetchAt': NOW.getTime() - 24 * HOUR,
      'weather:locations': [{ name: '哈尔滨', lat: 45.75, lon: 126.65, primary: true }],
      'weather:day:哈尔滨/2026-10-22': {
        city: '哈尔滨', date: '2026-10-22',
        daily: { minC: 16, maxC: 24 },   // 昨天暖
      },
    });
    const api = mkApi({
      fetchWeather: async () => ({
        current: { tempC: 3, feelsC: 0, humidity: 60, code: 71, windKmh: 10, at: '2026-10-23T08:00' },
        daily: { date: '2026-10-23', maxC: 5, minC: 2, code: 71, precipProb: 80 },   // 今天骤冷
        forecast: [],
      }),
    });
    const c = createWeatherCollector({ locations: ['哈尔滨'], geoIp: false, thresholds: { warnC: 5, criticalC: 8 } }, api);
    await c.setup(mkEnv(s));
    const evts = await c.run(mkEnv(s));
    const swing = evts.find((e) => e.kind === 'temperature-drop');
    ok('第二天报骤降', swing !== undefined, JSON.stringify(evts.map((e) => e.kind)));
    ok('骤降 level=critical', swing?.level === 'critical', swing?.level);
    ok('骤降摘要含"骤降"', typeof swing?.summary === 'string' && swing.summary.includes('骤降'), swing?.summary);
  }

  // ③ 没有昨天数据 → 不报温差（不猜）
  {
    const s = mkState({ 'weather:locations': [{ name: '哈尔滨', lat: 45.75, lon: 126.65, primary: true }] });
    const c = createWeatherCollector({ locations: ['哈尔滨'], geoIp: false }, mkApi());
    await c.setup(mkEnv(s));
    const evts = await c.run(mkEnv(s));
    ok('首日不报温差', evts.every((e) => e.kind !== 'temperature-drop' && e.kind !== 'temperature-rise'),
      JSON.stringify(evts.map((e) => e.kind)));
  }

  // ④ 清理 10 天前的
  {
    const old = localDate(new Date(NOW.getTime() - 30 * 86_400_000));
    const s = mkState({
      'weather:locations': [{ name: '哈尔滨', lat: 45.75, lon: 126.65, primary: true }],
      [`weather:day:哈尔滨/${old}`]: { city: '哈尔滨', date: old, daily: { minC: 1, maxC: 2 } },
    });
    const c = createWeatherCollector({ locations: ['哈尔滨'], geoIp: false, keepDays: 10 }, mkApi());
    await c.setup(mkEnv(s));
    await c.run(mkEnv(s));
    ok('30 天前的被清掉', s.get(`weather:day:哈尔滨/${old}`, undefined) === undefined);
  }

  // ═══════════ 五、失败与防抖 ═══════════

  // ① 单次失败不报（C3：连续 3 次才报）
  {
    const s = mkState({ 'weather:locations': [{ name: '哈尔滨', lat: 45.75, lon: 126.65, primary: true }] });
    const api = mkApi({ fetchWeather: async () => { throw new Error('HTTP 500'); } });
    const c = createWeatherCollector({ locations: ['哈尔滨'], geoIp: false, failThreshold: 3 }, api);
    await c.setup(mkEnv(s));
    const e1 = await c.run(mkEnv(s));
    ok('第 1 次失败不报', e1.every((e) => e.kind !== 'collector-error'), JSON.stringify(e1.map((e) => e.kind)));
  }

  // ② 连续 3 次才报
  {
    const s = mkState({ 'weather:locations': [{ name: '哈尔滨', lat: 45.75, lon: 126.65, primary: true }] });
    const api = mkApi({ fetchWeather: async () => { throw new Error('HTTP 500'); } });
    const c = createWeatherCollector({ locations: ['哈尔滨'], geoIp: false, failThreshold: 3 }, api);
    await c.setup(mkEnv(s));
    await c.run(mkEnv(s));
    await c.run(mkEnv(s));
    const e3 = await c.run(mkEnv(s));
    ok('第 3 次失败报 warn', e3.some((e) => e.kind === 'collector-error'), JSON.stringify(e3.map((e) => e.kind)));
  }

  // ③ 失败不更新 lastFetchAt（下次还会试）
  {
    const s = mkState({ 'weather:locations': [{ name: '哈尔滨', lat: 45.75, lon: 126.65, primary: true }] });
    const api = mkApi({ fetchWeather: async () => { throw new Error('boom'); } });
    const c = createWeatherCollector({ locations: ['哈尔滨'], geoIp: false }, api);
    await c.setup(mkEnv(s));
    await c.run(mkEnv(s));
    ok('失败不写 lastFetchAt', s.get('weather:lastFetchAt', null) === null);
  }

  // ④ 一个城市失败不影响另一个的**数据**（但事件只由默认城市产生）
  //
  //   【2026-10-23 行为变更】
  //     维护者：「所有的什么温度骤降，都只落在默认地址上。」
  //     所以非默认城市**不再产事件**，但数据照拉、照存 —— 用户问到再算。
  //     这条测试同时守住两件事：
  //       a) 非默认城市不产事件（行为符合新规则）
  //       b) 非默认城市的数据确实写进表了（没被顺手砍掉）
  {
    const s = mkState({
      'weather:locations': [
        { name: '坏城', lat: 1, lon: 1, primary: true },
        { name: '好城', lat: 2, lon: 2, primary: false },
      ],
    });
    const api = mkApi({
      fetchWeather: async (lat) => {
        if (lat === 1) throw new Error('bad city');
        return {
          current: { tempC: 10, feelsC: 8, humidity: 50, code: 0, windKmh: 5, at: 'x' },
          daily: { date: '2026-10-23', maxC: 12, minC: 8, code: 0, precipProb: 0 },
          forecast: [],
        };
      },
    });
    const c = createWeatherCollector({ locations: ['坏城', '好城'], geoIp: false }, api);
    await c.setup(mkEnv(s));
    const evts = await c.run(mkEnv(s));
    // a) 非默认城市不产事件
    ok('非默认城市不产事件', !evts.some((e) => e.payload?.city === '好城'),
      JSON.stringify(evts.map((e) => e.payload?.city)));
    // b) 但数据要存下来
    const saved = s.get('weather:day:好城/2026-10-23', null);
    ok('非默认城市数据仍落表', saved !== null, JSON.stringify(saved));
    ok('落表数据正确', saved?.daily?.maxC === 12, JSON.stringify(saved?.daily));
  }

  // ═══════════ 六、工具函数 ═══════════

  {
    ok('weatherCode 0', weatherCodeZh(0) === '晴');
    ok('weatherCode 71', weatherCodeZh(71) === '小雪');
    ok('weatherCode 未知', weatherCodeZh(999).startsWith('未知'));

    const locs = parseLocations(['哈尔滨', { name: '上海', lat: 31.2, lon: 121.5 }]);
    ok('parseLocations 字符串', locs[0].name === '哈尔滨' && locs[0].primary === true);
    ok('parseLocations 对象带坐标', locs[1].lat === 31.2);
    ok('parseLocations 空', parseLocations(null).length === 0);
    ok('parseLocations 跳过空名', parseLocations(['', '  ']).length === 0);

    ok('localDate 深夜不跨天', localDate(new Date(2026, 9, 23, 23, 59)) === '2026-10-23');
    ok('localDate 凌晨不跨天', localDate(new Date(2026, 9, 23, 0, 1)) === '2026-10-23');
  }

  // ═══════════ 七、事件构造 ═══════════

  {
    const evt = buildDailyEvent({
      city: '哈尔滨',
      date: '2026-10-23',
      data: {
        current: { tempC: 5.3 },
        daily: { minC: 5.5, maxC: 15.3, code: 3, precipProb: 16 },
      },
    });
    ok('日常事件有 source', evt.source === 'weather');
    ok('日常事件 kind=daily', evt.kind === 'daily');
    ok('日常摘要含城市', evt.summary.includes('哈尔滨'), evt.summary);
    ok('日常摘要含温度', evt.summary.includes('℃'), evt.summary);
    ok('日常 dedupeKey 含日期', evt.dedupeKey.includes('2026-10-23'));

    const swing = buildSwingEvent({
      city: '哈尔滨',
      date: '2026-10-23',
      swing: { delta: -9.5, kind: 'drop' },
      data: { today: { minC: 2, maxC: 5 }, previous: { minC: 12, maxC: 15 }, thresholds: { warnC: 5, criticalC: 8 } },
    });
    ok('温差事件 level=critical', swing?.level === 'critical');
    ok('温差摘要含"骤降"', swing?.summary.includes('骤降'));
    ok('温差摘要含数值', swing?.summary.includes('9.5'));

    const below = buildSwingEvent({
      city: '哈尔滨',
      date: '2026-10-23',
      swing: { delta: -2, kind: 'drop' },
      data: { today: { minC: 10, maxC: 15 }, previous: { minC: 12, maxC: 15 }, thresholds: { warnC: 5, criticalC: 8 } },
    });
    ok('未过阈值不产事件', below === null);
  }

  // ═══════════ 八、recordRun 体检 ═══════════

  {
    const s = mkState({ 'weather:locations': [{ name: '哈尔滨', lat: 45.75, lon: 126.65, primary: true }] });
    const env = mkEnv(s);
    const c = createWeatherCollector({ locations: ['哈尔滨'], geoIp: false }, mkApi());
    await c.setup(env);
    await c.run(env);
    ok('每轮都记 recordRun', env._runs.length === 1, `runs=${env._runs.length}`);
    ok('recordRun 带 city', Array.isArray(env._runs[0]?.cities), JSON.stringify(env._runs[0]));
  }

  // ── 汇总 ──
  //
  // 【格式必须与 zz-all.mjs 的正则对齐】
  //   zz-all 用 /\((?:(\d+) passed)?,\s*(\d+) failed\)/ 抓统计行。
  //   我第一版只打了中文「N 项通过」，结果 zz-all 显示 0 / 0 —— 
  //   测试跑了，但总数统计不到，等于没测。
  //   照 zz-finance-test.mjs 的格式来。
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
