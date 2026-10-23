// collectors/finance.mjs — 金融采集器（读本地量化库）
//
// 图纸：
// 查证：
// 契约：lib/collector.mjs（CONTRACT_VERSION = 1）
//
// 【为什么不用 NeoData】
//   那套接口要 WorkBuddy 的登录态，token 12 小时过期。为了每天一条收盘价
//   去抠别人的私有凭据，既不稳也不干净。维护者 自己有量化底座：
//     data\quant.db   746 万条日线
//   一条 SQL 就能拿到「昨日 / 30 日 / 90 日 / 1 年」四档对比。
//
// 【硬边界】
//   ① 只读打开（readOnly: true）。
//   ② 不 spawn / exec。用 Node 24 内置的 node:sqlite，不引第三方包。
//   ③ 库里没有的数字不编。查不到就跳过这只票，绝不拿训练数据凑数
//      （WorkBuddy 自己的 skill 里也写着：禁止用训练数据回答）。
//
// 【新鲜度闸门】
//   库停在 2026-06-12（写这段时已差 4 个月）。旧数据当今天的行情发出去
//   比不发更糟 —— 会让人按四个月前的价格做判断。
//   所以：库太旧 → 一条 quote 都不产，只发一条 warn 说清楚「库旧了」。
//
// 【为什么只拉 300 根 K 线】
//   1 年窗口按日历 365 天算，300 个交易日足够覆盖（一年约 242 个交易日）。
//   一次取完再在内存里算，比每只票发 5 条 SQL 快，也少一次出错的地方。

import { existsSync } from 'node:fs';

/** 默认值。都可由 config 的 sources.finance 覆盖。 */
export const DEFAULTS = {
  /** 量化库路径。只读打开。 */
  /** 量化库路径。null = 未配置（首次安装即如此），此时采集器静默不动。 */
  dbPath: null,
  /** 关注列表：[ '600362' ] 或 [ { code: '600362', name: '江西铜业' } ] */
  codes: [],
  /** 每天几点之后才产数据（本地时间 HH:MM） */
  at: '09:00',
  /** 定时器间隔。真正的"一天一次"靠 at + 当天去过重，不靠这个间隔。 */
  intervalSec: 1800,
  /** 库里的最新交易日距今超过这么多天 → 判为陈旧，不产行情 */
  maxAgeDays: 7,
  /** 单只票取多少根 K 线 */
  barsPerCode: 300,
  /** 事件级别。金融是信息，不叫醒人。 */
  level: 'info',
  /** 连续几次读不到库才报（防抖，同 C3） */
  failThreshold: 3,
};

const DAY_MS = 86_400_000;

// ─────────────────────────── 小工具 ───────────────────────────

function round2(v) {
  return Math.round(v * 100) / 100;
}

/** 本地日期 YYYY-MM-DD。（不用 toISOString：那是 UTC，晚上 8 点后会差一天） */
export function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 两个 YYYY-MM-DD 之间差多少天（b - a）。 */
export function daysBetween(a, b) {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.round((tb - ta) / DAY_MS);
}

/** YYYY-MM-DD 往前推 n 个日历日。 */
export function shiftDate(dateStr, days) {
  const t = Date.parse(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return new Date(t + days * DAY_MS).toISOString().slice(0, 10);
}

/** 把配置里的关注列表归一成 [{code, name}]。 */
export function parseCodes(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const item of input) {
    if (typeof item === 'string') {
      const code = item.trim();
      if (/^\d{6}$/.test(code)) out.push({ code, name: '' });
      continue;
    }
    if (item !== null && typeof item === 'object') {
      const code = String(item.code ?? '').trim();
      if (!/^\d{6}$/.test(code)) continue;
      out.push({ code, name: String(item.name ?? '').trim() });
    }
  }
  // 同代码出现两次只留一条
  const seen = new Set();
  return out.filter((c) => (seen.has(c.code) ? false : (seen.add(c.code), true)));
}

/** 现在是不是已经过了配置的 at（本地时间）。 */
export function afterAt(now, at) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at ?? '').trim());
  if (m === null) return true; // 配置写坏了就别拦着，让采集照跑
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh > 23 || mm > 59) return true;
  return now.getHours() * 60 + now.getMinutes() >= hh * 60 + mm;
}

// ─────────────────────────── 数据库 ───────────────────────────

/**
 * 只读打开量化库。
 *
 * 【为什么用动态 import】
 *   node:sqlite 是 Node 22.13+/24 才稳定可用的。如果哪天换到不支持的运行时，
 *   顶层 import 会让整个插件加载失败（连带邮件、系统监控一起死）。
 *   动态 import + 兜底，最坏也只是金融这一个源报错。
 */
export async function openDb(dbPath) {
  if (!existsSync(dbPath)) {
    throw new Error(`量化库不存在：${dbPath}`);
  }
  let sqlite;
  try {
    sqlite = await import('node:sqlite');
  } catch (e) {
    throw new Error(`当前运行时没有 node:sqlite（${e?.message ?? e}）`);
  }
  return new sqlite.DatabaseSync(dbPath, { readOnly: true });
}

/** 库里最新一个交易日。没有数据返回 null。 */
export function latestDbDate(db) {
  const row = db.prepare('SELECT MAX(date) AS d FROM daily_bars').get();
  const d = row?.d ?? null;
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

/** 股票名。查不到返回空串（不编名字）。 */
export function stockName(db, code) {
  try {
    const row = db.prepare('SELECT name FROM stocks WHERE code = ?').get(code);
    return typeof row?.name === 'string' ? row.name : '';
  } catch {
    return '';
  }
}

/** 取最近 N 根日线，按日期倒序。 */
export function recentBars(db, code, limit = DEFAULTS.barsPerCode) {
  const rows = db.prepare(
    'SELECT date, close, pct_chg FROM daily_bars WHERE code = ? ORDER BY date DESC LIMIT ?',
  ).all(code, limit);
  return rows
    .filter((r) => typeof r?.date === 'string' && Number.isFinite(r?.close))
    .map((r) => ({ date: r.date, close: Number(r.close), pctChg: Number.isFinite(r.pct_chg) ? Number(r.pct_chg) : null }));
}

/**
 * 在倒序的 K 线里找「不晚于 target 的最近一根」。
 *
 * 【为什么要"不晚于"】
 *   target 是算出来的日历日，经常落在周末/节假日，那天没有 K 线。
 *   取"最近一根不晚于它"的，就是那一天真实的收盘价；
 *   取"最近一根"（不管早晚）会把周五的价当成周日的价，指数会漂。
 */
export function barOnOrBefore(bars, target) {
  for (const b of bars) {
    if (b.date <= target) return b;
  }
  return null;
}

/**
 * 四档对比：昨日 / 30 日 / 90 日 / 1 年。
 * 基准是**最新一根**（不是今天 —— 库里可能停更，今天没有 K 线）。
 */
export function computeChange(bars) {
  const empty = { d1: null, d30: null, d90: null, d1y: null };
  if (!Array.isArray(bars) || bars.length === 0) return { base: null, change: empty };

  const latest = bars[0];
  const basePrice = latest.close;
  const windows = { d1: 1, d30: 30, d90: 90, d1y: 365 };
  const change = { ...empty };

  for (const [key, days] of Object.entries(windows)) {
    const target = shiftDate(latest.date, -days);
    if (target === null) continue;
    const bar = barOnOrBefore(bars, target);
    if (bar === null || bar.date === latest.date) continue;
    if (!Number.isFinite(bar.close) || bar.close <= 0) continue;
    change[key] = {
      pct: round2(((basePrice / bar.close) - 1) * 100),
      price: round2(bar.close),
      date: bar.date,
    };
  }

  return { base: latest, change };
}

// ─────────────────────────── 事件构造 ───────────────────────────

/** 一行摘要：`600362 江西铜业 24.30 +4.21%` */
export function formatSummary(code, name, price, d1Pct) {
  const label = name === '' ? code : `${code} ${name}`;
  const move = Number.isFinite(d1Pct) ? ` ${d1Pct >= 0 ? '+' : ''}${d1Pct.toFixed(2)}%` : '';
  return `${label} ${Number(price).toFixed(2)}${move}`;
}

/** 陈旧数据的那条 warn。一天只发一条（dedupeKey 带日期）。 */
export function buildStaleEvent({ dbDate, today, ageDays, maxAgeDays }) {
  return {
    source: 'finance',
    kind: 'stale-data',
    level: 'warn',
    dedupeKey: `finance:stale:${today}`,
    summary: `量化库停在 ${dbDate}（${ageDays} 天未更新，阈值 ${maxAgeDays} 天），今日不出行情`,
    payload: {
      dbDate,
      today,
      ageDays,
      maxAgeDays,
      hint: '更新量化库后会自动恢复（库的更新方式取决于你配置的 dbPath 来源）',
    },
  };
}

/** 一只票一条日线事件。 */
export function buildQuoteEvent({ code, name, bars, level }) {
  const { base, change } = computeChange(bars);
  if (base === null) return null;
  const d1Pct = change.d1?.pct ?? null;
  return {
    source: 'finance',
    kind: 'daily-quote',
    level,
    // 一天一条，天然去重（学邮件的 UID 做主键）
    dedupeKey: `finance:${code}:${base.date}`,
    summary: formatSummary(code, name, base.close, d1Pct),
    payload: {
      code,
      name,
      price: round2(base.close),
      baseDate: base.date,
      change,
    },
  };
}

// ─────────────────────────── 采集器本体 ───────────────────────────

/**
 * 造一个金融采集器。
 *
 * @param cfg config.json 的 sources.finance
 */
export function createFinanceCollector(cfg = {}) {
  const conf = { ...DEFAULTS, ...cfg };
  const watch = parseCodes(conf.codes);
  let db = null;
  let started = false;
  // 当天是否已经产过（同一天不重复发；重启用 dedupeKey 兜）
  let lastProducedDate = null;
  let failStreak = 0;

  async function ensureDb() {
    if (db !== null) return db;
    // 【2026-10-23】未配置库路径 → 不猜、不碰。发布包里不该有作者的私有路径。
    if (typeof conf.dbPath !== 'string' || conf.dbPath.trim() === '') {
      throw new Error('未配置量化库路径（sources.finance.dbPath）');
    }
    db = await openDb(conf.dbPath);
    return db;
  }

  return {
    name: 'finance',
    version: '1.0.0',
    contract: 1,
    trigger: { kind: 'interval', everySec: conf.intervalSec },

    async setup(env) {
      if (started) return;
      started = true;
      env?.log?.('info', 'finance collector started', {
        codes: watch.length, at: conf.at, dbPath: conf.dbPath,
      });
    },

    async run(env) {
      const now = env?.now?.() ?? new Date();
      const today = localDate(now);
      const events = [];

      // ⓪ 库路径没配 —— 首次安装的正常状态，静默跳过。
      //    【为什么放在最前】（2026-10-23）
      //      发布包里不带作者的私有路径，用户没配之前这里就是 null。
      //      如果按"读库失败"处理，会连续 3 次报一条 warn，用户刚装就被骂一顿。
      //      这里直接 return，recordRun 记 no-dbpath 备查，不产任何事件。
      if (typeof conf.dbPath !== 'string' || conf.dbPath.trim() === '') {
        env?.recordRun?.({ at: now.toISOString(), kind: 'finance', codes: 0, events: 0, note: 'no-dbpath' });
        return [];
      }

      // ① 没有关注列表就什么也不做（别拿空列表去碰库）
      if (watch.length === 0) {
        env?.recordRun?.({ at: now.toISOString(), kind: 'finance', codes: 0, events: 0, note: 'no-watchlist' });
        return [];
      }

      // ② 每天到点之后才跑。靠"今天发过没有"去重，不用定时器精确到分。
      const stateDate = env?.state?.get?.('lastProducedDate');
      const producedToday = (typeof stateDate === 'string' ? stateDate : lastProducedDate) === today;
      if (producedToday || !afterAt(now, conf.at)) {
        return [];
      }

      // ③ 读库。读不到就按 C3 连续 3 次才报
      let d = null;
      try {
        d = await ensureDb();
      } catch (e) {
        db = null;
        failStreak += 1;
        env?.recordRun?.({ at: now.toISOString(), kind: 'finance', error: String(e?.message ?? e), events: 0 });
        if (failStreak >= conf.failThreshold) {
          failStreak = 0;
          return [{
            source: 'finance',
            kind: 'collector-error',
            level: 'warn',
            dedupeKey: `finance:error:${today}`,
            summary: `金融采集器连续读不到量化库：${String(e?.message ?? e).slice(0, 40)}`,
            payload: { dbPath: conf.dbPath, error: String(e?.message ?? e), at: now.toISOString() },
          }];
        }
        return [];
      }

      // ④ 新鲜度闸门：库太旧就一条行情都不产
      let dbDate = null;
      try {
        dbDate = latestDbDate(d);
      } catch (e) {
        env?.recordRun?.({ at: now.toISOString(), kind: 'finance', error: String(e?.message ?? e), events: 0 });
        return [];
      }
      if (dbDate === null) {
        env?.recordRun?.({ at: now.toISOString(), kind: 'finance', note: 'empty-db', events: 0 });
        return [];
      }
      const ageDays = daysBetween(dbDate, today);
      if (ageDays !== null && ageDays > conf.maxAgeDays) {
        lastProducedDate = today;
        env?.state?.set?.('lastProducedDate', today);
        env?.recordRun?.({ at: now.toISOString(), kind: 'finance', dbDate, ageDays, stale: true, events: 1 });
        return [buildStaleEvent({ dbDate, today, ageDays, maxAgeDays: conf.maxAgeDays })];
      }

      // ⑤ 逐只票产事件。单只查不到就跳过 —— 不编
      let produced = 0;
      for (const item of watch) {
        try {
          const bars = recentBars(d, item.code, conf.barsPerCode);
          if (bars.length === 0) continue;
          const name = item.name !== '' ? item.name : stockName(d, item.code);
          const evt = buildQuoteEvent({ code: item.code, name, bars, level: conf.level });
          if (evt !== null) {
            events.push(evt);
            produced += 1;
          }
        } catch (e) {
          env?.log?.('warn', 'finance quote failed', { code: item.code, error: String(e?.message ?? e) });
        }
      }

      failStreak = 0;
      lastProducedDate = today;
      env?.state?.set?.('lastProducedDate', today);
      env?.recordRun?.({
        at: now.toISOString(), kind: 'finance', dbDate, ageDays,
        codes: watch.length, produced, events: events.length,
      });
      return events;
    },

    async teardown() {
      try { db?.close?.(); } catch { /* ignore */ }
      db = null;
      started = false;
    },
  };
}

export default createFinanceCollector();
