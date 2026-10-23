// weather-query.mjs — 天气查询（relay 算好，给 agent 结果）
//
// 维护者 2026-10-23：
//   「可以让 relay 查询过去十天数据，我们保存十天，然后计算出结果，
//     直接给 agent 结果，这样 agent 上下文干净些。如果 agent 想自己查也允许查就是了，
//     这样下来就是简单可靠 + 可溯源。」
//
// 【为什么要这一层】
//   我（agent）需要知道「哈尔滨这三天怎么样」。
//   如果我自己读表，要把 10 天 × N 城市的原始记录全读进上下文再算 —— 几百行。
//   relay 算完只给 3-5 行结论，**上下文干净，而且数字可回查**。
//
// 【数据从哪来】
//   `butler` 域的 `weather` 表，key = `<城市>/<YYYY-MM-DD>`，保留 keepDays 天。
//   这是采集器 collectors/weather.mjs 写进去的，**同源** —— 所以查询结果和告警一致。
//
// 【算什么】
//   逐日列表（日期、天气、最低~最高、降水概率）
//   日间温差（今天最低 − 昨天最低、今天最高 − 昨天最高）
//   趋势（这段时间整体升还是降）

import { resolveCity } from './cities.mjs';

/** WMO 天气代码 → 中文。与 collectors/weather.mjs 保持一致。 */
const CODE_ZH = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
  45: '雾', 48: '冻雾',
  51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨', 56: '冻毛毛雨', 57: '强冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '米雪',
  80: '小阵雨', 81: '阵雨', 82: '强阵雨', 85: '小阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷阵雨伴冰雹',
};

function codeZh(c) {
  return CODE_ZH[c] ?? (c === null || c === undefined ? '—' : `未知(${c})`);
}

/** 本地日期 YYYY-MM-DD。 */
function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 前 n 天的日期串，从今天往前。 */
function lastNDates(n, from = new Date()) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(localDate(new Date(from.getTime() - i * 86_400_000)));
  }
  return out.reverse(); // 旧 → 新
}

function round1(v) {
  return Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
}

/**
 * 从 state 读某城市的记录。
 *
 * @param state  state 后端（同步 get）
 * @param city   标准城市名
 * @param days   要几天
 */
export function readCityHistory(state, city, days = 10) {
  const rows = [];
  for (const date of lastNDates(days)) {
    const rec = state.get(`weather:day:${city}/${date}`, null);
    if (rec !== null) rows.push(rec);
  }
  return rows;
}

/**
 * 算一个城市的天气结论。
 *
 * 【为什么返回对象而不直接返回字符串】
 *   CLI 要打印、agent 要读、测试要断言 —— 三种用途同一份数据。
 *   渲染成文字是最后一层的事。
 *
 * @param rows 已按日期升序排列的记录
 */
export function summarize(rows) {
  if (rows.length === 0) return null;

  const days = rows.map((r) => ({
    date: r.date,
    code: r.daily?.code ?? null,
    weather: codeZh(r.daily?.code),
    minC: round1(r.daily?.minC),
    maxC: round1(r.daily?.maxC),
    precipProb: r.daily?.precipProb ?? null,
    fetchedAt: r.fetchedAt ?? null,
  }));

  // 逐日温差（相邻两天，同量对比）
  for (let i = 1; i < days.length; i++) {
    const cur = days[i];
    const prev = days[i - 1];
    if (Number.isFinite(cur.minC) && Number.isFinite(prev.minC)) {
      cur.minDelta = round1(cur.minC - prev.minC);
    }
    if (Number.isFinite(cur.maxC) && Number.isFinite(prev.maxC)) {
      cur.maxDelta = round1(cur.maxC - prev.maxC);
    }
    // 取绝对值大的那个作为"当天变化"
    const a = Math.abs(cur.minDelta ?? 0);
    const b = Math.abs(cur.maxDelta ?? 0);
    cur.swing = a >= b ? cur.minDelta : cur.maxDelta;
  }

  const first = days[0];
  const last = days[days.length - 1];
  const trend = (Number.isFinite(first.minC) && Number.isFinite(last.minC))
    ? round1(last.minC - first.minC)
    : null;

  return {
    city: rows[0].city ?? null,
    days,
    span: { from: first.date, to: last.date, count: days.length },
    trend,
    latest: last,
  };
}

/**
 * 渲染成给人/给 agent 看的极简文本。
 *
 * 【为什么这么短】
 *   维护者：「简化过的摘要」「agent 上下文干净些」。
 *   一行一天，不带 JSON，不带原始字段。
 */
export function renderSummary(s) {
  if (s === null) return '（没有数据）';
  const lines = [];
  lines.push(`${s.city}  近 ${s.span.count} 天（${s.span.from} ~ ${s.span.to}）`);
  for (const d of s.days) {
    const range = Number.isFinite(d.minC) && Number.isFinite(d.maxC)
      ? `${d.minC}~${d.maxC}℃`
      : '—';
    const md = String(d.date).slice(5); // MM-DD
    const swing = d.swing !== undefined && d.swing !== null
      ? `  ${d.swing > 0 ? '↑' : '↓'}${Math.abs(d.swing)}`
      : '';
    const rain = d.precipProb !== null && d.precipProb >= 30 ? `  降水${d.precipProb}%` : '';
    lines.push(`  ${md}  ${d.weather.padEnd(6, '　')}  ${range}${swing}${rain}`);
  }
  if (s.trend !== null) {
    lines.push(`  整体：${s.trend > 0 ? '↑' : s.trend < 0 ? '↓' : '→'} ${Math.abs(s.trend)}℃（首日→末日最低温）`);
  }
  return lines.join('\n');
}

/**
 * 查询入口。
 *
 * @param opts.state    state 后端
 * @param opts.city     任意写法（中文/拼音/简写/代码）
 * @param opts.days     要几天，默认 10
 * @param opts.now      可注入（测试用）
 * @returns {{ ok, city, summary, text, error }}
 */
export function queryWeather({ state, city, days = 10, now = null }) {
  if (state === null || state === undefined) {
    return { ok: false, error: 'state 不可用（relay 未初始化）' };
  }
  const std = resolveCity(city);
  if (std === null) return { ok: false, error: '没给城市名' };

  const d = Math.max(1, Math.min(30, Number(days) || 10));
  const base = now instanceof Date ? now : new Date();
  const rows = (() => {
    const out = [];
    for (const date of lastNDates(d, base)) {
      const rec = state.get(`weather:day:${std}/${date}`, null);
      if (rec !== null) out.push(rec);
    }
    return out;
  })();

  if (rows.length === 0) {
    // 查不到时给个有用的提示：这个城市在不在采集列表里
    const configured = state.get('weather:locations', null);
    const names = Array.isArray(configured) ? configured.map((l) => l.name ?? l) : [];
    return {
      ok: false,
      city: std,
      error: names.includes(std)
        ? `${std} 还没有数据（采集器可能刚启动，还没刷新过）`
        : `${std} 不在采集列表里。当前列表：${names.length > 0 ? names.join('、') : '（空）'}`,
      configured: names,
    };
  }

  const summary = summarize(rows);
  return { ok: true, city: std, summary, text: renderSummary(summary), days: rows.length };
}

/** 列出所有有数据的城市。 */
export function listCitiesWithData(state, days = 10, now = null) {
  const base = now instanceof Date ? now : new Date();
  const map = new Map();
  for (const date of lastNDates(days, base)) {
    // key 是 `<城市>/<日期>`，这里换一种思路：从 locations 拿候选，再看有没有数据
    void date;
  }
  const configured = state?.get?.('weather:locations', null);
  const names = Array.isArray(configured) ? configured.map((l) => l.name ?? l) : [];
  for (const n of names) {
    const rows = (() => {
      const out = [];
      for (const date of lastNDates(days, base)) {
        const rec = state.get(`weather:day:${n}/${date}`, null);
        if (rec !== null) out.push(rec);
      }
      return out;
    })();
    if (rows.length > 0) map.set(n, rows.length);
  }
  return [...map.entries()].map(([city, count]) => ({ city, count }));
}

export default { queryWeather, summarize, renderSummary, readCityHistory, listCitiesWithData };
