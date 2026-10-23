// collector.mjs — 采集器接口与注册表
//
// 标准：
//
// 【采集器是什么】
//   一个采集器 = 一个"从外面拿数据"的模块。
//   它只做三件事：拿数据 → 产事件 → 交出去。
//   它不知道通知存在，不知道窗口存在，更不知道自己产出的东西会不会叫醒谁。
//
// 【为什么要这层】
//   以前加一个源就要改 index.js。
//   现在加一个源 = 写一个 collector 文件 + 在 config 里开一行。
//   内核一行不动。
//
// 【硬边界】
//   采集器可以：
//     - 读文件（只读）
//     - 开网络请求
//     - 跑 Node 内置模块
//   采集器不可以：
//     - spawn / exec（这条路会让外部消息变成任意命令执行）
//     - 写业务文件（要存东西走状态接口）
//     - 直接投递通知（只能产事件）

import { validateEvent, REJECT } from './event.mjs';

/** 采集器契约的版本。接口变了要升这个。 */
export const CONTRACT_VERSION = 1;

/** 采集器运行时状态。 */
export const STATE = {
  IDLE: 'idle',
  RUNNING: 'running',
  STOPPED: 'stopped',
  ERROR: 'error',
};

/**
 * 采集器接口说明（写采集器照这个抄）：
 *
 *   export default {
 *     name: 'mail',                    // 必须 = config 里的源名
 *     version: '1.0.0',
 *     contract: 1,                     // 必须 = CONTRACT_VERSION
 *     trigger: { kind: 'interval', everySec: 600 },
 *     needs: ['log', 'state', 'config'],
 *     async setup(env) {},             // 可选
 *     async run(env) → event[] ,       // 必须
 *     async teardown(env) {},          // 可选
 *   }
 *
 * env 里给什么：
 *   { now, log, state, config, signal }
 *   - now:    () => Date     当前时间（测试可注入）
 *   - log:    (level, msg, extra) 写日志
 *   - state:  { get(k, d), set(k, v), del(k) } 采集器自己的状态（持久化由调用方负责）
 *   - config: 该采集器的配置段（只读）
 *   - signal: AbortSignal，插件卸载时触发
 */

/** 校验一个采集器是否符合契约。 */
export function validateCollector(mod, expectedName = null) {
  if (mod === null || typeof mod !== 'object') {
    return { ok: false, reason: 'not-object' };
  }
  if (typeof mod.name !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(mod.name)) {
    return { ok: false, reason: 'bad-name', detail: String(mod.name) };
  }
  if (expectedName !== null && mod.name !== expectedName) {
    return { ok: false, reason: 'name-mismatch', detail: `${mod.name}!=${expectedName}` };
  }
  const contract = mod.contract ?? 1;
  if (contract !== CONTRACT_VERSION) {
    return { ok: false, reason: 'contract-mismatch', detail: `${contract}!=${CONTRACT_VERSION}` };
  }
  if (typeof mod.run !== 'function') {
    return { ok: false, reason: 'no-run' };
  }
  if (mod.trigger !== undefined) {
    const t = mod.trigger;
    if (t === null || typeof t !== 'object') return { ok: false, reason: 'bad-trigger' };
    if (t.kind === 'interval') {
      if (!Number.isFinite(t.everySec) || t.everySec <= 0) {
        return { ok: false, reason: 'bad-trigger', detail: 'interval needs everySec>0' };
      }
    } else if (t.kind === 'manual') {
      // 只能被显式调用，不自动跑
    } else {
      return { ok: false, reason: 'bad-trigger', detail: String(t.kind) };
    }
  }
  if (mod.setup !== undefined && typeof mod.setup !== 'function') {
    return { ok: false, reason: 'bad-setup' };
  }
  if (mod.teardown !== undefined && typeof mod.teardown !== 'function') {
    return { ok: false, reason: 'bad-teardown' };
  }
  return { ok: true };
}

/** 从采集器返回的东西里抽出合法事件。坏的丢掉并计数。 */
export function collectEvents(raw, collectorName) {
  const list = Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw];
  const events = [];
  const rejected = [];
  for (const item of list) {
    // 允许采集器直接返回已校验过的（有 id + displayed）
    if (item?.id && item?.displayed && item?.source) {
      events.push(item);
      continue;
    }
    const v = validateEvent(item);
    if (v.ok) {
      events.push(v.event);
    } else {
      rejected.push({ reason: v.reason, detail: v.detail ?? null });
    }
  }
  return { events, rejected, source: collectorName };
}

/**
 * 采集器注册表。
 *
 * 管三件事：注册、按配置启动、统一调用。
 * 单个采集器崩了不影响别的 —— 这是"平台稳定"的核心。
 */
export class CollectorRegistry {
  constructor({ onError = null } = {}) {
    this.items = new Map(); // name → { mod, state, lastRunAt, lastError, timer }
    this.onError = onError;
  }

  get size() {
    return this.items.size;
  }

  /** 注册。同名覆盖旧的不允许 —— 说明配置写错了。 */
  register(mod, expectedName = null) {
    const v = validateCollector(mod, expectedName);
    if (!v.ok) return v;
    if (this.items.has(mod.name)) {
      return { ok: false, reason: 'duplicate-name', detail: mod.name };
    }
    this.items.set(mod.name, {
      mod,
      state: STATE.IDLE,
      lastRunAt: null,
      lastError: null,
      timer: null,
    });
    return { ok: true, name: mod.name };
  }

  has(name) {
    return this.items.has(name);
  }

  get(name) {
    return this.items.get(name)?.mod ?? null;
  }

  /** 列出全部采集器及其状态（给窗口/面板看）。 */
  list() {
    return [...this.items.entries()].map(([name, s]) => ({
      name,
      version: s.mod.version ?? null,
      trigger: s.mod.trigger ?? null,
      state: s.state,
      lastRunAt: s.lastRunAt,
      lastError: s.lastError,
    }));
  }

  /**
   * 跑一个采集器。
   *
   * 【绝不让它把平台带崩】
   *   - 抛错 → 记下来，返回空事件
   *   - 超时 → 同上
   *   - 返回值乱 → 只取合法的
   */
  async runOne(name, env, { timeoutMs = 60_000 } = {}) {
    const slot = this.items.get(name);
    if (slot === undefined) return { events: [], rejected: [], error: 'not-registered' };
    if (slot.state === STATE.RUNNING) return { events: [], rejected: [], error: 'already-running' };

    slot.state = STATE.RUNNING;
    slot.lastRunAt = new Date().toISOString();

    let timer = null;
    try {
      const work = Promise.resolve(slot.mod.run(env));
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`collector ${name} timeout ${timeoutMs}ms`)), timeoutMs);
      });
      const raw = await Promise.race([work, timeout]);
      const out = collectEvents(raw, name);
      slot.state = STATE.IDLE;
      slot.lastError = null;
      return out;
    } catch (e) {
      slot.state = STATE.ERROR;
      slot.lastError = String(e?.message ?? e);
      this.onError?.({ name, error: slot.lastError });
      return { events: [], rejected: [], error: slot.lastError };
    } finally {
      if (timer !== null) clearTimeout(timer);
      // 超时后 timer 已被 race 抛掉，但采集器可能还在跑；
      // 状态留在 ERROR 让上层记录，下次 interval 再跑会重置。
    }
  }

  /** 跑全部已注册的采集器。单个失败不影响其余。 */
  async runAll(env, opts) {
    const names = [...this.items.keys()];
    const results = await Promise.allSettled(names.map((n) => this.runOne(n, { ...env, name: n }, opts)));
    const events = [];
    const rejected = [];
    const errors = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        events.push(...r.value.events);
        rejected.push(...r.value.rejected);
        if (r.value.error) errors.push({ name: names[i], error: r.value.error });
      } else {
        errors.push({ name: names[i], error: String(r.reason) });
      }
    });
    return { events, rejected, errors };
  }

  /** 启动定时器。 */
  start(envFactory, { onEvents = null } = {}) {
    for (const [name, slot] of this.items) {
      const trig = slot.mod.trigger;
      if (trig?.kind !== 'interval') continue;
      if (slot.timer !== null) continue;
      const everyMs = trig.everySec * 1000;
      slot.timer = setInterval(async () => {
        if (slot.state === STATE.STOPPED) return;
        const env = envFactory(name);
        const out = await this.runOne(name, env);
        if (out.events.length > 0 || out.rejected.length > 0) {
          onEvents?.(name, out);
        }
      }, everyMs);
      // 不阻止进程退出
      slot.timer.unref?.();
    }
  }

  /** 停止所有定时器。插件卸载必须调。 */
  stop() {
    for (const slot of this.items.values()) {
      if (slot.timer !== null) {
        clearInterval(slot.timer);
        slot.timer = null;
      }
      slot.state = STATE.STOPPED;
    }
  }

  /** 清空注册表（测试用）。 */
  clear() {
    this.stop();
    this.items.clear();
  }
}
