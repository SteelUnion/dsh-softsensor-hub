// zz-rules-test.mjs — 规则引擎测试

import { writeFileSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validateRules, matchRule, inQuietHours, evaluate, RulesEngine, CONFIG_REJECT,
} from '../lib/rules.mjs';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

const TMP = mkdtempSync(join(tmpdir(), 'rules-test-'));
const RULES = join(TMP, 'rules.json');

const evt = (o = {}) => ({
  id: 'e1', source: 'mail', kind: 'new-mail', level: 'info',
  summary: '张三：项目周报', ...o,
});

console.log('\n=== ① 清单校验：合法 ===');
{
  const spec = {
    rules: [
      { id: 'mail-window', match: { source: 'mail' }, channels: ['window'] },
      { id: 'sys-crit', match: { source: 'system', level: 'critical' }, channels: ['window', 'wake'] },
    ],
  };
  const r = validateRules(spec);
  ok('合法清单通过', r.ok === true);
  ok('载入 2 条规则', r.spec.rules.length === 2);
  ok('默认通道是 window', r.spec.defaultChannels.join(',') === 'window');
  ok('默认 wake 冷却 300', r.spec.rules[0].wake.cooldownSec === 300);
}

console.log('\n=== ② 清单校验：各类拒收 ===');
{
  ok('非对象拒收', validateRules(null).reason === CONFIG_REJECT.NOT_OBJECT);
  ok('无 rules 数组拒收', validateRules({}).reason === CONFIG_REJECT.NO_RULES);
  ok('rules 不是数组拒收', validateRules({ rules: 'x' }).reason === CONFIG_REJECT.NO_RULES);
  ok('缺 id 拒收', validateRules({ rules: [{ match: {}, channels: ['window'] }] }).reason === CONFIG_REJECT.BAD_RULE_ID);
  ok('id 大写拒收', validateRules({ rules: [{ id: 'Bad', match: {}, channels: ['window'] }] }).reason === CONFIG_REJECT.BAD_RULE_ID);
  ok('id 重复拒收', validateRules({ rules: [
    { id: 'a', match: {}, channels: ['window'] },
    { id: 'a', match: {}, channels: ['window'] },
  ] }).reason === CONFIG_REJECT.DUP_RULE_ID);
  ok('缺 match 拒收', validateRules({ rules: [{ id: 'a', channels: ['window'] }] }).reason === CONFIG_REJECT.BAD_MATCH);
  ok('match.source 非法拒收', validateRules({ rules: [{ id: 'a', match: { source: 'MAIL' }, channels: ['window'] }] }).reason === CONFIG_REJECT.BAD_MATCH_SOURCE);
  ok('match.level 非法拒收', validateRules({ rules: [{ id: 'a', match: { level: 'fatal' }, channels: ['window'] }] }).reason === CONFIG_REJECT.BAD_MATCH_LEVEL);
  ok('非法正则拒收', validateRules({ rules: [{ id: 'a', match: { summaryMatches: '[unclosed' }, channels: ['window'] }] }).reason === CONFIG_REJECT.BAD_REGEX);
  ok('空 channels 拒收', validateRules({ rules: [{ id: 'a', match: {}, channels: [] }] }).reason === CONFIG_REJECT.BAD_CHANNELS);
  ok('未知通道拒收', validateRules({ rules: [{ id: 'a', match: {}, channels: ['telegram'] }] }).reason === CONFIG_REJECT.BAD_CHANNELS);
  ok('defaults.channels 非法拒收', validateRules({ defaults: { channels: ['nope'] }, rules: [] }).reason === CONFIG_REJECT.BAD_CHANNELS);
}

console.log('\n=== ③ 规则匹配 ===');
{
  const spec = validateRules({ rules: [
    { id: 'mail', match: { source: 'mail' }, channels: ['window'] },
    { id: 'multi', match: { source: ['finance', 'weather'] }, channels: ['window'] },
    { id: 'crit', match: { level: 'critical' }, channels: ['wake'] },
    { id: 'contains', match: { summaryContains: '磁盘' }, channels: ['wake'] },
    { id: 'regex', match: { summaryMatches: '\\d+%' }, channels: ['batch'] },
    { id: 'off', enabled: false, match: { source: 'mail' }, channels: ['wake'] },
  ] }).spec;

  const find = (e) => spec.rules.find((r) => matchRule(r, e));
  // 注意：evt 默认 source=mail，测别的规则要先换掉 source，否则邮件规则先命中
  const other = (o) => evt({ source: 'other', ...o });

  ok('单源匹配', find(evt({ source: 'mail' }))?.id === 'mail');
  ok('数组源 OR', find(evt({ source: 'finance' }))?.id === 'multi');
  ok('数组源第二个', find(evt({ source: 'weather' }))?.id === 'multi');
  ok('级别匹配', find(other({ level: 'critical' }))?.id === 'crit');
  ok('包含匹配', find(other({ summary: '磁盘 91% 剩余不足' }))?.id === 'contains');
  ok('正则匹配', find(other({ summary: '内存 93%' }))?.id === 'regex');
  ok('不匹配返回 undefined', find(other({ source: 'unknown', summary: '普通' })) === undefined);
  ok('enabled:false 跳过', matchRule(spec.rules[5], evt({ source: 'mail' })) === false);
  ok('空 match 匹配一切', matchRule({ enabled: true, match: {} }, evt()) === true);
}

console.log('\n=== ④ 静默时段 ===');
{
  ok('0-6 内 3 点命中', inQuietHours({ start: 0, end: 6 }, new Date('2026-10-21T03:00:00')) === true);
  ok('0-6 内 7 点不命中', inQuietHours({ start: 0, end: 6 }, new Date('2026-10-21T07:00:00')) === false);
  ok('跨午夜 23-7 内 2 点命中', inQuietHours({ start: 23, end: 7 }, new Date('2026-10-21T02:00:00')) === true);
  ok('跨午夜 23-7 内 23 点命中', inQuietHours({ start: 23, end: 7 }, new Date('2026-10-21T23:30:00')) === true);
  ok('跨午夜 23-7 内 12 点不命中', inQuietHours({ start: 23, end: 7 }, new Date('2026-10-21T12:00:00')) === false);
  ok('start===end 永不命中', inQuietHours({ start: 5, end: 5 }, new Date('2026-10-21T05:00:00')) === false);
  ok('null 不命中', inQuietHours(null) === false);
}

console.log('\n=== ⑤ evaluate：通道决策 ===');
{
  const spec = validateRules({ rules: [
    { id: 'mail', match: { source: 'mail' }, channels: ['window'] },
    { id: 'crit', match: { level: 'critical' }, channels: ['window', 'wake'], wake: { cooldownSec: 60 } },
    { id: 'quiet-wake', match: { source: 'system' }, channels: ['window', 'wake'], quietHours: { start: 0, end: 6 } },
  ] }).spec;

  const d1 = evaluate(evt({ source: 'mail' }), spec);
  ok('邮件只进窗口', d1.channels.join(',') === 'window');
  ok('命中规则 id', d1.ruleId === 'mail');

  const d2 = evaluate(evt({ source: 'other', level: 'critical' }), spec);
  ok('critical 走 window+wake', d2.channels.join(',') === 'window,wake', d2.channels.join(','));
  ok('自定义冷却生效', d2.wake.cooldownSec === 60);
  const d3 = evaluate(evt({ source: 'system' }), spec, { now: new Date('2026-10-21T03:00:00') });
  ok('静默期去掉 wake', d3.channels.join(',') === 'window');
  ok('标记为被压制', d3.suppressed === true);

  const d4 = evaluate(evt({ source: 'system' }), spec, { now: new Date('2026-10-21T12:00:00') });
  ok('非静默期保留 wake', d4.channels.includes('wake'));
  ok('非静默期不算压制', d4.suppressed === false);

  const d5 = evaluate(evt({ source: 'nomatch' }), spec);
  ok('不匹配走默认（只进窗口）', d5.channels.join(',') === 'window');
  ok('默认 ruleId 为 null', d5.ruleId === null);
}

console.log('\n=== ⑥ RulesEngine：文件加载与回退（核心）===');
{
  const changes = [];
  const errors = [];
  const eng = new RulesEngine(RULES, {
    onReload: (s) => changes.push(s.rules.length),
    onError: (e) => errors.push(e.reason),
  });

  // 文件不存在
  const r0 = eng.load();
  ok('文件不存在用 fallback', r0.ok === true && r0.used === 'fallback');
  ok('fallback 也有默认通道', eng.current().defaultChannels.join(',') === 'window');

  // 写入合法清单
  writeFileSync(RULES, JSON.stringify({ rules: [{ id: 'mail', match: { source: 'mail' }, channels: ['window'] }] }));
  const r1 = eng.load();
  ok('合法清单加载成功', r1.ok === true && r1.rules === 1);
  ok('onReload 被调用', changes.length === 1 && changes[0] === 1);
  ok('决策生效', eng.decide(evt({ source: 'mail' })).ruleId === 'mail');

  // 写入坏 JSON —— 核心：旧规则必须还在
  writeFileSync(RULES, '{ this is not json');
  const r2 = eng.load();
  ok('坏 JSON 返回失败', r2.ok === false && r2.reason === 'bad-json');
  ok('onError 被调用', errors.includes('bad-json'));
  ok('★ 旧规则仍然生效', eng.current().rules.length === 1);
  ok('★ 旧规则仍然能决策', eng.decide(evt({ source: 'mail' })).ruleId === 'mail');

  // 写入非法 schema
  writeFileSync(RULES, JSON.stringify({ rules: [{ id: 'BAD', match: {}, channels: ['window'] }] }));
  const r3 = eng.load();
  ok('非法 schema 返回失败', r3.ok === false && r3.reason === CONFIG_REJECT.BAD_RULE_ID);
  ok('★ 仍然保留旧规则', eng.current().rules.length === 1);

  // 恢复合法
  writeFileSync(RULES, JSON.stringify({ rules: [
    { id: 'a', match: { source: 'mail' }, channels: ['window'] },
    { id: 'b', match: { source: 'finance' }, channels: ['window'] },
  ] }));
  const r4 = eng.load();
  ok('恢复正常后 2 条规则', r4.ok === true && r4.rules === 2);
  ok('lastError 被清空', eng.lastError === null);
}

console.log('\n=== ⑦ RulesEngine：热重载 ===');
{
  writeFileSync(RULES, JSON.stringify({ rules: [] }));
  const eng = new RulesEngine(RULES);
  eng.load();
  ok('初始 0 条规则', eng.current().rules.length === 0);

  eng.watch(50);
  ok('watch 启动', eng._watching === true);

  writeFileSync(RULES, JSON.stringify({ rules: [{ id: 'x', match: { source: 'mail' }, channels: ['wake'] }] }));
  await new Promise((r) => setTimeout(r, 1500));
  ok('★ 文件变了自动重载', eng.current().rules.length === 1, `got ${eng.current().rules.length}`);

  eng.unwatch();
  ok('unwatch 停止', eng._watching === false);
}

console.log('\n=== ⑧ fallback 静态方法 ===');
{
  const f = RulesEngine.fallback();
  ok('fallback 规则为空', f.rules.length === 0);
  ok('fallback 默认只进窗口', f.defaultChannels.join(',') === 'window');
}

// 清理
try { unlinkSync(RULES); } catch {}
try { rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log(`\n===== ${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} (${pass} passed, ${fail} failed) =====`);
process.exit(fail === 0 ? 0 : 1);
