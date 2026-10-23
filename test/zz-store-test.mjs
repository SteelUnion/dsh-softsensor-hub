// zz-store-test.mjs — 事件库测试（MemoryStore + FileStore）

import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore, FileStore, DEFAULT_RETENTION, createStore } from '../lib/store.mjs';
import { validateEvent } from '../lib/event.mjs';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

const TMP = mkdtempSync(join(tmpdir(), 'store-test-'));

function mkEvent(o = {}) {
  const r = validateEvent({
    source: 'mail', kind: 'new-mail', level: 'info',
    summary: '测试', payload: {}, ...o,
  });
  if (!r.ok) throw new Error(`bad fixture: ${r.reason}`);
  return r.event;
}

// ─────────────────────────────────────────────
async function testMemory() {
  console.log('\n=== ① MemoryStore ===');
  const s = new MemoryStore();

  const e1 = mkEvent({ summary: 'a' });
  const e2 = mkEvent({ summary: 'b' });
  ok('存入成功', (await s.put(e1)).ok === true);
  ok('count 为 1', (await s.count()) === 1);

  const dup = await s.put(e1);
  ok('重复 id 被拒', dup.ok === false && dup.reason === 'duplicate-id');
  ok('重复被计数', s.duplicates === 1);
  ok('count 仍是 1', (await s.count()) === 1);

  await s.put(e2);
  ok('取回单条', (await s.get(e1.id))?.summary === 'a');
  ok('取不存在的返回 null', (await s.get('nope')) === null);
  ok('getAll 返回 2 条', (await s.getAll()).length === 2);

  // 按源
  const fin = mkEvent({ source: 'finance', summary: 'f' });
  await s.put(fin);
  ok('bySource 筛出 1 条', (await s.bySource('finance')).length === 1);
  ok('bySource 不存在源返回空', (await s.bySource('nope')).length === 0);

  // 更新
  const u = await s.update(e1.id, (x) => ({ ...x, displayed: { wake: 'now', window: null } }));
  ok('update 成功', u.ok === true);
  ok('update 生效', (await s.get(e1.id)).displayed.wake === 'now');
  ok('update 不存在报 missing-key', (await s.update('nope', (x) => x)).reason === 'missing-key');

  // 删除
  ok('remove 成功', (await s.remove(e2.id)).ok === true);
  ok('remove 不存在返回 false', (await s.remove('nope')).ok === false);

  // 清理：超天数
  console.log('\n=== ② MemoryStore 清理 ===');
  const s2 = new MemoryStore();
  const now = Date.now();
  const old = mkEvent({ summary: 'old' });
  old.at = new Date(now - 40 * 86400_000).toISOString();
  const fresh = mkEvent({ summary: 'fresh' });
  fresh.at = new Date(now - 1 * 86400_000).toISOString();
  await s2.put(old);
  await s2.put(fresh);
  const sw = await s2.sweep({ eventsMaxDays: 30, eventsMaxPerSource: 5000 }, now);
  ok('超 30 天被删', sw.removed === 1, `removed=${sw.removed}`);
  ok('新的还在', (await s2.count()) === 1);

  // 清理：单源超上限
  const s3 = new MemoryStore();
  for (let i = 0; i < 10; i++) {
    const e = mkEvent({ summary: `e${i}` });
    e.at = new Date(now - (10 - i) * 1000).toISOString();
    await s3.put(e);
  }
  const sw2 = await s3.sweep({ eventsMaxDays: 30, eventsMaxPerSource: 4 }, now);
  ok('单源超上限删 6 条', sw2.removed === 6, `removed=${sw2.removed}`);
  ok('留下 4 条', (await s3.count()) === 4);
}

// ─────────────────────────────────────────────
async function testFile() {
  console.log('\n=== ③ FileStore 基本 ===');
  const root = join(TMP, 'f1');
  const s = new FileStore(root, { retention: { eventsMaxDays: 30, eventsMaxPerSource: 5000 } });

  const e1 = mkEvent({ summary: 'file-a', at: '2026-10-21T10:00:00.000Z' });
  const e2 = mkEvent({ summary: 'file-b', at: '2026-10-21T11:00:00.000Z' });
  ok('存入成功', (await s.put(e1)).ok === true);
  await s.put(e2);
  ok('count 为 2', (await s.count()) === 2);

  const dup = await s.put(e1);
  ok('重复 id 被拒', dup.ok === false && dup.reason === 'duplicate-id');

  ok('取回单条', (await s.get(e1.id))?.summary === 'file-a');
  ok('getAll 返回 2 条', (await s.getAll()).length === 2);

  // 按天分文件
  const files = readdirSync(join(root, 'events')).filter((f) => f.endsWith('.jsonl'));
  ok('按天分文件（1 天 1 文件）', files.length === 1, files.join(','));
  ok('文件名是日期', /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(files[0]), files[0]);

  const dayEvents = await s.byDay('2026-10-21');
  ok('byDay 取到 2 条', dayEvents.length === 2, `got ${dayEvents.length}`);

  // 跨天
  const e3 = mkEvent({ summary: 'other-day', at: '2026-10-20T10:00:00.000Z' });
  await s.put(e3);
  const files2 = readdirSync(join(root, 'events')).filter((f) => f.endsWith('.jsonl'));
  ok('第二天生成第二个文件', files2.length === 2, files2.join(','));
  ok('byDay 20 号 1 条', (await s.byDay('2026-10-20')).length === 1);
  ok('byDay 21 号仍 2 条', (await s.byDay('2026-10-21')).length === 2);
}

// ─────────────────────────────────────────────
async function testFileUpdate() {
  console.log('\n=== ④ FileStore 更新与删除 ===');
  const root = join(TMP, 'f2');
  const s = new FileStore(root);
  const e1 = mkEvent({ summary: 'u1', at: '2026-10-21T10:00:00.000Z' });
  await s.put(e1);

  const u = await s.update(e1.id, (x) => ({ ...x, displayed: { wake: 'T', window: null } }));
  ok('update 成功', u.ok === true);
  ok('update 落盘生效', (await s.get(e1.id)).displayed.wake === 'T');

  // 重开一次，确认从磁盘读回来
  const s2 = new FileStore(root);
  ok('重开后能读到', (await s2.get(e1.id))?.displayed.wake === 'T');
  ok('重开后索引重建', (await s2.count()) === 1);

  const r = await s2.remove(e1.id);
  ok('remove 成功', r.ok === true);
  ok('remove 后取不到', (await s2.get(e1.id)) === null);
  ok('remove 不存在返回 false', (await s2.remove('nope')).ok === false);
}

// ─────────────────────────────────────────────
async function testFileSweep() {
  console.log('\n=== ⑤ FileStore 清理 ===');
  const root = join(TMP, 'f3');
  const s = new FileStore(root, { retention: { eventsMaxDays: 30, eventsMaxPerSource: 3 } });
  const now = Date.now();

  const oldE = mkEvent({ summary: 'too-old', at: new Date(now - 40 * 86400_000).toISOString() });
  await s.put(oldE);
  for (let i = 0; i < 5; i++) {
    const e = mkEvent({ summary: `n${i}`, at: new Date(now - (5 - i) * 1000).toISOString() });
    await s.put(e);
  }
  ok('清理前 6 条', (await s.count()) === 6, `got ${await s.count()}`);

  const sw = await s.sweep({ eventsMaxDays: 30, eventsMaxPerSource: 3 }, now);
  ok('清掉 3 条（1 旧的 + 2 超限）', sw.removed === 3, `removed=${sw.removed}`);
  ok('剩 3 条', (await s.count()) === 3);
}

// ─────────────────────────────────────────────
async function testCreateStore() {
  console.log('\n=== ⑥ createStore 选后端 ===');
  const root = join(TMP, 'f4');

  const a = await createStore({ rootDir: root });
  ok('给 rootDir 用 file', a.kind === 'file');

  const b = await createStore({});
  ok('什么都不给用 memory', b.kind === 'memory');

  // storageDomain 抛错 → 回退 file，不炸
  const c = await createStore({
    storageDomain: { open: () => { throw new Error('backend down'); } },
    spec: { name: 'x' },
    rootDir: join(TMP, 'f5'),
  });
  ok('★ storageDomain 挂了回退 file', c.kind === 'file', c.kind);
  ok('回退原因被记下', typeof c.fallbackReason === 'string');
  ok('回退后能正常用', (await c.store.put(mkEvent())).ok === true);
}

// ─────────────────────────────────────────────
async function testAtomic() {
  console.log('\n=== ⑦ 原子写（不能读到半个文件）===');
  const root = join(TMP, 'f6');
  const s = new FileStore(root);
  const e = mkEvent({ at: '2026-10-21T10:00:00.000Z' });
  await s.put(e);
  await s.update(e.id, (x) => ({ ...x, summary: 'after-update' }));

  const dayFile = join(root, 'events', '2026-10-21.jsonl');
  const raw = readFileSync(dayFile, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  ok('文件里只有 1 行（没重复）', lines.length === 1, `got ${lines.length}`);
  ok('每行都是合法 JSON', lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));
  const tmpLeft = readdirSync(join(root, 'events')).filter((f) => f.endsWith('.tmp'));
  ok('没有残留 .tmp', tmpLeft.length === 0, tmpLeft.join(','));
}

// ─────────────────────────────────────────────
// 跑全部
await testMemory();
await testFile();
await testFileUpdate();
await testFileSweep();
await testCreateStore();
await testAtomic();

// 清理
try { rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log(`\n===== ${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} (${pass} passed, ${fail} failed) =====`);
process.exit(fail === 0 ? 0 : 1);