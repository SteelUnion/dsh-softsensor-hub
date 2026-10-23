// 注入链路的测试。
//
// 依据 DSH 源码：agent/pre-step 的参数形如
//   ({ agent, messages, signal, step }, next) => decision
// 其中 agent 上有 inject(message)。

import { strict as assert } from 'node:assert';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, existsSync, rmSync, mkdirSync, readFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
};

// 清场
for (const d of ['received.jsonl', 'rejected.jsonl']) {
  const p = join(ROOT, d);
  if (existsSync(p)) rmSync(p, { force: true });
}
for (const d of ['inbox', 'archive']) {
  const p = join(ROOT, d);
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  mkdirSync(p, { recursive: true });
}

const peersDir = join(ROOT, 'peers');
if (!existsSync(peersDir)) mkdirSync(peersDir, { recursive: true });
writeFileSync(
  join(peersDir, 'zz-inject-test.json'),
  JSON.stringify({ id: 'zz-inject-test', token: 'tk', allowedLevels: ['info', 'warn', 'critical'] }),
);

// ---- 假 agent，记录注入 ----
const injectedMessages = [];
const fakeAgent = {
  inject(msg) {
    injectedMessages.push(msg);
  },
};

// ---- 收集 pre-step 钩子 ----
let preStep = null;
const ctx = {
  on: (name, fn) => {
    if (name === 'agent/pre-step') preStep = fn;
    return () => {};
  },
  get: () => null,
  emit: () => {},
};

const { apply } = await import('../lib/index.js');
apply(ctx, {});

console.log('\n--- 注入链路 ---');

check('注册了 agent/pre-step 钩子', () => {
  assert.ok(typeof preStep === 'function', '应注册 pre-step');
});

// 投一条 warn，然后驱动一轮 pre-step
const drop = (name, obj) => writeFileSync(join(ROOT, 'inbox', name), JSON.stringify(obj));
drop('inj-1.json', { peer: 'zz-inject-test', token: 'tk', level: 'warn', title: '注入测试消息' });
await new Promise((r) => setTimeout(r, 50));

// apply 首轮已扫过。再 apply 一次触发扫描。
const ctx2 = { on: (n, f) => n === 'agent/pre-step' ? (preStep = f, () => {}) : () => {}, get: () => null, emit: () => {} };
apply(ctx2, {});
await new Promise((r) => setTimeout(r, 100));

// 驱动一轮
let nextCalled = false;
const decision = await preStep({ agent: fakeAgent, messages: [], signal: { aborted: false }, step: 1 }, () => {
  nextCalled = true;
  return { kind: 'continue', messages: [] };
});

check('pre-step 调用了 next()', () => {
  assert.equal(nextCalled, true, '必须放行，不能吞掉这一轮');
});

check('消息被注入了', () => {
  assert.equal(injectedMessages.length, 1, `应注入 1 条，实际 ${injectedMessages.length}`);
});

check('注入的消息 role 是 user', () => {
  assert.equal(injectedMessages[0].role, 'user');
});

check('注入的 source.kind 是 schedule', () => {
  assert.equal(injectedMessages[0].source?.kind, 'schedule', `实际 ${JSON.stringify(injectedMessages[0].source)}`);
});

check('注入内容含消息标题', () => {
  const text = injectedMessages[0].content?.[0]?.text ?? '';
  assert.ok(text.includes('注入测试消息'), `实际内容：${text}`);
});

check('注入内容标注了级别', () => {
  const text = injectedMessages[0].content?.[0]?.text ?? '';
  assert.ok(text.includes('WARN'), `应含级别标记，实际：${text}`);
});

// 再驱动一轮，应当没有新注入（队列已空）
const before = injectedMessages.length;
await preStep({ agent: fakeAgent, messages: [], signal: { aborted: false }, step: 2 }, () => ({ kind: 'continue', messages: [] }));

check('队列清空后不再重复注入', () => {
  assert.equal(injectedMessages.length, before, '不应重复注入');
});

// 没有 agent 时不能丢消息
console.log('\n--- 异常路径 ---');

drop('inj-2.json', { peer: 'zz-inject-test', token: 'tk', level: 'warn', title: '无 agent 时的消息' });
const ctx3 = { on: (n, f) => n === 'agent/pre-step' ? (preStep = f, () => {}) : () => {}, get: () => null, emit: () => {} };
apply(ctx3, {});
await new Promise((r) => setTimeout(r, 100));

const beforeBad = injectedMessages.length;
// 传一个没有 inject 方法的假 agent
await preStep({ agent: {}, messages: [], signal: { aborted: false }, step: 3 }, () => ({ kind: 'continue', messages: [] }));

check('agent 没有 inject 时不崩溃', () => {
  assert.equal(injectedMessages.length, beforeBad, '不应注入');
});

// 之后有正常 agent 时，之前没注入的消息应当补上
await preStep({ agent: fakeAgent, messages: [], signal: { aborted: false }, step: 4 }, () => ({ kind: 'continue', messages: [] }));

check('拿不到 agent 时的消息不丢，下一轮补投', () => {
  assert.ok(injectedMessages.length > beforeBad, '应在下一轮补上');
  const last = injectedMessages[injectedMessages.length - 1];
  assert.ok(last.content[0].text.includes('无 agent 时的消息'), '应含之前那条');
});

// 清理
if (existsSync(join(peersDir, 'zz-inject-test.json'))) rmSync(join(peersDir, 'zz-inject-test.json'), { force: true });

console.log(`\n===== ${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} (${pass} passed, ${fail} failed) =====`);
process.exit(fail === 0 ? 0 : 1);
