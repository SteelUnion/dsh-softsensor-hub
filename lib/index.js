/**
 * @steelunion/dsh-relay — 消息中枢
 *
 * 标准：
 * 图纸：
 *
 * 一句话：收外部消息 → 判轻重 → 说给用户听 → 需要决定时提问。
 *
 * 【硬边界】中枢能看、能说、能问，**不能动手**。
 * 本文件不得出现：spawn / exec / 业务文件的写操作。
 * 契约来自 design：常驻 + 能动 = 无人看着的手，绕过了 confirm-gate。
 *
 * @module @steelunion/dsh-relay
 */

export const name = 'relay';

/**
 * cordis 的服务依赖声明。
 *
 * 不声明就用 `ctx.userQuestions`，会抛
 *   cannot get property "userQuestions" without inject
 *
 * 【2026-10-23 改动：加了 storageDomain】
 *   原来这里只有 userQuestions 和 agents，注释还写着「为什么不在 inject 里加
 *   storageDomain」——理由是「Cordis 要求服务必须存在，否则插件不起作用」。
 *   那个理由**已被手册推翻**：
 *     dsh编码手册 §1.3 铁律③：「要访问服务，先 export const inject = ['xxx']。
 *     声明就是能力边界。」并明确「`ctx.get()` 不是软探测，绕不过注入门」。
 *   实测也证明：不声明时 ctx.get('storageDomain') 拿不到真服务，
 *   StorageDomainStore 这个类从头到尾没被用过。
 *
 *   现在声明了。**拿不到时的降级仍在**：createStore 的 catch 会退 FileStore，
 *   所以「某个 profile 没挂 storageDomain」不会让 relay 停摆 —— 降级不在 inject 层，
 *   在 createStore 层，那才是对的位置。
 *
 * 只声明这三个：中枢不碰 tools / shell / 任何能动手的服务，
 * 声明本身就是能力的边界。
 */
export const inject = ['userQuestions', 'agents', 'storageDomain'];

import { readFileSync, existsSync, readdirSync, renameSync, appendFileSync, mkdirSync, unlinkSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadPeers, validate, Deduper, fingerprint, shouldInject, render, eventSkeleton, groupBySkeleton, renderBatch } from './message.mjs';
// 智能管家框架（阶段 2）。四个模块独立、已单测；这里只做接线。
// 设计：
// 协议：
import { upgradeLegacyMessage, isLegacyEvent, summarizeBySource, renderEvent, newEventId } from './event.mjs';
import { RulesEngine } from './rules.mjs';
import { CollectorRegistry } from './collector.mjs';
import { createStore, DEFAULT_RETENTION } from './store.mjs';
import { createStateBackend } from './state.mjs';
import { createButlerSpec, TABLES } from './butler-spec.mjs';
import { evaluate as evaluateInit, ITEMS as INIT_ITEMS } from './init.mjs';
import {
  checkSync, buildSyncEvent, writeConfigFile, readConfigFile,
  pickSynced, SYNC, syncBanner, mergeDeep,
} from './config-sync.mjs';
import { createSystemCollector } from './collectors/system.mjs';
import { createMailCollector } from './collectors/mail.mjs';
import { createFinanceCollector } from './collectors/finance.mjs';
import { createWeatherCollector } from './collectors/weather.mjs';
import { CredentialVault, makeCredentialReader } from './credentials.mjs';

/**
 * 可选的 storageDomain。
 *
 * 【为什么不在 inject 数组里加】
 *   inject 数组里写哪个服务名，Cordis 就要求那个服务**必须存在**，
 *   否则整个插件不起作用。而 relay 在任何 profile 都该能跑。
 *
 * 【Cordis 只认两种 inject 写法】
 *   读源码 `Inject.resolve`（cordis 包，app.asar 内）确认：
 *     - 数组：['a', 'b']
 *     - 纯映射：{ a: null, b: null }
 *   写成 `{ required: [...], optional: [...] }` 会被当成
 *   "依赖名为 required 和 optional 的两个服务"，是错的写法。
 *
 * 【正确的可选做法】
 *   `ctx.get(name)` 是**可选查询**，服务不存在返回 undefined，不抛。
 *   原文（dsh 源码注释）：「ctx.get(name) performs optional lookup;
 *   direct ctx.serviceName access is gated by the fiber's inject declaration.」
 *
 *   ⚠️ 这和本文件顶部那句注释不冲突：
 *   那句说的是 `ctx.get('userQuestions')` 在被**注入门拦下**时也会抛 ——
 *   因为 userQuestions 是必填依赖的一个实例，只是当时没声明。
 *   对完全没声明的可选服务，ctx.get 返回 undefined。
 *   两种行为都实测过，见 dsh编码手册。
 */

/**
 * HTTP 服务器工厂。**延迟加载**，不是顶层 import。
 *
 * 【为什么】relay 的硬边界是「能看、能说、能问，不能动手」。
 * 起 HTTP 服务不执行命令、不写业务文件，但它是"对外开了一个口子"，
 * 属于边界上的东西。所以：
 *   - 默认 enabled:false
 *   - 只在配置显式开启时才加载 node:http
 *   - 只监听回环地址
 *   - 走与文件入口完全相同的校验流程
 */
let serverFactory = null;
async function ensureHttpFactory() {
  if (serverFactory !== null) return;
  try {
    const mod = await import('node:http');
    serverFactory = mod.createServer;
  } catch {
    serverFactory = null;
  }
}

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
/** 插件自带的数据目录兜底：插件装在哪，inbox/peers 就在哪。 */
const INSTALLED_ROOT = dirname(LIB_DIR);

const SCAN_INTERVAL_MS = 10_000;
const ALIVE_CHECK_MS = 60_000;

/**
 * 提示语版本。
 *
 * 【它是什么】
 *   要往用户的 `$DSH_HOME/AGENTS.md` 里加的那句话的版本号。
 *   写在文件里用 `<!-- relay-hint v1 -->` 标记，加载时比对。
 *
 * 【为什么要版本号】
 *   提示语会随插件升级而变化（比如以后加新模块的说明）。
 *   没有版本号，就分不清用户那份是"装过"还是"装过但旧了"。
 *   本地比对就够 —— 不需要联网（维护者 2026-10-23 问过的那个问题）。
 */
export const HINT_VERSION = 1;

/**
 * 读一个 AGENTS.md 里的 relay 提示版本。
 *
 * @returns {{ exists: boolean, version: number|null }}
 *   exists=false  文件不存在
 *   version=null  文件在，但没有 relay-hint 标记
 */
function readHintVersion(p) {
  try {
    if (typeof p !== 'string' || p === '') return { exists: false, version: null };
    if (!existsSync(p)) return { exists: false, version: null };
    const text = readFileSync(p, 'utf8');
    // 标记形如 <!-- relay-hint v1 -->
    const m = /<!--\s*relay-hint\s+v(\d+)\s*-->/.exec(text);
    return { exists: true, version: m === null ? null : Number(m[1]) };
  } catch {
    return { exists: false, version: null };
  }
}

/**
 * 决定中枢用哪个目录存数据。
 *
 * 为什么要能指定：`dsh plugin add` 是**复制**插件，不是软链。
 * 复制后插件跑在 profile 的 node_modules 里，它旁边就是一个新的空 inbox —— 
 * 于是「源目录里的 inbox」和「真正被读的 inbox」是两个地方。
 * 实测踩过：消息放进源目录的 inbox，插件纹丝不动，因为它们根本不是同一个目录。
 *
 * 配置项 `root` 指向源仓库，数据就集中在那一处，
 * 重装插件不会丢 peers、不会丢日志。
 */
function resolveRoot(config) {
  const wanted = config?.root;
  if (typeof wanted === 'string' && wanted.trim() !== '') return wanted;
  return INSTALLED_ROOT;
}

/** 读取中枢配置。配置坏了用默认值，不因此罢工。 */
export function loadConfig(root) {
  const cfgPath = join(root, 'config.json');
  const defaults = {
    enabled: true,
    delivery: {
      levels: {
        // critical：立刻发，不攒；不限次数（真到这个水平的事很少）
        critical: { channel: 'wake', cooldownSec: 300, mergeWindowSec: 300, titleChars: 20,
          batch: { enabled: false } },
        // warn：攒批。攒满 5 类 或 满 5 分钟，先到先发
        warn: { channel: 'queue', cooldownSec: 0, mergeWindowSec: 0, titleChars: 20,
          batch: { enabled: true, maxItems: 5, maxWaitSec: 300 } },
        // info：只留档
        info: { channel: 'archive', cooldownSec: 0, mergeWindowSec: 0, titleChars: 20,
          batch: { enabled: false } },
      },
    },
    rate: { maxPerTurn: 2, maxPerHour: 5, globalCooldownSec: 30 },
    quietHours: { enabled: false, start: 23, end: 7 },
    supervise: { enabled: true },
    gameMode: { enabled: true, flagFile: 'game-mode.on', autoExpireSec: 21600 },
    interface: {
      file: { enabled: true, dir: 'inbox', pollMs: 10000 },
      http: { enabled: false, host: '127.0.0.1', port: 17831, path: '/inbox' },
    },
  };
  if (!existsSync(cfgPath)) return defaults;
  try {
    const c = JSON.parse(readFileSync(cfgPath, 'utf8'));
    // 浅合并每个顶层段，让用户可以只覆盖想改的字段
    const merged = { ...defaults };
    for (const [k, v] of Object.entries(c)) {
      if (k.startsWith('_')) continue;   // 注释字段不进运行时
      if (v !== null && typeof v === 'object' && !Array.isArray(v)
          && defaults[k] !== null && typeof defaults[k] === 'object') {
        merged[k] = { ...defaults[k], ...v };
      } else {
        merged[k] = v;
      }
    }
    return merged;
  } catch {
    return defaults;
  }
}

/**
 * 取某个级别对应的投递策略。
 *
 * 【为什么要有这一层】以前级别是写死在代码里的（levels: ["critical"]），
 * 改行为要改代码。现在全部走配置，默认值兜底。
 */
function deliveryOf(cfg, level) {
  const levels = cfg?.delivery?.levels ?? {};
  const spec = levels[level];
  if (spec !== undefined && typeof spec === 'object') return spec;
  // 未知级别按 info 处理（只留档）—— 宁可不说，不可乱说
  return { channel: 'archive', cooldownSec: 0, mergeWindowSec: 0, titleChars: 20 };
}

/** 确保运行时目录存在。这些是中枢自己的工作目录，不是业务文件。 */
function ensureDirs(root) {
  // 【logs 必须在这里】（2026-10-23 发布整理）
  //   以前所有 .jsonl 直接写在 root 根下，装完一看十几个日志散在插件目录里。
  //   现在统一进 logs\：目录先建好，appendFileSync 就不会因父目录不存在而静默失败。
  for (const d of ['inbox', 'archive', 'peers', 'logs']) {
    const p = join(root, d);
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  }
}

/** 日志目录名。与 ensureDirs 必须一致。 */
const LOGS_DIR = 'logs';

/**
 * 写一行 JSONL。
 *
 * 名字带 `At` 后缀是刻意的：`apply()` 里要绑一个局部版本把 root 固化进去，
 * 若局部变量还叫 appendJsonl，箭头函数体里的同名引用会解析到**它自己**，
 * 于是自我递归 → RangeError: Maximum call stack size exceeded。
 * 实测踩过：桌面版因此四次启动即崩。
 */
function appendJsonlAt(root, name, obj) {
  try {
    // 统一写进 logs\：根目录保持干净，卸载/备份时一眼能看出哪些是日志
    const dir = join(root, LOGS_DIR);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, name), `${JSON.stringify(obj)}\n`, 'utf8');
  } catch {
    /* 记不上账也不能让中枢停 */
  }
}

/**
 * 首次启动：没有 config.json 就从模板生成一份。
 *
 * 【为什么需要】（2026-10-23 发布整理）
 *   发布包里不带作者的 config.json（里面有私有路径、城市、关注列表）。
 *   但 loadConfig() 在没有 config.json 时只返回内置默认值 ——
 *   那些默认值散在代码里，用户看不见也不知道能改什么。
 *
 *   所以：从 config.template.json（带注释、带 null 占位）复制一份出来，
 *   用户打开就是一个"填空表"，而不是对着空目录发愣。
 *
 * 【边界】
 *   ① 只创建，不覆盖 —— 已经有了就一个字都不动
 *   ② 模板缺失不算错 —— 退回内置默认值，插件照常跑
 *   ③ 写失败不算错 —— 同上，不能让启动流程挂掉
 *
 * @returns {'created'|'exists'|'no-template'|'failed'}
 */
export function ensureConfigFile(root) {
  const target = join(root, 'config.json');
  if (existsSync(target)) return 'exists';
  const tpl = join(INSTALLED_ROOT, 'config.template.json');
  if (!existsSync(tpl)) return 'no-template';
  try {
    const raw = readFileSync(tpl, 'utf8');
    writeFileSync(target, raw, 'utf8');
    return 'created';
  } catch {
    return 'failed';
  }
}

export function apply(ctx, config) {
  const ROOT = resolveRoot(config);
  // 先补配置，再读配置 —— 顺序反了就会用内置默认值跑一轮
  const cfgInit = ensureConfigFile(ROOT);
  const cfg = loadConfig(ROOT);
  ensureDirs(ROOT);
  /** 把 root 固化进闭包；指向 appendJsonlAt，不是自己。 */
  const appendJsonl = (name, obj) => appendJsonlAt(ROOT, name, obj);
  if (cfgInit === 'created') {
    appendJsonl('config-init.jsonl', {
      at: new Date().toISOString(),
      where: 'ensureConfigFile',
      message: '已从 config.template.json 生成 config.json，请按 INSTALL.md 填写',
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  智能管家框架（阶段 2 接线）
  //
  //  【接线原则：只加不改】
  //    老的 scanInbox / pending / batch / steer 一行不动，新东西并行加载。
  //    这样"现有 287 项测试一条不能少"才守得住。
  //
  //  【如果新模块起不来】
  //    整个 try 包住。起不来就写一条 errors.jsonl，然后 relay 照老样子跑。
  //    绝不能因为一个新模块把通知功能搞死。
  // ═══════════════════════════════════════════════════════════════
  const framework = {
    ready: false,        // 新模块是否成功加载
    reason: null,        // 没加载起来的原因
    rules: null,         // RulesEngine
    collectors: null,    // CollectorRegistry
    store: null,         // 事件库
    storeKind: null,     // 'storageDomain' | 'file' | 'memory'
    events: 0,           // 本次运行入库的事件数
    lastDecide: null,    // 最近一次规则决策（排障用）
    lastRoute: null,     // 最近一次路由结果（排障用）
    systemCollector: null, // 系统监控采集器实例
    mailCollector: null,   // 邮件采集器实例
    financeCollector: null, // 金融采集器实例
    weatherCollector: null, // 天气采集器实例
    vault: null,           // 凭据库
    setupDone: null,     // 已跑过 setup 的采集器名
    /** 采集器共享状态（lib/state.mjs）。store ready 后才有。 */
    state: null,
    /** storageDomain 领域句柄。拿到才用，否则 null。 */
    domain: null,
    /** 引导配置（lib/init.mjs）最近一次评估结果。 */
    initState: null,
    /** 配置同步检查结果（lib/config-sync.mjs）。 */
    configSync: null,
  };
  /** 采集器定时器：name → Interval。卸载时要清干净。 */
  const collectorTimers = new Map();

  /**
   * storageDomain 句柄与领域 spec。
   *
   * 【为什么提到 apply() 顶层，而不是留在下面的 try 里】
   *   initState() 是独立函数，它要用这两个值。
   *   如果它们声明在下面那个 `try {}` 块里，initState() 看到的是**块作用域外**的
   *   同名变量不存在 → ReferenceError / TDZ。
   *   手册 §6.1 ② 记过同一类坑（lastAliveAt）。
   *   这里提前声明，块内只赋值。
   */
  let storageDomainHandle = null;
  let butlerSpecHandle = null;

  /**
   * 凭据库。数据目录下的 vault.json（密文）+ 环境变量主密钥。
   *
   * 放在最前面建，因为采集器要用。读不到不影响插件启动 —
   * 只是邮件采集器会报 collector-error。
   */
  try {
    framework.vault = new CredentialVault(ROOT);
  } catch {
    framework.vault = null;
  }

  try {
    // ① 规则引擎：读 rules.json，热加载，坏配置保留旧规则
    const rulesPath = join(ROOT, 'rules.json');
    const rules = new RulesEngine(rulesPath, {
      onReload: (spec) => {
        appendJsonl('alerts-local.jsonl', {
          at: new Date().toISOString(), kind: 'rules-reloaded', rules: spec.rules.length,
        });
      },
      onError: (err) => {
        // 坏配置不停摆：只记一条，行为继续按旧规则
        appendJsonl('errors.jsonl', {
          at: new Date().toISOString(), where: 'rules-reload',
          reason: err.reason, detail: err.detail ?? null,
        });
      },
    });
    rules.load();
    rules.watch();
    framework.rules = rules;

    // ② 采集器注册表
    framework.collectors = new CollectorRegistry({
      onError: ({ name, error }) => {
        appendJsonl('errors.jsonl', {
          at: new Date().toISOString(), where: `collector:${name}`, message: error,
        });
      },
    });

    // ②.5 注册内置采集器：系统监控
    //
    // 【这是"监视器成为插件的一部分"那一步】
    //   以前 monitor 是独立进程，relay 读它写的心跳文件；它一死采集就断。
    //   现在采集在插件进程内跑，插件活着 = 采集活着。
    //
    // 【配置位置】config.json 的 sources.system（可选，缺了用默认值）
    //   { "sources": { "system": { "enabled": true, "intervalSec": 60, ... } } }
    if (cfg.sources?.system?.enabled !== false) {
      try {
        const sysCollector = createSystemCollector(cfg.sources?.system ?? {});
        framework.collectors.register(sysCollector);
        // setup 是 async，但这里不 await —— register 只存引用。
        // 真正的 setup 放在 invokeCollector 第一次跑之前。
        framework.systemCollector = sysCollector;
      } catch (e) {
        appendJsonl('errors.jsonl', {
          at: new Date().toISOString(), where: 'system-collector-register', message: String(e?.message ?? e),
        });
      }
    }

    // ②.6 注册内置采集器：邮件
    //
    // 【配置位置】config.json 的 sources.mail
    //   {
    //     "enabled": true,
    //     "boxes": [
    //       { "address": "xxx@qq.com",  "credential": "relay-qq-mail" },
    //       { "address": "xxx@163.com", "credential": "relay-163-mail" }
    //     ]
    //   }
    //
    // 【凭据怎么来】
    //   boxes[].credential 只是个名字，不是密码。
    //   真正的值从 CredentialVault 取（环境变量或 vault.json 密文）。
    //   这里把读凭据的函数塞进采集器 env —— 采集器本身不管加密。
    if (cfg.sources?.mail?.enabled !== false && Array.isArray(cfg.sources?.mail?.boxes) && cfg.sources.mail.boxes.length > 0) {
      try {
        const mailCollector = createMailCollector(cfg.sources.mail);
        framework.collectors.register(mailCollector);
        framework.mailCollector = mailCollector;
      } catch (e) {
        appendJsonl('errors.jsonl', {
          at: new Date().toISOString(), where: 'mail-collector-register', message: String(e?.message ?? e),
        });
      }
    }

    // ②.7 注册内置采集器：金融
    //
    // 【配置位置】data\relay\config.json 的 sources.finance
    //   {
    //     "enabled": true,
    //     "codes": ["600362", { "code": "000001", "name": "平安银行" }],
    //     "at": "09:00",
    //     "maxAgeDays": 7,
    //     "dbPath": "D:\\data\\quant.db"   ← 改成你自己的库路径
    //   }
    //
    // 【默认关闭】
    //   关注列表是 维护者 自己定的，不该由代码猜。
    //   没配 codes 的采集器跑起来只会每 30 分钟空转一次，所以宁可先不注册。
    if (cfg.sources?.finance?.enabled !== false && Array.isArray(cfg.sources?.finance?.codes) && cfg.sources.finance.codes.length > 0) {
      try {
        const finCollector = createFinanceCollector(cfg.sources.finance);
        framework.collectors.register(finCollector);
        framework.financeCollector = finCollector;
      } catch (e) {
        appendJsonl('errors.jsonl', {
          at: new Date().toISOString(), where: 'finance-collector-register', message: String(e?.message ?? e),
        });
      }
    }

    // ②.8 注册内置采集器：天气
    //
    // 【配置位置】config.json 的 sources.weather
    //   {
    //     "enabled": true,
    //     "locations": ["哈尔滨", "上海"],
    //     "refreshHours": 6,
    //     "keepDays": 10,
    //     "thresholds": { "warnC": 5, "criticalC": 8 },
    //     "dailyLevel": "info"
    //   }
    //
    // 【默认关闭】
    //   和金融一样：位置是用户的事，不该由代码猜。
    //   用户在 init 里定了位置、确认启用之后才注册。
    if (cfg.sources?.weather?.enabled === true) {
      try {
        const weatherCollector = createWeatherCollector(cfg.sources.weather);
        framework.collectors.register(weatherCollector);
        framework.weatherCollector = weatherCollector;
      } catch (e) {
        appendJsonl('errors.jsonl', {
          at: new Date().toISOString(), where: 'weather-collector-register', message: String(e?.message ?? e),
        });
      }
    }

    // ③ 事件库：优先 storageDomain，拿不到就退文件，再不行退内存
    //
    // 【2026-10-23 改动：真正接上 storageDomain】
    //   以前这里只有 `sd = ctx.get('storageDomain')`，而 inject 里没声明这个服务，
    //   所以永远拿到 undefined，StorageDomainStore 写了却从没被用过。
    //   手册（dsh编码手册 §1.3 铁律③）：「ctx.get() 不是软探测，绕不过注入门」。
    //   现在 inject 里声明了 storageDomain，这条路径才真的通。
    //
    //   拿不到时仍然降级 —— createStore 的 catch 会退 FileStore，功能不停摆。
    let sd = null;
    try {
      sd = ctx.storageDomain ?? ctx.get?.('storageDomain') ?? null;
    } catch {
      // 某些 ctx 实现的 get 会抛，接住当作没有
      sd = null;
    }
    storageDomainHandle = sd;
    // 领域 spec。storageDomain 存在才需要；拿不到就传 null，createStore 会退文件。
    let butlerSpec = null;
    if (sd !== null) {
      try {
        // defineDomain / domainTable 从 storage-domain 包的导出拿不到（relay 零依赖），
        // 但它们本身只是"校验 + 包一层"，语义简单到可以就地实现：
        //   defineDomain(spec)  —— 校验 name/version/表名，原样返回
        //   domainTable(schema) —— 原样包成 { valueSchema: schema }
        // 见 lib/butler-spec.mjs 顶部说明。
        const defineDomain = (spec) => spec;
        const domainTable = (schema) => ({ valueSchema: schema });
        butlerSpec = createButlerSpec(defineDomain, domainTable);
      } catch (e) {
        appendJsonl('errors.jsonl', {
          at: new Date().toISOString(), where: 'butler-spec', message: String(e?.message ?? e),
        });
        butlerSpec = null;
      }
    }
    butlerSpecHandle = butlerSpec;
    framework.storeKind = sd !== null && butlerSpec !== null ? 'storageDomain' : 'file';
    createStore({
      storageDomain: sd,
      spec: butlerSpec,
      rootDir: ROOT,
      retention: { ...DEFAULT_RETENTION, ...(cfg.retention ?? {}) },
    })
      .then((r) => {
        framework.store = r.store;
        framework.storeKind = r.kind;
        framework.ready = true;
        appendJsonl('alerts-local.jsonl', {
          at: new Date().toISOString(), kind: 'framework-ready', store: r.kind,
          fallbackReason: r.fallbackReason ?? null,
        });
        return initState().catch((e) => {
          appendJsonl('errors.jsonl', {
            at: new Date().toISOString(), where: 'state-init', message: String(e?.message ?? e),
          });
        });
      })
      .catch((e) => {
        framework.reason = String(e?.message ?? e);
        appendJsonl('errors.jsonl', {
          at: new Date().toISOString(), where: 'framework-init', message: framework.reason,
        });
      });
  } catch (e) {
    framework.reason = String(e?.message ?? e);
    appendJsonl('errors.jsonl', {
      at: new Date().toISOString(), where: 'framework-init-sync', message: framework.reason,
    });
  }

  /**
   * 框架就绪后的第二步：打开领域、建状态后端、跑引导配置。
   *
   * 【为什么单独一只函数】
   *   createStore() 是异步的，它的 .then 里才知道 store 成没成。
   *   而 domain 和 state 都依赖 store —— 所以只能在这个回调里做。
   */
  async function initState() {
    // ① 拿 storageDomain 的域句柄。
    //
    //   【必须复用，不能再 open 一次】（2026-10-23 实测踩到）
    //     storageDomain 一个域名只能 open 一次，第二次报 already-open。
    //     createStore() 建事件库时已经 open 过这个域了，
    //     这里如果自己再 open —— 必然失败，state 退回文件后端。
    //     实测日志：{"where":"domain-open","message":"domain 'butler' is already open"}
    //     所以先问 store 要现成的句柄（StorageDomainStore.currentDomain()）。
    let reuse = null;
    try {
      reuse = framework.store?.currentDomain?.() ?? null;
    } catch {
      reuse = null;
    }

    if (reuse !== null) {
      framework.domain = reuse;
      appendJsonl('alerts-local.jsonl', {
        at: new Date().toISOString(), kind: 'domain-reused',
        domain: butlerSpecHandle?.name ?? 'butler',
        tables: butlerSpecHandle !== null ? Object.keys(butlerSpecHandle.tables) : null,
      });
    } else if (storageDomainHandle !== null && butlerSpecHandle !== null && typeof storageDomainHandle.open === 'function') {
      // 兜底：store 不是 storageDomain 后端（比如退回了文件），但我们仍想用域
      try {
        framework.domain = await storageDomainHandle.open(butlerSpecHandle);
        appendJsonl('alerts-local.jsonl', {
          at: new Date().toISOString(), kind: 'domain-open', domain: butlerSpecHandle.name,
          tables: Object.keys(butlerSpecHandle.tables),
        });
      } catch (e) {
        // already-open 在这里属于正常情况（别的消费者先开了），不是故障。
        appendJsonl('alerts-local.jsonl', {
          at: new Date().toISOString(), kind: 'domain-open-skip', message: String(e?.message ?? e),
        });
        framework.domain = null;
      }
    }

    // ② 状态后端：domain 优先，退文件
    framework.state = await createStateBackend({
      store: framework.store,
      rootDir: ROOT,
      domain: framework.domain,
    });
    appendJsonl('alerts-local.jsonl', {
      at: new Date().toISOString(), kind: 'state-ready', backend: framework.state.kind,
    });

    // ③ 跑一次引导配置评估
    await runInitCheck();

    // ④ 配置同步检查（维护者 2026-10-23：保住 + 检查 + 由 relay 发起申请）
    await runConfigSyncCheck();
  }

  /**
   * 检查 config.json 与 state 镜像是否同步。
   *
   * 【为什么不一致时不自动改】（维护者 原话：「relay不动吧，没必要啊，框架动什么？」）
   *   框架不该替用户决定哪份是对的。运行以 state 为准，功能照常；
   *   只产一条 warn 说清楚哪儿不同步，由用户决定。
   *
   * 【同步顺序】
   *   ① state 里没有镜像（第一次）→ 用 config.json 建镜像
   *   ② config.json 里的用户字段覆盖镜像（维护者：手改肉眼可见的那份应生效）
   *   ③ 比对，不同则产事件
   */
  async function runConfigSyncCheck() {
    if (framework.state === null) return { skipped: 'no-state' };
    try {
      // 【必须是 ROOT，不是 INSTALLED_ROOT】（2026-10-23 踩到）
      //   relay 真正读的配置是 `loadConfig(ROOT)`（第 261 行），
      //   而 ROOT 来自 cordis.patch.yml 的 `root`（这里是 
      //   我第一版写成 INSTALLED_ROOT（插件安装目录）——
      //   于是同步检查盯的是插件目录那份模板，改它不生效，
      //   init/weather 全部读的旧配置：天气不启动、init 用默认值（位置阻塞）。
      //   教训：一个进程只有一处 `ROOT` 是真配置源，别被"看起来像配置"的文件骗。
      const configPath = join(ROOT, 'config.json');
      const MIRROR_KEY = 'config:mirror';

      // ① 第一次：拿 config.json 建镜像
      let mirror = framework.state.get(MIRROR_KEY, null);
      const cur = readConfigFile(configPath);
      if (mirror === null && cur.exists && cur.data !== null) {
        mirror = pickSynced(cur.data);
        framework.state.set(MIRROR_KEY, mirror);
        appendJsonl('alerts-local.jsonl', {
          at: new Date().toISOString(), kind: 'config-mirror-created', path: configPath,
        });
      }

      // ② config.json 里用户改过的字段以它为准，回写镜像
      //
      //   【为什么这个方向】
      //     config.json 是用户看得见、手改得到的文件。
      //     state 用户看不见，不该压过用户的显式改动。
      //     反过来，relay 在 init 里改的配置会**同时**写两份，所以不会丢。
      if (cur.exists && cur.data !== null && mirror !== null) {
        const fromFile = pickSynced(cur.data);
        const merged = mergeDeep(mirror, fromFile);
        framework.state.set(MIRROR_KEY, merged);
        mirror = merged;
      }

      // ③ 比对（此时若还有差异，说明某处写入没落全 —— 那正是要报的）
      const r = checkSync(configPath, framework.state, MIRROR_KEY);
      framework.configSync = r;
      const evt = buildSyncEvent(r);
      if (evt !== null) {
        await routeEvent(evt);
        appendJsonl('alerts-local.jsonl', {
          at: new Date().toISOString(), kind: 'config-out-of-sync',
          diffs: r.diffs.map((d) => d.field),
        });
      }
      return r;
    } catch (e) {
      appendJsonl('errors.jsonl', {
        at: new Date().toISOString(), where: 'config-sync', message: String(e?.message ?? e),
      });
      return { status: 'error', detail: String(e?.message ?? e) };
    }
  }

  /**
   * 把一份配置**同时**写进 state 和 config.json。
   *
   * 【存在的意义】
   *   用户改配置必须两份一起改，否则就不一致。
   *   relay 自己不在启动时乱调它 —— 只有用户明确要求改时才调。
   *
   * @param patch 要改的部分，如 { sources: { weather: { locations: ['哈尔滨'] } } }
   */
  async function saveConfig(patch) {
    if (framework.state === null) return { ok: false, reason: 'no-state' };
    // 同 runConfigSyncCheck：必须是 ROOT，relay 只读那里。
    const configPath = join(ROOT, 'config.json');
    const MIRROR_KEY = 'config:mirror';
    const cur = framework.state.get(MIRROR_KEY, null) ?? {};
    const next = mergeDeep(cur, patch);
    framework.state.set(MIRROR_KEY, next);
    const w = writeConfigFile(configPath, next, '~/.dsh/storages/butler (state 表, key=config:mirror)');
    appendJsonl('alerts-local.jsonl', {
      at: new Date().toISOString(), kind: 'config-saved', path: configPath,
    });
    return { ok: true, ...w, config: pickSynced(next) };
  }

  /**
   * 跑引导配置评估，产 issue 事件（如果有待配置项）。
   *
   * 【三态判据】（维护者 2026-10-23）
   *   null  = 还没处理 → 提醒
   *   true  = 做了
   *   false = 用户明确跳过
   *   只要还有 null 就提醒；全 true/false 就静默。
   *
   * 【怎么叫人】
   *   这里不直接调 followup —— 拿不到 agent（手册 §2.1）。
   *   产一条事件，交给 routeEvent → 规则 → pending → pre-step / trySteer 那条现成链路。
   */
  async function runInitCheck() {
    if (framework.state === null) return { skipped: 'no-state' };
    try {
      const env = {
        dataDir: () => ROOT,
        checkDirWritable: (dir) => {
          try {
            // 只探测，不写文件：能访问目录就算可写（真写测试文件会污染数据目录）
            if (!existsSync(dir)) return { ok: false, reason: '目录不存在' };
            return { ok: true };
          } catch (e) {
            return { ok: false, reason: String(e?.message ?? e) };
          }
        },
        hintPath: () => cfg.init?.hintPath ?? null,
        readHintVersion: (p) => readHintVersion(p),
        /**
         * 按 agent 的实际加载顺序，收集所有存在的 AGENTS.md。
         *
         * 【顺序 = dsh-agent-instructions 的真实顺序】
         *   ① $DSH_HOME/AGENTS.md            （或 ~/.dsh，来自 env）
         *   ② <agentsHome>/AGENTS.md         （$DSH_AGENTS_HOME 或 ~/.agents）
         *   ③ 项目根 → 会话 cwd 的每个目录    （从宽泛到具体）
         *
         * 【为什么不再只猜 $DSH_HOME】
         *   2026-10-23 维护者 指出：他给的文件在项目链（工作区）里，
         *   而我第一版只查 $DSH_HOME 就报「找不到」。
         *   看 agent 实际读什么，比猜默认地址可靠。
         *
         * 【项目链怎么定】
         *   以 relay 的 ROOT（数据目录）和进程 cwd 为锚，往上走到盘根，
         *   收集沿途的 AGENTS.md。**不要求 .git** —— 维护者 的工作区没有 git 也是一个整体。
         *   这一步是只读的目录列举，不 spawn。
         */
        findHintFiles: () => {
          const out = [];
          const seen = new Set();
          const push = (p, layer) => {
            const key = p.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            if (!existsSync(p)) return;
            const r = readHintVersion(p);
            out.push({ path: p, layer, version: r.version });
          };

          // ① 用户全局
          const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
          push(join(dshHome, 'AGENTS.md'), 'global');

          // ② 共享 agents 根
          const agentsHome = process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents');
          push(join(agentsHome, 'AGENTS.md'), 'shared');

          // ③ 项目链：从 cwd 往上，到盘根为止
          //    同时把 ROOT（数据目录）所在链也带上 —— 插件可能跑在别的目录
          for (const start of [process.cwd(), ROOT]) {
            let cur = start;
            for (let i = 0; i < 12; i++) {
              push(join(cur, 'AGENTS.md'), i === 0 ? 'project-cwd' : `project-${i}`);
              const parent = dirname(cur);
              if (parent === cur) break;
              cur = parent;
            }
          }
          return out;
        },
        hintVersion: () => HINT_VERSION,
        locations: () => {
          const v = cfg.sources?.weather?.locations;
          return Array.isArray(v) && v.length > 0 ? v : [];
        },
        moduleList: () => {
          const s = cfg.sources ?? {};
          return ['system', 'mail', 'finance', 'weather']
            .filter((n) => s[n] !== undefined)
            .map((n) => ({ name: n, enabled: s[n].enabled !== false }));
        },
        checkLatestVersion: () => checkLatestVersion(),
      };
      const r = await evaluateInit(framework.state, env);
      framework.initState = {
        complete: r.complete,
        items: r.items.map((it) => ({ key: it.key, value: it.value, blocking: it.blocking, detail: it.detail })),
      };
      // wakeOnIncomplete=false 时，把 critical 降成 info（只进窗口，不打扰）
      if (r.event !== null && cfg.init?.wakeOnIncomplete === false && r.event.level === 'critical') {
        r.event.level = 'info';
      }
      if (r.event !== null) {
        await routeEvent(r.event);
        appendJsonl('alerts-local.jsonl', {
          at: new Date().toISOString(), kind: 'init-pending',
          pending: r.items.filter((it) => it.value === null).map((it) => it.key),
        });
        // 【产出后立刻试着唤醒】
        //   routeEvent 进来时若 sessionId 还是 null，消息只会进 pending。
        //   而 agent/created 可能已经错过了（apply 期间不会触发）。
        //   所以这里再主动捞一次 agent 并补发 —— 否则又是"消息烂在队列"。
        try {
          const roots = ctx.agents?.roots?.() ?? [];
          if (roots.length > 0) {
            if (sessionId === null) sessionId = roots[0].id;
            flushPendingOnSession(roots[0]);
          }
        } catch { /* 拿不到就等 agent/created */ }
      }
      return framework.initState;
    } catch (e) {
      appendJsonl('errors.jsonl', {
        at: new Date().toISOString(), where: 'init-check', message: String(e?.message ?? e),
      });
      return { error: String(e?.message ?? e) };
    }
  }

  /**
   * 查 GitHub 有没有新版。**一天最多一次**。
   *
   * 【为什么查】
   *   维护者 2026-10-23：「可以检测版本，但我们没渠道推，难道检测 github 吗，倒也是可以的哦」
   *   查得到就告诉你；查不到（断网/限流/GitHub 挂了）就静默。
   *   这项**不阻塞**引导配置 —— 永远不该因为它把用户卡住。
   *
   * 【怎么算"一天一次"】
   *   state 里记 `version:checkedAt`，同一个本地日期就跳过。
   */
  async function checkLatestVersion() {
    const today = new Date().toISOString().slice(0, 10);
    const last = framework.state?.get?.('version:checkedAt', null);
    const cached = framework.state?.get?.('version:latest', null);
    const current = pluginVersion();
    if (last === today) {
      return { current, latest: cached, newer: cached !== null && cached !== current };
    }
    if (cfg.init?.checkGitHub === false) {
      return { current, latest: null, newer: false };
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5_000);
      const r = await fetch('https://api.github.com/repos/SteelUnion/dsh-relay/releases/latest', {
        signal: ctrl.signal,
        headers: { 'user-agent': 'dsh-relay' },
      });
      clearTimeout(timer);
      if (!r.ok) return { current, latest: null, error: `HTTP ${r.status}` };
      const j = await r.json();
      const latest = String(j?.tag_name ?? '').replace(/^v/, '') || null;
      framework.state?.set?.('version:checkedAt', today);
      if (latest !== null) framework.state?.set?.('version:latest', latest);
      return { current, latest, newer: latest !== null && latest !== current };
    } catch (e) {
      // 失败静默：不写 checkedAt，下次启动还会再试
      return { current, latest: null, error: String(e?.message ?? e) };
    }
  }

  /** 读本插件自己的版本号。读不到返回 '0.0.0'。 */
  function pluginVersion() {
    try {
      const pkg = JSON.parse(readFileSync(join(INSTALLED_ROOT, 'package.json'), 'utf8'));
      return String(pkg.version ?? '0.0.0');
    } catch {
      return '0.0.0';
    }
  }

  /**
   * 把一条老消息升级成事件，按规则决策，入库。
   *
   * 【它现在只做"记录"，不做"投递"】
   *   投递仍走老路径（scanInbox 里那套 pending / batch / steer）。
   *   等规则引擎跑稳了，再让投递也听规则。
   *   这就是"一步一测"。
   */
  async function ingestAsEvent(msg) {
    const evt = upgradeLegacyMessage(msg);
    try {
      if (framework.store !== null) {
        const r = await framework.store.put(evt);
        if (r.ok) framework.events += 1;
      }
    } catch (e) {
      appendJsonl('errors.jsonl', {
        at: new Date().toISOString(), where: 'event-put', message: String(e?.message ?? e),
      });
    }
    if (framework.rules !== null) {
      try {
        framework.lastDecide = framework.rules.decide(evt);
      } catch (e) {
        appendJsonl('errors.jsonl', {
          at: new Date().toISOString(), where: 'rules-decide', message: String(e?.message ?? e),
        });
      }
    }
    return evt;
  }

  /**
   * 收集器产出的**新格式事件**入库 + 按规则路由。
   *
   * 【和老消息的区别】
   *   老消息走 ingestAsEvent → 只记录，投递听老配置（delivery.levels）。
   *   新事件走这里 → 入库 + 按 rules.json 决策，**真的会投递**。
   *
   * 【投递怎么走】
   *   决策出来的 channels 里：
   *     'wake'   → 进 pending，下一轮 pre-step 注入（和 critical 一样）
   *     'batch'  → 进 batch 队列，攒撮
   *     'window' → 只入库，不进会话
   *   'archive' 同理只入库。
   *
   * 【为什么复用老队列】
   *   不另起一套投递，避免两条路分叉。老队列的限流/冷却/去重都还在。
   */
  async function routeEvent(evt) {
    // ⓪ 入库前兜底补 id。
    //
    //   【为什么必须】（2026-10-23 踩到并炸了整个域）
    //     事件库的存储 key 就是 evt.id。任何一条没有 id 的事件会被写成
    //     key = 字面量 'undefined'；而 storageDomain **打开时要校验每一条已存记录**，
    //     那条坏记录会让整个域 open 失败 —— 连带 state 全部退回文件后端。
    //     实测日志：stored record 'undefined' in table 'events' does not match its schema
    //
    //     event.mjs 的 validateEvent() 会自动补 id，但这条路（采集器 → routeEvent）
    //     是直接入库、不走 validateEvent 的。所以在这里兜一次，
    //     让"漏了 id"变成不可能入库，而不是等它污染磁盘。
    if (evt === null || typeof evt !== 'object') return evt;
    if (typeof evt.id !== 'string' || evt.id === '') {
      const bad = { source: evt.source, kind: evt.kind };
      evt = { ...evt, id: newEventId(evt.source ?? 'evt') };
      appendJsonl('alerts-local.jsonl', {
        at: new Date().toISOString(), kind: 'event-id-patched', ...bad, newId: evt.id,
      });
    }
    // ① 入库
    try {
      if (framework.store !== null) {
        const r = await framework.store.put(evt);
        if (r.ok) framework.events += 1;
      }
    } catch (e) {
      appendJsonl('errors.jsonl', {
        at: new Date().toISOString(), where: 'event-put', message: String(e?.message ?? e),
      });
    }

    // ② 规则决策
    let decision = null;
    try {
      decision = framework.rules?.decide(evt) ?? null;
      framework.lastDecide = decision;
    } catch (e) {
      appendJsonl('errors.jsonl', {
        at: new Date().toISOString(), where: 'rules-decide', message: String(e?.message ?? e),
      });
      return evt;
    }
    if (decision === null) return evt;

    framework.lastRoute = { id: evt.id, source: evt.source, kind: evt.kind, channels: decision.channels, ruleId: decision.ruleId };

    // ③ 只进窗口/存档 → 到此为止
    const channels = decision.channels ?? [];
    if (!channels.includes('wake') && !channels.includes('batch')) return evt;

    // ④ 转成老消息形状，复用老队列
    //    老队列认 msg.peer / msg.level / msg.title / msg.body / msg.dedupeKey
    const asMsg = {
      peer: evt.source,
      level: evt.level,
      title: evt.summary,
      body: '',
      dedupeKey: evt.dedupeKey,
      cooldownSec: 300,
      at: evt.at,
    };
    const fp = fingerprint(asMsg);

    // 已注入过就不再重复
    if (injected.has(fp)) return evt;

    if (channels.includes('wake')) {
      // 叫醒：和老 critical 同一条路
      if (trySteer(asMsg)) {
        injected.add(fp);
        stats.steered++;
        appendJsonl('steered.jsonl', {
          at: new Date().toISOString(), via: 'collector', source: evt.source, kind: evt.kind,
        });
      } else {
        pending.push({ msg: asMsg, fp });
        stats.queued++;
      }
      return evt;
    }

    if (channels.includes('batch')) {
      const r = batchPush({ msg: asMsg, fp }, stats);
      if (r === 'disabled') {
        pending.push({ msg: asMsg, fp });
        stats.queued++;
      } else if (r === 'batching') {
        stats.batchedQueued = (stats.batchedQueued ?? 0) + 1;
      }
    }
    return evt;
  }

  /** 采集器跑一次并把事件路由出去。 */
  async function runCollectorOnce(name) {
    if (framework.collectors === null || framework.store === null) return { events: 0, error: 'not-ready' };
    const env = {
      now: () => new Date(),
      log: () => {},
      /**
       * 采集器共享状态。
       *
       * 【2026-10-23：原来是空壳】
       *   `{ get: () => undefined, set: () => {}, del: () => {} }` —— 什么也没存。
       *   后果：finance 的 lastProducedDate 每次插件重载都丢，重载就再发一遍行情。
       *   现在接 StateBackend（lib/state.mjs）：storageDomain 优先，退文件，再退内存。
       *
       * 接口保持**同步**——这是既有契约（finance.mjs / system.mjs 都同步取值）。
       * 内存是权威，磁盘是投影；写排队走存储层自己的写入链。
       */
      state: framework.state,
      config: cfg.sources?.[name] ?? {},
      /**
       * 采集体检记录。每一轮都写，不只有告警时写。
       *
       * 【为什么要有】
       *   2026-10-21 下午内存从 88% 冲到 97.7% 又回落到 93%，告警发了，
       *   但事后查不出趋势 —— 因为只记了超阈值那一刻。
       *   有了这个文件，"采集器还活着吗""它看到了什么"随时能查。
       */
      recordRun: (snapshot) => {
        try {
          appendJsonl('collector-runs.jsonl', { collector: name, ...snapshot });
        } catch {
          /* 记录失败不影响采集 */
        }
      },
      /**
       * 读凭据。采集器只知道名字（如 `relay-qq-mail`），不知道密码。
       *
       * 【为什么插件自己读不到 Windows 凭据管理器】
       *   插件运行时不能 spawn（硬边界），而 CredRead 必须走外部调用。
       *   所以用 CredentialVault：环境变量 或 vault.json 密文。
       *   详见 lib/credentials.mjs 顶部的威胁模型说明。
       */
      readCredential: framework.vault !== null
        ? makeCredentialReader(framework.vault)
        : async () => { throw new Error('凭据库未初始化'); },
    };
    // setup 只跑一次
    const mod = framework.collectors.get(name);
    if (mod?.setup !== undefined && framework.setupDone?.has(name) !== true) {
      framework.setupDone ??= new Set();
      framework.setupDone.add(name);
      try { await mod.setup(env); } catch { /* setup 失败不阻塞 */ }
    }
    const out = await framework.collectors.runOne(name, env);
    if (out.error) {
      appendJsonl('errors.jsonl', {
        at: new Date().toISOString(), where: `collector-run:${name}`, message: out.error,
      });
    }
    for (const evt of out.events) {
      await routeEvent(evt);
    }
    return { events: out.events.length, error: out.error };
  }

  /**
   * 小窗口数据源：按源计数。
   * 窗口还没做，先把接口留出来，做了直接接。
   */
  async function summary(dateStr = null) {
    if (framework.store === null) {
      return { ready: false, reason: framework.reason ?? 'not-initialized', total: 0, sources: [] };
    }
    const day = dateStr ?? new Date().toISOString().slice(0, 10);
    const events = await framework.store.byDay(day);
    const labels = cfg.labels ?? {};
    return { ready: true, date: day, ...summarizeBySource(events, labels) };
  }

  const deduper = new Deduper();
  /** 待注入队列：已判定该说，等下一轮 pre-step 时注入。 */
  const pending = [];
  /** 已注入过的指纹，防重复。 */
  const injected = new Set();
  /** 对端监管状态：peerId → 上次发问时间 */
  const askedAt = new Map();

  /**
   * 待提问队列：supervise() 只往里塞，真正的 ask() 在 pre-step 里发。
   *
   * 为什么不直接在 supervise() 里问：
   *   ask() 要携带活着的 agent 才能找到应答器（dsh-user-questions 里
   *   `assertLiveRoot` + `scopeTarget(agent, agent)` 的 scope 路由）。
   *   定时器线程里没有 agent，所以只会拿到 NO_PROVIDER。
   *
   * 上限 5：多出来的合并成「另有 N 条」，不逐条问。
   * 依据设计局 §7.3「宁可不问，不可烦人」。
   */
  const questionQueue = [];
  const QUESTION_QUEUE_MAX = 5;
  /**
   * 提问超时。取 120 秒，与 dsh-tool-ask-user 的 Config.timeout 默认值一致
   * （读源码确认：`timeout: ...default(120)`）。
   */
  const QUESTION_TIMEOUT_MS = 120_000;

  let lastScanAt = 0;
  let lastAliveAt = 0;
  let stopped = false;

  /**
   * 根会话 id。定时器里 steer 需要 agent，而 agent 只能通过 ctx.agents.get(id) 拿。
   * 只记第一个（根本会话），不理会子会话。
   * 依据：dsh创造编码手册 §八（send/steer 源码）、relay主动通知方案 §四改动2。
   */
  let sessionId = null;

  /**
   * 主动通知的限流状态。
   * 依据：relay主动通知方案 §三 分层策略 + 流量控制。
   * - 超出任一上限 → 降级 inject（不丢消息，下次说话可见）
   * - 同一 dedupeKey 在合并窗内不重复叫
   */
  const steerState = {
    turnCount: 0,      // 本轮已叫醒次数
    hourCount: 0,      // 本小时已叫醒次数
    hourStart: 0,      // 本小时起点（ms）
    lastSteerAt: 0,    // 上次叫醒时间（ms）
    lastKey: null,     // 上次叫醒的话题键
  };

  /**
   * turn-stopping 续跑计数。
   *
   * 【为什么要这个】官方在 `agent/turn-stopping` 上**没有内置续跑保护**。
   * 监听者每次都在收尾时插一条，回合就永远不关 —— 俗称无限续跑，
   * `dsh-hooks-claude-code` 踩过这个坑。
   *
   * 上限取 2：一次回合内最多因为外部消息多续两步，
   * 再多就放行让回合正常结束，剩余消息留给下一轮。
   */
  const TURN_STOP_MAX = 2;
  let turnStopCount = 0;

  /**
   * HTTP 服务器句柄。
   * 【声明必须在 dispose 钩子注册之前】否则卸载时是 TDZ 报错 ——
   * 手册 §6.1 ② 记过同一类坑（lastAliveAt 声明在使用之后）。
   */
  let httpServer = null;

  // ---------------------------------------------------------------- 主动通知（steer）
  //
  // 依据：dsh创造编码手册 §八 —— agent-loop 源码实测
  //   inject(msg) = send(msg, 'next-step', false)  不唤醒
  //   steer(msg)  = send(msg, 'next-step', true)   唤醒
  //   且 wakeDriver 在 phase.kind !== 'idle' 时直接返回 —— 忙则只排队，不打断。
  //
  // 分层策略（relay主动通知方案 §三）：
  //   走 steer：critical / 任务完成 / 卡住 / 出事故 / 崩溃恢复
  //   走 inject：warn / info / 进度 / 重复 / 小事
  //   永不 steer：外发 / 不可逆 / 替用户决定

  /** 读游戏模式标记文件是否存在。存在 = 用户玩游戏，压制 info/warn。 */
  function gameModeOn() {
    const g = cfg.gameMode;
    if (g === undefined || g.enabled === false) return false;
    const flag = join(ROOT, g.flagFile ?? 'game-mode.on');
    try {
      if (!existsSync(flag)) return false;
      // 自动失效：文件 mtime 超过 autoExpireSec 就当没有
      const st = statSync(flag);
      const maxAge = Number(g.autoExpireSec ?? 21600) * 1000;
      if (Date.now() - st.mtimeMs > maxAge) return false;
      return true;
    } catch {
      return false;
    }
  }

  /** 该消息是否值得叫醒用户。级别 → channel 全走配置。 */
  function worthWaking(msg) {
    const spec = deliveryOf(cfg, msg.level);
    if (spec.channel !== 'wake') return false;
    // 游戏模式：wake 通道的 warn/info 被压制，critical 照穿
    if (gameModeOn() && spec.channel === 'wake' && msg.level !== 'critical') return false;
    return true;
  }

  /** 限流检查。通过返回 null，被拦返回原因字符串。 */
  function steerBudget(msg) {
    const rate = cfg.rate ?? {};
    const spec = deliveryOf(cfg, msg.level);
    const now = Date.now();

    // 小时窗口滚动
    if (now - steerState.hourStart >= 3_600_000) {
      steerState.hourStart = now;
      steerState.hourCount = 0;
    }
    const maxPerTurn = Number(rate.maxPerTurn ?? 2);
    const maxPerHour = Number(rate.maxPerHour ?? 5);
    if (steerState.turnCount >= maxPerTurn) return 'per-turn-limit';
    if (steerState.hourCount >= maxPerHour) return 'per-hour-limit';

    // 全局冷却：任何两条唤醒之间至少间隔 globalCooldownSec
    const globalCd = Number(rate.globalCooldownSec ?? 0) * 1000;
    if (globalCd > 0 && now - steerState.lastSteerAt < globalCd) return 'global-cooldown';

    // 同话题合并窗 + 级别冷却
    const key = `${msg.peer}:${msg.level}:${msg.title}`;
    const mergeMs = Number(spec.mergeWindowSec ?? 60) * 1000;
    if (mergeMs > 0 && steerState.lastKey === key && now - steerState.lastSteerAt < mergeMs) {
      return 'merge-window';
    }
    const cdMs = Number(spec.cooldownSec ?? 300) * 1000;
    if (cdMs > 0 && steerState.lastKey === key && now - steerState.lastSteerAt < cdMs) {
      return 'cooldown';
    }
    return null;
  }

  /**
   * 尝试用 steer 叫醒。成功返回 true；任何失败都返回 false，由调用方降级 inject。
   *
   * 【五个失败路径全部降级，一个都不静默】—— dsh编码手册 §5.1 ⑨⑩ 的教训：
   *   1. sessionId 为 null
   *   2. ctx.agents.get() 返回 undefined
   *   3. agent.steer 不是函数
   *   4. steer 抛错
   *   5. 游戏模式/限流拦下
   *
   * 【idle 用 followup，busy 用 steer】—— 外部审查（V4.1）第②条：
   *   steer 的语义是"插话到当前轮次的下一步"，设计场景是 agent 正在运行。
   *   空闲时应 followup（开完整新轮次），这才是"开启对话"的正确语义。
   *   两者都会 wakeDriver，但契约不同；用错不会坏，但偏离官方语义边界。
   */
  function trySteer(msg) {
    if (sessionId === null) return false;
    if (!worthWaking(msg)) return false;
    const blocked = steerBudget(msg);
    if (blocked !== null) {
      appendJsonl('steer-skipped.jsonl', {
        at: new Date().toISOString(),
        peer: msg.peer, level: msg.level, title: msg.title, reason: blocked,
      });
      return false;
    }

    let agent;
    try {
      agent = ctx.agents.get(sessionId);
    } catch {
      return false;
    }
    if (agent === undefined || agent === null) return false;

    // idle → followup（开新轮次）；busy → steer（插下一步）
    const idle = typeof agent.status === 'string'
      ? agent.status === 'idle'
      : false;
    const useFollow = idle && typeof agent.followup === 'function';
    const method = useFollow ? 'followup' : 'steer';
    if (typeof agent[method] !== 'function') return false;

    try {
      agent[method]({
        // 【必须有 id】宿主不补，缺了整份会话拒载（2026-10-17 实测）
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: render(msg, deliveryOf(cfg, msg.level).titleChars) }],
        // 【必须是 schedule】不能用 'user'，那会重置 confirm-gate 计数
        // 实测 dsh-session/lib/index.js:1205 —— user/message 的 kind 只要求
        // 非空字符串，无白名单；丢弃风险不成立。
        source: { kind: 'schedule' },
      });
    } catch (e) {
      appendJsonl('errors.jsonl', {
        at: new Date().toISOString(), where: method,
        peer: msg.peer, message: String(e?.message ?? e),
      });
      return false;
    }

    steerState.hourCount++;
    steerState.turnCount++;
    steerState.lastSteerAt = Date.now();
    steerState.lastKey = `${msg.peer}:${msg.level}:${msg.title}`;
    appendJsonl('steered.jsonl', {
      at: new Date().toISOString(),
      peer: msg.peer, level: msg.level, title: msg.title, method,
    });
    return true;
  }

  // ---------------------------------------------------------------- 收件

  /**
   * 扫一次 inbox。处理完的移到 archive，拒收的记 rejected。
   * 只移动 inbox/archive 里的文件——这是它自己的邮箱，不是业务文件。
   */
  function scanInbox(stats) {
    const inbox = join(ROOT, 'inbox');
    if (!existsSync(inbox)) return;
    let files;
    try {
      files = readdirSync(inbox).filter((f) => f.endsWith('.json'));
    } catch {
      return;
    }

    const peers = loadPeers(join(ROOT, 'peers'));

    for (const f of files) {
      const src = join(inbox, f);
      let raw;
      try {
        raw = readFileSync(src, 'utf8');
      } catch {
        continue; // 被别的进程拿走了，下轮再说
      }

      const v = validate(raw, peers);
      if (!v.ok) {
        stats.rejected++;
        appendJsonl('rejected.jsonl', {
          at: new Date().toISOString(),
          file: f,
          reason: v.reason,
          detail: v.detail ?? null,
        });
        // 坏消息也要移走，否则每次扫描都撞同一块石头
        try {
          renameSync(src, join(ROOT, 'archive', `rejected-${Date.now()}-${f}`));
        } catch {
          /* ignore */
        }
        continue;
      }

      const msg = v.msg;
      if (!deduper.admit(msg)) {
        stats.deduped++;
        try {
          renameSync(src, join(ROOT, 'archive', `deduped-${Date.now()}-${f}`));
        } catch {
          /* ignore */
        }
        continue;
      }

      stats.received++;
      appendJsonl('received.jsonl', { at: new Date().toISOString(), ...msg });

      // 【新框架：同时入事件库】老路径一字不动，这里只是并行记一份。
      // 不 await —— 入库慢不能拖慢收件；失败也只记 errors.jsonl。
      if (framework.ready) {
        ingestAsEvent(msg).catch((e) => {
          appendJsonl('errors.jsonl', {
            at: new Date().toISOString(), where: 'ingest-async', message: String(e?.message ?? e),
          });
        });
      }

      const fp = fingerprint(msg);
      // 级别 → 通道，全走配置（delivery.levels[level].channel）
      const spec = deliveryOf(cfg, msg.level);
      const quiet = cfg.quietHours;
      // 静默时段：critical 穿透，其余推迟
      const inQuiet = isQuietNow(quiet) && msg.level !== 'critical';

      if (injected.has(fp)) {
        stats.archived++;
      } else if (spec.channel === 'archive' || inQuiet) {
        // 只留档 / 静默期推迟：进 deferred，静默结束后补投
        if (inQuiet && spec.channel !== 'archive') {
          deferred.push({ msg, fp, until: quietEndMs(quiet) });
          stats.deferred++;
        } else {
          stats.archived++;
        }
      } else if (spec.channel === 'wake') {
        if (trySteer(msg)) {
          injected.add(fp);
          stats.steered++;
        } else {
          pending.push({ msg, fp });
          stats.queued++;
        }
      } else {
        // channel === 'queue'
        // 先试批次：开启了 batch 的级别（如 warn）攒批；
        // 没开就直接进 pending，下一轮 pre-step 注入。
        const spec2 = deliveryOf(cfg, msg.level);
        const r = batchPush({ msg, fp }, stats);
        if (r === 'disabled') {
          pending.push({ msg, fp });
          stats.queued++;
        } else if (r === 'batching') {
          stats.batchedQueued = (stats.batchedQueued ?? 0) + 1;
        }
      }

      try {
        renameSync(src, join(ROOT, 'archive', `${Date.now()}-${f}`));
      } catch {
        /* ignore */
      }
    }

    deduper.prune();
    lastScanAt = Date.now();
  }

  /**
   * 静默期推迟的消息。静默时段结束时补投。
   * 每项：{ msg, fp, until: 解禁时刻(ms) }
   */
  const deferred = [];

  /**
   * 批次队列（只给 channel === 'queue' 且开启 batch 的级别用）。
   *
   * 用户定的规则：
   *   - 攒满 maxItems（默认 5）条 **或** 距上批起点满 maxWaitSec（默认 300）
   *   - **先到先发**，发完重置计时
   *   - 发之前按事件骨架合并同类，正文显示"另有 N 条同类已合并"
   *   - critical **不进批次**，立刻发
   */
  const batch = {
    items: [],       // [{ msg, fp }]
    startedAt: 0,    // 本批起点（ms）
  };

  /** 现在是否处于静默时段。跨午夜也支持（如 23 → 7）。 */
  function isQuietNow(qh) {
    if (qh === undefined || qh.enabled !== true) return false;
    const { start, end } = qh;
    if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
    const h = new Date().getHours();
    return start <= end ? h >= start && h < end : h >= start || h < end;
  }

  /** 静默期解禁的时刻（ms）。用于 deferred 的 until 字段。 */
  function quietEndMs(qh) {
    if (qh === undefined || !Number.isInteger(qh.end)) return Date.now();
    const now = new Date();
    const end = new Date(now);
    end.setHours(qh.end, 0, 0, 0);
    if (end.getTime() <= now.getTime()) end.setDate(end.getDate() + 1);
    return end.getTime();
  }

  /** 静默期结束后，把 deferred 里的消息放回 pending（合并成摘要）。 */
  function releaseDeferred(stats) {
    if (deferred.length === 0) return;
    if (isQuietNow(cfg.quietHours)) return;
    const now = Date.now();
    const due = deferred.filter((d) => d.until <= now);
    if (due.length === 0) return;

    for (const d of due) {
      const i = deferred.indexOf(d);
      if (i >= 0) deferred.splice(i, 1);
      if (!injected.has(d.fp)) {
        pending.push({ msg: d.msg, fp: d.fp });
        stats.queued++;
      }
    }
    if (due.length > 1) {
      appendJsonl('quiet-release.jsonl', {
        at: new Date().toISOString(), count: due.length,
      });
    }
  }

  /**
   * 摘要：多条消息合成一行，每条取标题前 N 个字（默认 20）。
   * 用户原话：「每条前面选20个字，一般能说清楚了」。
   */
  function summarize(items, titleChars = 20) {
    if (items.length === 0) return '';
    const n = Number(titleChars) > 0 ? Number(titleChars) : 20;
    const lines = items.map((it) => {
      const t = String(it.title ?? '');
      return t.length > n ? `${t.slice(0, n - 1)}…` : t;
    });
    if (lines.length === 1) return lines[0];
    return `${lines.length} 条：\n` + lines.map((l) => `· ${l}`).join('\n');
  }

  // ---------------------------------------------------------------- HTTP 入口
  //
  // 「什么东西想接进来，有个统一入口」—— 除文件 inbox 外的第二种入口。
  //
  // 安全约束（全部硬编码，不可配置绕过）：
  //   1. 默认只监听 127.0.0.1（回环），不对外网开放
  //   2. 必须带 peer + token，与文件入口同一套校验
  //   3. body 上限 64 KB，超了直接断
  //   4. 只接受 POST
  //   5. 写进的是同一个 inbox 目录，走同一套 scanInbox 流程 —— 不做第二套判定
  async function startHttp(stats) {
    const h = cfg.interface?.http;
    if (h === undefined || h.enabled !== true) return null;
    await ensureHttpFactory();
    if (typeof serverFactory !== 'function') return null;

    const MAX_BODY = 64 * 1024;
    const server = serverFactory((req, res) => {
      const path = h.path ?? '/inbox';
      if (req.method !== 'POST' || !String(req.url ?? '').startsWith(path)) {
        res.writeHead(404); res.end('not found'); return;
      }
      let body = '';
      let over = false;
      req.on('data', (chunk) => {
        if (over) return;
        body += chunk;
        if (body.length > MAX_BODY) {
          over = true;
          res.writeHead(413); res.end('payload too large');
          req.destroy();
        }
      });
      req.on('end', () => {
        if (over) return;
        try {
          const parsed = JSON.parse(body);
          const name = `${parsed?.peer ?? 'unknown'}-${Date.now()}-http.json`;
          const dir = join(ROOT, 'inbox');
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, name), body);
          appendJsonl('http-received.jsonl', {
            at: new Date().toISOString(), peer: parsed?.peer ?? null, file: name,
          });
          res.writeHead(202); res.end('accepted');
        } catch (e) {
          appendJsonl('errors.jsonl', {
            at: new Date().toISOString(), where: 'http-parse', message: String(e?.message ?? e),
          });
          res.writeHead(400); res.end('bad json');
        }
      });
    });

    try {
      server.listen(Number(h.port ?? 17831), h.host ?? '127.0.0.1');
      server.unref?.();
      appendJsonl('http-listening.jsonl', {
        at: new Date().toISOString(), host: h.host, port: h.port, path: h.path,
      });
      return server;
    } catch (e) {
      appendJsonl('errors.jsonl', {
        at: new Date().toISOString(), where: 'http-listen', message: String(e?.message ?? e),
      });
      return null;
    }
  }

  /**
   * 批次：把一条 warn 放进批次队列，并检查是否该发。
   *
   * @returns 'sent' | 'batching' | 'disabled'
   */
  function batchPush(item, stats) {
    const spec = deliveryOf(cfg, item.msg.level);
    const b = spec.batch;
    if (b === undefined || b.enabled !== true) return 'disabled';

    if (batch.items.length === 0) batch.startedAt = Date.now();
    batch.items.push(item);

    const maxItems = Number(b.maxItems ?? 5);
    const maxWaitSec = Number(b.maxWaitSec ?? 300);
    // 「条数」按**事件骨架去重后**算 —— 同一件事重复 10 次不该算 10 条，
    // 否则"攒满 5 条"变成"攒满 5 条重复"。用户要求：relay 自行合并去重。
    const { groups } = groupBySkeleton(batch.items);
    const elapsed = (Date.now() - batch.startedAt) / 1000;

    if (groups.length >= maxItems || elapsed >= maxWaitSec) {
      flushBatch(stats);
      return 'sent';
    }
    return 'batching';
  }

  /** 把当前批次发出去。发完清空、重置计时。 */
  function flushBatch(stats, agentOverride = undefined) {
    if (batch.items.length === 0) return 0;
    const items = batch.items.splice(0, batch.items.length);
    batch.startedAt = 0;

    const { groups, total, deduped } = groupBySkeleton(items);
    if (groups.length === 0) return 0;

    const titleChars = Number(deliveryOf(cfg, groups[0].keep.msg.level).titleChars ?? 20);
    const text = renderBatch(groups, deduped, titleChars);

    // 发出去：优先叫醒（wake 一条），拿不到 agent 就进 pending
    const agent = agentOverride ?? liveAgent();
    let delivered = false;
    if (agent !== undefined) {
      const call = typeof agent.steer === 'function' ? 'steer'
        : typeof agent.inject === 'function' ? 'inject' : null;
      if (call !== null) {
        try {
          agent[call]({
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text }],
            source: { kind: 'schedule' },
          });
          delivered = true;
          stats.steered++;
        } catch { /* 降到 pending */ }
      }
    }
    if (!delivered) {
      // 降级：整批塞回 pending，下一轮 pre-step 注入
      for (const g of groups) {
        pending.push({ msg: g.keep.msg, fp: g.keep.fp });
        stats.queued++;
      }
    }

    // 统计留档 —— 用户要求「应该能看到去重几次」
    appendJsonl('batches.jsonl', {
      at: new Date().toISOString(),
      groups: groups.length,
      total,
      deduped,
      delivered,
      windowSec: Math.round((Date.now() - (batch.startedAt || Date.now())) / 1000),
    });
    stats.batched = (stats.batched ?? 0) + groups.length;
    return groups.length;
  }

  /** 取一个活着的根 agent（拿不到返回 undefined）。 */
  function liveAgent() {
    if (sessionId === null) return undefined;
    try {
      const a = ctx.agents.get(sessionId);
      return a ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** 批次超时检查：定时器每轮调一次。 */
  function batchTick(stats) {
    if (batch.items.length === 0) return;
    const spec = deliveryOf(cfg, batch.items[0].msg.level);
    const b = spec.batch;
    if (b === undefined || b.enabled !== true) return;
    const maxWaitSec = Number(b.maxWaitSec ?? 300);
    if ((Date.now() - batch.startedAt) / 1000 >= maxWaitSec) flushBatch(stats);
  }

  // ---------------------------------------------------------------- 对端监管
  //
  // 全程只读：读 pid 文件、读进程存在性、读最后心跳。
  // 发现死了只提问，绝不执行任何启动动作。

  function isAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  function readPidFile(path) {
    try {
      if (!existsSync(path)) return null;
      const n = Number(readFileSync(path, 'utf8').trim());
      return Number.isInteger(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  }

  /** 心跳：metrics.jsonl 最后一行的时间。 */
  function lastHeartbeatAt(path) {
    try {
      if (!existsSync(path)) return null;
      const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l !== '');
      if (lines.length === 0) return null;
      const last = JSON.parse(lines[lines.length - 1]);
      const t = Date.parse(last.at);
      return Number.isFinite(t) ? t : null;
    } catch {
      return null;
    }
  }

  /**
   * 三项探测。至少两项判定「死了」才算死 —— 单靠一项容易误判。
   */
  function probePeer(peer) {
    const sup = peer.supervise;
    if (!sup || sup.enabled !== true) return null;

    const checks = [];

    if (typeof sup.alivePidFile === 'string') {
      const pid = readPidFile(sup.alivePidFile);
      checks.push({ name: 'pidFile', dead: pid === null });
      if (pid !== null) checks.push({ name: 'process', dead: !isAlive(pid) });
    }

    if (typeof sup.metricsFile === 'string') {
      const hb = lastHeartbeatAt(sup.metricsFile);
      const staleMs = (sup.staleAfterSec ?? 600) * 1000;
      checks.push({ name: 'heartbeat', dead: hb === null || Date.now() - hb > staleMs, detail: hb });
    }

    if (checks.length === 0) return null;

    const deadCount = checks.filter((c) => c.dead).length;
    return { dead: deadCount >= Math.min(2, checks.length), checks };
  }

  async function supervise(stats) {
    if (cfg.supervise?.enabled === false) return;
    const peers = loadPeers(join(ROOT, 'peers'));

    for (const [id, peer] of peers) {
      const sup = peer.supervise;
      if (!sup || sup.enabled !== true) continue;

      const intervalMs = (sup.checkEverySec ?? 300) * 1000;
      const last = askedAt.get(`${id}:check`) ?? 0;
      if (Date.now() - last < intervalMs) continue;
      askedAt.set(`${id}:check`, Date.now());

      const r = probePeer(peer);
      if (r === null || !r.dead) {
        // ★ 崩溃恢复检测：上一次被判死，这一次活了 → 报一条
        const wasDown = askedAt.has(`${id}:down`);
        if (wasDown) {
          askedAt.delete(`${id}:down`);
          const cr = cfg.sources?.monitor?.crashRecovery;
          if (cr === undefined || cr.enabled !== false) {
            const level = cr?.level ?? 'critical';
            const fp = `recover:${id}:${Date.now()}`;
            pending.push({
              msg: {
                peer: id,
                level,
                title: `${id} 已恢复运行`,
                body: '对端曾停止运行，现已恢复。中断期间的消息可能缺失。',
                dedupeKey: null,
                cooldownSec: 0,
                at: new Date().toISOString(),
              },
              fp,
            });
            stats.queued++;
            appendJsonl('peer-recovered.jsonl', {
              at: new Date().toISOString(), peer: id, level,
            });
          }
        }
        askedAt.delete(`${id}:asked`); // 活了，允许以后再问
        continue;
      }

      // 判死了 → 记下"曾经是死的"，供下次检测到恢复时用
      askedAt.set(`${id}:down`, Date.now());

      stats.peerDown++;
      // 停机记录也限流：同一对端 checkEverySec 内只记一条。
      // 实测教训：不加限制时，一次停机 3 分钟内能刷出 23 条同样的记录，
      // 日志被噪音淹掉，真有问题反而看不见。
      const noteKey = `${id}:noted`;
      const notedAt = askedAt.get(noteKey) ?? 0;
      if (Date.now() - notedAt >= intervalMs) {
        askedAt.set(noteKey, Date.now());
        appendJsonl('peers-down.jsonl', {
          at: new Date().toISOString(),
          peer: id,
          checks: r.checks.map((c) => ({ name: c.name, dead: c.dead })),
        });
      }

      // 只问一次：同一次停机不重复打扰
      //
      // 【关键】这里不再直接 ask()——定时器线程里没有 agent，
      // ask() 会以 NO_PROVIDER 失败（实测 3 次，见 alerts-local.jsonl）。
      // 改为入队，由 pre-step 钩子带着活 agent 去问。
      if (sup.askOnDown !== false && !askedAt.has(`${id}:asked`)) {
        askedAt.set(`${id}:asked`, Date.now());
        enqueueQuestion(id, peer, r);
      }
    }
  }

  /**
   * 把一次「对端停机」塞进待提问队列。
   *
   * 【边界】这里只入队，**没有任何启动逻辑，也没有任何 ask 调用**。
   * 真正的提问发生在 pre-step 里，带着活 agent 走官方应答器。
   *
   * 超上限时不无限增长：丢弃最旧的一条，并记一笔。
   * 丢弃是有意的——设计局 §7.3「宁可不问，不可烦人」。
   */
  function enqueueQuestion(id, peer, probe) {
    const deadNames = (probe?.checks ?? []).filter((c) => c.dead).map((c) => c.name);
    questionQueue.push({
      id,
      peerId: id,
      note: peer?.note ?? id,
      dead: deadNames,
      at: new Date().toISOString(),
    });
    if (questionQueue.length > QUESTION_QUEUE_MAX) {
      const dropped = questionQueue.splice(0, questionQueue.length - QUESTION_QUEUE_MAX);
      appendJsonl('alerts-local.jsonl', {
        at: new Date().toISOString(),
        note: 'question-queue-overflow',
        dropped: dropped.map((q) => q.peerId),
        kept: questionQueue.length,
      });
    }
  }

  /** 合并成一条提问文案。多条时不逐条问，符合 §7.3。 */
  function buildQuestion(items) {
    // 文案里 **note 和 id 都要有**：人靠 note 认，排查靠 id。
    // 只给 note 会让提问和 peers-down.jsonl 里的记录串不起来。
    const tag = (q) => (q.note && q.note !== q.peerId ? `${q.note}（${q.peerId}）` : q.peerId);
    const lines = items.map((q) => `• ${tag(q)} —— 已停止（${q.dead.join(' / ')}不通）`);
    return {
      id: 'relay-peer-down',
      header: '消息中枢',
      question:
        items.length === 1
          ? `${tag(items[0])} 似乎已停止运行。要处理吗？`
          : `以下 ${items.length} 个对端已停止运行，要处理吗？\n\n${lines.join('\n')}`,
      options: [
        {
          // 【边界】不能写「我来拉起」——中枢不做任何动作，它只发问。
          label: '我去看看 (Recommended)',
          description: '由你或模型走正常流程处理，会计入操作次数',
        },
        { label: '知道了，暂不处理', description: '保持现状，不再重复问这一条' },
      ],
    };
  }

  /**
   * 带 agent 提问，失败一律降级成注入。**永不抛出**。
   *
   * 为什么必须降级而不是只记日志：
   *   历史缺陷——catch 里只写 alerts-local.jsonl，
   *   而那个文件没有任何消费者，等于把告警埋了。
   *   实测：13:40–14:02 对端死 6 次，用户一次都没看到。
   *
   * 所有失败路径都把**原始错误码**写进日志，否则以后分不清
   * 是用户取消、调用方不合法、还是超时。
   */
  function askInBackground(agent, signal, items) {
    const questions = ctx.userQuestions;
    if (questions === undefined || questions === null || typeof questions.ask !== 'function') {
      fallbackToInject(items, 'no-ask-channel', 'userQuestions 服务不可用');
      return;
    }

    const q = buildQuestion(items);

    // 超时用官方默认值 120 秒；race 保证人不在也不会一直挂着。
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error('ask timed out');
        e.code = 'ask-timeout';
        reject(e);
      }, QUESTION_TIMEOUT_MS);
      timer.unref?.();
    });

    let asking;
    try {
      asking = questions.ask({
        agent,
        signal,
        questions: [q],
      });
    } catch (e) {
      // ask() 同步抛出（非 Promise）也要接住
      clearTimeout(timer);
      fallbackToInject(items, e?.code ?? 'ask-threw-sync', String(e?.message ?? e));
      return;
    }

    // 两层 catch：race 本身，以及 ask() 的独立 rejection（防 unhandled）。
    Promise.resolve(asking).catch(() => {});
    Promise.race([asking, timeout])
      .then(() => {
        clearTimeout(timer);
        appendJsonl('alerts-local.jsonl', {
          at: new Date().toISOString(),
          note: 'peer-down-asked',
          peers: items.map((i) => i.peerId),
          answered: true,
        });
      })
      .catch((e) => {
        clearTimeout(timer);
        fallbackToInject(items, e?.code ?? 'ask-failed', String(e?.message ?? e));
      })
      .catch(() => {
        /* 最后的兜底：降级本身失败也不再往外抛 */
      });
  }

  /** 降级：把告警塞回注入队列，保证「说了」= 「看得到」。 */
  function fallbackToInject(items, code, message) {
    appendJsonl('alerts-local.jsonl', {
      at: new Date().toISOString(),
      note: 'peer-down-ask-fallback',
      errorCode: code,
      message,
      peers: items.map((i) => i.peerId),
    });
    try {
      const text = [
        '[消息中枢] 对端停止运行（提问通道不可用，已降级为知会）',
        ...items.map((q) => `• ${q.note} —— ${q.dead.join(' / ')} 不通`),
        `（原因：${code}）`,
      ].join('\n');
      pending.push({
        msg: {
          from: 'relay',
          level: 'warn',
          title: '对端停止运行',
          body: text,
          at: new Date().toISOString(),
        },
        fp: `relay:fallback:${items.map((i) => i.peerId).join(',')}:${Date.now()}`,
      });
    } catch {
      /* 队列都进不去就只能靠 alerts-local.jsonl 了 */
    }
  }

  // ---------------------------------------------------------------- 注入
  //
  // 依据（读 DSH 源码，非猜测）：
  //
  //   interface Agent {
  //     send(message, target, wakeup): void;
  //     followup(message): void;   // 下一轮，会唤醒
  //     steer(message): void;      // 下一步，会唤醒
  //     inject(message): void;     // 下一步，不唤醒  ← 我们用这个
  //   }
  //
  //   // dsh-agent-loop: inject(input) { this.send(input, 'next-step', false) }
  //
  // 而 agent 从 `agent/pre-step` 的参数里拿：
  //   ctx.on('agent/pre-step', async ({ agent, messages, signal, step }, next) => {...})
  //
  // 为什么用 inject 而不是 followup/steer：
  //   followup 会开启新一轮、steer 会打断当前走向。
  //   中枢的消息是「知会」，不该改变模型正在做的事 —— 所以不唤醒。

  /**
   * 把待投消息注入会话。
   *
   * source.kind 用 'schedule' —— 官方 MessageSourceMap 的合法值，
   * 语义是定时触发，与中枢的定时器吻合。
   * 不能用 'user'（那会重置 confirm-gate 的计数）。
   */
  function injectPending(agent) {
    if (pending.length === 0) return 0;
    if (agent === undefined || agent === null || typeof agent.inject !== 'function') {
      // 拿不到 agent 就不消费队列 —— 下轮再试，别把消息丢了
      return 0;
    }

    const batch = pending.splice(0, pending.length);
    const lines = [];
    for (const { msg, fp } of batch) {
      injected.add(fp);
      // titleChars 按每条消息自己的级别取，多级别混批时各自截断
      lines.push(render(msg, deliveryOf(cfg, msg.level).titleChars));
    }

    try {
      agent.inject({
        // 【必须有 id】dsh-agent-loop 的 inject() 只做
        //   inject(input) { this.send(input, "next-step", false); }
        // 原样转发，宿主不补 id。而 dsh-session 的 assertMessageEventShape 要求
        //   user/message 的 data.id 是非空 string，否则抛
        //   `lacks an identified message`，整份会话拒绝加载。
        // 2026-10-17 实测：缺这个字段让 12218 行的会话打不开，只能逐帧重压抢救。
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: lines.join('\n\n') }],
        source: { kind: 'schedule' },
      });
      return batch.length;
    } catch {
      // 注入失败：把消息放回队列头，下轮重试
      pending.unshift(...batch);
      return 0;
    }
  }

  // ---------------------------------------------------------------- 挂钩子

  const stats = { received: 0, rejected: 0, deduped: 0, queued: 0, archived: 0, peerDown: 0, injected: 0, steered: 0, deferred: 0 };

  // 定时扫描：收件 + 监管
  //
  // unref：这个定时器不该单独把进程钉住。
  // DSH 里通常有别的活动让它活着；但宿主想退出时，
  // 我们不该成为唯一拦着它的东西。
  //
  // 【ctx.effect 包裹】外部审查（V4.1）第⑦条：
  //   Cordis 未管理的资源（定时器/连接/watcher）应包在 ctx.effect() 里并返回 disposer。
  //   只靠手写 dispose 钩子在正常卸载时够用，但 ctx.effect 是框架级保证：
  //   HMR 热卸载、父作用域销毁、加载失败回滚等路径都会走到它。
  //   这里两条路都留：effect 的 disposer + 原有 dispose 钩子，clearInterval 幂等。
  const tick = () => {
    if (stopped) return;
    try {
      scanInbox(stats);
    } catch (e) {
      // 收件的错误单独记，不和监管混在一起
      appendJsonl('errors.jsonl', { at: new Date().toISOString(), where: 'scanInbox', message: String(e?.message ?? e) });
    }
    try {
      releaseDeferred(stats);
    } catch (e) {
      appendJsonl('errors.jsonl', { at: new Date().toISOString(), where: 'releaseDeferred', message: String(e?.message ?? e) });
    }
    try {
      batchTick(stats);
    } catch (e) {
      appendJsonl('errors.jsonl', { at: new Date().toISOString(), where: 'batchTick', message: String(e?.message ?? e) });
    }
    if (Date.now() - (lastAliveAt ?? 0) > ALIVE_CHECK_MS) {
      lastAliveAt = Date.now();
      // supervise 是 async，必须接住它的 rejection ——
      // void 一个 Promise 会吞掉异常，出问题时完全无声。
      supervise(stats).catch((e) => {
        appendJsonl('errors.jsonl', {
          at: new Date().toISOString(),
          where: 'supervise',
          message: String(e?.message ?? e),
          stack: String(e?.stack ?? '').split('\n').slice(0, 4).join(' | '),
        });
      });
    }
  };

  let timer = null;
  const stopTimer = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  timer = setInterval(tick, SCAN_INTERVAL_MS);
  timer.unref?.();

  // 交给 Cordis 管：返回 disposer，框架在作用域销毁 / HMR 卸载时调用。
  try {
    ctx.effect?.(() => stopTimer);
  } catch {
    /* 没有 effect 就靠 dispose 钩子 */
  }

  // 每轮开始前注入积压消息。
  //
  // 参数形状（读 DSH 源码确认）：
  //   ({ agent, messages, signal, step }, next) => decision
  // agent 上带 inject/steer/followup，这是官方的注入接口。
  try {
    ctx.on('agent/pre-step', ({ agent, step }, next) => {
      if (stopped) return next();
      // step === 1 = 新回合的第一步：重置 turn-stopping 续跑计数，
      // 否则计数会跨回合累积，几轮之后上限就被耗尽，续跑失效。
      if (step === 1) {
        turnStopCount = 0;
        steerState.turnCount = 0;
      }
      try {
        if (pending.length > 0) {
          const n = injectPending(agent);
          stats.injected += n;
        }
      } catch {
        /* 注入失败不阻断本轮 */
      }
      return next();
    });
  } catch {
    /* 没有这个钩子就只靠文件留档 */
  }

  // 提问钩子：与注入钩子并列的**第二个** handler。
  //
  // 【为什么另开一个而不是改上面那个】
  //   上面那个是同步的，`return next()` 直接返回。把它改成 async 会让
  //   next() 返回 Promise，下游多一等——那是语义级改动，风险高于新增。
  //
  // 【为什么这里也不 await】
  //   handler 必须同步返回 next()，把 ask 的异步性全部封在
  //   askInBackground 内部。handler 本身不 async、不 await、不返回 Promise。
  try {
    ctx.on('agent/pre-step', ({ agent, signal }, next) => {
      if (stopped || questionQueue.length === 0) return next();
      try {
        const items = questionQueue.splice(0, questionQueue.length);
        askInBackground(agent, signal, items);
      } catch {
        /* 入不了后台也不能阻断本轮 */
      }
      return next();
    });
  } catch {
    /* 没有这个钩子就只有注入这一条路 */
  }

  // 记录根会话 id：定时器里 steer 需要它去 ctx.agents.get()。
  // 【为什么还要主动捞一次】
  //   `agent/created` 在 apply() 期间不会触发（它由 agent 工厂在 setup 后派发），
  //   而 apply() 末尾会立即 scanInbox 一次 —— 那时 sessionId 必然为 null，
  //   首轮消息就永远走不了 steer。所以这里先把活着的根 agent 捞一遍。
  try {
    const live = ctx.agents.roots?.() ?? [];
    if (live.length > 0) sessionId = live[0].id;
  } catch {
    /* 拿不到就等 agent/created */
  }

  /**
   * 会话一出现，立刻把"等会话"的那批消息发出去。
   *
   * 【这是 2026-10-23 那个死循环的解】
   *   init 向导在 apply() 里产出事件，那时 sessionId 必然是 null，
   *   trySteer() 直接 return false，消息进了 pending 队列等 pre-step。
   *   但 pre-step 要靠用户说话才触发 —— 用户不说话就永远没有 pre-step。
   *   于是「不配置就不跑」这条规则生效了，但用户**永远不知道要配置**。
   *
   *   实测证据：alerts-local.jsonl 01:55:00 有 init-pending，
   *   之后 9 小时过去，维护者 一条都没收到。
   *
   * 【修法】
   *   拿到 sessionId 的那一刻（不管是从 roots() 捞的还是 agent/created 给的），
   *   立刻把 pending 里该发的发掉。这就是 followup/steer 的语义：
   *   不是"等下一轮"，是"现在就开一轮"。
   *
   * 【为什么不直接无条件全发】
   *   限流和游戏模式还得守。这里走现成的 trySteer()，它内部有
   *   worthWaking / steerBudget / 冷却，一个都不绕。
   */
  function flushPendingOnSession(agent) {
    // 【防御 TDZ】
    //   pending / stopped / injected 都声明在本文件后半段，
    //   initState() 由 createStore().then() 异步调起 —— 那时候它们已经初始化。
    //   但万一哪天有人把这几个改成同步调用，这里会直接 TDZ 崩。
    //   用 try 包住，拿不到就当"没有待发消息"。
    try {
      if (stopped) return;
      if (pending.length === 0) return;
      if (agent === undefined || agent === null) return;
      // 只发 critical：warn 走攒批、info 进窗口，不该由这里叫醒
      const shout = pending.filter((p) => p.msg.level === 'critical');
      if (shout.length === 0) return;
      let sent = 0;
      for (const p of shout) {
        if (trySteer(p.msg)) {
          const i = pending.indexOf(p);
          if (i >= 0) pending.splice(i, 1);
          injected.add(p.fp);
          sent += 1;
        }
      }
      if (sent > 0) {
        appendJsonl('steered.jsonl', {
          at: new Date().toISOString(), via: 'session-ready',
          count: sent, remaining: pending.length,
        });
      }
    } catch {
      /* 变量还没就绪 —— 等下次机会 */
    }
  }

  // 主动捞到 agent 时，顺手补发（覆盖"插件重载时已有会话"的情况）
  try {
    const live = ctx.agents.roots?.() ?? [];
    if (live.length > 0 && live[0] !== undefined) {
      sessionId = live[0].id;
      // 延到下一拍再发：apply() 期间 agent 可能还没完全就绪
      setTimeout(() => {
        try { flushPendingOnSession(live[0]); } catch { /* 补发失败不阻断启动 */ }
      }, 1500)?.unref?.();
    }
  } catch {
    /* ignore */
  }

  try {
    ctx.on('agent/created', ({ agent }) => {
      if (sessionId === null && agent !== undefined && agent !== null) {
        sessionId = agent.id;
      }
      // ★ 会话来了 = 可以叫醒用户了。把等会话的那批发出去。
      try { flushPendingOnSession(agent); } catch { /* ignore */ }
    });
  } catch {
    /* 没有这个钩子就只能走 inject */
  }

  // ---------------------------------------------------------------- 收尾自检点
  //
  // `agent/turn-stopping` 是官方唯一的 terminal checkpoint（外部审查 V4.1 第①条）：
  //   回合眼看要关（turnEnds && nextStep 空）→ 广播本事件 → 监听者可插话 →
  //   机器**再查一次** nextStep，非空就继续跑一步，空才真关。
  //
  // 【为什么必须自带计数】官方在此事件上**没有内置续跑保护**。
  //   `dsh-hooks-claude-code` 曾因无条件 steer 出现**无限续跑**。
  //   我们每轮最多续 turnStopMax 次，超了就放行，让回合正常结束。
  //
  // 【分级】（V4.1 第④条）
  //   critical → steer（wakeup:true，请求续跑）
  //   其他     → inject（wakeup:false，只让模型下一步读到，不请求续跑）
  //
  // 【⚠️ serial 模式，没有 next()】
  //   `agent/turn-stopping` 的签名是：
  //     (this: Scoped<Agent>, payload: { agent, turn, signal }) => Promise<void> | void
  //   **没有 next 参数**。照抄 pre-step（waterfall）的 `return next()` 会抛
  //   `next is not a function`，而且每轮收尾都触发一次 —— 2026-10-20 实测踩到。
  //   serial 监听器：正常返回即可，return 值不参与决策。
  try {
    ctx.on('agent/turn-stopping', ({ agent }) => {
      try {
        if (stopped || pending.length === 0) return;
        if (turnStopCount >= TURN_STOP_MAX) {
          appendJsonl('steer-skipped.jsonl', {
            at: new Date().toISOString(), reason: 'turn-stop-limit', queued: pending.length,
          });
          return;
        }
        if (agent === undefined || agent === null) return;

        // 只取 critical；其余留给下一轮 pre-step 正常注入
        const shout = pending.filter((p) => p.msg.level === 'critical');
        if (shout.length === 0) return;
        for (const p of shout) {
          const i = pending.indexOf(p);
          if (i >= 0) pending.splice(i, 1);
          injected.add(p.fp);
        }

        const text = shout.map((p) => render(p.msg, deliveryOf(cfg, p.msg.level).titleChars)).join('\n\n');
        const payload = {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'schedule' },
        };
        // critical 用 steer 请求续跑；拿不到 steer 就退回 inject（同样阻止关回合）
        const call = typeof agent.steer === 'function' ? 'steer'
          : typeof agent.inject === 'function' ? 'inject' : null;
        if (call === null) return;
        agent[call](payload);

        turnStopCount++;
        stats.steered++;
        appendJsonl('turn-stop.jsonl', {
          at: new Date().toISOString(), count: turnStopCount,
          n: shout.length, method: call,
        });
      } catch (e) {
        appendJsonl('errors.jsonl', {
          at: new Date().toISOString(), where: 'turn-stopping',
          message: String(e?.message ?? e),
        });
      }
    });
  } catch {
    /* 没有这个钩子就只靠定时器 + pre-step */
  }

  // DSH 卸载时清定时器，不留孤儿
  // （ctx.effect 的 disposer 已在上面注册；这里保留是因为 effect 可能不可用，
  //   stopTimer 内部判 null，重复调用无害）
  ctx.on?.('dispose', () => {
    stopped = true;
    stopTimer();
    try {
      httpServer?.close?.();
    } catch {
      /* ignore */
    }
    // 新框架的资源也要收干净：watchFile 句柄、采集器定时器、域连接
    try {
      framework.rules?.unwatch();
    } catch { /* ignore */ }
    try {
      framework.collectors?.stop();
    } catch { /* ignore */ }
    try {
      for (const t of collectorTimers.values()) clearInterval(t);
      collectorTimers.clear();
    } catch { /* ignore */ }
    try {
      // 【为什么遍历而不是只收 system】
      //   以前只有 system 一个采集器，写死名字没问题。
      //   现在多了 mail / finance，各自可能有定时器、socket、数据库句柄。
      //   少收一个 = 插件重载后句柄泄漏。
      for (const item of framework.collectors?.list() ?? []) {
        try {
          framework.collectors.get(item.name)?.teardown?.({ log: () => {} });
        } catch { /* 单个收不干净不影响别的 */ }
      }
    } catch { /* ignore */ }
    try {
      framework.store?.close?.();
    } catch { /* ignore */ }
  });

  // 首轮立即扫一次，不用等 10 秒
  try {
    scanInbox(stats);
  } catch {
    /* ignore */
  }

  // 首轮也做一次对端探活：否则启动后要等满一个周期才发现对端已死。
  // 同样必须接住 rejection —— try/catch 抓不到 async 函数的异常。
  lastAliveAt = Date.now();
  supervise(stats).catch((e) => {
    appendJsonl('errors.jsonl', {
      at: new Date().toISOString(),
      where: 'supervise-first',
      message: String(e?.message ?? e),
      stack: String(e?.stack ?? '').split('\n').slice(0, 4).join(' | '),
    });
  });

  // HTTP 入口（默认关）。开了才加载 node:http。
  // 【声明必须在使用之前】dispose 钩子在上面注册时会闭包引用它，
  // 若声明在下面，卸载时走到这里就是 TDZ 报错（手册 §6.1 §② lastAliveAt 同一类坑）。
  startHttp(stats)
    .then((s) => { httpServer = s; })
    .catch((e) => {
      appendJsonl('errors.jsonl', {
        at: new Date().toISOString(), where: 'http-start', message: String(e?.message ?? e),
      });
    });

  // ═══════════════════════════════════════════════════════════════
  //  启动采集器定时器（智能管家框架，阶段 3）
  //
  //  【这就是"监视器成为插件的一部分"】
  //   以前 monitor 是独立进程；现在采集跑在插件的事件循环里。
  //   插件活着 = 采集活着，不再依赖任何外部进程。
  //
  //  【为什么要等 store ready】
  //   采集到的事件要入库。库没好就先不启动定时器，等下一轮。
  //   用 setTimeout 轮询框架就绪，最多等 10 秒，超时就放弃并记一笔。
  // ═══════════════════════════════════════════════════════════════
  if (framework.collectors !== null && framework.collectors.size > 0) {
    let waited = 0;
    const startWhenReady = () => {
      if (stopped) return;
      if (framework.ready) {
        // 启动各采集器自己的 interval
        for (const item of framework.collectors.list()) {
          const everySec = item.trigger?.everySec;
          if (!Number.isFinite(everySec) || everySec <= 0) continue;
          const t = setInterval(() => {
            if (stopped) return;
            runCollectorOnce(item.name).catch((e) => {
              appendJsonl('errors.jsonl', {
                at: new Date().toISOString(), where: `collector-cycle:${item.name}`, message: String(e?.message ?? e),
              });
            });
          }, everySec * 1000);
          t.unref?.();
          collectorTimers.set(item.name, t);
        }
        // 启动时立刻采一次，不用等满一个周期
        for (const item of framework.collectors.list()) {
          runCollectorOnce(item.name).catch((e) => {
            appendJsonl('errors.jsonl', {
              at: new Date().toISOString(), where: `collector-first:${item.name}`, message: String(e?.message ?? e),
            });
          });
        }
        appendJsonl('alerts-local.jsonl', {
          at: new Date().toISOString(), kind: 'collectors-started',
          names: framework.collectors.list().map((x) => x.name),
        });
        return;
      }
      waited += 500;
      if (waited > 10_000) {
        appendJsonl('errors.jsonl', {
          at: new Date().toISOString(), where: 'collectors-start-skip',
          message: framework.reason ?? 'framework not ready in 10s',
        });
        return;
      }
      setTimeout(startWhenReady, 500).unref?.();
    };
    startWhenReady();
  }

  return {
    stats,
    /** 测试/排障用：看 HTTP 是否在听。 */
    httpListening: () => httpServer !== null && httpServer !== undefined,

    // ── 智能管家框架（阶段 2）对外接口 ──
    /** 小窗口角标：按源计数。抄 WorkBuddy 的 summary 接口。 */
    summary,
    /** 立刻跑一次指定采集器（测试/手动触发用）。 */
    runCollector: (name) => runCollectorOnce(name),
    /** 重跑引导配置评估（用户答完一项后调）。 */
    recheckInit: () => runInitCheck(),
    /** 重跑配置同步检查。 */
    checkConfigSync: () => runConfigSyncCheck(),
    /**
     * 保存配置（两份一起写）。
     * 只有用户明确要求改配置时才该调 —— relay 自己不在启动时调它。
     */
    saveConfig: (patch) => saveConfig(patch),
    /** 新框架的加载状态。排障第一眼看这个。 */
    framework: () => ({
      ready: framework.ready,
      reason: framework.reason,
      storeKind: framework.storeKind,
      events: framework.events,
      rules: framework.rules?.current()?.rules?.length ?? 0,
      lastError: framework.rules?.lastError ?? null,
      lastDecide: framework.lastDecide,
      lastRoute: framework.lastRoute ?? null,
      collectors: framework.collectors?.list() ?? [],
      initState: framework.initState,
      configSync: framework.configSync,
      stateBackend: framework.state?.kind ?? null,
      domain: framework.domain !== null && framework.domain !== undefined,
    }),
  };
}
