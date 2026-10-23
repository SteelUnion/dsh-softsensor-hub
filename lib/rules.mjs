// rules.mjs — 叫醒规则引擎
//
// 标准：
// Schema：schema/rules.schema.json
//
// 【为什么要单独一个引擎】
//   "哪些事件叫醒我、哪些只进窗口"是策略，不是代码。
//   策略写进代码 = 想改就得改代码 = 不敢改 = 锁死。
//   写进清单文件 = 改一行 json = 立刻生效。
//
// 【最关键的一条：坏配置不能停摆】
//   新规则解析失败 → 保留旧规则继续跑，发一条 config-error。
//   绝不因为改动配置把整个通知功能搞死。

import { readFileSync, existsSync, watchFile, unwatchFile } from 'node:fs';

const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
const SOURCE_RE = /^[a-z][a-z0-9-]{0,31}$/;
const LEVELS = ['info', 'warn', 'critical'];
const CHANNELS = ['window', 'wake', 'batch', 'archive'];

/** 配置错误码。 */
export const CONFIG_REJECT = {
  NOT_OBJECT: 'not-object',
  NO_RULES: 'no-rules',
  BAD_RULE_ID: 'bad-rule-id',
  DUP_RULE_ID: 'duplicate-rule-id',
  BAD_MATCH: 'bad-match',
  BAD_MATCH_SOURCE: 'bad-match-source',
  BAD_MATCH_KIND: 'bad-match-kind',
  BAD_MATCH_LEVEL: 'bad-match-level',
  BAD_REGEX: 'bad-regex',
  BAD_CHANNELS: 'bad-channels',
  BAD_RULE: 'bad-rule',
};

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function asList(v) {
  if (v === undefined || v === null) return null;
  return Array.isArray(v) ? v : [v];
}

/**
 * 校验整份规则清单。
 *
 * @returns {{ ok: true, spec: object } | { ok: false, reason: string, detail?: string }}
 */
export function validateRules(raw) {
  if (!isObject(raw)) return { ok: false, reason: CONFIG_REJECT.NOT_OBJECT };
  if (!Array.isArray(raw.rules)) return { ok: false, reason: CONFIG_REJECT.NO_RULES };

  // defaults
  let defaultChannels = ['window'];
  if (raw.defaults !== undefined) {
    if (!isObject(raw.defaults)) return { ok: false, reason: CONFIG_REJECT.BAD_RULE, detail: 'defaults' };
    const dch = raw.defaults.channels;
    if (dch !== undefined) {
      if (!Array.isArray(dch) || dch.some((c) => !CHANNELS.includes(c))) {
        return { ok: false, reason: CONFIG_REJECT.BAD_CHANNELS, detail: 'defaults.channels' };
      }
      defaultChannels = [...dch];
    }
  }

  const seen = new Set();
  const rules = [];

  for (let i = 0; i < raw.rules.length; i++) {
    const r = raw.rules[i];
    if (!isObject(r)) return { ok: false, reason: CONFIG_REJECT.BAD_RULE, detail: `rules[${i}]` };

    if (typeof r.id !== 'string' || !NAME_RE.test(r.id)) {
      return { ok: false, reason: CONFIG_REJECT.BAD_RULE_ID, detail: `rules[${i}].id=${String(r.id)}` };
    }
    if (seen.has(r.id)) {
      return { ok: false, reason: CONFIG_REJECT.DUP_RULE_ID, detail: r.id };
    }
    seen.add(r.id);

    if (!isObject(r.match)) {
      return { ok: false, reason: CONFIG_REJECT.BAD_MATCH, detail: r.id };
    }

    const match = {};
    const srcs = asList(r.match.source);
    if (srcs !== null) {
      if (srcs.length === 0 || srcs.some((s) => typeof s !== 'string' || !SOURCE_RE.test(s))) {
        return { ok: false, reason: CONFIG_REJECT.BAD_MATCH_SOURCE, detail: r.id };
      }
      match.source = [...srcs];
    }
    const kinds = asList(r.match.kind);
    if (kinds !== null) {
      if (kinds.length === 0 || kinds.some((s) => typeof s !== 'string' || !SOURCE_RE.test(s))) {
        return { ok: false, reason: CONFIG_REJECT.BAD_MATCH_KIND, detail: r.id };
      }
      match.kind = [...kinds];
    }
    const levels = asList(r.match.level);
    if (levels !== null) {
      if (levels.length === 0 || levels.some((l) => !LEVELS.includes(l))) {
        return { ok: false, reason: CONFIG_REJECT.BAD_MATCH_LEVEL, detail: r.id };
      }
      match.level = [...levels];
    }
    if (r.match.summaryContains !== undefined) {
      if (typeof r.match.summaryContains !== 'string') {
        return { ok: false, reason: CONFIG_REJECT.BAD_MATCH, detail: `${r.id}.summaryContains` };
      }
      match.summaryContains = r.match.summaryContains;
    }
    if (r.match.summaryMatches !== undefined) {
      if (typeof r.match.summaryMatches !== 'string') {
        return { ok: false, reason: CONFIG_REJECT.BAD_MATCH, detail: `${r.id}.summaryMatches` };
      }
      let re;
      try {
        re = new RegExp(r.match.summaryMatches);
      } catch (e) {
        return { ok: false, reason: CONFIG_REJECT.BAD_REGEX, detail: `${r.id}: ${e.message}` };
      }
      match.summaryMatches = re;
    }

    if (!Array.isArray(r.channels) || r.channels.length === 0 || r.channels.some((c) => !CHANNELS.includes(c))) {
      return { ok: false, reason: CONFIG_REJECT.BAD_CHANNELS, detail: r.id };
    }

    rules.push({
      id: r.id,
      enabled: r.enabled !== false,
      match,
      channels: [...r.channels],
      wake: isObject(r.wake)
        ? {
            cooldownSec: Number.isFinite(r.wake.cooldownSec) ? r.wake.cooldownSec : 300,
            exemptGameMode: r.wake.exemptGameMode === true,
          }
        : { cooldownSec: 300, exemptGameMode: false },
      batch: isObject(r.batch)
        ? {
            maxItems: Number.isFinite(r.batch.maxItems) && r.batch.maxItems > 0 ? r.batch.maxItems : 5,
            maxWaitSec:
              Number.isFinite(r.batch.maxWaitSec) && r.batch.maxWaitSec > 0 ? r.batch.maxWaitSec : 300,
          }
        : { maxItems: 5, maxWaitSec: 300 },
      digest: isObject(r.digest) ? { ...r.digest } : null,
      quietHours:
        isObject(r.quietHours) &&
        Number.isInteger(r.quietHours.start) &&
        Number.isInteger(r.quietHours.end)
          ? { start: r.quietHours.start, end: r.quietHours.end }
          : null,
    });
  }

  return { ok: true, spec: { defaultChannels, rules } };
}

/**
 * 单个条件是否命中。
 * 期望值为 undefined → 该条件不限，命中。
 * 期望值为数组 → 按 OR。
 */
function hit(expected, actual) {
  if (expected === undefined) return true;
  return Array.isArray(expected) ? expected.includes(actual) : expected === actual;
}

/** 规则是否匹配这条事件。 */
export function matchRule(rule, event) {
  if (!rule.enabled) return false;
  const { match } = rule;
  if (!hit(match.source, event.source)) return false;
  if (!hit(match.kind, event.kind)) return false;
  if (!hit(match.level, event.level)) return false;
  if (match.summaryContains !== undefined) {
    if (!String(event.summary ?? '').includes(match.summaryContains)) return false;
  }
  if (match.summaryMatches !== undefined) {
    if (!match.summaryMatches.test(String(event.summary ?? ''))) return false;
  }
  return true;
}

/** 时段判断。允许跨午夜（23 → 7）。 */
export function inQuietHours(qh, now = new Date()) {
  if (!qh) return false;
  const h = now.getHours();
  const { start, end } = qh;
  if (start === end) return false;
  return start < end ? h >= start && h < end : h >= start || h < end;
}

/**
 * 决定一条事件走哪些通道。
 *
 * @returns {{ ruleId: string|null, channels: string[], wake: object, batch: object, suppressed: boolean }}
 */
export function evaluate(event, spec, { now = new Date() } = {}) {
  const rule = spec.rules.find((r) => matchRule(r, event));

  if (rule === undefined) {
    return {
      ruleId: null,
      channels: [...spec.defaultChannels],
      wake: { cooldownSec: 300, exemptGameMode: false },
      batch: { maxItems: 5, maxWaitSec: 300 },
      suppressed: false,
    };
  }

  // 静默时段：该规则不叫醒（窗口照常）
  const quiet = inQuietHours(rule.quietHours, now);
  const channels = quiet ? rule.channels.filter((c) => c !== 'wake') : [...rule.channels];

  return {
    ruleId: rule.id,
    channels,
    wake: rule.wake,
    batch: rule.batch,
    suppressed: quiet && rule.channels.includes('wake'),
  };
}

/**
 * 规则引擎：管清单的加载、热重载、失败回退。
 *
 * 【失败回退是核心】
 *   load() 失败时返回 false，但**不动当前生效的 spec**。
 *   调用方拿到 false 就发一条 config-error，行为继续按旧的走。
 */
export class RulesEngine {
  constructor(filePath, { onReload = null, onError = null } = {}) {
    this.filePath = filePath;
    this.onReload = onReload;
    this.onError = onError;
    this.spec = null;
    this.lastError = null;
    this._watching = false;
    this._debounce = null;
  }

  /** 默认规则：全部只进窗口。文件不存在时用它。 */
  static fallback() {
    return validateRules({ rules: [], defaults: { channels: ['window'] } }).spec;
  }

  /** 读一次。成功则替换 spec，失败保留旧的。 */
  load() {
    try {
      if (!existsSync(this.filePath)) {
        this.spec = RulesEngine.fallback();
        this.lastError = null;
        return { ok: true, used: 'fallback', reason: 'no-file' };
      }
      const text = readFileSync(this.filePath, 'utf8');
      let raw;
      try {
        raw = JSON.parse(text);
      } catch (e) {
        const err = { reason: 'bad-json', detail: e.message };
        this.lastError = err;
        if (this.spec === null) this.spec = RulesEngine.fallback();
        this.onError?.(err);
        return { ok: false, ...err };
      }
      const v = validateRules(raw);
      if (!v.ok) {
        this.lastError = { reason: v.reason, detail: v.detail };
        if (this.spec === null) this.spec = RulesEngine.fallback();
        this.onError?.(this.lastError);
        return { ok: false, reason: v.reason, detail: v.detail };
      }
      this.spec = v.spec;
      this.lastError = null;
      this.onReload?.(v.spec);
      return { ok: true, used: 'file', rules: v.spec.rules.length };
    } catch (e) {
      const err = { reason: 'read-error', detail: e.message };
      this.lastError = err;
      if (this.spec === null) this.spec = RulesEngine.fallback();
      this.onError?.(err);
      return { ok: false, ...err };
    }
  }

  /** 当前生效的规格。没加载过就先加载。 */
  current() {
    if (this.spec === null) this.load();
    return this.spec;
  }

  /** 用当前 spec 判断一条事件。 */
  decide(event, opts) {
    return evaluate(event, this.current(), opts);
  }

  /**
   * 开始监听文件变化。200ms 防抖 —— 编辑器保存会触发多次。
   */
  watch(intervalMs = 200) {
    if (this._watching) return;
    this._watching = true;
    watchFile(this.filePath, { interval: 500 }, () => {
      if (this._debounce !== null) clearTimeout(this._debounce);
      this._debounce = setTimeout(() => {
        this._debounce = null;
        this.load();
      }, intervalMs);
    });
  }

  /** 停止监听。插件卸载必须调，否则句柄泄漏。 */
  unwatch() {
    if (!this._watching) return;
    unwatchFile(this.filePath);
    if (this._debounce !== null) {
      clearTimeout(this._debounce);
      this._debounce = null;
    }
    this._watching = false;
  }
}
