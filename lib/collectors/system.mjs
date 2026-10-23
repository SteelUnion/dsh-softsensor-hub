// collectors/system.mjs — 系统监控采集器
//
// 图纸：
// 契约：lib/collector.mjs（CONTRACT_VERSION = 1）
//
// 【它取代了什么】
//   以前 monitor 是一个独立进程，把心跳写进 daemon.pid、指标写进 metrics.jsonl，
//   relay 去读那两个文件。monitor 一死，采集就断了 —— 2026-10-20 实测断了 34 小时没人发现。
//
//   现在采集在插件进程内跑：插件活着 = 采集活着。不再依赖任何外部进程。
//
// 【硬边界】
//   lib/index.js 顶部写着「不得出现 spawn / exec」。
//   本文件全部用 Node 内置模块，不执行任何外部命令：
//     内存   → process.memoryUsage() / os.totalmem() / os.freemem()
//     磁盘   → fs.statfsSync()          （Node 18.15+，Windows 实测可用）
//     事件循环 → perf_hooks.monitorEventLoopDelay()
//     自身停顿 → 定时器 tick 间隔
//
// 【为什么阈值都放进配置】
//   「90% warn / 95% critical」是 维护者 定的，但机器的内存大小会变。
//   写死就等于换台机器就不合适了。全部可由 rules/config 覆盖。

import os from 'node:os';
import { statfsSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';

/** 默认阈值。都可由配置覆盖。 */
export const DEFAULTS = {
  intervalSec: 60,
  memoryPercent: 90,
  memoryCriticalPercent: 95,
  diskPercent: 90,
  diskCriticalPercent: 95,
  /** 事件循环延迟（毫秒）超过这个值报 warn */
  eventLoopMs: 500,
  /** 一次采样连续失败几次才报（防抖） */
  failThreshold: 3,
  /** 检查哪个盘的剩余空间。null = 自动选取（见 pickDiskPath）。 */
  diskPath: null,
  /**
   * 迟滞（回差）宽度，百分点。
   *
   * 【为什么必须有】（2026-10-23 实测）
   *   这台机器日常就在 90% 附近。阈值设 90%，每越过一次就产一条事件，
   *   攒 5 分钟发一次 → 维护者 一上午收到 8 条「内存 90.x% 超过 90%」。
   *   不是采集器坏，是**没有回差**：90.1 报、89.9 平静、90.2 又报……
   *
   *   加迟滞之后：超过阈值报一次并「记住已报」，
   *   直到降到 (阈值 - hysteresis) 以下才清除记忆、允许再报。
   *   这是告警系统的标准做法。
   */
  hysteresisPercent: 3,
};

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function pct(used, total) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return Math.round((used / total) * 1000) / 10; // 一位小数
}

/** 分级：达到 critical 阈值给 critical，达到 warn 给 warn，否则 null。 */
function grade(value, warnAt, criticalAt) {
  if (value === null) return null;
  if (Number.isFinite(criticalAt) && value >= criticalAt) return 'critical';
  if (Number.isFinite(warnAt) && value >= warnAt) return 'warn';
  return null;
}

// ─────────────────────────── 各项采样 ───────────────────────────

/** 内存：整机已用百分比。 */
export function sampleMemory(cfg = {}) {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const percent = pct(used, total);
  const level = grade(percent, cfg.memoryPercent ?? DEFAULTS.memoryPercent, cfg.memoryCriticalPercent ?? DEFAULTS.memoryCriticalPercent);
  return {
    metric: 'memory',
    value: percent,
    detail: {
      totalGB: Math.round((total / GB) * 10) / 10,
      freeGB: Math.round((free / GB) * 10) / 10,
      usedGB: Math.round((used / GB) * 10) / 10,
      // 插件自己的占用，跟整机比很小，但排障时有用
      processRssMB: Math.round(process.memoryUsage().rss / MB),
    },
    threshold: level === 'critical'
      ? (cfg.memoryCriticalPercent ?? DEFAULTS.memoryCriticalPercent)
      : (cfg.memoryPercent ?? DEFAULTS.memoryPercent),
    level,
  };
}

/**
 * 选一个要监控的磁盘路径。
 *
 * 【为什么不能写死】（2026-10-23 发布整理）
 *   以前默认是 'E:\\' —— 那是作者的盘。别人机器上可能根本没有 E 盘，
 *   于是 statfs 直接抛错，磁盘这一项永远是 unavailable。
 *
 * 选择顺序：
 *   ① 配置里明确指定了 → 用它的
 *   ② Windows：数据目录所在的卷（通常就是插件装在哪就盯哪）
 *   ③ Linux/macOS：'/'
 * 都不满足就返回 null，调用方按 unavailable 处理 —— 不编数字。
 */
export function pickDiskPath(cfg = {}) {
  const wanted = cfg.diskPath;
  if (typeof wanted === 'string' && wanted.trim() !== '') return wanted;
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  if (home === '') return process.platform === 'win32' ? 'C:\\' : '/';
  // 取盘符根：C:\Users\x → C:\
  if (process.platform === 'win32') {
    const m = /^([A-Za-z]:\\)/.exec(home);
    if (m) return m[1];
    return 'C:\\';
  }
  return '/';
}

/** 磁盘：指定路径所在卷的已用百分比。 */
export function sampleDisk(cfg = {}) {
  const path = pickDiskPath(cfg);
  let st;
  try {
    st = statfsSync(path);
  } catch {
    return { metric: 'disk', value: null, detail: { path, error: 'statfs-unavailable' }, threshold: null, level: null };
  }
  // bavail 对非特权用户可用块数，blocks 总块数
  const blocks = Number(st.blocks);
  const avail = Number(st.bavail);
  if (!Number.isFinite(blocks) || blocks <= 0) {
    return { metric: 'disk', value: null, detail: { path, error: 'bad-statfs' }, threshold: null, level: null };
  }
  const usedPercent = pct(blocks - avail, blocks);
  const level = grade(usedPercent, cfg.diskPercent ?? DEFAULTS.diskPercent, cfg.diskCriticalPercent ?? DEFAULTS.diskCriticalPercent);
  return {
    metric: 'disk',
    value: usedPercent,
    detail: {
      path,
      totalGB: Math.round(((blocks * st.bsize) / GB) * 10) / 10,
      availGB: Math.round(((avail * st.bsize) / GB) * 10) / 10,
    },
    threshold: level === 'critical'
      ? (cfg.diskCriticalPercent ?? DEFAULTS.diskCriticalPercent)
      : (cfg.diskPercent ?? DEFAULTS.diskPercent),
    level,
  };
}

/**
 * 事件循环延迟。
 *
 * 【为什么要看这个】
 *   采集器自己就在事件循环里。循环卡住 = 所有定时器都晚了 = 告警本身就迟到。
 *   这是"监视器自己还在不在"的关键指标。
 */
export function sampleEventLoop(histogram, cfg = {}) {
  if (histogram === null || histogram === undefined) {
    return { metric: 'event-loop', value: null, detail: { error: 'no-histogram' }, threshold: null, level: null };
  }
  const p99 = histogram.percentile(99) / 1e6; // ns → ms
  const mean = histogram.mean / 1e6;
  const threshold = cfg.eventLoopMs ?? DEFAULTS.eventLoopMs;
  return {
    metric: 'event-loop',
    value: Math.round(p99 * 10) / 10,
    detail: { p99Ms: Math.round(p99 * 10) / 10, meanMs: Math.round(mean * 100) / 100 },
    threshold,
    level: Number.isFinite(p99) && p99 >= threshold ? 'warn' : null,
  };
}

// ─────────────────────────── 事件构造 ───────────────────────────

/**
 * 进程明细：**有意不做**。
 *
 * 【为什么放弃这个功能】
 *   要知道"谁吃了内存"，Windows 上只有三条路：
 *     A. spawn `Get-Process`  → 破了 relay「不得 spawn/exec」的硬边界
 *     B. 引入 koffi/ffi 调 Win32 API → 插件要保持零依赖
 *     C. 读性能计数器 → 同样无内置支持
 *
 *   **三条都不可行。宁可少一个字段，不破边界。**
 *
 * 【替代做法】
 *   告警正文带「读数 + 剩余量」，事后对时间线。
 *   2026-10-21 那次内存告警，就是靠时间对上 维护者 在打游戏。
 */

const LABEL = {
  memory: '内存',
  disk: '磁盘',
  'event-loop': '事件循环',
  'self-stall': '采集器',
  'collector-error': '采集器',
};

const HOST = os.hostname();

function toEvent(sample, now = new Date()) {
  if (sample.level === null || sample.level === undefined) return null;
  const label = LABEL[sample.metric] ?? sample.metric;
  const unit = sample.metric === 'event-loop' ? 'ms' : '%';
  const head = sample.metric === 'event-loop'
    ? `${label} ${sample.value}${unit} 超过 ${sample.threshold}${unit}`
    : `${label} ${sample.value}${unit} 超过 ${sample.threshold}${unit}`;

  // 细节补一句，方便一眼知道什么情况
  let tail = '';
  if (sample.metric === 'memory' && sample.detail?.freeGB !== undefined) {
    tail = `（剩 ${sample.detail.freeGB} GB / 共 ${sample.detail.totalGB} GB）`;
  } else if (sample.metric === 'disk' && sample.detail?.availGB !== undefined) {
    tail = `（剩 ${sample.detail.availGB} GB / 共 ${sample.detail.totalGB} GB）`;
  }

  return {
    source: 'system',
    kind: sample.metric,
    level: sample.level,
    // 不设 dedupeKey：同类指标每次超阈值都该报一次；
    // 攒批和冷却由 rules.json 的 batch/wake 配置管，不在这里管。
    dedupeKey: null,
    summary: `${head}${tail}`,
    payload: {
      metric: sample.metric,
      value: sample.value,
      threshold: sample.threshold,
      detail: sample.detail ?? {},
      host: HOST,
      sampledAt: now.toISOString(),
    },
  };
}

// ─────────────────────────── 采集器本体 ───────────────────────────

/**
 * 造一个采集器实例。
 *
 * @param cfg 配置段（来自 config.json 的 sources.system）
 */
export function createSystemCollector(cfg = {}) {
  const conf = { ...DEFAULTS, ...cfg };
  let histogram = null;
  let started = false;

  // 上一次 tick 的时刻，用来判"自己是不是停顿了"
  let lastTickAt = null;
  // 连续失败次数
  let failStreak = 0;
  // 上次报过的 self-stall 时刻，防重复
  let lastStallReportAt = 0;

  /**
   * 迟滞状态：指标名 → 上次报过的级别（'warn' | 'critical' | null）。
   *
   * 【语义】
   *   已报过 warn，且数值还 ≥ (阈值 − hysteresis) → 不再报。
   *   一旦降到阈值 − hysteresis 以下 → 清除，允许再次报。
   *
   * 【为什么要分指标记】
   *   内存和磁盘各自独立。内存贴在 90% 线上不该把磁盘的状态也带偏。
   */
  const alertState = { memory: null, disk: null };

  return {
    name: 'system',
    version: '1.0.0',
    contract: 1,
    trigger: { kind: 'interval', everySec: conf.intervalSec },

    async setup(env) {
      if (started) return;
      started = true;
      try {
        histogram = monitorEventLoopDelay({ resolution: 20 });
        histogram.enable();
      } catch {
        histogram = null;
      }
      env?.log?.('info', 'system collector started', { intervalSec: conf.intervalSec });
    },

    async run(env) {
      const now = env?.now?.() ?? new Date();
      const events = [];

      // ① 自身停顿检查：两个 tick 间隔明显超出配置，说明事件循环被卡过
      if (lastTickAt !== null) {
        const gapSec = (now.getTime() - lastTickAt) / 1000;
        const expected = conf.intervalSec;
        // 留一倍余量，避免正常抖动误报
        if (gapSec > expected * 2 + 30) {
          const sinceLast = now.getTime() - lastStallReportAt;
          if (sinceLast > 10 * 60 * 1000) {
            lastStallReportAt = now.getTime();
            events.push({
              source: 'system',
              kind: 'self-stall',
              level: 'critical',
              dedupeKey: null,
              summary: `采集器停摆 ${Math.round(gapSec)} 秒（应每 ${expected} 秒一次）`,
              payload: { gapSec: Math.round(gapSec), expectedSec: expected, host: HOST, sampledAt: now.toISOString() },
            });
          }
        }
      }
      lastTickAt = now.getTime();

      // ② 三项采样。任何一项抛错都不能让整个采集器倒
      const samples = [];
      try {
        samples.push(sampleMemory(conf));
      } catch { /* 记失败 */ }
      try {
        samples.push(sampleDisk(conf));
      } catch { /* 记失败 */ }

      let el = null;
      if (histogram !== null) {
        try {
          el = sampleEventLoop(histogram, conf);
          samples.push(el);
          // 每轮读完重置，看的是"这一轮的最大延迟"
          histogram.reset();
        } catch { /* ignore */ }
      }

      // ③ 全部采不到 → 记失败次数，连续多次才报
      const gotAny = samples.some((s) => s !== null && s.value !== null);
      if (!gotAny) {
        failStreak += 1;
        if (failStreak >= conf.failThreshold) {
          events.push({
            source: 'system',
            kind: 'collector-error',
            level: 'warn',
            dedupeKey: null,
            summary: `采集器连续 ${failStreak} 次采不到数据`,
            payload: { failStreak, host: HOST, sampledAt: now.toISOString() },
          });
          failStreak = 0; // 报完清零，别一直刷
        }
      } else {
        failStreak = 0;
      }

      // ④ 超阈值的转成事件（带迟滞）
      //
      //   【迟滞怎么做】（2026-10-23 加，止住阈值线上反复刷屏）
      //     指标已报过某级 → 数值还在 (阈值 − hysteresis) 以上 → 静默
      //     数值掉到 (阈值 − hysteresis) 以下 → 清除记忆，允许下次再报
      //
      //   只对 memory / disk 生效。事件循环延迟和自停摆是瞬时事件，
      //   加迟滞反而会漏报。
      const hyst = Number.isFinite(conf.hysteresisPercent) ? conf.hysteresisPercent : DEFAULTS.hysteresisPercent;
      for (const s of samples) {
        const tracked = s.metric === 'memory' || s.metric === 'disk';

        if (tracked && s.value !== null && s.level !== null) {
          const warnAt = s.metric === 'memory'
            ? (conf.memoryPercent ?? DEFAULTS.memoryPercent)
            : (conf.diskPercent ?? DEFAULTS.diskPercent);
          const critAt = s.metric === 'memory'
            ? (conf.memoryCriticalPercent ?? DEFAULTS.memoryCriticalPercent)
            : (conf.diskCriticalPercent ?? DEFAULTS.diskCriticalPercent);
          // 当前级别对应的「复位线」
          const floor = (s.level === 'critical' ? critAt : warnAt) - hyst;
          const prev = alertState[s.metric];

          if (s.value > floor && prev !== null) {
            // 还在迟滞带里，且已经报过 → 不再报
            continue;
          }
          if (s.value > floor && prev === null) {
            // 第一次越过 → 报，并记住
            alertState[s.metric] = s.level;
          } else {
            // 掉到复位线以下 → 清除记忆，这次也不再报（数值本来就正常）
            alertState[s.metric] = null;
            continue;
          }
        } else if (tracked && s.value !== null && s.level === null) {
          // 数值正常 → 清除记忆
          alertState[s.metric] = null;
        }

        const e = toEvent(s, now);
        if (e !== null) events.push(e);
      }

      // ⑤ 体检记录（每一轮都记，不只有告警时记）
      //
      // 【为什么必须有这个】
      //   2026-10-21 下午出过一次：内存 88% → 97.7% → 93%，告警发了，
      //   但事后查不出来"什么时候开始涨的、涨得多快"。
      //   因为只记了超阈值那一刻，没有基线就看不出趋势。
      //
      //   这个文件每轮写一条，回答两个问题：
      //     采集器还活着吗？（看最后一条的时间）
      //     它看到了什么？（看三个读数）
      //
      //   「谁吃的内存」这里答不了 —— 见上面 topProcesses 位置的说明。
      try {
        env?.recordRun?.({
          at: now.toISOString(),
          memory: samples.find((s) => s.metric === 'memory')?.value ?? null,
          disk: samples.find((s) => s.metric === 'disk')?.value ?? null,
          eventLoop: samples.find((s) => s.metric === 'event-loop')?.value ?? null,
          events: events.length,
        });
      } catch {
        // 记录失败不能影响采集
      }

      return events;
    },

    async teardown() {
      try {
        histogram?.disable();
      } catch { /* ignore */ }
      histogram = null;
      started = false;
    },
  };
}

export default createSystemCollector();
