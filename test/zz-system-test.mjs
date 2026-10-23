// zz-system-test.mjs — 系统监控采集器测试
//
// 特点：用**真实的系统数据**跑，不全是桩。
// 这样阈值逻辑才验得实。

import os from 'node:os';
import { statfsSync } from 'node:fs';
import { validateCollector, collectEvents } from '../lib/collector.mjs';
import { validateEvent } from '../lib/event.mjs';
import { createSystemCollector, sampleMemory, sampleDisk, sampleEventLoop, DEFAULTS } from '../lib/collectors/system.mjs';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

const env = {
  now: () => new Date(),
  log: () => {},
  state: { get: () => undefined, set: () => {}, del: () => {} },
  config: {},
};

console.log('\n=== ① 契约 ===');
{
  const c = createSystemCollector();
  ok('符合采集器契约', validateCollector(c).ok === true);
  ok('名字是 system', c.name === 'system');
  ok('默认 60 秒一采', c.trigger.everySec === 60);
  ok('有 run', typeof c.run === 'function');
  ok('有 setup', typeof c.setup === 'function');
  ok('有 teardown', typeof c.teardown === 'function');
}

console.log('\n=== ② 内存采样（真实数据）===');
{
  const s = sampleMemory();
  ok('返回 metric=memory', s.metric === 'memory');
  ok('百分比在 0~100 之间', s.value > 0 && s.value <= 100, `value=${s.value}`);
  ok('带 total/free/used', s.detail.totalGB > 0 && s.detail.freeGB >= 0);
  ok('total 与 os.totalmem 一致', Math.abs(s.detail.totalGB - os.totalmem() / 1024 ** 3) < 0.2);
  ok('阈值默认 90', s.threshold === 90);

  // 【阈值逻辑必须用相对值测】
  //   本机内存可能已经用了 88%，拿 1%/2% 当阈值必然 critical —— 那测不出"分级"对不对。
  //   所以按真实占用值往上/往下各调 1 个百分点来测。
  const v = s.value;
  const warnOnly = sampleMemory({ memoryPercent: v - 1, memoryCriticalPercent: v + 10 });
  ok('★ 阈值略低于实值时 → warn', warnOnly.level === 'warn', `v=${v} level=${warnOnly.level}`);
  ok('阈值字段跟着变', warnOnly.threshold === v - 1, `threshold=${warnOnly.threshold}`);

  const both = sampleMemory({ memoryPercent: v - 10, memoryCriticalPercent: v - 1 });
  ok('★ 实值超过 critical 阈值 → critical', both.level === 'critical', `level=${both.level}`);

  const neither = sampleMemory({ memoryPercent: v + 10, memoryCriticalPercent: v + 20 });
  ok('★ 两个阈值都高于实值 → 不报', neither.level === null, `level=${neither.level}`);
}

console.log('\n=== ③ 磁盘采样（真实数据）===');
{
  const s = sampleDisk({ diskPath: 'E:\\' });
  ok('返回 metric=disk', s.metric === 'disk');
  ok('百分比合理', s.value !== null && s.value > 0 && s.value < 100, `value=${s.value}`);
  ok('带可用空间', typeof s.detail.availGB === 'number');

  // 和 statfsSync 直接算的对一下
  const st = statfsSync('E:\\');
  const expect = Math.round(((Number(st.blocks) - Number(st.bavail)) / Number(st.blocks)) * 1000) / 10;
  ok('★ 和 statfs 直算一致', Math.abs(s.value - expect) < 0.2, `${s.value} vs ${expect}`);

  const low = sampleDisk({ diskPath: 'E:\\', diskPercent: 1, diskCriticalPercent: 2 });
  ok('★ 低阈值触发', low.level === 'warn' || low.level === 'critical', `level=${low.level}`);

  // 不存在的盘
  const bad = sampleDisk({ diskPath: 'Z:\\不存在的盘\\' });
  ok('坏路径不抛，返回 null 值', bad.value === null, JSON.stringify(bad));
  ok('坏路径带 error 标记', bad.detail.error === 'statfs-unavailable');
}

console.log('\n=== ④ 事件循环采样 ===');
{
  ok('没有 histogram 时返回 null 值', sampleEventLoop(null).value === null);

  const fake = {
    percentile: () => 900_000_000, // 900ms（ns）
    mean: 100_000_000,
    reset: () => {},
  };
  const s = sampleEventLoop(fake, { eventLoopMs: 500 });
  ok('★ 900ms 超过 500ms 阈值 → warn', s.level === 'warn', `level=${s.level}`);
  ok('换算成毫秒正确', s.value === 900, `value=${s.value}`);

  const fast = { percentile: () => 10_000_000, mean: 1_000_000, reset: () => {} };
  ok('10ms 不报', sampleEventLoop(fast, { eventLoopMs: 500 }).level === null);
}

console.log('\n=== ⑤ 采集器整体运行 ===');
{
  const c = createSystemCollector({ memoryPercent: 99, memoryCriticalPercent: 99.9, diskPercent: 99, diskCriticalPercent: 99.9 });
  await c.setup(env);
  const raw = await c.run(env);
  ok('run 返回数组', Array.isArray(raw));
  ok('阈值调很高时不误报', raw.length === 0, `got ${raw.length}: ${JSON.stringify(raw.map((e) => e.kind))}`);

  // 产出的事件必须能过事件校验
  const c2 = createSystemCollector({ memoryPercent: 0.1, memoryCriticalPercent: 0.2, diskPercent: 0.1, diskCriticalPercent: 0.2, eventLoopMs: 0 });
  await c2.setup(env);
  const raw2 = await c2.run(env);
  ok('★ 极低阈值时确实产出事件', raw2.length >= 2, `got ${raw2.length}`);

  const { events, rejected } = collectEvents(raw2, 'system');
  ok('★ 产出的全部是合法事件', rejected.length === 0, JSON.stringify(rejected));
  ok('事件数一致', events.length === raw2.length);
  ok('都是 source=system', events.every((e) => e.source === 'system'));
  ok('都有 kind', events.every((e) => typeof e.kind === 'string' && e.kind.length > 0));
  ok('都有 level', events.every((e) => ['info', 'warn', 'critical'].includes(e.level)));

  const mem = events.find((e) => e.kind === 'memory');
  ok('★ 内存事件带摘要', typeof mem?.summary === 'string' && mem.summary.includes('内存'), mem?.summary);
  ok('★ 内存事件带 payload.detail', mem?.payload?.detail?.totalGB > 0);
  ok('★ 摘要含剩余空间提示', mem?.summary.includes('剩'), mem?.summary);

  const disk = events.find((e) => e.kind === 'disk');
  ok('★ 磁盘事件带摘要', typeof disk?.summary === 'string' && disk.summary.includes('磁盘'), disk?.summary);

  await c.teardown();
  await c2.teardown();
}

console.log('\n=== ⑥ 自身停顿检测 ===');
{
  const c = createSystemCollector({ intervalSec: 60, memoryPercent: 99, memoryCriticalPercent: 99.9, diskPercent: 99, diskCriticalPercent: 99.9 });
  await c.setup(env);

  // 第一次跑：建基准
  const r1 = await c.run(env);
  ok('第一轮不报停顿', r1.every((e) => e.kind !== 'self-stall'));

  // 假装过了 5 分钟（应 60 秒一次，超过 2×60+30=150 秒即算停顿）
  const later = new Date(Date.now() + 5 * 60 * 1000);
  const env2 = { ...env, now: () => later };
  const r2 = await c.run(env2);
  const stall = r2.find((e) => e.kind === 'self-stall');
  ok('★ 超时未 tick 报 self-stall', stall !== undefined, JSON.stringify(r2.map((e) => e.kind)));
  ok('★ self-stall 是 critical', stall?.level === 'critical');
  ok('摘要说明停了多久', stall?.summary.includes('停摆'), stall?.summary);

  // 再跑一次：10 分钟冷却内不该重复报
  const later2 = new Date(Date.now() + 6 * 60 * 1000);
  const r3 = await c.run({ ...env, now: () => later2 });
  ok('★ 冷却内不重复报', r3.every((e) => e.kind !== 'self-stall'));

  await c.teardown();
}

console.log('\n=== ⑦ 采集失败计数 ===');
{
  // 用不存在的盘 + 内存阈值正常 → 至少内存能采到，不算全失败
  const c = createSystemCollector({ diskPath: 'Z:\\nope\\', memoryPercent: 99.9, memoryCriticalPercent: 99.95 });
  await c.setup(env);
  const r = await c.run(env);
  ok('一个指标坏了不影响另一个', Array.isArray(r));
  ok('不因为单个失败就报 collector-error', r.every((e) => e.kind !== 'collector-error'));
  await c.teardown();
}

console.log('\n=== ⑧ 默认值 ===');
{
  ok('默认间隔 60 秒', DEFAULTS.intervalSec === 60);
  ok('默认内存 warn 90', DEFAULTS.memoryPercent === 90);
  ok('默认内存 critical 95', DEFAULTS.memoryCriticalPercent === 95);
  ok('默认磁盘 warn 90', DEFAULTS.diskPercent === 90);
  ok('默认磁盘 critical 95', DEFAULTS.diskCriticalPercent === 95);
  ok('默认事件循环 500ms', DEFAULTS.eventLoopMs === 500);
}

console.log(`\n===== ${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} (${pass} passed, ${fail} failed) =====`);
process.exit(fail === 0 ? 0 : 1);
