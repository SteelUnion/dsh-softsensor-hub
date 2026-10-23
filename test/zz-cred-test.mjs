// zz-cred-test.mjs — 凭据库测试

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CredentialVault, encrypt, decrypt, envNameFor, makeCredentialReader,
} from '../lib/credentials.mjs';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

const TMP = mkdtempSync(join(tmpdir(), 'cred-test-'));

console.log('\n=== ① 环境变量名转换 ===');
{
  ok('relay-qq-mail → DSH_RELAY_QQ_MAIL', envNameFor('relay-qq-mail') === 'DSH_RELAY_QQ_MAIL');
  ok('relay-163-mail → DSH_RELAY_163_MAIL', envNameFor('relay-163-mail') === 'DSH_RELAY_163_MAIL');
  ok('带点的也处理', envNameFor('a.b.c') === 'DSH_RELAY_A_B_C');
}

console.log('\n=== ② AES-256-GCM 加解密 ===');
{
  const enc = encrypt('hello-secret', 'master-key');
  ok('有 salt/iv/tag/ct 四段', !!(enc.salt && enc.iv && enc.tag && enc.ct));
  ok('密文不含明文', !JSON.stringify(enc).includes('hello-secret'));
  ok('能解回原文', decrypt(enc, 'master-key') === 'hello-secret');
  ok('★ 错主密钥解密失败', (() => {
    try { decrypt(enc, 'wrong-key'); return false; } catch { return true; }
  })());
  ok('★ 篡改密文被发现', (() => {
    const bad = { ...enc, ct: Buffer.from('tampered-data-xx').toString('base64') };
    try { decrypt(bad, 'master-key'); return false; } catch { return true; }
  })());
  ok('每次加密 iv 不同', encrypt('x', 'k').iv !== encrypt('x', 'k').iv);
}

console.log('\n=== ③ 从环境变量读（优先级 1）===');
{
  const root = join(TMP, 'v1');
  mkdirSync(root, { recursive: true });
  const env = { DSH_RELAY_QQ_MAIL: 'auth-code-123' };
  const v = new CredentialVault(root, env);
  ok('读得到', v.get('relay-qq-mail') === 'auth-code-123');
  ok('source 标为 env', v.source === 'env');
  ok('不存在的返回 undefined', v.get('relay-nope') === undefined);

  const { values, missing } = v.requireAll(['relay-qq-mail', 'relay-nope']);
  ok('requireAll 分开返回', values['relay-qq-mail'] === 'auth-code-123' && missing.length === 1);
}

console.log('\n=== ④ 从 vault 读（优先级 2）===');
{
  const root = join(TMP, 'v2');
  mkdirSync(root, { recursive: true });
  const env = { DSH_RELAY_MASTER: 'my-master-key' };
  const v = new CredentialVault(root, env);
  ok('无主密钥时 set 失败', new CredentialVault(root, {}).set('x', 'y').reason === 'no-master-key');

  const r = v.set('relay-qq-mail', 'secret-abc');
  ok('有主密钥时 set 成功', r.ok === true);
  ok('vault.json 已创建', existsSync(join(root, 'vault.json')));

  const raw = readFileSync(join(root, 'vault.json'), 'utf8');
  ok('★ 文件里没有明文', !raw.includes('secret-abc'), raw.slice(0, 80));

  const v2 = new CredentialVault(root, env); // 重开，确认能解
  ok('★ 重开能解出原文', v2.get('relay-qq-mail') === 'secret-abc');
  ok('source 标为 vault', v2.source === 'vault');

  const v3 = new CredentialVault(root, { DSH_RELAY_MASTER: 'wrong' });
  ok('★ 错主密钥读不到', v3.get('relay-qq-mail') === undefined);
}

console.log('\n=== ⑤ 环境变量优先于 vault ===');
{
  const root = join(TMP, 'v3');
  mkdirSync(root, { recursive: true });
  const master = 'mk';
  const v = new CredentialVault(root, { DSH_RELAY_MASTER: master });
  v.set('relay-163-mail', 'from-vault');

  // 【关键】envNameFor('relay-163-mail') = DSH_RELAY_163_MAIL（不是 DSH_RELAY_RELAY_163_MAIL）
  const envOverride = { DSH_RELAY_MASTER: master, DSH_RELAY_163_MAIL: 'from-env' };
  const v2 = new CredentialVault(root, envOverride);
  ok('★ 环境变量赢', v2.get('relay-163-mail') === 'from-env', `envName=${envNameFor('relay-163-mail')}`);
}

console.log('\n=== ⑥ 原子写 ===');
{
  const root = join(TMP, 'v4');
  mkdirSync(root, { recursive: true });
  const v = new CredentialVault(root, { DSH_RELAY_MASTER: 'k' });
  v.set('a', 'one');
  v.set('b', 'two');
  const v2 = new CredentialVault(root, { DSH_RELAY_MASTER: 'k' });
  ok('两次写都保住', v2.get('a') === 'one' && v2.get('b') === 'two');
  ok('没有残留 .tmp', !existsSync(join(root, 'vault.json.tmp')));
}

console.log('\n=== ⑦ 坏文件不炸 ===');
{
  const root = join(TMP, 'v5');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'vault.json'), '{ broken json');
  const v = new CredentialVault(root, { DSH_RELAY_MASTER: 'k' });
  ok('坏 vault 返回 undefined 不抛', v.get('x') === undefined);
  ok('set 能重建', v.set('x', 'y').ok === true);
  const v2 = new CredentialVault(root, { DSH_RELAY_MASTER: 'k' });
  ok('重建后能读', v2.get('x') === 'y');
}

console.log('\n=== ⑧ list / status ===');
{
  const root = join(TMP, 'v6');
  mkdirSync(root, { recursive: true });
  const env = { DSH_RELAY_MASTER: 'k', DSH_RELAY_EXTRA_ONE: 'e' };
  const v = new CredentialVault(root, env);
  v.set('relay-qq-mail', 'x');
  const names = v.list();
  ok('列出 vault 里的', names.includes('relay-qq-mail'));
  ok('列出环境变量里的', names.includes('relay-extra-one'));
  ok('不列 MASTER 本身', !names.includes('master'));

  const st = v.status();
  ok('status.hasMaster', st.hasMaster === true);
  ok('status.vaultExists', st.vaultExists === true);
  ok('status 不含明文', !JSON.stringify(st).includes('"x"'));
}

console.log('\n=== ⑨ makeCredentialReader ===');
{
  const root = join(TMP, 'v7');
  mkdirSync(root, { recursive: true });
  // envNameFor('relay-test-key') = DSH_RELAY_TEST_KEY
  const v = new CredentialVault(root, { DSH_RELAY_TEST_KEY: 'val-1' });
  const read = makeCredentialReader(v);
  ok('读得到', (await read('relay-test-key')) === 'val-1');
  ok('找不到时抛错', await (async () => {
    try { await read('nope'); return false; } catch { return true; }
  })());
}

console.log('\n=== ⑩ 采集器集成前置：mock readCredential ===');
{
  const root = join(TMP, 'v8');
  mkdirSync(root, { recursive: true });
  const v = new CredentialVault(root, { DSH_RELAY_QQ_MAIL: 'ok-code' });
  const read = makeCredentialReader(v);
  ok('采集器拿到的读取器能工作', (await read('relay-qq-mail')) === 'ok-code');
}

try { rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log(`\n===== ${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} (${pass} passed, ${fail} failed) =====`);
process.exit(fail === 0 ? 0 : 1);
