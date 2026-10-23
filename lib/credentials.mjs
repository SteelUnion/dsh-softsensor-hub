// credentials.mjs — 凭据存取（零 spawn）
//
// 【为什么要自己写】
//   凭据已经在 Windows 凭据管理器里（2026-10-21 用 cmdkey 存好，可读回）。
//   但**插件运行时不能 spawn**（relay 硬边界），
//   而读凭据管理器只有两条路：
//     A. 起 powershell 调 CredReadW  → spawn，破边界 ❌
//     B. 直接解 DPAPI 加密文件         → 需要 CryptUnprotectData，也要外部调用 ❌
//
//   所以插件内**读不到**凭据管理器。这是真限制，不是嫌麻烦。
//
// 【替代方案：本地加密文件 + 环境变量主密钥】
//   vault.json 里存的是 AES-256-GCM 密文，
//   主密钥来自环境变量 DSH_RELAY_MASTER（或环境变量里直接给单个凭据）。
//
//   威胁模型（说清楚，不夸大）：
//     挡住 → 拷贝走 vault.json 的人（没主密钥解不开）
//     挡住 → 误把配置/仓库传出去（只有密文）
//     挡不住 → 拿到你 Windows 账号 + 主密钥的人
//
//   若没有主密钥，退化为：**直接读环境变量**（和 WorkBuddy 的 qq-email 做法一致）。
//   这就少了一层文件加密，但仍不落明文。
//
// 【优先级】
//   1. 环境变量 DSH_RELAY_<NAME>            （如 DSH_RELAY_QQ_MAIL）
//   2. vault.json 密文 + DSH_RELAY_MASTER   （AES-256-GCM）
//   3. 失败 → 报错，由采集器产出 collector-error 事件
//
// 【为什么不直接读 Windows 凭据管理器】
//   见上。但我们**仍然保留**在凭据管理器里存的那两份 ——
//   将来若允许一个独立的"配好就走"的小工具，可以从那里取。

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';

const MAGIC = 'DSH-RELAY-VAULT-1';
const KDF_SALT_BYTES = 16;
const KEY_BYTES = 32;
const IV_BYTES = 12;

/**
 * 把凭据名转成环境变量名。
 *
 * 【为什么要砍掉 relay- 前缀】
 *   凭据名本身叫 `relay-qq-mail`（存量，在 Windows 凭据管理器里就叫这个）。
 *   如果直接转，环境变量会变成 `DSH_RELAY_RELAY_QQ_MAIL`，读着别扭。
 *   砍掉开头的 `relay-`，得到 `DSH_RELAY_QQ_MAIL`。
 *
 *   `relay-qq-mail`  → DSH_RELAY_QQ_MAIL
 *   `relay-163-mail` → DSH_RELAY_163_MAIL
 *   其他名字照常转。
 */
export function envNameFor(credentialName) {
  const base = String(credentialName).toLowerCase().replace(/^relay-/, '');
  return `DSH_RELAY_${base.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

/** AES-256-GCM 加密。返回可以直接写进 JSON 的对象。 */
export function encrypt(value, master, salt = randomBytes(KDF_SALT_BYTES)) {
  const key = scryptSync(master, salt, KEY_BYTES);
  const iv = randomBytes(IV_BYTES);
  const ci = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([ci.update(String(value), 'utf8'), ci.final()]);
  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: ci.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

export function decrypt(entry, master) {
  const salt = Buffer.from(entry.salt, 'base64');
  const key = scryptSync(master, salt, KEY_BYTES);
  const de = createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'));
  de.setAuthTag(Buffer.from(entry.tag, 'base64'));
  return Buffer.concat([de.update(Buffer.from(entry.ct, 'base64')), de.final()]).toString('utf8');
}

/**
 * 凭据库。
 *
 * @param root 数据目录（vault.json 放这）
 * @param env  环境变量对象（默认 process.env，测试可注入）
 */
export class CredentialVault {
  constructor(root, env = process.env) {
    this.file = join(root, 'vault.json');
    this.env = env;
    this.cache = new Map();
    this.source = 'none'; // 'env' | 'vault' | 'none'
  }

  /** 主密钥。没有就返回 null（意味着只能走环境变量）。 */
  get master() {
    const v = this.env.DSH_RELAY_MASTER;
    return typeof v === 'string' && v !== '' ? v : null;
  }

  /** 读一个凭据。同步 —— 采集器在 run() 里要用 await，包一层即可。 */
  get(name) {
    if (this.cache.has(name)) return this.cache.get(name);

    // ① 环境变量优先（最直接，不依赖任何文件）
    const envKey = envNameFor(name);
    const fromEnv = this.env[envKey];
    if (typeof fromEnv === 'string' && fromEnv !== '') {
      this.cache.set(name, fromEnv);
      this.source = 'env';
      return fromEnv;
    }

    // ② vault.json 密文
    const master = this.master;
    if (master !== null && existsSync(this.file)) {
      try {
        const doc = JSON.parse(readFileSync(this.file, 'utf8'));
        if (doc?.magic === MAGIC && doc?.entries?.[name] !== undefined) {
          const plain = decrypt(doc.entries[name], master);
          this.cache.set(name, plain);
          this.source = 'vault';
          return plain;
        }
      } catch {
        // 解密失败 = 主密钥不对或文件损坏。不抛，让调用方看到 undefined
      }
    }

    return undefined;
  }

  /** 一次性读出多个，缺哪个报哪个（不抛异常）。 */
  requireAll(names) {
    const out = {};
    const missing = [];
    for (const n of names) {
      const v = this.get(n);
      if (v === undefined) missing.push(n);
      else out[n] = v;
    }
    return { values: out, missing };
  }

  /**
   * 写一个凭据。
   * 需要主密钥；没有就返回错误（不落明文）。
   */
  set(name, value) {
    const master = this.master;
    if (master === null) {
      return { ok: false, reason: 'no-master-key', detail: '需要环境变量 DSH_RELAY_MASTER' };
    }
    let doc = { magic: MAGIC, entries: {} };
    if (existsSync(this.file)) {
      try {
        const cur = JSON.parse(readFileSync(this.file, 'utf8'));
        if (cur?.magic === MAGIC && cur?.entries !== undefined) doc = cur;
      } catch { /* 坏了就重建 */ }
    }
    doc.entries[name] = encrypt(value, master);

    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
    renameSync(tmp, this.file); // 原子替换
    this.cache.set(name, value);
    this.source = 'vault';
    return { ok: true };
  }

  /** 有哪些凭据名（不返回明文）。 */
  list() {
    const names = new Set();
    if (existsSync(this.file)) {
      try {
        const doc = JSON.parse(readFileSync(this.file, 'utf8'));
        if (doc?.magic === MAGIC) for (const k of Object.keys(doc.entries ?? {})) names.add(k);
      } catch { /* ignore */ }
    }
    for (const k of Object.keys(this.env)) {
      if (k.startsWith('DSH_RELAY_') && k !== 'DSH_RELAY_MASTER') {
        // 反向：DSH_RELAY_QQ_MAIL → relay-qq-mail
        const tail = k.slice('DSH_RELAY_'.length).toLowerCase().replace(/_/g, '-');
        names.add(`relay-${tail}`);
      }
    }
    return [...names];
  }

  /** 排障用：当前凭据从哪来。 */
  status() {
    return {
      hasMaster: this.master !== null,
      vaultExists: existsSync(this.file),
      source: this.source,
      names: this.list(),
    };
  }
}

/** 造一个只读的凭据读取函数，给采集器的 env.readCredential 用。 */
export function makeCredentialReader(vault) {
  return async (name) => {
    const v = vault.get(name);
    if (v === undefined) {
      throw new Error(
        `凭据 "${name}" 不存在。设置环境变量 ${envNameFor(name)}，` +
        `或用 DSH_RELAY_MASTER + vault.json 存一份。`,
      );
    }
    return v;
  };
}
