// message.mjs — 消息的校验、去重、分级
//
// 标准：
//
// 这里只做判定，不做任何投递。纯函数，好测。

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/** 标准 v1 §2 的字段定义。 */
export const LEVELS = ['info', 'warn', 'critical'];
export const TITLE_MAX = 60;
const DEFAULT_COOLDOWN_SEC = 300;

/** 拒收原因。每条都能对应到标准的某一节。 */
export const REJECT = {
  BAD_JSON: 'bad-json',
  NOT_OBJECT: 'not-object',
  MISSING_PEER: 'missing-peer',
  MISSING_TOKEN: 'missing-token',
  MISSING_LEVEL: 'missing-level',
  MISSING_TITLE: 'missing-title',
  BAD_LEVEL: 'bad-level',
  PEER_UNKNOWN: 'peer-unknown',
  TOKEN_MISMATCH: 'token-mismatch',
  LEVEL_NOT_ALLOWED: 'level-not-allowed',
};

/** 读全部配对文件。 */
export function loadPeers(peersDir) {
  const map = new Map();
  if (!existsSync(peersDir)) return map;
  for (const f of readdirSync(peersDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const p = JSON.parse(readFileSync(join(peersDir, f), 'utf8'));
      if (typeof p?.id === 'string' && typeof p?.token === 'string') map.set(p.id, p);
    } catch {
      /* 坏的配对文件跳过，不影响其他 */
    }
  }
  return map;
}

/**
 * 校验一条消息。
 * @returns {{ ok: true, msg: object } | { ok: false, reason: string, detail?: string }}
 */
export function validate(raw, peers) {
  let m;
  try {
    m = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, reason: REJECT.BAD_JSON };
  }
  if (m === null || typeof m !== 'object' || Array.isArray(m)) {
    return { ok: false, reason: REJECT.NOT_OBJECT };
  }

  if (typeof m.peer !== 'string' || m.peer === '') return { ok: false, reason: REJECT.MISSING_PEER };
  if (typeof m.token !== 'string' || m.token === '') return { ok: false, reason: REJECT.MISSING_TOKEN };
  if (typeof m.level !== 'string' || m.level === '') return { ok: false, reason: REJECT.MISSING_LEVEL };
  if (typeof m.title !== 'string' || m.title.trim() === '') return { ok: false, reason: REJECT.MISSING_TITLE };
  if (!LEVELS.includes(m.level)) return { ok: false, reason: REJECT.BAD_LEVEL, detail: m.level };

  const peer = peers.get(m.peer);
  if (peer === undefined) return { ok: false, reason: REJECT.PEER_UNKNOWN, detail: m.peer };
  if (peer.token !== m.token) return { ok: false, reason: REJECT.TOKEN_MISMATCH, detail: m.peer };

  const allowed = Array.isArray(peer.allowedLevels) && peer.allowedLevels.length > 0 ? peer.allowedLevels : LEVELS;
  if (!allowed.includes(m.level)) {
    return { ok: false, reason: REJECT.LEVEL_NOT_ALLOWED, detail: `${m.peer}:${m.level}` };
  }

  // 标题超长截断而不是拒收 —— 内容有效，只是太长
  const title = m.title.trim();
  const truncated = title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title;

  return {
    ok: true,
    msg: {
      peer: m.peer,
      level: m.level,
      title: truncated,
      body: typeof m.body === 'string' ? m.body : '',
      dedupeKey: typeof m.dedupeKey === 'string' && m.dedupeKey !== '' ? m.dedupeKey : null,
      cooldownSec: Number.isFinite(m.cooldownSec) && m.cooldownSec >= 0 ? m.cooldownSec : DEFAULT_COOLDOWN_SEC,
      at: typeof m.at === 'string' ? m.at : new Date().toISOString(),
    },
  };
}

/**
 * 去重器。
 * 同 dedupeKey 在 cooldownSec 内只放行一次。
 * 没有 dedupeKey 的永不拦截（那是调用方明确表示「每次都要说」）。
 */
export class Deduper {
  constructor() {
    this.seen = new Map(); // key → 上次放行时间
  }

  /**
   * @returns {boolean} true 表示应当投递，false 表示被去重拦下
   */
  admit(msg, now = Date.now()) {
    if (msg.dedupeKey === null) return true;
    const key = `${msg.peer}:${msg.dedupeKey}`;
    const last = this.seen.get(key);
    if (last !== undefined && now - last < msg.cooldownSec * 1000) return false;
    this.seen.set(key, now);
    return true;
  }

  /** 防内存无限增长：超量时清掉过期项。 */
  prune(now = Date.now()) {
    for (const [k, t] of this.seen) {
      // 保守：超过 1 小时的记录一律清掉
      if (now - t > 3600_000) this.seen.delete(k);
    }
  }
}

/** 消息的稳定指纹，用于避免重复注入同一条。 */
export function fingerprint(msg) {
  return createHash('sha1')
    .update(`${msg.peer}|${msg.at}|${msg.title}|${msg.body}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * 是否该打扰用户。
 * 标准 §3：info 不注入；warn 静默时段内推迟；critical 无视静默时段。
 */
export function shouldInject(msg, { quietHours, now = new Date() } = {}) {
  if (msg.level === 'info') return false;
  if (msg.level === 'critical') return true;
  if (!quietHours || !quietHours.enabled) return true;

  const hour = now.getHours();
  const { start, end } = quietHours;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return true;

  // 静默时段可跨午夜，如 23 → 7
  const inQuiet = start <= end ? hour >= start && hour < end : hour >= start || hour < end;
  return !inQuiet;
}

/**
 * 事件骨架：把"会变的部分"抹掉，留下"这是什么事"。
 *
 * 【为什么需要它】
 *   A 精确匹配（title 完全一样）永远合并不了 —— 告警标题里带数字和时间：
 *     "内存占用 93.2% 超过阈值 85%"
 *     "内存占用 93.5% 超过阈值 85%"
 *   说的是同一件事，字面却不同。用户原话：
 *   「有的时候通知带时间戳，时间不同那他就不合并，肯定不行。」
 *
 * 【顺序】
 *   1. 有 dedupeKey → 直接用（来源最清楚什么是同一件事）
 *   2. 否则 → 抹掉日期/时间/数字，折叠空白，截尾兜底
 *
 * @returns 分组键。同键视为同类事件。
 */
export function eventSkeleton(msg) {
  const peer = String(msg?.peer ?? '');
  const level = String(msg?.level ?? '');
  if (typeof msg?.dedupeKey === 'string' && msg.dedupeKey !== '') {
    return `${peer}|${level}|k:${msg.dedupeKey}`;
  }

  let t = String(msg?.title ?? '');
  t = t.replace(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/g, '#');   // 日期
  t = t.replace(/\d{1,2}:\d{2}(:\d{2})?/g, '#');        // 时间
  t = t.replace(/\d+(\.\d+)?/g, '#');                    // 其余数字
  t = t.replace(/[TZ]/g, '');                            // ISO 残留
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length > 30) t = t.slice(0, 30);

  return `${peer}|${level}|${t}`;
}

/**
 * 按骨架分组。
 * 每组保留**最新一条**，其余只计数 —— 内容不丢（原文在 received.jsonl 里），
 * 只是不再逐条打扰。
 *
 * @returns { groups: [{ skeleton, keep, count }], total, deduped }
 */
export function groupBySkeleton(items) {
  const valid = items.filter((it) => it !== null && it !== undefined && it.msg !== undefined);
  const map = new Map();
  for (const it of valid) {
    const key = eventSkeleton(it.msg);
    const cur = map.get(key);
    if (cur === undefined) {
      map.set(key, { skeleton: key, keep: it, count: 1 });
    } else {
      cur.keep = it;   // 保留最新
      cur.count += 1;
    }
  }
  const groups = [...map.values()];
  return { groups, total: valid.length, deduped: valid.length - groups.length };
}

/**
 * 注入时给模型看的文本。
 *
 * @param msg 已校验的消息
 * @param titleChars 标题截断长度。null/undefined/非正数 表示不截断。
 *
 * 【为什么截在这里】以前 titleChars 只是配置里的一个数字，
 * 渲染路径根本不读它 —— 摘要逻辑写了但完全没生效。
 * 现在所有渲染入口都把这个参数传进来。
 * 用户原话：「每条前面选 20 个字，一般能说清楚了」。
 */
export function render(msg, titleChars = null) {
  const n = Number(titleChars);
  const raw = String(msg.title ?? '');
  const title = Number.isFinite(n) && n > 0 && raw.length > n
    ? `${raw.slice(0, n - 1)}…`
    : raw;
  const head = `[${msg.level.toUpperCase()}] ${msg.peer} · ${title}`;
  return msg.body ? `${head}\n${msg.body}` : head;
}

/**
 * 渲染一个批次：多条事件合成一段，末尾附合并统计。
 *
 * @param groups groupBySkeleton 的 groups
 * @param deduped 被合并掉的条数
 * @param titleChars 每条标题截断长度
 *
 * 用户要求：「你应该能看到去重几次」——
 * 不显示这个数字，就分不清"没消息"和"消息被压死了"。
 */
export function renderBatch(groups, deduped, titleChars = 20) {
  if (groups.length === 0) return '';
  const level = String(groups[0].keep.msg.level ?? 'warn').toUpperCase();
  const peer = String(groups[0].keep.msg.peer ?? '');
  const n = Number(titleChars) > 0 ? Number(titleChars) : 20;

  const lines = groups.map((g) => {
    const raw = String(g.keep.msg.title ?? '');
    const t = raw.length > n ? `${raw.slice(0, n - 1)}…` : raw;
    return `· ${t}`;
  });

  const head = `[${level}] ${peer} · ${groups.length} 类告警`;
  const tail = deduped > 0 ? `\n（另有 ${deduped} 条同类已合并）` : '';
  return `${head}\n${lines.join('\n')}${tail}`;
}
