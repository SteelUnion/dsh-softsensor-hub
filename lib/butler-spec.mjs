// butler-spec.mjs — relay 的 storageDomain 领域声明
//
// 手册：@deepseek-ai/dsh-storage-domain README.zh.md
//   - defineDomain({ name, version, tables })  声明一次，导出
//   - domainTable(schema)                       每张表的记录 schema
//   - ctx.storageDomain.open(spec)              消费方打开
//
// 【为什么单独一个文件】
//   领域声明是"唯一真源"（README 原话）。放进 store.mjs 会让它和存储实现搅在一起，
//   而采集器、init、测试都要引用它。单独一份，谁都能 import 而不拉起整个 store。
//
// 【为什么零依赖】
//   手册的 domainTable 接受"有 .parse() 的 schema"，而 relay 保持零依赖（package.json
//   dependencies 为空）。所以我手写 schema 对象 —— 这不是取巧：
//   domainTable(spec) 的源码只有一句 `return { valueSchema: schema }`，
//   真正的校验只在 open() 时调 `tableSpec.valueSchema.parse(raw)`。
//   只要 .parse() 在记录不合法时抛错即可，符合契约。
//
// 【三张表的分工】（维护者 2026-10-23 定：并表，但保留独立格式分区）
//   events  —— 事件库。key = 事件 id
//   state   —— 水位/标记。key = `<采集器>:<项>`，前缀即分区
//   weather —— 天气历史。key = `<城市>/<YYYY-MM-DD>`，十来天滚动
//
// 【为什么三张表而不是三张领域】
//   写入链在领域层（README：「每个领域一条写入链」），不是表层。
//   分三张表 = 清晰的分区；分三个领域才有三条链，但那要多三次 open/close，
//   而我们的最高写入频率是 6 小时一次 —— 排队可以忽略。
//   要切换成三领域，只改本文件的 buildDomains() 即可。

/** 领域名。UNIT_NAME_RE 要求小写字母开头、允许数字和连字符。 */
export const DOMAIN_NAME = 'butler';

/** 领域版本。改 schema 必须升版本并手工迁移（手册：无自动迁移）。 */
export const DOMAIN_VERSION = 1;

/** 表名。 */
export const TABLES = {
  EVENTS: 'events',
  STATE: 'state',
  WEATHER: 'weather',
};

/** state 表 key 的分区前缀。采集器各占一段，互不覆盖。 */
export const STATE_PREFIX = {
  INIT: 'init:',
  WEATHER: 'weather:',
  FINANCE: 'finance:',
  SYSTEM: 'system:',
  VERSION: 'version:',
};

// ─────────────────────────── 手写 schema ───────────────────────────

/**
 * 造一个"只做形状校验"的 schema。
 *
 * 契约（来自 domainTable 的用法）：`{ parse(raw) }`，不合法就 throw。
 * 校验失败时 open() 会包成 DomainError('invalid-record')，所以 throw 什么都行。
 *
 * @param {(raw: any) => void} check 校验函数，不通过就 throw
 */
function shape(check) {
  return {
    parse(raw) {
      check(raw);
      return raw;
    },
  };
}

/** 是不是普通对象（不是 null / 不是数组）。 */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * events 表：一条事件。
 *
 * 必填字段与 lib/event.mjs 的 validateEvent 保持一致 —— 两处都校验是有意的：
 * 入库前校验一次（早失败），打开领域时再校验一次（防磁盘上的坏记录）。
 */
const eventSchema = shape((raw) => {
  if (!isPlainObject(raw)) throw new TypeError('event must be an object');
  if (typeof raw.id !== 'string' || raw.id === '') throw new TypeError('event.id must be a non-empty string');
  if (typeof raw.source !== 'string' || raw.source === '') throw new TypeError('event.source required');
  if (typeof raw.kind !== 'string' || raw.kind === '') throw new TypeError('event.kind required');
  if (!['info', 'warn', 'critical'].includes(raw.level)) throw new TypeError('event.level invalid');
  if (typeof raw.summary !== 'string') throw new TypeError('event.summary must be a string');
  if (!isPlainObject(raw.payload)) throw new TypeError('event.payload must be an object');
});

/**
 * state 表：一个键值标记。
 *
 * 允许任意 JSON 值（数字、字符串、布尔、对象都行）——
 * 因为这张表就是给采集器存各色水位的。
 * 唯独不允许 undefined（JSON 里不存在这个值，存进去读回来会变成缺失）。
 */
const stateSchema = shape((raw) => {
  if (raw === undefined) throw new TypeError('state value cannot be undefined');
  // null 是合法值：init 三态里的"未处理"就是 null（维护者 2026-10-23 定）
});

/**
 * weather 表：一天的天气。
 *
 * 【为什么 key 里带城市】
 *   README 明说「没有多段键」，key 是单个字符串。
 *   多城市只能拼：`哈尔滨/2026-10-23`。
 *   这样清理也好办：删前缀 + 日期即可。
 */
const weatherSchema = shape((raw) => {
  if (!isPlainObject(raw)) throw new TypeError('weather record must be an object');
  if (typeof raw.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) {
    throw new TypeError('weather.date must be YYYY-MM-DD');
  }
  if (typeof raw.city !== 'string' || raw.city === '') throw new TypeError('weather.city required');
  if (typeof raw.fetchedAt !== 'string') throw new TypeError('weather.fetchedAt required');
});

// ─────────────────────────── 领域声明 ───────────────────────────

/**
 * 声明 relay 的领域。**纯函数，可安全重复调用**（defineDomain 只做字段校验）。
 *
 * 注意：`defineDomain` 在模块加载期就会校验 name / version / 表名，
 * 写错了当场抛 —— 这正是"唯一真源"的含义。
 */
export function defineButlerSpec() {
  // 延迟 import：butler-spec 要被 init / 采集器引用，
  // 而这几个地方有时跑在纯 Node 环境（测试），那里没有 @deepseek-ai 包。
  // 用动态 import 会让本模块变成 async，反而更麻烦；
  // 所以这里从传入的 defineDomain/domainTable 构造 —— 见 createButlerSpec。
  throw new Error('请用 createButlerSpec(defineDomain, domainTable)；本函数仅为兼容保留');
}

/**
 * 用宿主提供的 defineDomain / domainTable 构造领域 spec。
 *
 * 【为什么要传进来，而不是自己 import】
 *   relay 的 package.json 里 @deepseek-ai/* 全在 peerDependencies，
 *   而 storage-domain 那个包在线上是按需提供的。
 *   自己 import 会让测试环境（纯 node，没有该包）加载失败。
 *   由调用方（lib/index.js 从 ctx 拿到的模块）注入，测试时传两个桩函数即可。
 *
 * @param {(spec: object) => object} defineDomain 宿主/桩的 defineDomain
 * @param {(schema: object) => object} domainTable 宿主/桩的 domainTable
 */
export function createButlerSpec(defineDomain, domainTable) {
  if (typeof defineDomain !== 'function' || typeof domainTable !== 'function') {
    throw new TypeError('createButlerSpec 需要 defineDomain 与 domainTable 两个函数');
  }
  return defineDomain({
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    tables: {
      [TABLES.EVENTS]: domainTable(eventSchema),
      [TABLES.STATE]: domainTable(stateSchema),
      [TABLES.WEATHER]: domainTable(weatherSchema),
    },
  });
}

/**
 * 未来若要把三个表拆成三个领域（各自一条写入链），只改这里。
 *
 * 现在返回一个 —— 写入频率 6 小时一次，一条链足够。
 * 手册：「每个领域一条写入链」，所以拆领域才有第二条链，拆表没有。
 *
 * @returns {{ name: string, spec: object }[]}
 */
export function buildDomains(defineDomain, domainTable) {
  return [{ name: DOMAIN_NAME, spec: createButlerSpec(defineDomain, domainTable) }];
}

/** weather 表的 key。 */
export function weatherKey(city, date) {
  return `${city}/${date}`;
}

/** 从 weather key 里拆出城市和日期。形状不对返回 null。 */
export function parseWeatherKey(key) {
  if (typeof key !== 'string') return null;
  const i = key.indexOf('/');
  if (i <= 0) return null;
  const city = key.slice(0, i);
  const date = key.slice(i + 1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return { city, date };
}
