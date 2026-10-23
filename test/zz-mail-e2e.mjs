// zz-mail-e2e.mjs — 邮件采集器端到端：真调 apply() → 事件入库 → 窗口统计
//
// 这是最后一环验证：不只是"采集器能拉信"，而是"拉到的信真的进了 relay 的管道"。
//
// 需要环境变量（否则跳过）：
//   DSH_RELAY_QQ_MAIL / DSH_RELAY_163_MAIL

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { apply } from '../lib/index.js';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

if (!process.env.DSH_RELAY_QQ_MAIL && !process.env.DSH_RELAY_163_MAIL) {
  console.log('跳过：没设凭据环境变量');
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), 'mail-e2e-'));
mkdirSync(join(root, 'inbox'), { recursive: true });
mkdirSync(join(root, 'archive'), { recursive: true });
mkdirSync(join(root, 'peers'), { recursive: true });

const boxes = [];
if (process.env.DSH_RELAY_QQ_MAIL) boxes.push({ address: '********@qq.com', credential: 'relay-qq-mail' });
if (process.env.DSH_RELAY_163_MAIL) boxes.push({ address: '********@163.com', credential: 'relay-163-mail' });

writeFileSync(join(root, 'config.json'), JSON.stringify({
  enabled: true,
  supervise: { enabled: false },
  interface: { file: { enabled: true, dir: 'inbox', pollMs: 999999 }, http: { enabled: false } },
  sources: {
    system: { enabled: false },          // 本文只测邮件
    mail: { enabled: true, intervalSec: 9999, maxPerRun: 3, initialDays: 3, boxes },
  },
  delivery: {
    levels: {
      critical: { channel: 'wake', cooldownSec: 0, mergeWindowSec: 0, titleChars: 20 },
      warn: { channel: 'queue', cooldownSec: 0, mergeWindowSec: 0, titleChars: 20, batch: { enabled: false } },
      info: { channel: 'archive', cooldownSec: 0, mergeWindowSec: 0, titleChars: 20 },
    },
  },
  rate: { maxPerTurn: 10, maxPerHour: 50, globalCooldownSec: 0 },
  labels: { mail: { zh: '邮件', order: 1 } },
}));

// 规则：邮件只进窗口
writeFileSync(join(root, 'rules.json'), JSON.stringify({
  defaults: { channels: ['window'] },
  rules: [{ id: 'mail-window', match: { source: 'mail' }, channels: ['window'] }],
}));

const ctx = {
  on: () => () => {},
  get: () => undefined,
  effect: (f) => { const d = f(); return () => d?.(); },
  userQuestions: {},
  agents: { roots: () => [], get: () => undefined },
};

const api = apply(ctx, { root, enabled: false });

// 【等首次采集跑完】
//   apply() 末尾会立刻跑一轮采集（启动即采，不等 interval）。
//   如果这里不等就去 runCollector，会撞上 already-running。
//   邮件要连网，给足时间。
await new Promise((r) => setTimeout(r, 8000));

console.log('\n=== 框架就绪 ===');
const fw = api.framework();
ok('framework ready', fw.ready === true, fw.reason);
ok('★ mail 采集器已注册', fw.collectors.some((c) => c.name === 'mail'), JSON.stringify(fw.collectors.map((c) => c.name)));

console.log('\n=== 首轮采集已经跑过（启动即采）===');
const after = api.framework().events;
ok('★ 入库计数 > 0', after > 0, `events=${after}`);

const evDir = join(root, 'events');
ok('★ events 目录已创建', existsSync(evDir));
const files = existsSync(evDir) ? readdirSync(evDir).filter((x) => x.endsWith('.jsonl')) : [];
ok('有按天分文件', files.length >= 1, files.join(','));

let events = [];
for (const f of files) {
  events = events.concat(readFileSync(join(evDir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}
const mailEvents = events.filter((e) => e.source === 'mail');
ok('★ 事件库里是 mail 源', mailEvents.length > 0, `count=${mailEvents.length}`);
ok('第一条带 payload.uid', typeof mailEvents[0]?.payload?.uid === 'string');
ok('有 summary', typeof mailEvents[0]?.summary === 'string' && mailEvents[0].summary.length > 0);
ok('level 是 info（不叫醒）', mailEvents.every((e) => e.level === 'info'));

console.log('\n=== 窗口统计（summary 接口）===');
const s = await api.summary();
console.log('  summary:', JSON.stringify(s));
ok('summary ready', s.ready === true);
const mailRow = (s.sources ?? []).find((x) => x.source === 'mail');
ok('★ 分类计数里有「邮件」', mailRow !== undefined, JSON.stringify(s.sources));
ok('★ 中文标签正确', mailRow?.label === '邮件', mailRow?.label);
ok('★ 条数 > 0', (mailRow?.count ?? 0) > 0, `count=${mailRow?.count}`);

console.log('\n=== 体检记录 ===');
const runs = existsSync(join(root, 'collector-runs.jsonl'))
  ? readFileSync(join(root, 'collector-runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : [];
ok('★ collector-runs 有记录', runs.length > 0, `count=${runs.length}`);
ok('记录里有账号', runs.some((x) => typeof x.account === 'string'));
ok('记录里有采集条数', runs.some((x) => typeof x.scanned === 'number'));

try { rmSync(root, { recursive: true, force: true }); } catch {}

console.log(`\n===== ${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} (${pass} passed, ${fail} failed) =====`);
process.exit(fail === 0 ? 0 : 1);
