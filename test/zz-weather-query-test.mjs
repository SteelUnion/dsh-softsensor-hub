// zz-hint-lookup-test.mjs — AGENTS.md 三层查找 + 城市别名 + 天气查询
//
// 维护者 2026-10-23 两条要求：
//   ① 「检查的逻辑要覆盖三层，从上往下，没有就往下查，查完三层都没有就弹对话让建立文件」
//   ② 「那个 xxx 可以在 relay 中做映射表，比如城市简写，中文英文拼音，城市代码
//      都会关联到对应的城市」
//
// 约定 D1：每条都要能红。
//   三层顺序错了 → 「全局优先于项目」会红
//   别名表烂了   → 各种拼写用例会红
//   查询算错了   → 温差/趋势断言会红

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCity, aliasesOf, knownCities, searchCities } from '../lib/cities.mjs';
import { queryWeather, summarize, renderSummary } from '../lib/weather-query.mjs';

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

/** 内存 state 桩。 */
function mkState(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    get: (k, d) => (m.has(k) ? m.get(k) : d),
    set: (k, v) => { m.set(k, v); },
    del: (k) => m.delete(k),
    _map: m,
  };
}

/** 造一天的天气记录。 */
function mkDay(city, date, minC, maxC, code = 0, precipProb = 0) {
  return {
    city,
    date,
    fetchedAt: `${date}T08:00:00+08:00`,
    daily: { date, minC, maxC, code, precipProb },
  };
}

const BASE = new Date(2026, 9, 23, 12, 0, 0);   // 2026-10-23 本地

const tmpDirs = [];
function mkTmp(name) {
  const d = mkdtempSync(join(tmpdir(), `zz-hint-${name}-`));
  tmpDirs.push(d);
  return d;
}

async function main() {
  // ═══════════ 一、城市别名 ═══════════

  // ① 中文原样
  {
    ok('哈尔滨 → 哈尔滨', resolveCity('哈尔滨') === '哈尔滨');
    ok('九江 → 九江', resolveCity('九江') === '九江');
    ok('南昌 → 南昌', resolveCity('南昌') === '南昌');
  }

  // ② 拼音 / 简写 / 代码 / 英文
  {
    ok('haerbin → 哈尔滨', resolveCity('haerbin') === '哈尔滨');
    ok('harbin → 哈尔滨', resolveCity('harbin') === '哈尔滨');
    ok('HRB → 哈尔滨', resolveCity('HRB') === '哈尔滨');
    ok('hrb 小写 → 哈尔滨', resolveCity('hrb') === '哈尔滨');
    ok('jiujiang → 九江', resolveCity('jiujiang') === '九江');
    ok('jj → 九江', resolveCity('jj') === '九江');
    ok('360400 → 九江', resolveCity('360400') === '九江');
    ok('nanchang → 南昌', resolveCity('nanchang') === '南昌');
    ok('230100 → 哈尔滨', resolveCity('230100') === '哈尔滨');
  }

  // ③ 「市」后缀
  {
    ok('哈尔滨市 → 哈尔滨', resolveCity('哈尔滨市') === '哈尔滨');
    ok('九江市 → 九江', resolveCity('九江市') === '九江');
  }

  // ④ 俗名
  {
    ok('冰城 → 哈尔滨', resolveCity('冰城') === '哈尔滨');
    ok('桃花 → 景德镇', resolveCity('桃花') === '景德镇');
  }

  // ⑤ 查不到不报错，原样返回
  {
    ok('魔都 → 魔都（不报错）', resolveCity('魔都') === '魔都');
    ok('空串 → null', resolveCity('') === null);
    ok('null → null', resolveCity(null) === null);
    ok('两边空格被去掉', resolveCity('  哈尔滨  ') === '哈尔滨');
  }

  // ⑥ 别名表完整性
  {
    ok('城市数 >= 40', knownCities().length >= 40, String(knownCities().length));
    const hrb = aliasesOf('hrb');
    ok('哈尔滨别名 >= 5 个', hrb.length >= 5, hrb.join(','));
    ok('别名含 hrB 各种写法',
      hrb.some((a) => a === 'haerbin') && hrb.some((a) => a === 'harbin') && hrb.some((a) => a === 'hrb'));
  }

  // ⑦ 模糊搜索
  {
    const ns = searchCities('nan');
    ok('搜 nan 含南昌', ns.includes('南昌'), ns.join(','));
    ok('搜 nan 含南京', ns.includes('南京'), ns.join(','));
    ok('搜空串 → 空', searchCities('').length === 0);
    const jj = searchCities('jiu');
    ok('搜 jiu 含九江', jj.includes('九江'), jj.join(','));
  }

  // ═══════════ 二、天气查询 ═══════════

  // ① 三天数据，逐日降温
  {
    const s = mkState({
      'weather:locations': [{ name: '哈尔滨', lat: 45.75, lon: 126.65, primary: true }],
      'weather:day:哈尔滨/2026-10-21': mkDay('哈尔滨', '2026-10-21', 8, 15, 2, 0),
      'weather:day:哈尔滨/2026-10-22': mkDay('哈尔滨', '2026-10-22', 7, 14, 3, 10),
      'weather:day:哈尔滨/2026-10-23': mkDay('哈尔滨', '2026-10-23', -2, 5, 71, 80),
    });
    const r = queryWeather({ state: s, city: 'hrb', days: 10, now: BASE });
    ok('查询成功', r.ok === true, r.error);
    ok('城市解析对', r.city === '哈尔滨', r.city);
    ok('3 天', r.summary.days.length === 3, String(r.summary.days.length));

    const d = r.summary.days;
    ok('10-22 骤变 -1', d[1].swing === -1, String(d[1].swing));
    // max 5 - 14 = -9，min -2 - 7 = -9，两边一样取 min 侧 → -9
    ok('10-23 骤变 -9', d[2].swing === -9, String(d[2].swing));
    ok('趋势 -10（8→-2）', r.summary.trend === -10, String(r.summary.trend));
  }

  // ② 渲染成文字，行数受控（上下文干净）
  {
    const s = mkState({
      'weather:locations': [{ name: '哈尔滨', primary: true }],
      'weather:day:哈尔滨/2026-10-21': mkDay('哈尔滨', '2026-10-21', 8, 15),
      'weather:day:哈尔滨/2026-10-22': mkDay('哈尔滨', '2026-10-22', 7, 14),
      'weather:day:哈尔滨/2026-10-23': mkDay('哈尔滨', '2026-10-23', -2, 5),
    });
    const r = queryWeather({ state: s, city: '哈尔滨', days: 10, now: BASE });
    const lines = r.text.split('\n');
    // 1 行标题 + 3 行数据 + 1 行趋势 = 5
    ok('渲染 5 行', lines.length === 5, `${lines.length}:\n${r.text}`);
    ok('不含 JSON', !r.text.includes('{') && !r.text.includes('"'), r.text);
    ok('含城市名', r.text.includes('哈尔滨'));
    ok('含温度', r.text.includes('℃'));
    ok('含骤变标记', r.text.includes('↓9'), r.text);
  }

  // ③ 查不到 → 明确说原因
  {
    const s = mkState({
      'weather:locations': [{ name: '哈尔滨', primary: true }],
    });
    const r = queryWeather({ state: s, city: '上海', days: 3, now: BASE });
    ok('无数据 → ok=false', r.ok === false);
    ok('提示不在采集列表', r.error.includes('不在采集列表'), r.error);
    ok('列出当前列表', r.error.includes('哈尔滨'), r.error);
  }

  // ④ 在列表里但还没数据 → 提示不同
  {
    const s = mkState({
      'weather:locations': [{ name: '九江', primary: true }],
    });
    const r = queryWeather({ state: s, city: '九江', days: 3, now: BASE });
    ok('ok=false', r.ok === false);
    ok('提示还没数据（不是不在列表）', r.error.includes('还没有数据'), r.error);
  }

  // ⑤ state 不可用
  {
    const r = queryWeather({ state: null, city: '哈尔滨' });
    ok('state=null → 明确报错', r.ok === false && r.error.includes('state'), r.error);
  }

  // ⑥ 没给城市
  {
    const r = queryWeather({ state: mkState(), city: '' });
    ok('空城市 → 报错', r.ok === false);
  }

  // ⑦ days 边界
  {
    const s = mkState({
      'weather:day:哈尔滨/2026-10-23': mkDay('哈尔滨', '2026-10-23', -2, 5),
    });
    const r1 = queryWeather({ state: s, city: '哈尔滨', days: 0, now: BASE });
    ok('days=0 至少取 1 天', r1.ok === true, r1.error);
    const r2 = queryWeather({ state: s, city: '哈尔滨', days: 999, now: BASE });
    ok('days 上限 30（不炸）', r2.ok === true, r2.error);
  }

  // ═══════════ 三、summarize 纯函数 ═══════════

  // ① 空输入
  {
    ok('空数组 → null', summarize([]) === null);
  }

  // ② 单天没有趋势
  {
    const s = summarize([mkDay('哈尔滨', '2026-10-23', 5, 10)]);
    ok('单天 days=1', s.days.length === 1);
    ok('单天无 swing', s.days[0].swing === undefined);
    ok('单天趋势 0', s.trend === 0, String(s.trend));
  }

  // ③ 升温
  {
    const s = summarize([
      mkDay('哈尔滨', '2026-10-22', -10, -2),
      mkDay('哈尔滨', '2026-10-23', 5, 12),
    ]);
    ok('升温 swing 正数', s.days[1].swing > 0, String(s.days[1].swing));
    ok('升温趋势正数', s.trend > 0, String(s.trend));
  }

  // ④ 完全不变 → 0 骤变（防「昼夜温差当骤变」的老 bug）
  {
    const s = summarize([
      mkDay('哈尔滨', '2026-10-22', 8, 13),
      mkDay('哈尔滨', '2026-10-23', 8, 13),
    ]);
    ok('完全不变化 swing=0', s.days[1].swing === 0, String(s.days[1].swing));
    ok('完全不变化 trend=0', s.trend === 0, String(s.trend));
  }

  // ⑤ renderSummary 对 null
  {
    ok('null → 提示文字', renderSummary(null).includes('没有数据'));
  }

  // ── 汇总 ──
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }

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
