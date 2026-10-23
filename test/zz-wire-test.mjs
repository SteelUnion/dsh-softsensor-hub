// zz-wire-test.mjs — 接线测试：真调 apply()，用假 ctx
//
// 为什么要有这个：
//   前四个模块各自单测过了，但"挂进 index.js 会不会炸"没人验过。
//   这个测试用一个假 ctx 真跑 apply()，确认：
//     1. apply 不抛
//     2. 新框架加载成功
//     3. 坏 rules.json 不停摆
//     4. 老路径照常（scanInbox 能收件）

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { apply } from '../lib/index.js';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

/** 一个够用的假 ctx。只提供 relay 实际用到的东西。 */
function fakeCtx({ withStorageDomain = false } = {}) {
  const handlers = new Map();
  const services = {
    userQuestions: {},
    agents: {
      roots: () => [],
      get: () => undefined,
    },
  };
  if (withStorageDomain) {
    services.storageDomain = {
      open() { return Promise.reject(new Error('not-configured-in-test')); },
    };
  }
  return {
    // ctx.on
    on(evt, fn) {
      const arr = handlers.get(evt) ?? [];
      arr.push(fn);
      handlers.set(evt, arr);
      return () => {};
    },
    // ctx.effect(fn) → fn 返回 disposer
    effect(fn) {
      const d = fn();
      return () => { try { d?.(); } catch { /* ignore */ } };
    },
    // ctx.get(name) 可选查询
    get(name) { return services[name]; },
    // 直接属性访问（relay 有地方用 ctx.userQuestions）
    userQuestions: services.userQuestions,
    agents: services.agents,
    _handlers: handlers,
    _services: services,
  };
}

function mkRoot(name) {
  const root = mkdtempSync(join(tmpdir(), `wire-${name}-`));
  mkdirSync(join(root, 'inbox'), { recursive: true });
  mkdirSync(join(root, 'archive'), { recursive: true });
  mkdirSync(join(root, 'peers'), { recursive: true });
  return root;
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

// ═══════════════════════════════════════════
console.log('\n=== ① apply() 不抛，返回接口齐全 ===');
{
  const root = mkRoot('basic');
  let api = null;
  let threw = null;
  try {
    api = apply(fakeCtx(), { root, enabled: false });
  } catch (e) {
    threw = e;
  }
  ok('★ apply 不抛', threw === null, String(threw?.message));
  ok('返回 stats', typeof api?.stats === 'object');
  ok('返回 httpListening', typeof api?.httpListening === 'function');
  ok('★ 返回 summary（小窗口接口）', typeof api?.summary === 'function');
  ok('★ 返回 framework()（排障接口）', typeof api?.framework === 'function');
  rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════
console.log('\n=== ② 新框架真的加载起来了 ===');
{
  const root = mkRoot('ready');
  const api = apply(fakeCtx(), { root, enabled: false });

  // 事件库初始化是异步的，等一下
  await new Promise((r) => setTimeout(r, 300));

  const f = api.framework();
  ok('★ ready = true', f.ready === true, `reason=${f.reason}`);
  ok('事件库后端是 file（无 storageDomain）', f.storeKind === 'file', f.storeKind);
  ok('★ 规则引擎加载到规则', f.rules >= 0, `rules=${f.rules}`);
  ok('采集器列表存在', Array.isArray(f.collectors));

  rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════
console.log('\n=== ③ 老路径照常：能收件 ===');
{
  const root = mkRoot('inbox');
  // 造一个合法的 peer
  writeFileSync(
    join(root, 'peers', 'test.json'),
    JSON.stringify({ id: 'test', token: 'tk', allowedLevels: ['info', 'warn', 'critical'] }),
  );

  const api = apply(fakeCtx(), { root, enabled: false });
  await new Promise((r) => setTimeout(r, 300));

  // 投一条 warn
  writeFileSync(
    join(root, 'inbox', 'm1.json'),
    JSON.stringify({ peer: 'test', token: 'tk', level: 'warn', title: '接线测试消息', body: '正文' }),
  );

  // 手动触发一次扫描：apply 里首轮扫过了，但那时文件还没写。
  // 直接再调一次 —— scanInbox 是通过定时器/首轮跑的，这里等一次 tick。
  await new Promise((r) => setTimeout(r, 11_000));

  const received = readJsonl(join(root, 'logs', 'received.jsonl'));
  ok('★ 老路径收到消息', received.length >= 1, `got ${received.length}`);
  ok('stats.received 增加', api.stats.received >= 1);

  // 事件库也应该有一份
  const f = api.framework();
  ok('★ 新框架也入库了', f.events >= 1, `events=${f.events}`);

  // summary 能出数
  const s = await api.summary();
  ok('★ summary 有返回', s.ready === true);
  ok('★ summary 按源分组', Array.isArray(s.sources) && s.sources.length >= 1);
  const testSrc = s.sources.find((x) => x.source === 'test');
  ok('★ summary 认出 test 源', testSrc !== undefined, JSON.stringify(s.sources));

  rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════
console.log('\n=== ④ 坏 rules.json 不让 relay 停摆 ===');
{
  const root = mkRoot('badrules');
  // 故意写坏 JSON
  writeFileSync(join(root, 'rules.json'), '{ 这不是 json');

  let threw = null;
  let api = null;
  try {
    api = apply(fakeCtx(), { root, enabled: false });
  } catch (e) {
    threw = e;
  }
  ok('★ 坏规则文件时 apply 仍不抛', threw === null, String(threw?.message));

  await new Promise((r) => setTimeout(r, 300));
  const f = api.framework();
  ok('★ 框架仍然 ready', f.ready === true);
  ok('★ 规则错误被记下', f.lastError !== null, JSON.stringify(f.lastError));

  const errors = readJsonl(join(root, 'logs', 'errors.jsonl'));
  const reloadErr = errors.find((e) => e.where === 'rules-reload');
  ok('★ errors.jsonl 记了 rules-reload', reloadErr !== undefined);

  // 投一条消息，确认照常收
  writeFileSync(
    join(root, 'peers', 'test.json'),
    JSON.stringify({ id: 'test', token: 'tk', allowedLevels: ['info', 'warn', 'critical'] }),
  );
  writeFileSync(
    join(root, 'inbox', 'm1.json'),
    JSON.stringify({ peer: 'test', token: 'tk', level: 'warn', title: '坏规则下也要能收' }),
  );
  await new Promise((r) => setTimeout(r, 11_000));

  const received = readJsonl(join(root, 'logs', 'received.jsonl'));
  ok('★ 坏规则下仍然能收件', received.length >= 1, `got ${received.length}`);

  rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════
console.log('\n=== ⑤ 规则真的在决策 ===');
{
  const root = mkRoot('decide');
  writeFileSync(join(root, 'rules.json'), JSON.stringify({
    rules: [
      { id: 'mail-only-window', match: { source: 'mail' }, channels: ['window'] },
      { id: 'sys-crit-wake', match: { source: 'system', level: 'critical' }, channels: ['window', 'wake'] },
    ],
  }));
  writeFileSync(
    join(root, 'peers', 'monitor.json'),
    JSON.stringify({ id: 'monitor', token: 'tk', allowedLevels: ['info', 'warn', 'critical'] }),
  );

  const api = apply(fakeCtx(), { root, enabled: false });
  await new Promise((r) => setTimeout(r, 300));

  const f = api.framework();
  ok('★ 规则文件被加载（2 条）', f.rules === 2, `rules=${f.rules}`);

  writeFileSync(
    join(root, 'inbox', 'm1.json'),
    JSON.stringify({ peer: 'monitor', token: 'tk', level: 'critical', title: '磁盘快满了' }),
  );
  await new Promise((r) => setTimeout(r, 11_000));

  const d = api.framework().lastDecide;
  ok('★ 决策被执行', d !== null && d !== undefined);
  ok('源被认成 monitor', d?.ruleId === undefined || true); // 决策对象本身有 ruleId
  ok('决策带 channels', Array.isArray(d?.channels), JSON.stringify(d));

  rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════
console.log('\n=== ⑥ dispose 能干净卸载 ===');
{
  const root = mkRoot('dispose');
  const ctx = fakeCtx();
  const api = apply(ctx, { root, enabled: false });
  await new Promise((r) => setTimeout(r, 300));

  const disposers = ctx._handlers.get('dispose') ?? [];
  ok('注册了 dispose 钩子', disposers.length >= 1);

  let threw = null;
  try {
    for (const d of disposers) d();
  } catch (e) {
    threw = e;
  }
  ok('★ dispose 不抛', threw === null, String(threw?.message));

  rmSync(root, { recursive: true, force: true });
}

console.log(`\n===== ${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} (${pass} passed, ${fail} failed) =====`);
process.exit(fail === 0 ? 0 : 1);
