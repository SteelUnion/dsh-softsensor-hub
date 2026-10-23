// zz-event-test.mjs — 事件模型测试
//
// 规矩：测试脚本用 zz- 前缀，和不进主流程的临时件区分开。

import {
  validateEvent, upgradeLegacyMessage, clipSummary, payloadBytes,
  shouldDisplay, markDisplayed, eventSkeleton, groupEvents,
  renderEvent, summarizeBySource, newEventId,
  LEVELS, SUMMARY_MAX, PAYLOAD_MAX_BYTES, REJECT, LEGACY_SOURCE,
} from '../lib/event.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

const base = {
  source: 'mail',
  kind: 'new-mail',
  level: 'info',
  summary: '张三：项目周报',
  payload: { from: 'zhangsan@example.com' },
};

console.log('\n=== ① 校验：合法事件通过 ===');
{
  const r = validateEvent(base);
  ok('合法事件通过', r.ok === true);
  ok('自动生成 id', typeof r.event?.id === 'string' && r.event.id.startsWith('evt-'));
  ok('保留 source', r.event?.source === 'mail');
  ok('displayed 初始化成 null', r.event?.displayed?.wake === null && r.event?.displayed?.window === null);
}

console.log('\n=== ② 校验：各类拒收 ===');
{
  ok('非对象拒收', validateEvent(null).reason === REJECT.NOT_OBJECT);
  ok('数组拒收', validateEvent([]).reason === REJECT.NOT_OBJECT);
  ok('source 大写拒收', validateEvent({ ...base, source: 'Mail' }).reason === REJECT.BAD_SOURCE);
  ok('source 带点拒收', validateEvent({ ...base, source: 'a.b' }).reason === REJECT.BAD_SOURCE);
  ok('source 缺失拒收', validateEvent({ ...base, source: undefined }).reason === REJECT.BAD_SOURCE);
  ok('kind 数字拒收', validateEvent({ ...base, kind: 5 }).reason === REJECT.BAD_KIND);
  ok('level 不在枚举拒收', validateEvent({ ...base, level: 'fatal' }).reason === REJECT.BAD_LEVEL);
  ok('summary 空拒收', validateEvent({ ...base, summary: '   ' }).reason === REJECT.MISSING_SUMMARY);
  ok('summary 缺失拒收', validateEvent({ ...base, summary: undefined }).reason === REJECT.MISSING_SUMMARY);
  ok('payload 缺失 → 空对象通过', validateEvent({ ...base, payload: undefined }).ok === true);
}

console.log('\n=== ③ 校验：边界处理 ===');
{
  const longSummary = 'x'.repeat(200);
  const r = validateEvent({ ...base, summary: longSummary });
  ok('超长摘要被截断不报错', r.ok === true && r.event.summary.length === SUMMARY_MAX);
  ok('截断带省略号', r.event.summary.endsWith('…'));

  const big = { data: 'x'.repeat(PAYLOAD_MAX_BYTES) };
  const r2 = validateEvent({ ...base, payload: big });
  ok(`payload 超 ${PAYLOAD_MAX_BYTES} 拒收`, r2.reason === REJECT.PAYLOAD_TOO_LARGE);

  const r3 = validateEvent({ ...base, dedupeKey: '   ' });
  ok('空 dedupeKey 归 null', r3.ok === true && r3.event.dedupeKey === null);

  const r4 = validateEvent({ ...base, dedupeKey: ' k1 ' });
  ok('dedupeKey 去空白', r4.event.dedupeKey === 'k1');

  const r5 = validateEvent({ ...base, at: '2026-10-21T12:00:00' });
  ok('裸时间补时区', r5.ok === true && /Z$|[+-]\d{2}:\d{2}$/.test(r5.event.at));

  const r6 = validateEvent({ ...base, at: 'garbage' });
  ok('坏时间不炸，补当前时间', r6.ok === true && typeof r6.event.at === 'string');

  const r7 = validateEvent({ ...base, displayed: { wake: 'fake', window: 'fake' } });
  ok('源给的 displayed 被忽略', r7.event.displayed.wake === null);
}

console.log('\n=== ④ 老消息升级（74 项测试的命脉）===');
{
  const legacy = {
    peer: 'monitor', level: 'warn',
    title: '内存占用 93.2% 超过阈值 85%',
    body: '建议检查',
    dedupeKey: 'mem',
    at: '2026-10-21T12:00:00.000Z',
  };
  const e = upgradeLegacyMessage(legacy);
  ok('peer → source', e.source === 'monitor');
  ok('title → summary', e.summary === legacy.title);
  ok('body → payload.body', e.payload.body === '建议检查');
  ok('level 不变', e.level === 'warn');
  ok('kind 固定 message', e.kind === 'message');
  ok('meta.legacy 标记', e.meta.legacy === true);
  ok('保留老 peer 字段', e.peer === 'monitor');
  ok('保留老 title 字段', e.title === legacy.title);
  ok('保留老 body 字段', e.body === '建议检查');
  ok('isLegacyEvent 认得出来', e.meta.legacy === true);

  const weird = upgradeLegacyMessage({ peer: 'A.B_C', level: 'info', title: 't' });
  ok('怪 peer 被规范成合法 source', /^[a-z][a-z0-9-]{0,31}$/.test(weird.source), weird.source);

  const empty = upgradeLegacyMessage({});
  ok('空消息也有 source', empty.source === LEGACY_SOURCE);
  ok('空消息 summary 有兜底', empty.summary === '(无标题)');
}

console.log('\n=== ⑤ 展示记录（防重复叫醒，抄 WB）===');
{
  const evt = validateEvent(base).event;
  ok('初始该展示', shouldDisplay(evt, 'wake') === true);
  const m1 = markDisplayed(evt, 'wake', '2026-10-21T12:00:00.000Z');
  ok('标记后不该再展示', shouldDisplay(m1, 'wake') === false);
  ok('window 通道不受影响', shouldDisplay(m1, 'window') === true);
  ok('原对象没被改（不可变）', evt.displayed.wake === null);
  ok('未知通道被忽略', markDisplayed(evt, 'nope') === evt);
}

console.log('\n=== ⑥ 骨架去重 ===');
{
  const mk = (summary, dedupeKey = null) => validateEvent({ ...base, summary, dedupeKey }).event;
  const a = mk('内存占用 93.2% 超过阈值 85%');
  const b = mk('内存占用 93.5% 超过阈值 85%');
  ok('数字不同骨架相同', eventSkeleton(a) === eventSkeleton(b));

  const c = mk('磁盘 91% 剩余不足');
  ok('不同事件骨架不同', eventSkeleton(a) !== eventSkeleton(c));

  const d1 = mk('A', 'k1');
  const d2 = mk('完全不同的文字', 'k1');
  ok('有 dedupeKey 优先用它', eventSkeleton(d1) === eventSkeleton(d2));

  const items = [a, b, c].map((event, i) => ({ event, seq: i }));
  const g = groupEvents(items);
  ok('3 条 → 2 组', g.groups.length === 2, `got ${g.groups.length}`);
  ok('合并了 1 条', g.deduped === 1);
  const grp = g.groups.find((x) => x.count === 2);
  ok('保留最新一条', grp.keep.seq === 1);
}

console.log('\n=== ⑦ 渲染 ===');
{
  const e = validateEvent({ ...base, summary: '这是一个很长很长很长很长很长很长的标题' }).event;
  const s = renderEvent(e, 10);
  ok('标题被截断', s.includes('…'));
  ok('带级别标记', s.startsWith('[INFO]'));
  ok('带源名', s.includes('mail'));

  const withBody = validateEvent({ ...base, summary: 's', payload: { body: '正文内容' } }).event;
  ok('payload.body 被带出', renderEvent(withBody).includes('正文内容'));
  ok('无 body 时只有一行', renderEvent(e).split('\n').length === 1);
}

console.log('\n=== ⑧ 分类计数（小窗口角标）===');
{
  const labels = {
    mail: { zh: '邮件', order: 1 },
    finance: { zh: '金融', order: 2 },
    system: { zh: '系统通知', order: 3 },
    broadcast: { zh: '公告', order: 4, show: false },
    _fallback: { zh: '其他' },
  };
  const mk = (source) => validateEvent({ ...base, source }).event;
  const evts = [
    mk('mail'), mk('mail'), mk('mail'),
    mk('finance'),
    mk('system'), mk('system'),
    mk('unknown-src'),
    mk('broadcast'),
  ];
  const s = summarizeBySource(evts, labels);
  const get = (src) => s.sources.find((x) => x.source === src);
  ok('邮件 3', get('mail')?.count === 3);
  ok('金融 1', get('finance')?.count === 1);
  ok('系统 2', get('system')?.count === 2);
  ok('中文标签生效', get('mail')?.label === '邮件');
  ok('未登记源归「其他」', get('unknown-src')?.label === '其他');
  ok('show:false 的不出现', get('broadcast') === undefined);
  ok('按 order 排序', s.sources[0].source === 'mail' && s.sources[1].source === 'finance');
  ok('total 只算展示的', s.total === evts.length);
}

console.log('\n=== ⑨ 工具函数 ===');
{
  ok('clipSummary 折叠空白', clipSummary('a   b\n c') === 'a b c');
  ok('clipSummary 不超长不动', clipSummary('abc', 10) === 'abc');
  ok('payloadBytes 空对象', payloadBytes({}) === 2);
  ok('newEventId 带源前缀', newEventId('mail').startsWith('evt-mail-'));
  ok('newEventId 不重复', newEventId('x') !== newEventId('x'));
  ok('LEVELS 三档', LEVELS.length === 3);
}

console.log(`\n===== ${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} (${pass} passed, ${fail} failed) =====`);
process.exit(fail === 0 ? 0 : 1);
