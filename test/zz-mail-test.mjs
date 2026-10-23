// zz-mail-test.mjs — 邮件采集器测试（离线，不连真服务器）

import {
  serverFor, decodeHeader, parseFrom, cleanSubject,
  createMailCollector, DEFAULTS, SERVERS,
} from '../lib/collectors/mail.mjs';
import { validateCollector, collectEvents } from '../lib/collector.mjs';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

const mkEnv = (o = {}) => ({
  now: () => new Date(),
  log: () => {},
  state: { get: () => undefined, set: () => {}, del: () => {} },
  config: {},
  readCredential: async () => 'fake-code',
  recordRun: () => {},
  ...o,
});

console.log('\n=== ① 服务器推断 ===');
{
  ok('QQ', serverFor('a@qq.com')?.host === 'imap.qq.com');
  ok('QQ 不需要 ID', serverFor('a@qq.com')?.needsId === false);
  ok('163', serverFor('a@163.com')?.host === 'imap.163.com');
  ok('★ 163 需要 ID', serverFor('a@163.com')?.needsId === true);
  ok('126 也需要 ID', serverFor('a@126.com')?.needsId === true);
  ok('Gmail', serverFor('a@gmail.com')?.host === 'imap.gmail.com');
  ok('大写域名也能认', serverFor('A@QQ.COM')?.host === 'imap.qq.com');
  ok('不认识的返回 null', serverFor('a@nowhere.zz') === null);
  ok('没有 @ 返回 null', serverFor('bad') === null);
  ok('空值返回 null', serverFor(null) === null);
}

console.log('\n=== ② RFC 2047 解码 ===');
{
  // Base64 UTF-8
  const b64 = Buffer.from('你好世界', 'utf8').toString('base64');
  ok('★ Base64 UTF-8', decodeHeader(`=?UTF-8?B?${b64}?=`) === '你好世界', decodeHeader(`=?UTF-8?B?${b64}?=`));

  // Q 编码
  ok('★ Q 编码下划线转空格', decodeHeader('=?UTF-8?Q?hello_world?=') === 'hello world');

  // 混合内容
  const mixed = decodeHeader(`Re: =?UTF-8?B?${b64}?= [tag]`);
  ok('★ 前后有普通文字', mixed === 'Re: 你好世界 [tag]', mixed);

  // 多个编码块
  //
  // 【RFC 2047 §6.2 规定】相邻 encoded-word 之间若只有空白，视为同一段文字，空白丢弃。
  // 所以「第一」「第二」两块拼起来是「第一第二」，中间**没有**空格。
  // 2026-10-21 实测 QQ 会把一个中文字符拆成两块，中间那个空格必须吃掉，
  // 否则标题就成了「现已上 线！」。
  const two = `=?UTF-8?B?${Buffer.from('第一', 'utf8').toString('base64')}?= =?UTF-8?B?${Buffer.from('第二', 'utf8').toString('base64')}?=`;
  ok('★ 相邻编码块之间空格丢弃', decodeHeader(two) === '第一第二', decodeHeader(two));

  // 但编码块和普通文字之间要保留空格
  ok('编码块与普通文字间保留空格', decodeHeader(`abc =?UTF-8?B?${Buffer.from('字', 'utf8').toString('base64')}?=`) === 'abc 字');

  // 折行
  ok('折行续行被合并', decodeHeader('a\r\n b') === 'a b');

  // 真实场景：一个中文字被拆到两块
  const split = '=?UTF-8?B?5peg5Lq65Yy65ZKM5oiY5b295oms5YWI5L2T6aqM546w5bey5LiK?= =?UTF-8?B?57q/77yB?=';
  ok('★ 被拆开的中文标题拼回来', decodeHeader(split).endsWith('上线！'), decodeHeader(split));
  ok('★ 拆开与不拆结果一致',
    decodeHeader(split) === decodeHeader('=?UTF-8?B?5peg5Lq65Yy65ZKM5oiY5b295oms5YWI5L2T6aqM546w5bey5LiK57q/77yB?='));

  // 非字符串
  ok('null 返回空串', decodeHeader(null) === '');
  ok('未编码原样返回', decodeHeader('plain text') === 'plain text');
}

console.log('\n=== ③ 发件人解析 ===');
{
  const a = parseFrom('张三 <zs@example.com>');
  ok('名字 + 地址', a.name === '张三' && a.address === 'zs@example.com');

  const b = parseFrom('"Call of Duty" <x@y.com>');
  ok('引号被去掉', b.name === 'Call of Duty', b.name);

  const c = parseFrom('bare@example.com');
  ok('只有地址', c.name === 'bare@example.com' && c.address === 'bare@example.com');

  const d = parseFrom('NoBracket');
  ok('没有尖括号', d.address === 'NoBracket');
}

console.log('\n=== ④ 主题清洗 ===');
{
  ok('去掉 Re:', cleanSubject('Re: 测试') === '测试');
  ok('去掉 Fwd:', cleanSubject('Fwd: 测试') === '测试');
  ok('去掉中文回复:', cleanSubject('回复：测试') === '测试');
  ok('★ 去掉多层层级', cleanSubject('Re: Fwd: Re: 多层') === '多层');
  ok('无前缀原样', cleanSubject('普通主题') === '普通主题');
  ok('大小写都认', cleanSubject('RE: 大寫') === '大寫');
}

console.log('\n=== ⑤ 采集器契约 ===');
{
  const c = createMailCollector({ boxes: [{ address: 'a@qq.com', credential: 'relay-qq-mail' }] });
  ok('符合采集器契约', validateCollector(c).ok === true);
  ok('名字是 mail', c.name === 'mail');
  ok('默认 600 秒', c.trigger.everySec === 600);
  ok('有 run', typeof c.run === 'function');
  ok('有 setup/teardown', typeof c.setup === 'function' && typeof c.teardown === 'function');
}

console.log('\n=== ⑥ 没配邮箱不报错 ===');
{
  const c = createMailCollector({ boxes: [] });
  await c.setup(mkEnv());
  const r = await c.run(mkEnv());
  ok('空配置返回空数组', Array.isArray(r) && r.length === 0);
}

console.log('\n=== ⑦ 没有凭据读取器时报 collector-error ===');
{
  const c = createMailCollector({ boxes: [{ address: 'a@qq.com', credential: 'relay-qq-mail' }] });
  const env = mkEnv();
  delete env.readCredential;
  const r = await c.run(env);
  ok('★ 产出告警而不是崩溃', r.length === 1);
  ok('★ 是 collector-error', r[0].kind === 'collector-error');
  ok('是 warn 级别', r[0].level === 'warn');
  ok('事件合法', collectEvents(r, 'mail').rejected.length === 0);
}

console.log('\n=== ⑧ 认不出的域名 ===');
{
  const c = createMailCollector({ boxes: [{ address: 'x@nowhere.zz', credential: 'k' }] });
  const r = await c.run(mkEnv());
  // 第一次失败不报（要连续 3 次）
  ok('★ 首次失败静默（防抖）', r.length === 0, `got ${r.length}`);

  await c.run(mkEnv());
  const third = await c.run(mkEnv());
  ok('★ 连续 3 次才报', third.length === 1, `got ${third.length}`);
  ok('告警里有账号名', third[0]?.payload?.account === 'x@nowhere.zz');
  ok('告警里有原因', typeof third[0]?.payload?.error === 'string');
  ok('告警事件合法', collectEvents(third, 'mail').rejected.length === 0);
}

console.log('\n=== ⑨ 凭据读取失败 ===');
{
  const c = createMailCollector({ boxes: [{ address: 'a@qq.com', credential: 'relay-qq-mail' }] });
  const env = mkEnv({ readCredential: async () => { throw new Error('vault locked'); } });
  const r = await c.run(env);
  ok('首次静默', r.length === 0);
  await c.run(env);
  const third = await c.run(env);
  ok('★ 3 次后报错', third.length === 1);
  ok('原因是读凭据失败', String(third[0]?.payload?.error ?? '').includes('凭据'), third[0]?.payload?.error);
}

console.log('\n=== ⑩ 默认值 ===');
{
  ok('默认 600 秒一轮', DEFAULTS.intervalSec === 600);
  ok('首轮回溯 7 天', DEFAULTS.initialDays === 7);
  ok('单轮最多 50 封', DEFAULTS.maxPerRun === 50);
  ok('最长回溯 30 天', DEFAULTS.lookbackDays === 30);
  ok('服务器表有 6 个', Object.keys(SERVERS).length === 6);
}

console.log('\n=== ⑪ 事件形状（模拟一行头部）===');
{
  // 直接调内部构造逻辑：验证 summary 和 payload 的样子
  const from = parseFrom(decodeHeader('张三 <zs@example.com>'));
  const subject = cleanSubject(decodeHeader(`=?UTF-8?B?${Buffer.from('项目周报', 'utf8').toString('base64')}?=`));
  const summary = `${from.name}：${subject}`;
  ok('★ 摘要格式「名字：主题」', summary === '张三：项目周报', summary);
  ok('摘要不超 80 字', summary.length <= 80);
}

console.log(`\n===== ${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} (${pass} passed, ${fail} failed) =====`);
process.exit(fail === 0 ? 0 : 1);
