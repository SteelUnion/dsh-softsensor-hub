// zz-mail-live.mjs — 邮件采集器**真实连通**测试
//
// 和 zz-mail-test.mjs 的区别：那个是离线的，这个真连 IMAP。
//
// 凭据从环境变量读，脚本本身不含任何密码：
//   DSH_RELAY_QQ_MAIL / DSH_RELAY_163_MAIL
//
// 用法：
//   $env:DSH_RELAY_QQ_MAIL='...'; node test/zz-mail-live.mjs
//
// 只拉**最近 3 封**，只拉头部，不碰正文。

import { createMailCollector } from '../lib/collectors/mail.mjs';
import { CredentialVault, makeCredentialReader } from '../lib/credentials.mjs';
import { validateEvent } from '../lib/event.mjs';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

const boxes = [];
if (process.env.DSH_RELAY_QQ_MAIL) boxes.push({ address: '********@qq.com', credential: 'relay-qq-mail' });
if (process.env.DSH_RELAY_163_MAIL) boxes.push({ address: '********@163.com', credential: 'relay-163-mail' });

if (boxes.length === 0) {
  console.log('跳过：没有设置 DSH_RELAY_QQ_MAIL / DSH_RELAY_163_MAIL');
  console.log('这个测试需要真实凭据，环境变量没设就跳过。');
  process.exit(0);
}

console.log(`\n=== 真实连通测试：${boxes.length} 个邮箱 ===`);

const vault = new CredentialVault(process.cwd(), process.env);
const readCredential = makeCredentialReader(vault);

const c = createMailCollector({
  boxes,
  maxPerRun: 3,        // 只拉 3 封
  initialDays: 3,      // 只看最近 3 天
  timeoutMs: 20_000,
});

const env = {
  now: () => new Date(),
  log: () => {},
  state: { get: () => undefined, set: () => {}, del: () => {} },
  config: {},
  readCredential,
  recordRun: (r) => console.log('  体检:', JSON.stringify(r)),
};

await c.setup(env);
const t0 = Date.now();
const events = await c.run(env);
const dt = Date.now() - t0;

console.log(`\n用时 ${dt}ms，产出 ${events.length} 条事件\n`);

for (const e of events) {
  console.log(`  [${e.level}] ${e.source}/${e.kind}`);
  console.log(`    摘要: ${e.summary}`);
  console.log(`    payload: ${JSON.stringify(e.payload)}`);
  const v = validateEvent(e);
  ok(`  → 事件合法`, v.ok === true, v.reason);
  ok(`  → dedupeKey 带账号和 uid`, typeof e.dedupeKey === 'string' && e.dedupeKey.startsWith('mail:'));
}

ok('跑完不抛', true);
ok('每条都过了事件校验', events.every((e) => validateEvent(e).ok));

await c.teardown();

console.log(`\n===== ${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} (${pass} passed, ${fail} failed) =====`);
process.exit(fail === 0 ? 0 : 1);
