// zz-batch-test.mjs — 批次与去重专项
//
// 验证用户定的规则：
//   - 攒满 maxItems 条（按事件骨架去重后）→ 立刻发
//   - 满 maxWaitSec 秒 → 发
//   - 先到先发，发完重置
//   - 正文要显示"另有 N 条同类已合并"
//   - critical 不进批次，立刻发
//   - 同类告警（数字/时间不同）要合并

import { writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const SELF = dirname(fileURLToPath(import.meta.url));
const { apply } = await import('../lib/index.js');
const { eventSkeleton, groupBySkeleton } = await import('../lib/message.mjs');

let passed = 0, failed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); console.log(`PASS  ${name}`); passed++; }
  catch (e) { console.log(`FAIL  ${name}\n      ${e.message}`); failed++; failures.push(name); }
}

let caseNo = 0;

function cfg(over = {}) {
  return {
    enabled: true,
    quietHours: { enabled: false },
    supervise: { enabled: false },
    gameMode: { enabled: false },
    interface: { file: { enabled: true, dir: 'inbox', pollMs: 10000 }, http: { enabled: false } },
    rate: { maxPerTurn: 20, maxPerHour: 100, globalCooldownSec: 0 },
    delivery: {
      levels: {
        critical: { channel: 'wake', cooldownSec: 0, mergeWindowSec: 0, titleChars: 20, batch: { enabled: false } },
        warn: { channel: 'queue', cooldownSec: 0, mergeWindowSec: 0, titleChars: 20, batch: { enabled: true, maxItems: 5, maxWaitSec: 300 } },
        info: { channel: 'archive', cooldownSec: 0, mergeWindowSec: 0, titleChars: 20, batch: { enabled: false } },
      },
    },
    ...over,
  };
}

async function scenario(messages, over = {}) {
  caseNo++;
  const ROOT = join(SELF, `.zz-batch-root-${caseNo}`);
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(ROOT, 'inbox'), { recursive: true });
  mkdirSync(join(ROOT, 'peers'), { recursive: true });
  mkdirSync(join(ROOT, 'archive'), { recursive: true });
  writeFileSync(join(ROOT, 'peers', 'e2e.json'),
    JSON.stringify({ id: 'e2e', token: 'tok', allowedLevels: ['info', 'warn', 'critical'] }));
  writeFileSync(join(ROOT, 'config.json'), JSON.stringify(cfg(over)));
  messages.forEach((m, i) => writeFileSync(join(ROOT, 'inbox', `m-${i}.json`),
    JSON.stringify({ peer: 'e2e', token: 'tok', ...m })));

  const steered = [], followed = [], injected = [];
  const agent = { id: 's', status: 'running',
    inject: (m) => injected.push(m), steer: (m) => steered.push(m), followup: (m) => followed.push(m) };
  let created = null;
  const ctx = {
    on: (n, f) => { if (n === 'agent/created') created = f; return () => {}; },
    get: () => null, emit: () => {},
    agents: { get: () => agent, roots: () => [agent] },
    effect: (f) => { try { return f(); } catch { return () => {}; } },
  };
  const inst = apply(ctx, { root: ROOT });
  created?.({ agent });
  await new Promise((r) => setTimeout(r, 150));
  return { ROOT, steered, followed, injected, inst };
}

function cleanup(ROOT) { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ } }

function batchesOf(ROOT) {
  const p = join(ROOT, 'logs', 'batches.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

// ============================================ 骨架去重
console.log('\n=== 骨架去重 ===');
{
  const a = { peer: 'monitor', level: 'warn', title: '内存占用 93.2% 超过阈值 85%', dedupeKey: null };
  const b = { peer: 'monitor', level: 'warn', title: '内存占用 93.5% 超过阈值 85%', dedupeKey: null };
  const c = { peer: 'monitor', level: 'warn', title: '磁盘可用空间低于 10%', dedupeKey: null };
  const d1 = { peer: 'monitor', level: 'warn', title: '2026-10-20 17:30:12 服务重启' };
  const d2 = { peer: 'monitor', level: 'warn', title: '2026-10-20 18:45:03 服务重启' };

  check('不同百分比的同类告警合并', () => assert.equal(eventSkeleton(a), eventSkeleton(b)));
  check('不同事件不合并', () => assert.notEqual(eventSkeleton(a), eventSkeleton(c)));
  check('时间不同但事件相同 → 合并', () => assert.equal(eventSkeleton(d1), eventSkeleton(d2)));

  const g = groupBySkeleton([{ msg: a }, { msg: b }, { msg: c }, { msg: d1 }, { msg: d2 }]);
  check('5 条 → 3 组，合并 2 条', () => {
    assert.equal(g.groups.length, 3, `组数 ${g.groups.length}`);
    assert.equal(g.deduped, 2, `合并 ${g.deduped}`);
  });
  check('dedupeKey 优先于标题', () => {
    const x = { peer: 'p', level: 'warn', title: '完全不同的标题 A', dedupeKey: 'same' };
    const y = { peer: 'p', level: 'warn', title: '完全不同的标题 B', dedupeKey: 'same' };
    assert.equal(eventSkeleton(x), eventSkeleton(y));
  });
}

// ============================================ 攒满 5 类立刻发
console.log('\n=== 攒满 5 类 → 立刻发 ===');
{
  // 7 条，其中 3 条同类 → 5 组，应在第一轮就发出
  const msgs = [
    { level: 'warn', title: '内存占用 93.2% 超过阈值' },
    { level: 'warn', title: '内存占用 93.5% 超过阈值' },
    { level: 'warn', title: '内存占用 95.1% 超过阈值' },
    { level: 'warn', title: '磁盘可用空间低于 10%' },
    { level: 'warn', title: '服务 A 无响应' },
    { level: 'warn', title: '服务 B 无响应' },
    { level: 'warn', title: '对端心跳超时' },
  ];
  const r = await scenario(msgs);
  const batches = batchesOf(r.ROOT);
  check('攒满 5 类后发出了', () => assert.ok(batches.length >= 1, `batches.jsonl 应有记录，实际 ${batches.length}`));
  check('批次正文显示合并数', () => {
    const sent = r.steered.map((m) => m.content?.[0]?.text ?? '').join('\n');
    assert.ok(/另有 \d+ 条同类已合并/.test(sent), `正文应含合并统计，实际：${sent.slice(0, 200)}`);
  });
  cleanup(r.ROOT);
}

// ============================================ 不满 5 类 → 不立刻发
console.log('\n=== 不满 5 类 → 留在批次里 ===');
{
  const r = await scenario([
    { level: 'warn', title: '内存占用 93.2% 超过阈值' },
    { level: 'warn', title: '内存占用 93.5% 超过阈值' },
  ]);
  const batches = batchesOf(r.ROOT);
  check('2 条同类（1 组）不立刻发', () => assert.equal(batches.length, 0, `不该有批次记录，实际 ${batches.length}`));
  check('也没立刻 steer', () => assert.equal(r.steered.length, 0));
  cleanup(r.ROOT);
}

// ============================================ critical 不进批次
console.log('\n=== critical 不进批次，立刻发 ===');
{
  const r = await scenario([
    { level: 'critical', title: '磁盘满了' },
    { level: 'warn', title: '内存占用 93.2% 超过阈值' },
  ]);
  const batches = batchesOf(r.ROOT);
  check('critical 立刻 steer（不等批次）', () => assert.equal(r.steered.length, 1, `实际 ${r.steered.length}`));
  check('critical 的正文没有批次统计', () => {
    const t = r.steered[0]?.content?.[0]?.text ?? '';
    assert.ok(!/另有 \d+ 条/.test(t), `critical 不该带批次尾巴：${t}`);
  });
  check('warn 留在批次里（没发）', () => assert.equal(batches.length, 0));
  cleanup(r.ROOT);
}

// ============================================ 满 5 分钟发
console.log('\n=== 满 maxWaitSec → 发 ===');
{
  // maxWaitSec 设成 0：下一次 tick 就该发
  const r = await scenario(
    [{ level: 'warn', title: '单条告警' }],
    {
      delivery: {
        levels: {
          critical: { channel: 'wake', cooldownSec: 0, mergeWindowSec: 0, titleChars: 20, batch: { enabled: false } },
          warn: { channel: 'queue', cooldownSec: 0, mergeWindowSec: 0, titleChars: 20, batch: { enabled: true, maxItems: 99, maxWaitSec: 0 } },
          info: { channel: 'archive', cooldownSec: 0, mergeWindowSec: 0, titleChars: 20, batch: { enabled: false } },
        },
      },
    },
  );
  const batches = batchesOf(r.ROOT);
  check('maxWaitSec=0 时立刻发', () => assert.ok(batches.length >= 1, `应有批次记录，实际 ${batches.length}`));
  cleanup(r.ROOT);
}

// ============================================ batch 关闭时行为不变
console.log('\n=== batch 关闭 → 走原 pending 路径 ===');
{
  const r = await scenario(
    [{ level: 'warn', title: '普通告警' }],
    {
      delivery: {
        levels: {
          critical: { channel: 'wake', cooldownSec: 0, mergeWindowSec: 0, titleChars: 20, batch: { enabled: false } },
          warn: { channel: 'queue', cooldownSec: 0, mergeWindowSec: 0, titleChars: 20, batch: { enabled: false } },
          info: { channel: 'archive', cooldownSec: 0, mergeWindowSec: 0, titleChars: 20, batch: { enabled: false } },
        },
      },
    },
  );
  check('batch 关时无批次记录', () => assert.equal(batchesOf(r.ROOT).length, 0));
  check('batch 关时不立刻 steer', () => assert.equal(r.steered.length, 0));
  cleanup(r.ROOT);
}

console.log(`\n===== ${failed === 0 ? 'ALL PASS' : 'HAS FAILURES'} (${passed} passed, ${failed} failed) =====`);
if (failed > 0) console.log('失败项：\n' + failures.map((f) => '  - ' + f).join('\n'));
process.exit(failed === 0 ? 0 : 1);
