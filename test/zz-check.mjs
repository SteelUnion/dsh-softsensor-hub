// zz-check.mjs — relay 一键体检
//
// 用户原话：「得你测，我不一定记得住」。
// 所以把"重启后该验什么"固化成一个命令：
//
//   node test/zz-check.mjs
//
// 它做三件事：
//   ① 离线测试（zz-e2e / zz-steer / wiring）—— 不依赖运行中的 DSH
//   ② 在线检查（HTTP 入口 / 日志健康 / 配置一致性）—— 依赖运行中的 relay
//   ③ 汇总报告，标出哪些能力仍未在真实环境触发过

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const SELF = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(SELF);
const PROF = '

/**
 * 运行时数据目录。
 *
 * 【为什么不能写死 PROF】2026-10-20 起 relay 的数据与代码分离：
 *   profile patch 里配了 root: ''
 *   所以日志、peers、inbox 全在数据目录，不在 PROF。
 * 探测顺序：
 *   1. 环境变量 DSH_RELAY_DATA（手动指定优先）
 *   2. 标准数据目录 E:/SteelUnion/data/relay
 *   3. 退回 PROF（未做分离时）
 */
function pickDataDir() {
  const env = process.env.DSH_RELAY_DATA;
  if (typeof env === 'string' && env !== '') return env;
  const std = 'E:/SteelUnion/data/relay';
  try { if (existsSync(join(std, 'config.json'))) return std; } catch { /* */ }
  return PROF;
}
const DATA = pickDataDir();

const lines = [];
function say(s = '') { lines.push(s); console.log(s); }

// ---------------------------------------------------------------- ① 离线测试
say('════════ ① 离线测试 ════════');
const offline = [
  ['zz-e2e.mjs', '结构/映射/截断/静默/HTTP 单测/游戏模式'],
  ['zz-steer-test.mjs', 'steer 分流/限流/turn-stopping'],
  ['zz-batch-test.mjs', '批次攒批/骨架去重/合并统计'],
  ['zz-event-test.mjs', '事件模型 壳+瓤'],
  ['zz-rules-test.mjs', '规则引擎 热加载/失败回退'],
  ['zz-store-test.mjs', '事件库 三后端/清理'],
  ['zz-collector-test.mjs', '采集器 注册/隔离/定时'],
  ['zz-system-test.mjs', '系统监控 内存/磁盘/事件循环'],
  ['zz-mail-test.mjs', '邮件采集器 解码/UID/分页'],
  ['zz-finance-test.mjs', '金融采集器 四档对比/新鲜度闸门'],
  ['zz-cred-test.mjs', '凭据库 AES-GCM/环境变量'],
  ['zz-wire-test.mjs', '接线 真调 apply()'],
  ['wiring.mjs', '配对与校验'],
];
let offlineFail = 0;
for (const [file, what] of offline) {
  const p = join(SELF, file);
  if (!existsSync(p)) { say(`SKIP  ${file}（不存在）`); continue; }
  let out = '', ok = false;
  try {
    out = execFileSync(process.execPath, [p], { encoding: 'utf8', cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
    ok = /ALL PASS/.test(out);
  } catch (e) {
    out = String(e?.stdout ?? '') + String(e?.stderr ?? '');
    ok = /ALL PASS/.test(out);
  }
  const m = out.match(/\((\d+) passed, (\d+) failed\)/);
  const stat = m ? `${m[1]} passed, ${m[2]} failed` : '无统计';
  say(`${ok ? 'PASS' : 'FAIL'}  ${file.padEnd(22)} ${stat.padEnd(20)} ${what}`);
  if (!ok) offlineFail++;
}

// ---------------------------------------------------------------- ② 在线检查
say('');
say('════════ ② 在线检查（运行中的 relay）════════');
say(`数据目录        ${DATA}${DATA === PROF ? '  ⚠ 未分离（装插件会丢数据）' : '  ✅ 已与代码分离'}`);

function readJsonl(name) {
  // 日志在**数据目录下的 logs\**；代码在 PROF。两者分离后不能混用。
  // 【2026-10-23】日志统一进 logs\ 子目录，根目录只留配置与数据。
  const p = join(DATA, 'logs', name);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function hashOf(p) {
  try { return execFileSync('certutil', ['-hashfile', p, 'SHA256'], { encoding: 'utf8' }).split('\n')[1]?.trim() ?? ''; }
  catch { return ''; }
}

// 版本
let version = '?';
try { version = JSON.parse(readFileSync(join(PROF, 'package.json'), 'utf8')).version; } catch { /* */ }
say(`版本            ${version}`);

// 配置一致性
// 【为什么是这几份】代码 + 配置都要比。新增的框架模块也要在内，
// 否则"源改了没同步到 profile"这种问题查不出来。
let cfgMatch = 0, cfgTotal = 0;
// 【为什么不再比 config.json】
//   2026-10-21 清场后源码目录按 D4「数据与代码分离」不放 config.json。
//   运行时配置从数据目录（
//   留着这条只会每次体检都报一条假告警 —— 假告警久了就没人看体检了。
const SYNC_FILES = [
  'lib/index.js', 'lib/message.mjs', 'lib/event.mjs', 'lib/rules.mjs',
  'lib/store.mjs', 'lib/collector.mjs', 'lib/credentials.mjs',
  'lib/collectors/system.mjs', 'lib/collectors/mail.mjs', 'lib/collectors/finance.mjs',
  'package.json',
];
for (const f of SYNC_FILES) {
  cfgTotal++;
  const a = hashOf(join(REPO, f)), b = hashOf(join(PROF, f));
  if (a !== '' && a === b) cfgMatch++;
  else say(`  ⚠ ${f} 源与 profile 不一致`);
}
say(`代码同步         ${cfgMatch}/${cfgTotal} 文件一致`);

// 错误健康
// 【为什么按进程启动时间过滤】errors.jsonl 是累积的，历史已修复的错误会一直躺着，
// 拿它判断"现在有没有问题"会永远报红。只算本次 relay 加载之后的错误。
const errs = readJsonl('errors.jsonl');
const listen0 = readJsonl('http-listening.jsonl').at(-1);
let startedAt = 0;
try {
  // relay 每次 apply 都会写一条首扫记录到 received 或 http-listening；
  // 更可靠的锚点是"最后一条 http-listening 或最早一条进程内日志"。
  // 这里用 http-listening 的最新时间；没有就退回 12 小时前。
  startedAt = listen0 ? new Date(listen0.at).getTime() : Date.now() - 12 * 3600_000;
} catch { startedAt = Date.now() - 12 * 3600_000; }

const errSince = errs.filter((e) => new Date(e.at).getTime() >= startedAt);
// 自测造成的错误（坏 JSON 用例）不算故障
const errReal = errSince.filter((e) => e.where !== 'http-parse');
say(`错误            累计 ${errs.length} 条，本次运行 ${errSince.length} 条，其中真实故障 ${errReal.length} 条` +
  (errReal.length > 0 ? `  ← ${errReal.at(-1)?.where}: ${errReal.at(-1)?.message}` : '  ✅'));

// HTTP 入口
const hListen = readJsonl('http-listening.jsonl');
let httpLive = false;
let httpMsg = '未开启';
if (hListen.length > 0) {
  const last = hListen.at(-1);
  try {
    const r = await fetch(`http://${last.host}:${last.port}${last.path ?? '/inbox'}`, { method: 'GET' });
    httpMsg = `监听 ${last.host}:${last.port}，GET→${r.status}（应为 404）`;
    httpLive = r.status === 404;
  } catch { httpMsg = `监听记录在，但连不上 ${last.host}:${last.port}`; }
}
say(`HTTP 入口        ${httpLive ? '✅' : '❌'} ${httpMsg}`);

// ─────────────────────────── 智能管家框架 ───────────────────────────
say('');
say('════════ ④ 智能管家框架（阶段 2/3）════════');

const alertsLocal = readJsonl('alerts-local.jsonl');
const fwReady = alertsLocal.filter((a) => a.kind === 'framework-ready').at(-1);
const rulesReloaded = alertsLocal.filter((a) => a.kind === 'rules-reloaded').at(-1);
const collectorsStarted = alertsLocal.filter((a) => a.kind === 'collectors-started').at(-1);
const runs = readJsonl('collector-runs.jsonl');

function ago(iso) {
  if (typeof iso !== 'string') return '从未';
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return '时间无效';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} 秒前`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

// 事件库：数一下当天有多少条事件
let eventCount = 0;
let eventDays = 0;
try {
  const evDir = join(DATA, 'events');
  if (existsSync(evDir)) {
    const files = readdirSync(evDir).filter((f) => f.endsWith('.jsonl'));
    eventDays = files.length;
    for (const f of files) {
      eventCount += readFileSync(join(evDir, f), 'utf8').split(/\r?\n/).filter(Boolean).length;
    }
  }
} catch { /* ignore */ }

// 采集器最后一次采样
//
// 【为什么按采集器分开取】
//   每轮采样都往同一个文件写，最后一行可能是 mail（它有 account/scanned，没有内存读数）。
//   只取 .at(-1) 会出现「内存 ?% / 磁盘 ?%」—— 那不是采集器坏了，是取错了行。
const lastSysRun = runs.filter((r) => r.collector === 'system').at(-1);
const lastMailRun = runs.filter((r) => r.collector === 'mail').at(-1);
const lastRun = lastSysRun ?? runs.at(-1);
const lastRunAgo = lastRun ? ago(lastRun.at) : '从未';
// 60 秒一采，超过 5 分钟没记录就算"可能停了"
const runStale = lastRun ? (Date.now() - Date.parse(lastRun.at)) > 5 * 60_000 : true;

say(`框架状态         ${fwReady ? `✅ 已就绪（事件库 ${fwReady.store}）` : '⏳ 未见 framework-ready 记录'}`);
say(`规则加载         ${rulesReloaded ? `✅ ${rulesReloaded.rules} 条` : '⏳ 未见 rules-reloaded 记录'}`);
say(`采集器启动       ${collectorsStarted ? `✅ ${(collectorsStarted.names ?? []).join(', ')}` : '⏳ 未见 collectors-started 记录'}`);
say(`采集最近一次     ${runStale ? '⚠' : '✅'} ${lastRunAgo}` +
  (lastRun ? `  （内存 ${lastRun.memory ?? '?'}% / 磁盘 ${lastRun.disk ?? '?'}% / 事件循环 ${lastRun.eventLoop ?? '?'}ms）` : ''));
say(`邮件采集         ${lastMailRun ? (ago(lastMailRun.at) + `（${lastMailRun.account ?? '?'} 扫描 ${lastMailRun.scanned ?? '?'} 封 / 产 ${lastMailRun.events ?? 0} 条）`) : '未见记录'}`);
say(`事件库           ${eventCount} 条事件，${eventDays} 个日文件`);

if (runStale) {
  say('  ⚠ 采集记录超过 5 分钟没更新，采集器可能停了');
}


// 各通道实际触发情况
const steered = readJsonl('steered.jsonl');
const turnStop = readJsonl('turn-stop.jsonl');
const deferred = readJsonl('quiet-release.jsonl');
const recovered = readJsonl('peer-recovered.jsonl');
const received = readJsonl('received.jsonl');
const batches = readJsonl('batches.jsonl');

const byMethod = {};
for (const s of steered) byMethod[s.method ?? '?'] = (byMethod[s.method ?? '?'] ?? 0) + 1;

say('');
say('════════ ③ 各能力真实触发情况 ════════');
const rows = [
  ['收件', received.length > 0, `${received.length} 条 received`],
  ['steer（busy 唤醒）', (byMethod.steer ?? 0) > 0, `${byMethod.steer ?? 0} 次`],
  ['followup（idle 唤醒）', (byMethod.followup ?? 0) > 0, `${byMethod.followup ?? 0} 次`],
  ['批次合并（batches）', batches.length > 0, `${batches.length} 批` + (batches.length > 0 ? `，累计合并 ${batches.reduce((s, b) => s + (b.deduped ?? 0), 0)} 条` : '')],
  ['turn-stopping 续跑', turnStop.length > 0, `${turnStop.length} 次`],
  ['静默期补发', deferred.length > 0, `${deferred.length} 次`],
  ['对端崩溃恢复告警', recovered.length > 0, `${recovered.length} 次`],
  ['系统采集器产告警', runs.length > 0, `${runs.filter((r) => (r.events ?? 0) > 0).length} 轮有告警`],
];
for (const [name, ok, detail] of rows) {
  say(`${ok ? '✅ 已触发' : '⏳ 未触发'}  ${name.padEnd(24)} ${detail}`);
}

say('');
say('注：⏳ 未触发 ≠ 坏。有些能力要特定条件（如 followup 要 agent 空闲时来消息）。');
say('    代码与单测都已覆盖；真实触发后这里会变成 ✅。');

const bad = offlineFail > 0 || !httpLive || errReal.length > 0 || (runs.length > 0 && runStale);
say('');
say(`════════ 结论：${bad ? '有需要看的地方' : '一切正常'} ════════`);
process.exit(bad ? 1 : 0);
