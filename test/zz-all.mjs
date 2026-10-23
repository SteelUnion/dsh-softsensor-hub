// zz-all.mjs — 一条命令跑完全部测试
//
// 为什么要有这个：
//   6 个套件一条条跑容易漏，而且写一条长命令传给我自己容易出参数格式错误。
//   这里一次跑完，打印汇总表。
//
// 用法：node test/zz-all.mjs

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

const SUITES = [
  { file: 'wiring.mjs',            tag: '配对与校验' },
  { file: 'zz-e2e.mjs',            tag: '结构/映射/截断/静默/HTTP/游戏模式' },
  { file: 'zz-steer-test.mjs',     tag: 'steer 分流/限流/turn-stopping' },
  { file: 'zz-batch-test.mjs',     tag: '批次攒批/骨架去重/合并统计' },
  { file: 'zz-event-test.mjs',     tag: '事件模型 壳+瓤' },
  { file: 'zz-rules-test.mjs',     tag: '规则引擎 热加载/失败回退' },
  { file: 'zz-store-test.mjs',     tag: '事件库 三后端/清理' },
  { file: 'zz-collector-test.mjs', tag: '采集器 注册/隔离/定时' },
  { file: 'zz-system-test.mjs',    tag: '系统监控 内存/磁盘/事件循环/停顿检测' },
  { file: 'zz-hysteresis-test.mjs', tag: '告警迟滞 超阈值只报一次/恢复清零' },
  { file: 'zz-cred-test.mjs',      tag: '凭据库 AES-GCM 加解密/来源优先级' },
  { file: 'zz-mail-test.mjs',      tag: '邮件采集器 IMAP/RFC2047/失败防抖' },
  { file: 'zz-finance-test.mjs',   tag: '金融采集器 四档对比/新鲜度闸门/只读' },
  { file: 'zz-weather-test.mjs',   tag: '天气采集器 6h闸门/温差/位置/历史' },
  { file: 'zz-init-test.mjs',      tag: '引导配置 三态/中断续/不扰民' },
  { file: 'zz-config-sync-test.mjs', tag: '配置双写 state权威/同步检查/两侧位置' },
  { file: 'zz-weather-query-test.mjs', tag: '天气查询 城市别名/温差计算/极简渲染' },
  { file: 'zz-mail-e2e.mjs',       tag: '邮件端到端（需凭据，否则跳过）' },
  { file: 'zz-wire-test.mjs',      tag: '接线 真调 apply/老路径/坏规则不停摆' },
];

const rows = [];
let totalPass = 0;
let totalFail = 0;
let suitesWithFailure = 0;

for (const { file, tag } of SUITES) {
  const full = join(HERE, file);
  const r = spawnSync(process.execPath, [full], { encoding: 'utf8', timeout: 300_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;

  // 期望最后一行形如：===== ALL PASS (65 passed, 0 failed) =====
  const m = out.match(/\((?:(\d+) passed)?,\s*(\d+) failed\)/);
  const passed = m ? Number(m[1] ?? 0) : 0;
  const failed = m ? Number(m[2]) : 0;

  // 【跳过也算通过】
  //   有些套件需要外部条件（如 zz-mail-e2e 要真凭据）。
  //   它们会在没条件时打印"跳过"然后 exit 0，不打统计行。
  //   这种情况不能算崩溃，也不能算失败。
  const skipped = !m && r.status === 0 && /跳过|skip/i.test(out);
  if (skipped) {
    rows.push({ file, tag, passed: 0, failed: 0, note: 'SKIP' });
    continue;
  }

  // 真崩溃：有失败退出码、又没有统计行、也不是跳过
  const crashed = !m && r.status !== 0;
  if (crashed) {
    rows.push({ file, tag, passed: 0, failed: 1, note: 'CRASH' });
    totalFail += 1;
    suitesWithFailure += 1;
    continue;
  }

  rows.push({ file, tag, passed, failed, note: '' });
  totalPass += passed;
  totalFail += failed;
  if (failed > 0) suitesWithFailure += 1;
}

// 打印
const fileW = Math.max(...rows.map((r) => r.file.length), 5);
const pad = (s, n) => String(s).padEnd(n);
console.log('');
console.log('  ' + pad('套件', fileW) + '  结果        覆盖');
console.log('  ' + '-'.repeat(fileW) + '  ----------  ' + '-'.repeat(40));
for (const r of rows) {
  const verdict = r.note === 'CRASH' ? '崩溃' : r.note === 'SKIP' ? 'SKIP' : r.failed === 0 ? 'PASS' : 'FAIL';
  const num = r.note === 'CRASH' || r.note === 'SKIP' ? '' : `${r.passed} / ${r.passed + r.failed}`;
  console.log(`  ${pad(r.file, fileW)}  ${pad(verdict + ' ' + num, 12)}  ${r.tag}`);
}
console.log('  ' + '-'.repeat(fileW + 58));
console.log(`  合计：${rows.length} 个套件，${totalPass} 项通过，${totalFail} 项失败`);

if (suitesWithFailure === 0) {
  console.log('\n  ✅ 全部通过');
  process.exit(0);
}
console.log(`\n  ❌ ${suitesWithFailure} 个套件有问题`);
process.exit(1);
