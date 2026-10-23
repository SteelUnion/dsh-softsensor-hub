// state.mjs — 采集器共享状态（持久化）
//
// 【它解决什么问题】
//   lib/index.js 原来给采集器的 state 是空壳：
//     state: { get: () => undefined, set: () => {}, del: () => {} }
//   write 什么也没发生，read 永远 undefined。
//   后果很具体：finance 的 lastProducedDate 每次插件重载都丢，重载就重发一遍行情。
//
// 【为什么接口是同步的】
//   采集器的 run(env) 里用 env.state.get(...) 直接取值，不 await。
//   这是既有契约（finance.mjs / system.mjs 都这么写），不能改成异步 —— 那要动所有采集器。
//   所以：**内存是权威，磁盘是投影**。
//   读：同步从内存 Map 拿。
//   写：立刻改内存，同时排队落盘。
//
//   这正好是 storageDomain 自己的模型（README：「读取同步返回经过校验的内存状态；
//   每次写入在完成前即为持久」）。区别只是我们不等落盘就返回 ——
//   代价是极端情况下丢掉最后几次写（比如拔电），而这些值都是"水位/标记"，
//   丢了最坏是重采一次，不会错报。
//
// 【写入链】
//   README 承诺 storageDomain 一个领域一条写入链，并发更新不会交错。
//   但我们这一层也要排队：内存改了、落盘还没轮到，下一次 set 又要落盘。
//   用一条 Promise 链串起所有落盘，保证顺序 = 调用顺序。
//
// 【降级】
//   1. storageDomain 的 state 表（正式）
//   2. JSON 文件（rootDir/state.json）—— domain 不可用时
//   3. 纯内存 —— 连文件都写不了时（测试环境）

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** 文件降级时的文件名。 */
const FALLBACK_FILE = 'state.json';

/**
 * 状态后端。
 *
 * 对外只暴露 { get, set, del, flush, kind, close }，与采集器契约一致。
 */
export class StateBackend {
  /**
   * @param {'storageDomain'|'file'|'memory'} kind
   * @param {Map<string, any>} mem 内存镜像（权威）
   * @param {(next: Map<string,any>) => Promise<void>} persist 落盘函数
   * @param {object|null} table storageDomain 的表句柄（有就用它写）
   */
  constructor(kind, mem, persist, table = null) {
    this.kind = kind;
    this.mem = mem;
    this.persist = persist;
    this.table = table;
    /** 写入链：所有落盘排队，保证顺序。 */
    this.chain = Promise.resolve();
    /** 落盘失败次数（排障用）。 */
    this.writeErrors = 0;
    this.closed = false;
  }

  /** 同步读。缺省值可给。 */
  get(key, defaultValue = undefined) {
    return this.mem.has(key) ? this.mem.get(key) : defaultValue;
  }

  /** 同步改内存 + 排队落盘。不 await —— 采集器契约是同步的。 */
  set(key, value) {
    if (value === undefined) {
      // undefined 在 JSON 里不存在，存进去读回来会变成"缺失"，这是坑。
      // 要删请用 del。
      throw new TypeError(`state.set("${key}") 不接受 undefined；要删除请用 del()`);
    }
    this.mem.set(key, value);
    this._schedule(key, value, null);
    return true;
  }

  /** 删除。 */
  del(key) {
    if (!this.mem.has(key)) return false;
    this.mem.delete(key);
    this._schedule(key, null, 'del');
    return true;
  }

  /** 排一次落盘。key 级别的增量写优先，不支持才整体重写。 */
  _schedule(key, value, op) {
    this.chain = this.chain
      .then(async () => {
        if (this.closed) return;
        if (this.table !== null) {
          // storageDomain：按 key 写，天然增量
          if (op === 'del') {
            await this.table.delete(key);
          } else {
            await this.table.put(key, value);
          }
          return;
        }
        // 文件/内存：整体重写一份快照
        await this.persist(this.mem);
      })
      .catch(() => {
        // 落盘失败不抛回采集器 —— 采集不该因为存不进去而崩。
        // 计数留给 status 看。
        this.writeErrors += 1;
      });
  }

  /** 等所有排队写完（关停时用）。 */
  async flush() {
    await this.chain;
    return { writeErrors: this.writeErrors };
  }

  /** 关停：等写完，标记关闭。 */
  async close() {
    await this.flush();
    this.closed = true;
  }
}

/** 从文件读一份快照。坏文件当空。 */
function loadFile(file) {
  try {
    if (!existsSync(file)) return new Map();
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return new Map();
    return new Map(Object.entries(raw));
  } catch {
    return new Map();
  }
}

/** 写一份快照。原子替换，避免读到半个文件。 */
function saveFile(file, mem) {
  const dir = dirname(file);
  try {
    mkdirSync(dir, { recursive: true });
  } catch { /* 目录已在 */ }
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(mem), null, 2), 'utf8');
  renameSync(tmp, file);   // 原子替换
}

/**
 * 造一个状态后端。
 *
 * @param opts.store    事件库句柄（能有 domain 用它；没有就退文件）
 * @param opts.rootDir  文件降级时的目录
 * @param opts.domain   storageDomain 打开后的领域句柄（优先生效）
 */
export async function createStateBackend({ store = null, rootDir = null, domain = null } = {}) {
  // ① storageDomain：真领域句柄在，就用它
  if (domain !== null && typeof domain.table === 'function') {
    try {
      const table = domain.table('state');
      const mem = new Map();
      // 把已存记录读进内存（表句柄的 entries 是同步的）
      try {
        for (const [k, v] of table.entries()) mem.set(k, v);
      } catch { /* 空表 */ }
      return new StateBackend('storageDomain', mem, async () => {}, table);
    } catch {
      // 表拿不到就降级
    }
  }

  // ② 文件
  if (typeof rootDir === 'string' && rootDir !== '') {
    const file = join(rootDir, FALLBACK_FILE);
    const mem = loadFile(file);
    return new StateBackend('file', mem, async (m) => saveFile(file, m));
  }

  // ③ 纯内存
  return new StateBackend('memory', new Map(), async () => {});
}

export default createStateBackend;
