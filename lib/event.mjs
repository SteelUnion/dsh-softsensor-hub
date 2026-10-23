// event.mjs — 事件模型：壳 + 瓤
//
// 标准：
//
// 【为什么单独一个文件】
//   message.mjs 是"消息"（外层来的告警），本文件是"事件"（任何源产出的东西）。
//   两者不是替代关系：消息会升级成事件，事件不一定是消息。
//   分开写，老的照常跑，新的慢慢接。
//
// 【核心一刀】
//   壳：source / kind / level / summary / dedupeKey / displayed
//       —— 内核只读这些，用来决定"要不要叫醒你"
//   瓤：payload
//       —— 内核永不解析，原样存、原样给窗口
//
//   这一刀切下去，3000 字邮件正文永远进不了通知。

import { createHash } from 'node:crypto';

// ─────────────────────────── 常量 ───────────────────────────

export const LEVELS = ['info', 'warn', 'critical'];

/** 摘要上限。维护者 原话：「每条前面选 20 个字，一般能说清楚了」。 */
export const SUMMARY_MAX = 80;

/** payload 上限。超了拒收而不是截断 —— 截断的 payload 是坏数据。 */
export const PAYLOAD_MAX_BYTES = 64 * 1024;

/** 老消息升级后的源名。归到「其他」分类。 */
export const LEGACY_SOURCE = 'legacy';

/** 源 / 类型名：小写字母开头，允许数字和连字符。 */
const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** 拒收原因。每条对应协议的一节。 */
export const REJECT = {
  NOT_OBJECT: 'not-object',
  BAD_SOURCE: 'bad-source',
  BAD_KIND: 'bad-kind',
  BAD_LEVEL: 'bad-level',
  MISSING_SUMMARY: 'missing-summary',
  PAYLOAD_TOO_LARGE: 'payload-too-large',
};

// ─────────────────────────── 内部工具 ───────────────────────────

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 补时区。协议要求 `at` 必须带时区，缺了按本地 +08:00 处理。 */
function normalizeAt(v) {
  if (typeof v !== 'string' || v.trim() === '') return new Date().toISOString();
  const s = v.trim();
  // 已经带 Z 或 ±HH:MM 就不动
  if (/[Zz]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) {
    const t = new Date(s);
    return Number.isNaN(t.getTime()) ? new Date().toISOString() : t.toISOString();
  }
  // 裸时间（`2026-10-21T12:00:00`）按 +08:00 解释
  const t = new Date(`${s}+08:00`);
  return Number.isNaN(t.getTime()) ? new Date().toISOString() : t.toISOString();
}

/** 摘要截断：超长加省略号，不报错。 */
export function clipSummary(text, max = SUMMARY_MAX) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * 生成事件 id。
 * 带源前缀，便于人眼分辨"这条是谁产出的"。
 */
export function newEventId(source = 'evt') {
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = createHash('sha1')
    .update(`${process.pid}|${d.getTime()}|${Math.random()}`)
    .digest('hex')
    .slice(0, 8);
  return `evt-${source}-${date}-${rand}`;
}

/** payload 字节数（UTF-8）。 */
export function payloadBytes(payload) {
  try {
    return Buffer.byteLength(JSON.stringify(payload ?? {}), 'utf8');
  } catch {
    // 循环引用之类 —— 当作无限大，走拒收
    return Number.POSITIVE_INFINITY;
  }
}

// ─────────────────────────── 校验 ───────────────────────────

/**
 * 校验并规范化一条事件。
 *
 * 【设计取舍】
 *   - source / kind / level / summary：错就拒收，不猜
 *   - at：缺了补当前时间，比拒收好（时间不重要到要丢一条事件）
 *   - dedupeKey：空串当 null，不当错
 *   - displayed：框架自己管，源给了也覆盖
 *
 * @returns {{ ok: true, event: object } | { ok: false, reason: string, detail?: string }}
 */
export function validateEvent(raw, { now = new Date() } = {}) {
  if (!isPlainObject(raw)) return { ok: false, reason: REJECT.NOT_OBJECT };

  if (typeof raw.source !== 'string' || !NAME_RE.test(raw.source)) {
    return { ok: false, reason: REJECT.BAD_SOURCE, detail: String(raw.source ?? '') };
  }
  if (typeof raw.kind !== 'string' || !NAME_RE.test(raw.kind)) {
    return { ok: false, reason: REJECT.BAD_KIND, detail: String(raw.kind ?? '') };
  }
  if (!LEVELS.includes(raw.level)) {
    return { ok: false, reason: REJECT.BAD_LEVEL, detail: String(raw.level ?? '') };
  }
  if (typeof raw.summary !== 'string' || raw.summary.trim() === '') {
    return { ok: false, reason: REJECT.MISSING_SUMMARY };
  }

  const payload = isPlainObject(raw.payload) ? raw.payload : {};
  const bytes = payloadBytes(payload);
  if (bytes > PAYLOAD_MAX_BYTES) {
    return { ok: false, reason: REJECT.PAYLOAD_TOO_LARGE, detail: `${bytes}>${PAYLOAD_MAX_BYTES}` };
  }

  const dedupeKey =
    typeof raw.dedupeKey === 'string' && raw.dedupeKey.trim() !== '' ? raw.dedupeKey.trim() : null;

  return {
    ok: true,
    event: {
      id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : newEventId(raw.source),
      source: raw.source,
      kind: raw.kind,
      level: raw.level,
      at: normalizeAt(raw.at),
      dedupeKey,
      summary: clipSummary(raw.summary),
      payload,
      meta: isPlainObject(raw.meta) ? raw.meta : {},
      // displayed 归框架管，源给的不可信
      displayed: { wake: null, window: null },
    },
  };
}

// ─────────────────────────── 老消息升级 ───────────────────────────

/**
 * 把老格式消息升级成事件。
 *
 * 【为什么必须有这只函数】
 *   现有 74 项测试全跑在老格式上（peer / title / body）。
 *   直接换模型 = 全炸。所以老的走这只函数升级，行为不变。
 *
 * 【映射】
 *   peer    → source（同时保留在原位，老代码还在读它）
 *   title   → summary
 *   body    → payload.body
 *   level   → level（不变）
 *
 * @param msg 老消息，来自 message.mjs 的 validate()
 * @returns 事件形状
 */
export function upgradeLegacyMessage(msg) {
  const peer = typeof msg?.peer === 'string' && msg.peer !== '' ? msg.peer : LEGACY_SOURCE;
  // peer 名可能是大写或带点（如 `monitor`），规范化成合法 source
  const source = /^[a-z][a-z0-9-]{0,31}$/.test(peer)
    ? peer
    : peer.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || LEGACY_SOURCE;

  const body = typeof msg?.body === 'string' && msg.body !== '' ? msg.body : null;

  return {
    id: typeof msg?.id === 'string' && msg.id !== '' ? msg.id : newEventId(source),
    source,
    kind: 'message',
    level: LEVELS.includes(msg?.level) ? msg.level : 'info',
    at: normalizeAt(msg?.at),
    dedupeKey:
      typeof msg?.dedupeKey === 'string' && msg.dedupeKey !== '' ? msg.dedupeKey : null,
    summary: clipSummary(msg?.title ?? body ?? '(无标题)'),
    payload: body === null ? {} : { body },
    meta: { legacy: true, peer },
    displayed: { wake: null, window: null },
    // 老代码还要读这两个，一并带过去
    peer,
    title: msg?.title,
    body: msg?.body ?? '',
  };
}

/** 判断一条事件是不是从老消息升级来的。 */
export function isLegacyEvent(evt) {
  return evt?.meta?.legacy === true;
}

// ─────────────────────────── 展示记录 ───────────────────────────

/**
 * 该不该在这个通道展示？
 *
 * 抄 WorkBuddy 的 pending-displays / notify-shown：
 *   弹过一次就不再弹。
 *   不加这个，重连一次就重复叫醒。
 *
 * @param evt 事件
 * @param channel 'wake' | 'window'
 */
export function shouldDisplay(evt, channel) {
  if (!evt?.displayed) return true;
  return evt.displayed[channel] == null;
}

/**
 * 标记已展示。返回新对象，不改原对象
 * （storageDomain 的「记录是不可变数据，别原地改」）。
 */
export function markDisplayed(evt, channel, at = new Date().toISOString()) {
  if (channel !== 'wake' && channel !== 'window') return evt;
  return {
    ...evt,
    displayed: { ...(evt.displayed ?? { wake: null, window: null }), [channel]: at },
  };
}

// ─────────────────────────── 归组与渲染 ───────────────────────────

/**
 * 事件骨架：把"会变的部分"抹掉，留下"这是什么事"。
 *
 * 和 message.mjs 的 eventSkeleton 同一个思路，但作用在事件上。
 * 有 dedupeKey 用它；没有就抹数字。
 */
export function eventSkeleton(evt) {
  const source = String(evt?.source ?? '');
  const level = String(evt?.level ?? '');
  if (typeof evt?.dedupeKey === 'string' && evt.dedupeKey !== '') {
    return `${source}|${level}|k:${evt.dedupeKey}`;
  }
  let t = String(evt?.summary ?? '');
  t = t.replace(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/g, '#');
  t = t.replace(/\d{1,2}:\d{2}(:\d{2})?/g, '#');
  t = t.replace(/\d+(\.\d+)?/g, '#');
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length > 30) t = t.slice(0, 30);
  return `${source}|${level}|${t}`;
}

/** 按骨架分组，每组保留最新一条，其余只计数。 */
export function groupEvents(items) {
  const valid = items.filter((it) => it !== null && it !== undefined && it.event !== undefined);
  const map = new Map();
  for (const it of valid) {
    const key = eventSkeleton(it.event);
    const cur = map.get(key);
    if (cur === undefined) {
      map.set(key, { skeleton: key, keep: it, count: 1 });
    } else {
      cur.keep = it;
      cur.count += 1;
    }
  }
  const groups = [...map.values()];
  return { groups, total: valid.length, deduped: valid.length - groups.length };
}

/** 渲染一条事件给模型看。 */
export function renderEvent(evt, titleChars = null) {
  const n = Number(titleChars);
  const raw = String(evt.summary ?? '');
  const summary =
    Number.isFinite(n) && n > 0 && raw.length > n ? `${raw.slice(0, n - 1)}…` : raw;
  const head = `[${String(evt.level ?? 'info').toUpperCase()}] ${evt.source} · ${summary}`;
  const body = typeof evt.payload?.body === 'string' ? evt.payload.body : '';
  return body ? `${head}\n${body}` : head;
}

// ─────────────────────────── 分类计数 ───────────────────────────

/**
 * 按 source 计数 —— 小窗口角标用。
 *
 * 抄 WorkBuddy 的 summary 接口：只给数字，不拉详情。
 *
 * @param events 事件数组
 * @param labels 配置里的分类表 { mail: { zh: '邮件', order: 1 } }
 * @returns { total, sources: [{ source, label, count }] }
 */
export function summarizeBySource(events, labels = {}) {
  const counts = new Map();
  for (const e of events) {
    const s = String(e?.source ?? 'other');
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const fallback = labels._fallback?.zh ?? '其他';
  const rows = [...counts.entries()].map(([source, count]) => {
    const spec = labels[source];
    return {
      source,
      label: typeof spec?.zh === 'string' ? spec.zh : typeof spec === 'string' ? spec : fallback,
      order: Number.isFinite(spec?.order) ? spec.order : 999,
      show: spec?.show !== false,
      count,
    };
  });
  rows.sort((a, b) => a.order - b.order || a.source.localeCompare(b.source));
  return { total: events.length, sources: rows.filter((r) => r.show) };
}
