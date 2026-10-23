// 消息中枢的离线测试。
// 覆盖图纸的 20 条验收用例，重点是用例 18（灵魂检查）。

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, Deduper, shouldInject, render, fingerprint, REJECT, LEVELS } from '../lib/message.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, '..', 'lib');

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${e.message}`);
  }
}

console.log('\n--- 校验：必填字段 ---');

const peers = new Map([
  ['monitor', { id: 'monitor', token: 'good-token', allowedLevels: LEVELS }],
  ['limited', { id: 'limited', token: 'lim-token', allowedLevels: ['info', 'warn'] }],
]);

const base = { peer: 'monitor', token: 'good-token', level: 'warn', title: '标题' };

check('合法消息通过', () => {
  const r = validate({ ...base }, peers);
  assert.equal(r.ok, true);
  assert.equal(r.msg.peer, 'monitor');
});

check('坏 JSON 被拒', () => {
  assert.equal(validate('{not json', peers).reason, REJECT.BAD_JSON);
});

check('数组被拒', () => {
  assert.equal(validate([], peers).reason, REJECT.NOT_OBJECT);
});

check('缺 peer 被拒', () => {
  const { peer, ...rest } = base;
  assert.equal(validate(rest, peers).reason, REJECT.MISSING_PEER);
});

check('缺 token 被拒', () => {
  const { token, ...rest } = base;
  assert.equal(validate(rest, peers).reason, REJECT.MISSING_TOKEN);
});

check('缺 level 被拒', () => {
  const { level, ...rest } = base;
  assert.equal(validate(rest, peers).reason, REJECT.MISSING_LEVEL);
});

check('缺 title 被拒', () => {
  const { title, ...rest } = base;
  assert.equal(validate(rest, peers).reason, REJECT.MISSING_TITLE);
});

console.log('\n--- 校验：认证与授权 ---');

check('未配对的 peer 被拒', () => {
  assert.equal(validate({ ...base, peer: 'nobody' }, peers).reason, REJECT.PEER_UNKNOWN);
});

check('token 不匹配被拒', () => {
  assert.equal(validate({ ...base, token: 'wrong' }, peers).reason, REJECT.TOKEN_MISMATCH);
});

check('级别不在允许列表被拒', () => {
  const r = validate({ ...base, peer: 'limited', token: 'lim-token', level: 'critical' }, peers);
  assert.equal(r.reason, REJECT.LEVEL_NOT_ALLOWED);
});

check('非法级别被拒', () => {
  assert.equal(validate({ ...base, level: 'urgent' }, peers).reason, REJECT.BAD_LEVEL);
});

console.log('\n--- 字段规范化 ---');

check('标题超 60 字被截断而不是拒收', () => {
  const long = '一'.repeat(100);
  const r = validate({ ...base, title: long }, peers);
  assert.equal(r.ok, true);
  assert.ok(r.msg.title.length <= 60, `长度 ${r.msg.title.length}`);
});

check('缺省 cooldownSec 为 300', () => {
  assert.equal(validate({ ...base }, peers).msg.cooldownSec, 300);
});

check('没有 dedupeKey 时为 null', () => {
  assert.equal(validate({ ...base }, peers).msg.dedupeKey, null);
});

console.log('\n--- 去重 ---');

check('同 dedupeKey 冷却期内只放行一次', () => {
  const d = new Deduper();
  const m = { peer: 'monitor', dedupeKey: 'disk', cooldownSec: 300 };
  assert.equal(d.admit(m, 1000), true);
  assert.equal(d.admit(m, 2000), false);
  assert.equal(d.admit(m, 1000 + 301_000), true);
});

check('无 dedupeKey 永不拦截', () => {
  const d = new Deduper();
  const m = { peer: 'monitor', dedupeKey: null, cooldownSec: 300 };
  assert.equal(d.admit(m, 1000), true);
  assert.equal(d.admit(m, 1001), true);
});

check('不同 peer 的同名 key 互不影响', () => {
  const d = new Deduper();
  assert.equal(d.admit({ peer: 'a', dedupeKey: 'k', cooldownSec: 300 }, 1000), true);
  assert.equal(d.admit({ peer: 'b', dedupeKey: 'k', cooldownSec: 300 }, 1000), true);
});

console.log('\n--- 分级投递 ---');

check('info 不注入', () => {
  assert.equal(shouldInject({ level: 'info' }), false);
});

check('warn 注入', () => {
  assert.equal(shouldInject({ level: 'warn' }), true);
});

check('critical 注入', () => {
  assert.equal(shouldInject({ level: 'critical' }), true);
});

check('静默时段内 warn 推迟', () => {
  const at = new Date();
  at.setHours(2, 0, 0, 0);
  assert.equal(shouldInject({ level: 'warn' }, { quietHours: { enabled: true, start: 23, end: 7 }, now: at }), false);
});

check('静默时段内 critical 仍然注入', () => {
  const at = new Date();
  at.setHours(2, 0, 0, 0);
  assert.equal(shouldInject({ level: 'critical' }, { quietHours: { enabled: true, start: 23, end: 7 }, now: at }), true);
});

check('静默时段外 warn 正常注入', () => {
  const at = new Date();
  at.setHours(14, 0, 0, 0);
  assert.equal(shouldInject({ level: 'warn' }, { quietHours: { enabled: true, start: 23, end: 7 }, now: at }), true);
});

console.log('\n--- 渲染与指纹 ---');

check('render 含级别与标题', () => {
  const s = render({ level: 'warn', peer: 'monitor', title: '磁盘低', body: '剩 8GB' });
  assert.ok(s.includes('WARN'));
  assert.ok(s.includes('磁盘低'));
  assert.ok(s.includes('剩 8GB'));
});

check('指纹稳定且区分内容', () => {
  const a = { peer: 'p', at: 't', title: 'x', body: '' };
  assert.equal(fingerprint(a), fingerprint({ ...a }));
  assert.notEqual(fingerprint(a), fingerprint({ ...a, title: 'y' }));
});

console.log('\n--- 用例 18：灵魂检查（中枢不得有动手能力）---');

check('lib/index.js 不含 spawn/exec/child_process', () => {
  const src = readFileSync(join(LIB, 'index.js'), 'utf8');
  // 去掉注释行再查，避免注释里的词误判
  const code = src
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'))
    .join('\n');
  for (const bad of ['spawn(', 'exec(', 'execSync', 'child_process', 'fork(']) {
    assert.ok(!code.includes(bad), `出现禁止调用：${bad}`);
  }
});

check('lib/index.js 的写操作只落在中枢自己的目录', () => {
  const src = readFileSync(join(LIB, 'index.js'), 'utf8');
  // 所有 fs 写调用必须带 ROOT 或来自 own-dir 常量
  const writes = src.match(/^\s*(appendFileSync|writeFileSync|renameSync|unlinkSync|mkdirSync)\(.*$/gm) ?? [];
  assert.ok(writes.length > 0, '应当至少有中枢自用的写操作');
  for (const w of writes) {
    assert.ok(
      w.includes('ROOT') || w.includes('join(ROOT'),
      `写操作未限定在 ROOT 内：${w.trim()}`,
    );
  }
});

check('lib/message.mjs 是纯函数，不含任何 fs 写', () => {
  const src = readFileSync(join(LIB, 'message.mjs'), 'utf8');
  for (const bad of ['writeFileSync', 'appendFileSync', 'unlinkSync', 'renameSync', 'mkdirSync']) {
    assert.ok(!src.includes(bad), `message.mjs 不应有写操作：${bad}`);
  }
});

console.log(`\n===== ${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} (${pass} passed, ${fail} failed) =====`);
process.exit(fail === 0 ? 0 : 1);
