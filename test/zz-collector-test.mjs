// zz-collector-test.mjs — 采集器注册表测试

import {
  validateCollector, collectEvents, CollectorRegistry,
  CONTRACT_VERSION, STATE,
} from '../lib/collector.mjs';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

const goodMod = {
  name: 'demo',
  version: '1.0.0',
  contract: 1,
  trigger: { kind: 'interval', everySec: 60 },
  async run() { return []; },
};

const env = {
  now: () => new Date(),
  log: () => {},
  state: { get: () => undefined, set: () => {}, del: () => {} },
  config: {},
  signal: undefined,
};

console.log('\n=== ① 契约校验 ===');
{
  ok('合法采集器通过', validateCollector(goodMod).ok === true);
  ok('null 拒收', validateCollector(null).reason === 'not-object');
  ok('缺 name 拒收', validateCollector({ run() {} }).reason === 'bad-name');
  ok('name 大写拒收', validateCollector({ ...goodMod, name: 'Demo' }).reason === 'bad-name');
  ok('name 带点拒收', validateCollector({ ...goodMod, name: 'a.b' }).reason === 'bad-name');
  ok('名字不符拒收', validateCollector(goodMod, 'other').reason === 'name-mismatch');
  ok('名字相符通过', validateCollector(goodMod, 'demo').ok === true);
  ok('contract 不符拒收', validateCollector({ ...goodMod, contract: 99 }).reason === 'contract-mismatch');
  ok('缺 run 拒收', validateCollector({ name: 'x' }).reason === 'no-run');
  ok('run 不是函数拒收', validateCollector({ name: 'x', run: 5 }).reason === 'no-run');
  ok('trigger 非法拒收', validateCollector({ ...goodMod, trigger: 'every' }).reason === 'bad-trigger');
  ok('interval 缺 everySec 拒收', validateCollector({ ...goodMod, trigger: { kind: 'interval' } }).reason === 'bad-trigger');
  ok('everySec<=0 拒收', validateCollector({ ...goodMod, trigger: { kind: 'interval', everySec: 0 } }).reason === 'bad-trigger');
  ok('manual 触发合法', validateCollector({ ...goodMod, trigger: { kind: 'manual' } }).ok === true);
  ok('无 trigger 合法', validateCollector({ ...goodMod, trigger: undefined }).ok === true);
  ok('setup 非函数拒收', validateCollector({ ...goodMod, setup: 'x' }).reason === 'bad-setup');
}

console.log('\n=== ② 事件抽取 ===');
{
  const good = { source: 'mail', kind: 'new-mail', level: 'info', summary: 'ok' };
  const bad = { source: 'MAIL', kind: 'x', level: 'info', summary: 'bad' };

  const r1 = collectEvents([good], 'mail');
  ok('单条合法通过', r1.events.length === 1 && r1.rejected.length === 0);

  const r2 = collectEvents([good, bad], 'mail');
  ok('混合时只留合法的', r2.events.length === 1 && r2.rejected.length === 1);
  ok('坏事件带原因', r2.rejected[0].reason === 'bad-source');

  const r3 = collectEvents(good, 'mail');
  ok('单个对象也接受', r3.events.length === 1);

  const r4 = collectEvents(null, 'mail');
  ok('null 当空数组', r4.events.length === 0);

  const r5 = collectEvents(undefined, 'mail');
  ok('undefined 当空数组', r5.events.length === 0);

  const pre = { id: 'evt-x', source: 'mail', displayed: { wake: null, window: null }, summary: '已校验' };
  const r6 = collectEvents([pre], 'mail');
  ok('已校验的直通（不重复校验）', r6.events.length === 1 && r6.events[0].id === 'evt-x');
}

console.log('\n=== ③ 注册表 ===');
{
  const reg = new CollectorRegistry();
  ok('初始为空', reg.size === 0);
  ok('注册成功', reg.register(goodMod).ok === true);
  ok('size 为 1', reg.size === 1);
  ok('有 query', reg.has('demo') === true);
  ok('get 返回模块', reg.get('demo') === goodMod);
  ok('重复注册被拒', reg.register(goodMod).reason === 'duplicate-name');
  ok('名字不符被拒', reg.register({ ...goodMod, name: 'x' }, 'y').reason === 'name-mismatch');

  const list = reg.list();
  ok('list 返回 1 条', list.length === 1);
  ok('list 带状态', list[0].state === STATE.IDLE);
  ok('list 带 trigger', list[0].trigger.everySec === 60);
}

console.log('\n=== ④ 单个采集器运行 ===');
{
  const reg = new CollectorRegistry();
  reg.register({ ...goodMod, run: async () => [{ source: 'mail', kind: 'k', level: 'info', summary: 'r' }] });
  const out = await reg.runOne('demo', env);
  ok('产出 1 条事件', out.events.length === 1);
  ok('没报错', out.error === undefined);
  ok('状态回到 idle', reg.list()[0].state === STATE.IDLE);
  ok('记了 lastRunAt', typeof reg.list()[0].lastRunAt === 'string');

  const miss = await reg.runOne('nope', env);
  ok('未注册返回 not-registered', miss.error === 'not-registered');
}

console.log('\n=== ⑤ 采集器崩了不能带崩平台 ===');
{
  const errors = [];
  const reg = new CollectorRegistry({ onError: (e) => errors.push(e) });

  reg.register({ ...goodMod, run: async () => { throw new Error('采集器炸了'); } });
  const out = await reg.runOne('demo', env);
  ok('★ 抛错被接住', out.events.length === 0);
  ok('错误被记录', typeof out.error === 'string' && out.error.includes('炸了'));
  ok('★ onError 被通知', errors.length === 1 && errors[0].name === 'demo');
  ok('状态变 error', reg.list()[0].state === STATE.ERROR);

  // 超时
  const reg2 = new CollectorRegistry();
  reg2.register({ ...goodMod, name: 'slow', run: () => new Promise(() => {}) });
  const out2 = await reg2.runOne('slow', env, { timeoutMs: 100 });
  ok('★ 超时被接住', out2.error.includes('timeout'), out2.error);

  // 返回值乱
  const reg3 = new CollectorRegistry();
  reg3.register({ ...goodMod, name: 'junk', run: async () => 'not an array' });
  const out3 = await reg3.runOne('junk', env);
  ok('返回值乱只取合法的', out3.events.length === 0 && out3.rejected.length === 1);
}

console.log('\n=== ⑥ 并发保护 ===');
{
  const reg = new CollectorRegistry();
  let resolveIt;
  const gate = new Promise((r) => { resolveIt = r; });
  reg.register({ ...goodMod, run: async () => { await gate; return []; } });

  const p1 = reg.runOne('demo', env);
  // 立刻再跑一次 —— 应该被 already-running 挡住
  const p2 = await reg.runOne('demo', env);
  ok('★ 同一个不并发跑', p2.error === 'already-running');
  resolveIt();
  await p1;
  ok('前一个跑完后正常', true);
}

console.log('\n=== ⑦ runAll：一个崩不影响别的 ===');
{
  const reg = new CollectorRegistry();
  reg.register({ ...goodMod, name: 'aaa', run: async () => [{ source: 'mail', kind: 'k', level: 'info', summary: 'a' }] });
  reg.register({ ...goodMod, name: 'bbb', run: async () => { throw new Error('bbb炸'); } });
  reg.register({ ...goodMod, name: 'ccc', run: async () => [{ source: 'finance', kind: 'k', level: 'info', summary: 'c' }] });

  const out = await reg.runAll(env);
  ok('★ 两个好的都产出了', out.events.length === 2, `got ${out.events.length}`);
  ok('★ 坏的那个被记下', out.errors.length === 1 && out.errors[0].name === 'bbb');
  ok('事件来源不串', out.events.map((e) => e.source).sort().join(',') === 'finance,mail');
}

console.log('\n=== ⑧ 启动与停止 ===');
{
  const reg = new CollectorRegistry();
  let ticks = 0;
  reg.register({
    ...goodMod, name: 'tick',
    trigger: { kind: 'interval', everySec: 0.05 },
    run: async () => { ticks += 1; return []; },
  });

  reg.start(() => env);
  await new Promise((r) => setTimeout(r, 300));
  reg.stop();
  const after = ticks;
  ok('★ 定时器真的跑了', after >= 2, `ticks=${after}`);
  await new Promise((r) => setTimeout(r, 200));
  ok('★ stop 之后不再跑', ticks === after, `after stop ticks=${ticks}`);
  ok('stop 后状态是 stopped', reg.list()[0].state === STATE.STOPPED);
}

console.log('\n=== ⑨ manual 触发不自动跑 ===');
{
  const reg = new CollectorRegistry();
  reg.register({ ...goodMod, name: 'man', trigger: { kind: 'manual' }, run: async () => [] });
  reg.start(() => env);
  await new Promise((r) => setTimeout(r, 150));
  reg.stop();
  ok('manual 不被定时器跑', reg.list()[0].lastRunAt === null);
}

console.log('\n=== ⑩ clear ===');
{
  const reg = new CollectorRegistry();
  reg.register(goodMod);
  reg.clear();
  ok('clear 后为空', reg.size === 0);
  ok('契约版本是 1', CONTRACT_VERSION === 1);
}

console.log(`\n===== ${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} (${pass} passed, ${fail} failed) =====`);
process.exit(fail === 0 ? 0 : 1);
