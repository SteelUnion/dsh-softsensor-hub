// zz-config-sync-test.mjs — 配置双写与同步检查
//
// 维护者 2026-10-23 定：
//   「保住，并检查是否同步，如果不同步的话申请检查。由 relay 自己发起。
//     优先以 state，两个文件最上面都加一行，改动本文件需同时同步生效，
//     给出双方文件存储位置。」
//
// 约定 D1：每条都要能红。
//   指纹不稳定 → "键序不同应判一致"会红
//   比对字段写错 → "改 enabled 应被发现"会红
//   banner 不写 → "有 _sync 字段"会红

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fingerprint,
  pickSynced,
  diffSynced,
  stableStringify,
  checkSync,
  buildSyncEvent,
  readConfigFile,
  writeConfigFile,
  mergeDeep,
  inflate,
  syncBanner,
  applyBannerToJsonObject,
  stripSyncFields,
  SYNC,
  SYNCED_PATHS,
} from '../lib/config-sync.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 内存 state 桩。 */
function mkState(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    get: (k, d) => (m.has(k) ? m.get(k) : d),
    set: (k, v) => { m.set(k, v); },
    del: (k) => m.delete(k),
    _map: m,
  };
}

/** 造一份典型配置。 */
function mkConfig(over = {}) {
  return {
    _说明: 'relay 配置',
    sources: {
      weather: {
        enabled: true,
        locations: ['哈尔滨'],
        geoIp: true,
        fallbackCity: '北京',
        refreshHours: 6,
        keepDays: 10,
        thresholds: { warnC: 5, criticalC: 8 },
        dailyLevel: 'info',
      },
    },
    init: { hintPath: null, checkGitHub: true, wakeOnIncomplete: true },
    ...over,
  };
}

const tmpDirs = [];
function mkTmp(name) {
  const d = mkdtempSync(join(tmpdir(), `zz-cfg-${name}-`));
  tmpDirs.push(d);
  return d;
}

async function main() {
  // ═══════════ 一、稳定序列化与指纹 ═══════════

  // ① 键序不同，结果相同
  {
    const a = { x: 1, y: { p: 2, q: 3 } };
    const b = { y: { q: 3, p: 2 }, x: 1 };
    ok('键序不同 → 序列化相同', stableStringify(a) === stableStringify(b), stableStringify(a));
  }

  // ② 数组顺序有意义（不能排序）
  {
    ok('数组 [1,2] ≠ [2,1]',
      stableStringify([1, 2]) !== stableStringify([2, 1]));
  }

  // ③ 指纹：同一配置、不同书写顺序 → 相同
  {
    const a = mkConfig();
    const b = { ...mkConfig() };
    b.sources = { weather: { ...b.sources.weather } };
    // 重排 weather 内键序
    const w = b.sources.weather;
    b.sources.weather = {
      dailyLevel: w.dailyLevel, thresholds: w.thresholds, keepDays: w.keepDays,
      refreshHours: w.refreshHours, fallbackCity: w.fallbackCity, geoIp: w.geoIp,
      locations: w.locations, enabled: w.enabled,
    };
    ok('键序不同 → 指纹相同', fingerprint(a) === fingerprint(b));
  }

  // ④ 指纹：内容不同 → 不同
  {
    const a = mkConfig();
    const b = mkConfig();
    b.sources.weather.locations = ['哈尔滨', '上海'];
    ok('locations 不同 → 指纹不同', fingerprint(a) !== fingerprint(b));
  }

  // ⑤ 不参与同步的字段改了，指纹不变
  {
    const a = mkConfig();
    const b = mkConfig();
    b._说明 = '改过的说明';
    b.retention = { receivedMaxLines: 9999 };
    ok('_说明 改动不影响指纹', fingerprint(a) === fingerprint(b));
  }

  // ═══════════ 二、pickSynced / diffSynced ═══════════

  // ① 只取同步字段
  {
    const p = pickSynced(mkConfig());
    ok('取了 weather.enabled', p['sources.weather.enabled'] === true);
    ok('取了 locations', Array.isArray(p['sources.weather.locations']));
    ok('取了 init.checkGitHub', p['init.checkGitHub'] === true);
    ok('没取 _说明', p['_说明'] === undefined);
    ok('字段数 = SYNCED_PATHS 长度',
      Object.keys(p).length === SYNCED_PATHS.length,
      `${Object.keys(p).length} vs ${SYNCED_PATHS.length}`);
  }

  // ② 差异能定位到字段
  {
    const a = mkConfig();
    const b = mkConfig();
    b.sources.weather.refreshHours = 12;
    const d = diffSynced(a, b);
    ok('发现 1 处差异', d.length === 1, JSON.stringify(d));
    ok('字段名对', d[0]?.field === 'sources.weather.refreshHours', d[0]?.field);
    ok('带两边值', d[0]?.config === 6 && d[0]?.state === 12, JSON.stringify(d[0]));
  }

  // ③ 无差异
  {
    ok('同配置无差异', diffSynced(mkConfig(), mkConfig()).length === 0);
  }

  // ④ 字段缺失也算差异
  {
    const a = mkConfig();
    const b = mkConfig();
    delete b.sources.weather.locations;
    const d = diffSynced(a, b);
    ok('字段缺失算差异', d.length >= 1, JSON.stringify(d));
    ok('缺失侧为 null', d.find((x) => x.field === 'sources.weather.locations')?.state === null);
  }

  // ═══════════ 三、banner ═══════════

  // ① syncBanner 指明两份位置
  {
    const b = syncBanner('C:\\a\\config.json', '~/.dsh/storages/butler', 'state');
    ok('banner 含标记', b.includes('dsh-relay-sync'));
    ok('banner 含本文件路径', b.includes('C:\\a\\config.json'));
    ok('banner 含另一份路径', b.includes('~/.dsh/storages/butler'));
    ok('banner 说明需同步', b.includes('同步'));
  }

  // ② applyBannerToJsonObject 把 _sync 放第一个键
  {
    const o = applyBannerToJsonObject({ z: 1, a: 2 }, 'self', 'other');
    ok('_sync 是第一个键', Object.keys(o)[0] === '_sync', Object.keys(o).join(','));
    ok('_sync 含路径', o._sync.includes('self') && o._sync.includes('other'));
    ok('原字段还在', o.z === 1 && o.a === 2);
  }

  // ③ stripSyncFields 去掉 _sync
  {
    const o = stripSyncFields({ _sync: 'x', a: 1 });
    ok('去掉了 _sync', o._sync === undefined);
    ok('保留其他', o.a === 1);
  }

  // ═══════════ 四、读写 config.json ═══════════

  // ① 写 → 读 往返
  {
    const dir = mkTmp('rw');
    const p = join(dir, 'config.json');
    const w = writeConfigFile(p, mkConfig(), 'state-path');
    ok('写成功', w.ok === true);
    ok('文件存在', existsSync(p));
    const r = readConfigFile(p);
    ok('读回来 exists', r.exists === true);
    ok('读回来有 _sync', r.hasBanner === true, JSON.stringify(r.data?._sync));
    ok('读回来数据对', r.data?.sources?.weather?.refreshHours === 6);
  }

  // ② 写时保留原有注释字段
  {
    const dir = mkTmp('keep');
    const p = join(dir, 'config.json');
    writeFileSync(p, JSON.stringify({
      _sync: 'old',
      _说明: '别删我',
      sources: { weather: { enabled: false, refreshHours: 6 } },
    }), 'utf8');
    writeConfigFile(p, { sources: { weather: { refreshHours: 12 } } }, 'state');
    const r = readConfigFile(p);
    ok('保留 _说明', r.data?._说明 === '别删我', r.data?._说明);
    ok('合并了新值', r.data?.sources?.weather?.refreshHours === 12);
    ok('保留未提到的旧值', r.data?.sources?.weather?.enabled === false);
  }

  // ③ 坏 JSON 读回 error，不抛
  {
    const dir = mkTmp('bad');
    const p = join(dir, 'config.json');
    writeFileSync(p, '{ 这不是 json', 'utf8');
    let threw = false;
    let r = null;
    try { r = readConfigFile(p); } catch { threw = true; }
    ok('坏 JSON 不抛', threw === false);
    ok('坏 JSON 有 error', typeof r?.error === 'string');
  }

  // ④ 文件不存在
  {
    const dir = mkTmp('none');
    const r = readConfigFile(join(dir, 'nope.json'));
    ok('不存在 → exists=false', r.exists === false);
  }

  // ═══════════ 五、checkSync 五种状态 ═══════════

  // ① 一致
  {
    const dir = mkTmp('sync');
    const p = join(dir, 'config.json');
    writeConfigFile(p, mkConfig(), 'state');
    const s = mkState({ 'config:mirror': pickSynced(mkConfig()) });
    const r = checkSync(p, s);
    ok('一致 → IN_SYNC', r.status === SYNC.IN_SYNC, r.status);
    ok('无 diff', r.diffs.length === 0);
  }

  // ② 不一致
  {
    const dir = mkTmp('diff');
    const p = join(dir, 'config.json');
    writeConfigFile(p, mkConfig(), 'state');
    const other = mkConfig();
    other.sources.weather.locations = ['北京'];
    const s = mkState({ 'config:mirror': pickSynced(other) });
    const r = checkSync(p, s);
    ok('不一致 → DIFF', r.status === SYNC.DIFF, r.status);
    ok('指出 locations', r.diffs.some((d) => d.field === 'sources.weather.locations'), JSON.stringify(r.diffs));
    ok('detail 说清几处', r.detail.includes('1'), r.detail);
  }

  // ③ config 不存在
  {
    const dir = mkTmp('nocfg');
    const r = checkSync(join(dir, 'nope.json'), mkState({ 'config:mirror': {} }));
    ok('无 config → NO_CONFIG', r.status === SYNC.NO_CONFIG, r.status);
  }

  // ④ state 没镜像
  {
    const dir = mkTmp('nostate');
    const p = join(dir, 'config.json');
    writeConfigFile(p, mkConfig(), 'state');
    const r = checkSync(p, mkState());
    ok('无镜像 → NO_STATE', r.status === SYNC.NO_STATE, r.status);
  }

  // ⑤ 坏 config
  {
    const dir = mkTmp('badcfg');
    const p = join(dir, 'config.json');
    writeFileSync(p, 'destroyed', 'utf8');
    const r = checkSync(p, mkState({ 'config:mirror': {} }));
    ok('坏 config → BAD_CONFIG', r.status === SYNC.BAD_CONFIG, r.status);
  }

  // ⑥ 每个结果都带两份路径（用户要知道去哪改）
  {
    const dir = mkTmp('paths');
    const p = join(dir, 'config.json');
    writeConfigFile(p, mkConfig(), 'state');
    const r = checkSync(p, mkState({ 'config:mirror': pickSynced(mkConfig()) }));
    ok('带 configPath', typeof r.configPath === 'string' && r.configPath === p);
    ok('带 statePath', typeof r.statePath === 'string' && r.statePath.length > 0);
  }

  // ⑦ 回归：镜像必须是「扁平」存进 state，checkSync 要能还原
  //
  //   【这个 bug 2026-10-23 真踩过】
  //     state 存的是 pickSynced() 的扁平结果（键 = "sources.weather.enabled"）。
  //     checkSync 若直接把它传给 diffSynced（内部会再 pick 一次），
  //     扁平对象里点号路径取不到值 → 所有字段都被判为"缺失"→ 满屏假差异。
  //   下面两条守住它：镜像扁平化后，checkSync 仍判 IN_SYNC。
  {
    const dir = mkTmp('flat');
    const p = join(dir, 'config.json');
    writeConfigFile(p, mkConfig(), 'state');
    const flat = pickSynced(mkConfig());
    ok('镜像确实是扁平的', Object.keys(flat).some((k) => k.includes('.')), Object.keys(flat).slice(0, 2).join(','));
    const r = checkSync(p, mkState({ 'config:mirror': flat }));
    ok('扁平镜像 → 仍判一致', r.status === SYNC.IN_SYNC, `${r.status}: ${r.detail}`);
  }

  // ⑧ inflate 往返：嵌套 → 扁平 → 嵌套，值不变
  {
    const orig = mkConfig();
    const flat = pickSynced(orig);
    const back = inflate(flat);
    ok('inflate 还原 enabled', back?.sources?.weather?.enabled === true);
    ok('inflate 还原数组', JSON.stringify(back?.sources?.weather?.locations) === '["哈尔滨"]');
    ok('inflate 还原嵌套对象', back?.sources?.weather?.thresholds?.criticalC === 8);
    ok('inflate 后再 pick 与原始一致',
      fingerprint(back) === fingerprint(orig),
      `${fingerprint(back)?.slice(0, 60)}`);
  }

  // ═══════════ 六、同步事件 ═══════════

  // ① 不一致 → 产 warn 事件
  {
    const evt = buildSyncEvent({
      status: SYNC.DIFF,
      diffs: [{ field: 'sources.weather.locations', config: ['哈尔滨'], state: ['北京'] }],
      configPath: 'C:\\cfg.json',
      statePath: '~/.dsh/storages/butler',
    });
    ok('DIFF 产事件', evt !== null);
    ok('级别是 warn（不打断）', evt.level === 'warn', evt.level);
    ok('summary 含"不同步"', evt.summary.includes('不同步'), evt.summary);
    ok('payload 带 diffs', Array.isArray(evt.payload.diffs) && evt.payload.diffs.length === 1);
    ok('payload 带两份路径', evt.payload.configPath === 'C:\\cfg.json' && evt.payload.statePath.length > 0);
    ok('payload 说明以 state 为准', evt.payload.note.includes('state'), evt.payload.note);
  }

  // ② 一致 → 不产事件
  {
    ok('IN_SYNC 不产事件',
      buildSyncEvent({ status: SYNC.IN_SYNC, diffs: [], configPath: 'a', statePath: 'b' }) === null);
  }

  // ③ 其他状态不产事件
  {
    ok('NO_CONFIG 不产事件',
      buildSyncEvent({ status: SYNC.NO_CONFIG, diffs: [], configPath: 'a', statePath: 'b' }) === null);
  }

  // ④ dedupeKey 稳定：同一批差异两次算出来一样
  {
    const mk = () => buildSyncEvent({
      status: SYNC.DIFF,
      diffs: [
        { field: 'a.b', config: 1, state: 2 },
        { field: 'c.d', config: 3, state: 4 },
      ],
      configPath: 'p', statePath: 'q',
    });
    ok('dedupeKey 稳定', mk().dedupeKey === mk().dedupeKey, mk().dedupeKey);
  }

  // ⑤ 差异集合不同 → dedupeKey 不同
  {
    const e1 = buildSyncEvent({ status: SYNC.DIFF, diffs: [{ field: 'a.b' }], configPath: 'p', statePath: 'q' });
    const e2 = buildSyncEvent({ status: SYNC.DIFF, diffs: [{ field: 'c.d' }], configPath: 'p', statePath: 'q' });
    ok('不同差异 → 不同 dedupeKey', e1.dedupeKey !== e2.dedupeKey);
  }

  // ═══════════ 七、mergeDeep ═══════════

  {
    const a = { x: { y: 1, z: 2 }, arr: [1, 2] };
    const b = { x: { y: 9 }, arr: [3] };
    const m = mergeDeep(a, b);
    ok('深合并覆盖', m.x.y === 9);
    ok('深合并保留', m.x.z === 2);
    ok('数组整体替换', JSON.stringify(m.arr) === '[3]', JSON.stringify(m.arr));

    // 【关键】不能改原对象
    ok('不改原对象 a', a.x.y === 1, String(a.x.y));

    const n = mergeDeep(null, { a: 1 });
    ok('null base 也能合', n.a === 1);
    const s = mergeDeep({ a: 1 }, 5);
    ok('标量直接替换', s === 5, JSON.stringify(s));
  }

  // ═══════════ 汇总 ═══════════

  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  if (fail > 0) {
    console.log('');
    for (const f of failures) console.log(`    ✗ ${f}`);
  }
  console.log(`\n===== ${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} (${pass} passed, ${fail} failed) =====`);
  if (fail > 0) process.exitCode = 1;
  return { pass, fail };
}

const result = await main();
export default result;
