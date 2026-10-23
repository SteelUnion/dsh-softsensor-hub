// store.mjs — 事件库
//
// 标准：
//
// 【它管什么】
//   存、取、按源计数、按天查、定期清理。
//   不判断重要性 —— 那是规则引擎的事。
//
// 【两种后端，同一套接口】
//   1. StorageDomainStore —— 用 ctx.storageDomain（正式）
//   2. MemoryStore        —— 内存（测试用）
//   3. FileStore          —— JSON 行文件（storageDomain 不可用时的退路）
//
// 【为什么要有退路】
//   storageDomain 现在挂着（2026-10-21 实测），但插件可能在别的 profile 里跑，
//   那里未必挂了。挂不上不能整个功能就没了。
//
// 【为什么用 storageDomain 而不是自己写 JSON】
//   官方保证：「put/delete/update/global.set 全部排队在同一条写入链，
//              并发更新永远不会交错」。
//   这就是"配置文件被多个循环写锁死"的答案。

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** 保留策略默认值。 */
export const DEFAULT_RETENTION = {
  eventsMaxDays: 30,
  eventsMaxPerSource: 5000,
  sweepIntervalMin: 60,
};

/** 判断一条事件够不够新。 */
function withinDays(iso, days, now = Date.now()) {
  if (typeof iso !== 'string') return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return now - t <= days * 24 * 3600 * 1000;
}

// ─────────────────────────── 内存后端 ───────────────────────────

/** 内存后端：测试用，也当其他后端的行为基准。 */
export class MemoryStore {
  constructor() {
    this.byId = new Map();
    this.duplicates = 0;
    this.rejected = [];
  }

  /** 存一条。id 重复不覆盖，只计数（幂等丢弃）。 */
  async put(event) {
    if (this.byId.has(event.id)) {
      this.duplicates += 1;
      return { ok: false, reason: 'duplicate-id' };
    }
    this.byId.set(event.id, event);
    return { ok: true };
  }

  async get(id) {
    return this.byId.get(id) ?? null;
  }

  async getAll() {
    return [...this.byId.values()];
  }

  /** 按源筛。 */
  async bySource(source) {
    return [...this.byId.values()].filter((e) => e.source === source);
  }

  /** 取某天的事件（按 at 的本地日期）。 */
  async byDay(dateStr) {
    return [...this.byId.values()].filter((e) => String(e.at ?? '').startsWith(dateStr));
  }

  /** 更新某条（用于标记 displayed）。 */
  async update(id, fn) {
    const cur = this.byId.get(id);
    if (cur === undefined) return { ok: false, reason: 'missing-key' };
    const next = fn(cur);
    this.byId.set(id, next);
    return { ok: true };
  }

  async remove(id) {
    return { ok: this.byId.delete(id) };
  }

  /**
   * 清理。
   * 两条规则：超过 N 天 或 单源超上限。两条都按"从旧到新"删。
   */
  async sweep(retention = DEFAULT_RETENTION, now = Date.now()) {
    let removed = 0;
    const { eventsMaxDays, eventsMaxPerSource } = { ...DEFAULT_RETENTION, ...retention };

    // ① 超天数
    for (const [id, e] of this.byId) {
      if (!withinDays(e.at, eventsMaxDays, now)) {
        this.byId.delete(id);
        removed += 1;
      }
    }

    // ② 单源超上限
    const bySrc = new Map();
    for (const e of this.byId.values()) {
      const arr = bySrc.get(e.source) ?? [];
      arr.push(e);
      bySrc.set(e.source, arr);
    }
    for (const arr of bySrc.values()) {
      if (arr.length <= eventsMaxPerSource) continue;
      arr.sort((a, b) => String(a.at).localeCompare(String(b.at)));
      const excess = arr.length - eventsMaxPerSource;
      for (let i = 0; i < excess; i++) {
        this.byId.delete(arr[i].id);
        removed += 1;
      }
    }
    return { removed };
  }

  async count() {
    return this.byId.size;
  }
}

// ─────────────────────────── 文件后端 ───────────────────────────

/**
 * 文件后端：按天分文件，一行一条 JSON。
 *
 * 【为什么按天分】
 *   received.jsonl 现在 5000 行滚动 —— 今天的消息会被昨天的挤掉。
 *   维护者 要的是"今日消息 +12"，不能靠滚动。
 *
 * 【为什么不是 storageDomain 的下位替代】
 *   能用 storageDomain 就用它。这个是兜底。
 */
export class FileStore {
  constructor(rootDir, { retention = DEFAULT_RETENTION } = {}) {
    this.dir = join(rootDir, 'events');
    this.seen = new Set(); // 已入库的 id（内存索引，启动时重建）
    this.duplicates = 0;
    this.retention = { ...DEFAULT_RETENTION, ...retention };
    mkdirSync(this.dir, { recursive: true });
    this._reindex();
  }

  _dayFile(dateStr) {
    return join(this.dir, `${dateStr}.jsonl`);
  }

  _dayOf(event) {
    // 用 at 的日期，不用写入时间 —— 补发历史事件时要归到它发生的日子
    const d = String(event.at ?? '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : new Date().toISOString().slice(0, 10);
  }

  _reindex() {
    try {
      // 只索引最近 retention 天，启动不至于扫全盘
      const cutoff = Date.now() - this.retention.eventsMaxDays * 24 * 3600 * 1000;
      for (const f of readdirSync(this.dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const day = f.slice(0, 10);
        if (Date.parse(day) < cutoff) continue;
        for (const line of readFileSync(join(this.dir, f), 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const e = JSON.parse(line);
            if (typeof e?.id === 'string') this.seen.add(e.id);
          } catch { /* 坏行跳过 */ }
        }
      }
    } catch { /* 目录不存在就空着 */ }
  }

  async put(event) {
    if (this.seen.has(event.id)) {
      this.duplicates += 1;
      return { ok: false, reason: 'duplicate-id' };
    }
    appendFileSync(this._dayFile(this._dayOf(event)), `${JSON.stringify(event)}\n`, 'utf8');
    this.seen.add(event.id);
    return { ok: true };
  }

  async getAll({ days = this.retention.eventsMaxDays } = {}) {
    const out = [];
    const cutoff = Date.now() - days * 24 * 3600 * 1000;
    try {
      for (const f of readdirSync(this.dir).sort()) {
        if (!f.endsWith('.jsonl')) continue;
        if (Date.parse(f.slice(0, 10)) < cutoff) continue;
        for (const line of readFileSync(join(this.dir, f), 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try { out.push(JSON.parse(line)); } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }
    return out;
  }

  async get(id) {
    // 【为什么不用 getAll().find()】
    //   getAll 会把 30 天内所有事件读进内存再找一条。
    //   取一条和全量读取的开销差了两个数量级，别为了代码短这么写。
    //   事件 id 里带日期（evt-<source>-YYYYMMDD-xxxx），先定位到那一天。
    const m = /(\d{8})/.exec(String(id));
    if (m !== null) {
      const y = m[1].slice(0, 4);
      const mo = m[1].slice(4, 6);
      const d = m[1].slice(6, 8);
      const day = `${y}-${mo}-${d}`;
      const rows = await this.byDay(day);
      const hit = rows.find((e) => e.id === id);
      if (hit !== undefined) return hit;
      // 该日没有，说明 id 里的日期不可信，退回全量
    }
    const all = await this.getAll();
    return all.find((e) => e.id === id) ?? null;
  }

  async bySource(source) {
    // 这里是**真的**要跨天找，只能全量扫。
    // 但结果按 source 过滤后通常很小，内存压力主要在 getAll 的中间数组。
    return (await this.getAll()).filter((e) => e.source === source);
  }

  async byDay(dateStr) {
    const f = this._dayFile(dateStr);
    if (!existsSync(f)) return [];
    const out = [];
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return out;
  }

  /** 整文件重写。事件量小（按天），可接受。 */
  async update(id, fn) {
    const all = await this.getAll();
    const idx = all.findIndex((e) => e.id === id);
    if (idx < 0) return { ok: false, reason: 'missing-key' };
    all[idx] = fn(all[idx]);
    await this._rewrite(all);
    return { ok: true };
  }

  async remove(id) {
    const all = await this.getAll();
    const next = all.filter((e) => e.id !== id);
    if (next.length === all.length) return { ok: false };
    await this._rewrite(next);
    this.seen.delete(id);
    return { ok: true };
  }

  async _rewrite(events) {
    const byDay = new Map();
    for (const e of events) {
      const d = this._dayOf(e);
      const arr = byDay.get(d) ?? [];
      arr.push(e);
      byDay.set(d, arr);
    }
    // 【为什么要先删光】
    //   只写"有事件的日期"是不够的：某天事件被删光了，
    //   那天的旧文件还在磁盘上，下次 getAll 会把删掉的读回来。
    //   所以整体重写 = 先清掉目录里所有 .jsonl，再按天写回。
    try {
      for (const f of readdirSync(this.dir)) {
        if (f.endsWith('.jsonl')) {
          try { unlinkSync(join(this.dir, f)); } catch { /* 已没了 */ }
        }
      }
    } catch { /* 目录不在就跳过 */ }

    for (const [d, arr] of byDay) {
      const target = this._dayFile(d);
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, arr.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
      renameSync(tmp, target); // 原子替换，避免读到半个文件
    }
  }

  async sweep(retention = this.retention, now = Date.now()) {
    const { eventsMaxDays, eventsMaxPerSource } = { ...DEFAULT_RETENTION, ...retention };

    // 【为什么不复用 getAll({ days })】
    //   getAll 会按天数先过滤，更老的事件读不到，于是"删了多少"就统计不出来，
    //   磁盘上那些老文件也永远清不掉。
    //   清理必须看到全部，读 raw。
    const all = [];
    try {
      for (const f of readdirSync(this.dir).sort()) {
        if (!f.endsWith('.jsonl')) continue;
        for (const line of readFileSync(join(this.dir, f), 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try { all.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
        }
      }
    } catch { /* 目录不在 */ }

    const kept = all.filter((e) => withinDays(e.at, eventsMaxDays, now));
    let removed = all.length - kept.length;

    const bySrc = new Map();
    for (const e of kept) {
      const arr = bySrc.get(e.source) ?? [];
      arr.push(e);
      bySrc.set(e.source, arr);
    }
    const final = [];
    for (const arr of bySrc.values()) {
      arr.sort((a, b) => String(a.at).localeCompare(String(b.at)));
      if (arr.length > eventsMaxPerSource) {
        removed += arr.length - eventsMaxPerSource;
        final.push(...arr.slice(arr.length - eventsMaxPerSource));
      } else {
        final.push(...arr);
      }
    }
    await this._rewrite(final);
    this.seen = new Set(final.map((e) => e.id));
    return { removed };
  }

  async count() {
    return this.seen.size;
  }
}

// ─────────────────────────── storageDomain 后端 ───────────────────────────

/**
 * storageDomain 后端。
 *
 * 【和别的后端的差别】
 *   storageDomain 是 KV，不是表查询。所以：
 *   - id → 事件 存主表
 *   - source → id 列表 存索引表
 *   - day → id 列表 存索引表
 *
 * 【为什么分表】
 *   KV 没法按字段筛。要 bySource / byDay 就得自己维护索引。
 *   索引写失败不影响主表 —— 下次重建即可。
 */
export class StorageDomainStore {
  /**
   * @param schema 由调用方 defineDomain 出来的 spec
   * @param open   形如 (spec) => Promise<domain>
   */
  constructor(schema, open) {
    this.schema = schema;
    this.open = open;
    this.domain = null;
    this.duplicates = 0;
  }

  async ready() {
    if (this.domain === null) {
      this.domain = await this.open(this.schema);
    }
    return this.domain;
  }

  /**
   * 把已打开的域句柄交给别的消费者复用。
   *
   * 【为什么必须有这个方法】（2026-10-23 实测踩到）
   *   storageDomain 的规则是「一个域名只能 open 一次」——再开会报
   *   DomainError('already-open')（README：「名称已打开或仍在关闭」）。
   *
   *   事件库这里 open 了一次。index.js 的 initState() 想再 open 同一个域
   *   去拿 state 表，于是第二次必然失败，整个状态层退回文件后端。
   *   日志里那条 `domain-open: domain 'butler' is already open` 就是它。
   *
   *   正确做法是**复用同一个句柄**，而不是各开各的。
   *   手册也说「调用方拥有句柄的生命周期」——句柄本来就该只有一份。
   *
   * @returns 已打开的域句柄；还没打开就返回 null
   */
  currentDomain() {
    return this.domain;
  }

  async _events() {
    const d = await this.ready();
    return d.table('events');
  }

  async _index() {
    const d = await this.ready();
    return d.table('index');
  }

  async put(event) {
    const ev = await this._events();
    if (ev.get(event.id) !== undefined) {
      this.duplicates += 1;
      return { ok: false, reason: 'duplicate-id' };
    }
    await ev.put(event.id, event);
    // 索引：主表已写成功，索引失败只影响查询，下次 sweep 重建
    try {
      const idx = await this._index();
      const day = String(event.at ?? '').slice(0, 10);
      const sKey = `s:${event.source}`;
      const dKey = `d:${day}`;
      const merge = (list, id) => (Array.isArray(list) ? [...list, id] : [id]);
      idx.update(`__${sKey}`, (r) => ({ ids: merge(r?.ids, event.id) })) // 不存在会抛
        .catch(async () => idx.put(`__${sKey}`, { ids: [event.id] }));
      idx.update(`__${dKey}`, (r) => ({ ids: merge(r?.ids, event.id) }))
        .catch(async () => idx.put(`__${dKey}`, { ids: [event.id] }));
    } catch { /* 索引尽力而为 */ }
    return { ok: true };
  }

  async get(id) {
    const ev = await this._events();
    return ev.get(id) ?? null;
  }

  async getAll() {
    const ev = await this._events();
    return [...ev.entries()].map(([, v]) => v);
  }

  async bySource(source) {
    return (await this.getAll()).filter((e) => e.source === source);
  }

  async byDay(dateStr) {
    return (await this.getAll()).filter((e) => String(e.at ?? '').startsWith(dateStr));
  }

  async update(id, fn) {
    const ev = await this._events();
    if (ev.get(id) === undefined) return { ok: false, reason: 'missing-key' };
    await ev.update(id, fn);
    return { ok: true };
  }

  async remove(id) {
    const ev = await this._events();
    if (ev.get(id) === undefined) return { ok: false };
    await ev.delete(id);
    return { ok: true };
  }

  async sweep(retention = DEFAULT_RETENTION, now = Date.now()) {
    const { eventsMaxDays, eventsMaxPerSource } = { ...DEFAULT_RETENTION, ...retention };
    const ev = await this._events();
    let removed = 0;

    for (const [id, e] of ev.entries()) {
      if (!withinDays(e.at, eventsMaxDays, now)) {
        await ev.delete(id);
        removed += 1;
      }
    }

    const all = [...ev.entries()].map(([, v]) => v);
    const bySrc = new Map();
    for (const e of all) {
      const arr = bySrc.get(e.source) ?? [];
      arr.push(e);
      bySrc.set(e.source, arr);
    }
    for (const arr of bySrc.values()) {
      if (arr.length <= eventsMaxPerSource) continue;
      arr.sort((a, b) => String(a.at).localeCompare(String(b.at)));
      const excess = arr.length - eventsMaxPerSource;
      for (let i = 0; i < excess; i++) {
        await ev.delete(arr[i].id);
        removed += 1;
      }
    }
    return { removed };
  }

  async count() {
    const ev = await this._events();
    return [...ev.entries()].length;
  }

  async close() {
    if (this.domain !== null) {
      try { this.domain.close(); } catch { /* 已关 */ }
      this.domain = null;
    }
  }
}

/** 挑一个能用的后端。 */
export async function createStore({ storageDomain = null, spec = null, rootDir = null, retention } = {}) {
  const r = { ...DEFAULT_RETENTION, ...(retention ?? {}) };
  if (storageDomain !== null && spec !== null) {
    try {
      const store = new StorageDomainStore(spec, (s) => storageDomain.open(s));
      await store.ready();
      return { store, kind: 'storageDomain' };
    } catch (e) {
      // storageDomain 挂了不能把功能一起挂掉
      if (rootDir !== null) {
        return { store: new FileStore(rootDir, { retention: r }), kind: 'file', fallbackReason: String(e?.message ?? e) };
      }
      return { store: new MemoryStore(), kind: 'memory', fallbackReason: String(e?.message ?? e) };
    }
  }
  if (rootDir !== null) {
    return { store: new FileStore(rootDir, { retention: r }), kind: 'file' };
  }
  return { store: new MemoryStore(), kind: 'memory' };
}
