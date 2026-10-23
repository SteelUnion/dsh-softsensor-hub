#!/usr/bin/env node
// relay.mjs — 消息中枢命令行
//
// 标准：okb/消息中枢-接入标准.md v1
//
// 【边界】这个 CLI 会写文件（配对、发消息），但它是**人手动调用**的工具，
// 不是中枢自己。中枢（lib/index.js）不含任何写操作。
// 两者的权限不同，不要混为一谈。

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PEERS = join(ROOT, 'peers');
const INBOX = join(ROOT, 'inbox');
const ARCHIVE = join(ROOT, 'archive');

function ensure() {
  for (const d of [PEERS, INBOX, ARCHIVE]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

function readJsonl(name) {
  const p = join(ROOT, name);
  if (!existsSync(p)) return [];
  const out = [];
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 坏行跳过 */
    }
  }
  return out;
}

// ---------------------------------------------------------------- 子命令

function cmdPair(args) {
  ensure();
  const [id, note] = args;
  if (!id) {
    console.error('用法：relay.mjs pair <id> [备注]');
    process.exit(2);
  }
  const p = join(PEERS, `${id}.json`);
  if (existsSync(p)) {
    console.error(`配对已存在：${id}。要重配先 revoke`);
    process.exit(1);
  }
  const token = randomBytes(16).toString('hex');
  writeFileSync(
    p,
    JSON.stringify(
      {
        id,
        token,
        allowedLevels: ['info', 'warn', 'critical'],
        note: note ?? '',
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`已配对：${id}`);
  console.log(`  token  ${token}`);
  console.log(`  文件   peers/${id}.json`);
  console.log('');
  console.log('把 token 交给对应脚本，它就能往 inbox/ 投消息了。');
}

function cmdRevoke(args) {
  const id = args[0];
  if (!id) {
    console.error('用法：relay.mjs revoke <id>');
    process.exit(2);
  }
  const p = join(PEERS, `${id}.json`);
  if (!existsSync(p)) {
    console.log(`没有这个配对：${id}`);
    return;
  }
  unlinkSync(p);
  console.log(`已吊销：${id}`);
}

function cmdPeers() {
  ensure();
  const files = readdirSync(PEERS).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    console.log('没有配对。用 relay.mjs pair <id> 添加');
    return;
  }
  console.log(`${files.length} 个配对：`);
  for (const f of files) {
    try {
      const p = JSON.parse(readFileSync(join(PEERS, f), 'utf8'));
      const sup = p.supervise?.enabled ? '  [监管]' : '';
      console.log(`  ${String(p.id).padEnd(16)} ${p.note ?? ''}${sup}`);
    } catch {
      console.log(`  ${f}  (无法解析)`);
    }
  }
}

function cmdSend(args) {
  ensure();
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) opts[a.slice(2)] = args[++i];
  }
  if (!opts.peer || !opts.title) {
    console.error('用法：relay.mjs send --peer <id> --level <级别> --title <标题> [--body <正文>]');
    process.exit(2);
  }
  const peerFile = join(PEERS, `${opts.peer}.json`);
  if (!existsSync(peerFile)) {
    console.error(`没有配对的 peer：${opts.peer}`);
    process.exit(1);
  }
  const peer = JSON.parse(readFileSync(peerFile, 'utf8'));

  const msg = {
    peer: opts.peer,
    token: peer.token,
    level: opts.level ?? 'info',
    title: opts.title,
    ...(opts.body ? { body: opts.body } : {}),
    ...(opts.dedupe ? { dedupeKey: opts.dedupe } : {}),
    at: new Date().toISOString(),
  };

  const name = `${opts.peer}-${Date.now()}.json`;
  writeFileSync(join(INBOX, name), JSON.stringify(msg, null, 2), 'utf8');
  console.log(`已投递：inbox/${name}`);
}

function cmdStatus() {
  ensure();
  const received = readJsonl('received.jsonl');
  const rejected = readJsonl('rejected.jsonl');
  const down = readJsonl('peers-down.jsonl');
  const inboxCount = existsSync(INBOX) ? readdirSync(INBOX).filter((f) => f.endsWith('.json')).length : 0;

  console.log('消息中枢状态');
  console.log(`  收件待处理  ${inboxCount}`);
  console.log(`  已接收      ${received.length}`);
  console.log(`  已拒收      ${rejected.length}`);
  console.log(`  对端停机    ${down.length}`);

  if (rejected.length > 0) {
    console.log('  最近拒收：');
    for (const r of rejected.slice(-3)) console.log(`    ${r.at}  ${r.file}  ${r.reason}`);
  }
  if (down.length > 0) {
    console.log('  最近停机：');
    for (const d of down.slice(-3)) console.log(`    ${d.at}  ${d.peer}`);
  }
}

function cmdRecent(args) {
  const n = Number(args[0]) || 10;
  const received = readJsonl('received.jsonl').slice(-n);
  if (received.length === 0) {
    console.log('没有消息');
    return;
  }
  for (const m of received) {
    console.log(`${m.at}  [${m.level}] ${m.peer}  ${m.title}`);
  }
}

// ---------------------------------------------------------------- 天气查询
//
// 维护者 2026-10-23：
//   「给个极简接口，最好是有提示，比如 relay 的模块接口上写着，
//     查询：relay.mjs + xxxx 极简提示，这样你就知道了。」
//
// 【为什么不直接读表】
//   表里是原始记录（几十上百行 JSON）。relay 算好只给 3-5 行结论，
//   agent 的上下文干净，而数字仍可回查表 —— 简单可靠 + 可溯源。

/** 读 state：优先 butler 域的 state 表，退 relay 数据目录的 state.json。 */
async function loadState() {
  const { createStateBackend } = await import('./lib/state.mjs');
  // ROOT 是这个文件所在目录（即插件安装目录），数据在 dataDir 里
  const statePaths = [
    // 环境变量优先：用户可指向任意数据目录
    process.env.DSH_RELAY_DATA,
  ].filter(Boolean);

  for (const dir of statePaths) {
    if (!existsSync(join(dir, 'state.json'))) continue;
    const b = await createStateBackend({ rootDir: dir });
    return b;
  }
  // 最后试插件目录自己
  return createStateBackend({ rootDir: ROOT });
}

async function cmdWeather(args) {
  const { queryWeather, listCitiesWithData } = await import('./lib/weather-query.mjs');
  const { resolveCity, knownCities, aliasesOf } = await import('./lib/cities.mjs');

  // 解析参数：relay.mjs weather [城市] [--days N] [--list] [--alias <城市>]
  let city = null;
  let days = 10;
  let listMode = false;
  let aliasMode = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--days' || a === '-n') days = Number(args[++i]) || 10;
    else if (a === '--list' || a === '-l') listMode = true;
    else if (a === '--alias') aliasMode = args[++i] ?? null;
    else if (!a.startsWith('-')) city = a;
  }

  const state = await loadState();

  // --alias：查某城市的别名
  if (aliasMode !== null) {
    const std = resolveCity(aliasMode);
    console.log(`${aliasMode} → ${std}`);
    console.log(`  别名：${aliasesOf(std).join('  ')}`);
    return;
  }

  // --list：列出有数据的城市
  if (listMode) {
    const rows = listCitiesWithData(state, 10);
    if (rows.length === 0) {
      console.log('weather 表里还没有数据。');
      console.log('  （采集器可能没启用，或还没到第一次刷新）');
      return;
    }
    console.log('有天气数据的城市：');
    for (const r of rows) console.log(`  ${r.city}  ${r.count} 天`);
    return;
  }

  // 没给城市 → 列出可查的
  if (city === null) {
    const configured = state.get('weather:locations', null);
    const names = Array.isArray(configured) ? configured.map((l) => l.name ?? l) : [];
    console.error(`用法：relay.mjs weather <城市> [--days N]
       relay.mjs weather --list            列出有数据的城市
       relay.mjs weather --alias <城市>    查别名

采集列表：${names.length > 0 ? names.join('、') : '（空）'}
已知城市简写：${knownCities().slice(0, 8).join('、')}…（共 ${knownCities().length} 个）`);
    process.exit(2);
  }

  const r = queryWeather({ state, city, days });
  if (!r.ok) {
    console.error(`${r.error}`);
    process.exit(1);
  }
  console.log(r.text);
}

// ---------------------------------------------------------------- 入口

const [cmd, ...rest] = process.argv.slice(2);

const table = {
  pair: () => cmdPair(rest),
  revoke: () => cmdRevoke(rest),
  peers: () => cmdPeers(),
  send: () => cmdSend(rest),
  status: () => cmdStatus(),
  recent: () => cmdRecent(rest),
  weather: () => cmdWeather(rest),
};

if (!table[cmd]) {
  console.error(`relay — 消息中枢 CLI

  pair <id> [备注]        配对一个接入方，打印 token
  revoke <id>             吊销配对
  peers                   列出配对
  send --peer --title ... 手动投递一条消息
  status                  查看状态
  recent [n]              最近 n 条

  weather <城市> [--days N]   查天气（relay 算好，给结论）
  weather --list              列出有数据的城市
  weather --alias <城市>      查城市别名

【给 agent 的极简提示】
  问天气 → relay.mjs weather <城市>
  城市可写中文/拼音/简写，如 哈尔滨 / haerbin / hrb
  想要更长区间 → --days 3
`);
  process.exit(2);
}

try {
  await table[cmd]();
} catch (err) {
  console.error(`错误：${err.message}`);
  process.exit(1);
}
