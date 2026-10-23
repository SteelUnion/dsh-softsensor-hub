// relay 打包脚本 —— 按白名单，输出 dist/dsh-relay-v<version>.zip
//
// 借鉴 confirm-gate/pack.mjs：
//   白名单顺序固定（顺序影响哈希，固定才能复现），不允许通配。
//   通配会让 .jsonl 日志、peers/、inbox/ 这些运行时数据悄悄漏进包里。
//
// 用法：node pack.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, 'dist');

/**
 * 白名单：包内文件，顺序固定。
 *
 * 【不放什么 —— 比放什么更重要】
 *   ✗ *.jsonl       运行时日志（received / rejected / peers-down / steered ...）
 *   ✗ peers/        配对文件，含 token，是每台机器自己的
 *   ✗ inbox/ archive/  运行时邮箱
 *   ✗ config.json   含机器相关路径（relay.root），用默认值 + 用户自己配
 *
 * 【为什么现在把 test/ 也放进来】
 *   用户原话：「这个确认状态的有啥用，如果有用可以登记在这个插件的配置文件里，
 *   参与 git 的打包，以后都可以方便的测试。」
 *   装完就能自己跑 node test/zz-check.mjs 体检。
 *   注意：只放**零依赖、能独立跑**的 zz-* 脚本；
 *   老的 inject/integration/supervise 依赖仓库内相对路径与真实 peers，不放。
 */
const INCLUDE = [
  // ── 元数据 ──
  'package.json',
  'LICENSE',
  'README.md',
  'INSTALL.md',
  'cordis.patch.yml',
  'relay.mjs',
  'pack.mjs',
  'config.template.json',

  // ── 代码（lib 全量，逐个列，不用通配）──
  'lib/index.js',
  'lib/init.mjs',
  'lib/message.mjs',
  'lib/event.mjs',
  'lib/rules.mjs',
  'lib/store.mjs',
  'lib/state.mjs',
  'lib/collector.mjs',
  'lib/butler-spec.mjs',
  'lib/cities.mjs',
  'lib/config-sync.mjs',
  'lib/credentials.mjs',
  'lib/weather-query.mjs',
  'lib/collectors/system.mjs',
  'lib/collectors/mail.mjs',
  'lib/collectors/finance.mjs',
  'lib/collectors/weather.mjs',

  // ── schema ──
  'schema/rules.schema.json',

  // ── 测试：只放零依赖、能独立跑的 ──
  'test/zz-all.mjs',
  'test/zz-check.mjs',
  'test/zz-e2e.mjs',
  'test/zz-steer-test.mjs',
  'test/zz-batch-test.mjs',
  'test/zz-event-test.mjs',
  'test/zz-rules-test.mjs',
  'test/zz-store-test.mjs',
  'test/zz-collector-test.mjs',
  'test/zz-system-test.mjs',
  'test/zz-hysteresis-test.mjs',
  'test/zz-cred-test.mjs',
  'test/zz-finance-test.mjs',
  'test/zz-weather-test.mjs',
  'test/zz-init-test.mjs',
  'test/zz-config-sync-test.mjs',
  'test/zz-weather-query-test.mjs',
  'test/zz-wire-test.mjs',
  'test/zz-http-live.cjs',
];

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
if (typeof version !== 'string' || version.trim() === '') {
  console.error('package.json 里没有可用的 version');
  process.exit(1);
}

const name = `dsh-relay-v${version}.zip`;
const outPath = join(DIST, name);

// ---- 最小 zip 写入器（deflate，无第三方依赖）----
function crc32(buf) {
  let c;
  const table = crc32.table ?? (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

const files = [];
for (const rel of INCLUDE) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) {
    console.error(`白名单文件不存在：${rel}`);
    process.exit(1);
  }
  files.push({ rel, abs, size: statSync(abs).size });
}

const locals = [];
const centrals = [];
let offset = 0;

for (const f of files) {
  const raw = readFileSync(f.abs);
  const crc = crc32(raw);
  const deflated = deflateRawSync(raw, { level: 9 });
  const nameBuf = Buffer.from(f.rel, 'utf8');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);          // version needed
  local.writeUInt16LE(0x0800, 6);      // UTF-8 name
  local.writeUInt16LE(8, 8);           // deflate
  local.writeUInt16LE(0, 10);          // time
  local.writeUInt16LE(0, 12);          // date
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  locals.push(local, nameBuf, deflated);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(offset, 42);

  centrals.push(central, nameBuf);
  offset += local.length + nameBuf.length + deflated.length;
}

const cdBuf = Buffer.concat(centrals);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(cdBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

mkdirSync(DIST, { recursive: true });
writeFileSync(outPath, Buffer.concat([...locals, cdBuf, eocd]));

const total = statSync(outPath).size;
console.log(`已打包：dist/${name}  (${total} B, ${files.length} 个文件)`);
for (const f of files) console.log(`  ${f.rel}  ${f.size} B`);
