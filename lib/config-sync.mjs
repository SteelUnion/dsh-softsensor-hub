// config-sync.mjs — 配置双写与同步检查
//
// 维护者 2026-10-23 定：
//   「保住，并检查是否同步，如果不同步的话申请检查。由 relay 自己发起。
//     优先以 state，两个文件最上面都加一行，改动本文件需同时同步生效，
//     给出双方文件存储位置，这样也好改。」
//
// 【为什么两份】
//   配置写两处，各有各的不可替代性：
//
//   ① state（storageDomain 的 state 表）
//      权威源。pnpm 重装插件会清空 node_modules，但 state 在 ~/.dsh/storages 下，
//      重装后还在。所以运行**优先读 state**。
//
//   ② config.json（profile 的 node_modules 里）
//      给人看的副本。用户能手改、能 diff、能贴给别人。
//      但它在 node_modules 里，重装就没了 —— 所以它不能是唯一的源。
//
// 【两份不一致怎么办】
//   relay **只申请，不改**。产一条 warn 事件，告诉用户「这两处不一样了，要检查」。
//   维护者 原话：「relay不动吧，没必要啊，框架动什么？」
//   框架不该替用户决定哪份是对的 —— 那是用户的事。
//
// 【怎么让用户知道另存在哪】
//   两个文件顶部各写一行，互相指出对方位置，并写明「改本文件需同时同步生效」。
//   这样用户手改任何一份，抬头就看见还有另一份。
//
// 【谁来比对】
//   - config.json 是对象，state 里存 `config:mirror`（同结构）
//   - 只比"用户能改的那几个字段"，不比整份 —— 否则杂项差异会天天报警
//   - 用稳定序列化（键排序）算指纹，指纹不同 = 不同步

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** 同步提示行的标记。用 HTML 注释，Markdown 里不显示，但伸手可查。 */
export const SYNC_MARKER = 'dsh-relay-sync';

/**
 * 生成"这份文件还有另一份"的提示行。
 *
 * @param selfPath  本文件路径
 * @param otherPath 另一份的路径
 * @param authoritative 哪份是权威（'state' | 'config'）
 */
export function syncBanner(selfPath, otherPath, authoritative) {
  const mine = authoritative === 'state' ? '副本' : '权威';
  const theirs = authoritative === 'state' ? '权威' : '副本';
  return `<!-- ${SYNC_MARKER}: 本文件是${mine}。改动本文件需同时同步修改另一份才生效。` +
    ` 另一份(${theirs}): ${otherPath} ；本文件: ${selfPath} -->`;
}

/** 把 banner 插到 JSON 文件的第一个键之后（JSON 不允许注释，所以用 `_sync` 字段）。 */
export function applyBannerToJsonObject(obj, selfPath, otherPath) {
  const note = `本文件是副本。改动需同时同步 state 表（权威）才生效。` +
    ` 另一份: ${otherPath} ；本文件: ${selfPath}`;
  // 放第一个键，方便用户打开就看见
  return { _sync: note, ...obj };
}

/** 从 JSON 对象里去掉同步字段（比对时不参与）。 */
export function stripSyncFields(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  const out = { ...obj };
  delete out._sync;
  return out;
}

/**
 * 参与比对的字段。**只有用户能改的才比。**
 *
 * 不比整份的原因：`_说明` 注释、`interface`、`retention` 这些是开发维护的，
 * 用户不碰，混进比对只会制造假警报。
 */
export const SYNCED_PATHS = [
  'sources.weather.enabled',
  'sources.weather.locations',
  'sources.weather.geoIp',
  'sources.weather.fallbackCity',
  'sources.weather.refreshHours',
  'sources.weather.keepDays',
  'sources.weather.thresholds',
  'sources.weather.dailyLevel',
  'init.hintPath',
  'init.checkGitHub',
  'init.wakeOnIncomplete',
];

/** 按点号路径取值。 */
function getPath(obj, path) {
  let cur = obj;
  for (const key of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

/** 按点号路径设值（造嵌套用）。 */
function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (cur[k] === null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return obj;
}

/**
 * 把扁平的点号键对象还原成嵌套结构。
 *
 * 【为什么需要】
 *   state 里存的镜像是 `pickSynced()` 的结果，键是 `"sources.weather.enabled"`
 *   这种扁平形式。而 `diffSynced(a, b)` 期望两边都是**完整嵌套配置**（它会自己 pick）。
 *
 *   不还原的话，`diffSynced` 会对扁平对象再 pick 一次 —— 点号路径在扁平对象里
 *   找不到任何值，于是所有字段都被当成"缺失"，报出一整屏假差异。
 *   这是 2026-10-23 被 zz-config-sync-test 的「一致 → IN_SYNC」抓出来的真 bug。
 *
 * @param flat 形如 { 'a.b.c': 1 }
 */
export function inflate(flat) {
  if (flat === null || typeof flat !== 'object' || Array.isArray(flat)) return {};
  const out = {};
  for (const [k, v] of Object.entries(flat)) {
    setPath(out, k, v);
  }
  return out;
}

/**
 * 稳定序列化：键排序后再 JSON.stringify。
 *
 * 【为什么必须稳定】
 *   同一份配置，键顺序不同就算出不同指纹 —— 那会天天误报。
 *   对象键顺序在 JS 里是有保证的（插入序），但从 JSON 读回来时
 *   顺序取决于文件写法。所以排序后再比。
 */
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

/**
 * 抽出参与比对的字段，返回 { path: value }。
 */
export function pickSynced(config) {
  const out = {};
  for (const p of SYNCED_PATHS) {
    const v = getPath(config, p);
    if (v !== undefined) out[p] = v;
  }
  return out;
}

/** 算指纹。 */
export function fingerprint(config) {
  return stableStringify(pickSynced(config));
}

/** 逐字段比对，返回差异列表（排障和事件都用得上）。 */
export function diffSynced(a, b) {
  const pa = pickSynced(a ?? {});
  const pb = pickSynced(b ?? {});
  const keys = new Set([...Object.keys(pa), ...Object.keys(pb)]);
  const diffs = [];
  for (const k of [...keys].sort()) {
    const va = stableStringify(pa[k]);
    const vb = stableStringify(pb[k]);
    if (va !== vb) diffs.push({ field: k, config: pa[k] ?? null, state: pb[k] ?? null });
  }
  return diffs;
}

/**
 * 读 config.json，并检查它有没有我们的 banner。
 *
 * 文件不存在返回 null（新机器还没配）。
 */
export function readConfigFile(configPath) {
  try {
    if (!existsSync(configPath)) return { exists: false, data: null, hasBanner: false };
    const data = JSON.parse(readFileSync(configPath, 'utf8'));
    const hasBanner = typeof data?._sync === 'string' && data._sync.includes('另一份');
    return { exists: true, data, hasBanner };
  } catch (e) {
    return { exists: true, data: null, hasBanner: false, error: String(e?.message ?? e) };
  }
}

/**
 * 把配置写回 config.json（保留原文件的 `_说明` 等注释字段）。
 *
 * 【只覆盖参与同步的字段】不动别的键 —— 用户可能自己在文件里加东西。
 *
 * @param configPath 目标文件
 * @param next       新配置（可以是整份，也可以是局部）
 * @param statePath  写 banner 时用的"另一份"路径说明
 */
export function writeConfigFile(configPath, next, statePath) {
  const cur = readConfigFile(configPath);
  const base = cur.data ?? {};
  const merged = mergeDeep(base, next);
  const withBanner = applyBannerToJsonObject(merged, configPath, statePath);
  const dir = dirname(configPath);
  try {
    mkdirSync(dir, { recursive: true });
  } catch { /* 已在 */ }
  const tmp = `${configPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(withBanner, null, 2) + '\n', 'utf8');
  renameSync(tmp, configPath);   // 原子替换
  return { ok: true, path: configPath };
}

/** 深合并：next 覆盖 base，对象递归、数组整体替换。 */
export function mergeDeep(base, next) {
  if (next === null || typeof next !== 'object' || Array.isArray(next)) return next;
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return { ...next };
  const out = { ...base };
  for (const [k, v] of Object.entries(next)) {
    out[k] = v !== null && typeof v === 'object' && !Array.isArray(v)
      ? mergeDeep(base[k], v)
      : v;
  }
  return out;
}

// ─────────────────────────── 同步检查 ───────────────────────────

/** 同步检查的三种结果。 */
export const SYNC = {
  IN_SYNC: 'in-sync',
  DIFF: 'diff',
  NO_CONFIG: 'no-config',
  NO_STATE: 'no-state',
  BAD_CONFIG: 'bad-config',
};

/**
 * 检查两份是否同步。
 *
 * @param configPath  config.json 路径
 * @param state       state 后端
 * @param stateMirrorKey state 里存镜像的 key
 * @returns {{ status, diffs, configPath, statePath, detail }}
 */
export function checkSync(configPath, state, stateMirrorKey = 'config:mirror') {
  const cur = readConfigFile(configPath);
  const mirror = state?.get?.(stateMirrorKey, null);
  const statePath = '~/.dsh/storages/butler (state 表, key=config:mirror)';

  if (cur.exists === false) {
    return { status: SYNC.NO_CONFIG, diffs: [], configPath, statePath, detail: 'config.json 不存在' };
  }
  if (cur.error !== undefined) {
    return { status: SYNC.BAD_CONFIG, diffs: [], configPath, statePath, detail: cur.error };
  }
  if (mirror === null || mirror === undefined) {
    return { status: SYNC.NO_STATE, diffs: [], configPath, statePath, detail: 'state 里没有镜像，还没同步过' };
  }
  // 【必须还原成嵌套】mirror 是 pickSynced 的扁平结果，
  // diffSynced 会对两边各自 pick 一次 —— 直接传扁平对象会让所有字段都被判为缺失。
  const diffs = diffSynced(cur.data, inflate(mirror));
  if (diffs.length === 0) {
    return { status: SYNC.IN_SYNC, diffs: [], configPath, statePath, detail: '一致' };
  }
  return {
    status: SYNC.DIFF,
    diffs,
    configPath,
    statePath,
    detail: `${diffs.length} 个字段不一致：${diffs.map((d) => d.field).join(', ')}`,
  };
}

/**
 * 造一条"配置不同步"的事件。
 *
 * 【为什么是 warn 不是 critical】
 *   不同步不代表坏了 —— 运行用的还是 state，功能正常。
 *   只是提醒用户"你手改的那份没生效"。warn 走攒批，不打断。
 *
 * 【为什么叫"申请检查"】
 *   维护者 原话：「如果不同步的话申请检查。由 relay 自己发起。」
 *   relay 不动配置，只发问。用户看到后决定以谁为准。
 */
export function buildSyncEvent(result) {
  if (result.status !== SYNC.DIFF) return null;
  const fields = result.diffs.map((d) => d.field).join('、');
  return {
    source: 'relay-config',
    kind: 'config-out-of-sync',
    level: 'warn',
    // 同一批差异只提醒一次
    dedupeKey: `relay-config:sync:${result.diffs.map((d) => d.field).sort().join(',')}`,
    summary: `配置不同步：${result.diffs.length} 处（${fields.slice(0, 40)}）`,
    payload: {
      diffs: result.diffs,
      configPath: result.configPath,
      statePath: result.statePath,
      note: '运行以 state 为准。改 config.json 需同步 state 才生效；反之亦然。',
    },
  };
}

export default {
  SYNC_MARKER,
  SYNCED_PATHS,
  SYNC,
  syncBanner,
  applyBannerToJsonObject,
  stripSyncFields,
  stableStringify,
  pickSynced,
  fingerprint,
  diffSynced,
  readConfigFile,
  writeConfigFile,
  mergeDeep,
  checkSync,
  buildSyncEvent,
};
