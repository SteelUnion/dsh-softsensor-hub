// collectors/mail.mjs — 邮件采集器（IMAP）
//
// 协议：IMAP4rev1 over TLS
// 契约：lib/collector.mjs（CONTRACT_VERSION = 1）
//
// 【参考了什么】
//   WorkBuddy 的 qq-email skill（）
//   在三点上值得学：
//     ① 用 **UID** 做主键 —— IMAP 原生唯一，比自造 id 稳
//     ② **只拉头部**，正文按需 —— 对应我们的「壳 + 瓤」
//     ③ 凭证走环境变量，不硬编码
//
//   有三点**不采用**：
//     ① 不用 npm 的 imap / mailparser（要十几层依赖，还不支持 163）
//        本文件只用 node:tls + node:crypto，零第三方依赖
//     ② **不关证书校验**（它写了 rejectUnauthorized: false，等于自废防中间人）
//     ③ 不做一次性 CLI，做成常驻采集器
//
// 【164 那个坑】
//   163 邮箱登录成功后会拒绝 SELECT：
//     "a2 NO SELECT Unsafe Login. Please contact kefu@188.com for help"
//   必须先发 IMAP ID 命令（RFC 2971）声明客户端身份。QQ 不需要。
//   2026-10-21 实测：不发 ID 根本读不到 163 的信。
//
// 【硬边界】
//   本文件不 spawn / exec。除了 TCP 连接，不执行任何外部程序。

import tls from 'node:tls';
import { createHash } from 'node:crypto';

/** 默认值。都可由 config 的 sources.mail 覆盖。 */
export const DEFAULTS = {
  intervalSec: 600,          // 10 分钟一轮
  /** 首轮回溯多少天（之后按水位增量） */
  initialDays: 7,
  /** 单轮最多拉多少封（防一次刷屏） */
  maxPerRun: 50,
  /** 单次 SEARCH 最多往回看多少天，兜底防 IMAP 长期没连上时一次拉爆 */
  lookbackDays: 30,
  /** 每封邮件的 payload 里保留多少字摘要（正文不拉，这只是从主题补的） */
  timeoutMs: 30_000,
};

/** 各邮箱服务商的服务器地址。加新厂商往这加一行。 */
export const SERVERS = {
  'qq.com': { host: 'imap.qq.com', port: 993, needsId: false },
  '163.com': { host: 'imap.163.com', port: 993, needsId: true },
  '126.com': { host: 'imap.126.com', port: 993, needsId: true },
  'yeah.net': { host: 'imap.yeah.net', port: 993, needsId: true },
  'gmail.com': { host: 'imap.gmail.com', port: 993, needsId: false },
  'outlook.com': { host: 'outlook.office365.com', port: 993, needsId: false },
};

/** 从邮箱地址推服务器。 */
export function serverFor(address) {
  const at = String(address ?? '').lastIndexOf('@');
  if (at < 0) return null;
  const domain = String(address).slice(at + 1).toLowerCase();
  return SERVERS[domain] ?? null;
}

// ─────────────────────────── 头部解码 ───────────────────────────

/**
 * 解 RFC 2047 编码的头部。
 *
 * `=?UTF-8?B?5L2g5aW9?=` → `你好`
 * `=?GB2312?Q?=D6=D0=CE=C4?=` → `中文`
 *
 * 【为什么必须自己做】
 *   中文邮件主题几乎全是这种编码。不解出来的话，
 *   窗口里显示的就是一坨 `=?UTF-8?B?...?=`，根本没法看。
 *   2026-10-21 实测 QQ / 163 都会发这种编码。
 */
export function decodeHeader(value) {
  if (typeof value !== 'string') return '';

  // 【一次正则扫描，处理相邻编码块之间的空白】
  //   RFC 2047 §6.2：相邻的 encoded-word 之间若只有空白，
  //   视为同一段文字，空白要丢弃。
  //
  //   2026-10-21 实测：QQ 把一个中文字符拆成两个 encoded-word，
  //   中间插了个空格，解出来就成了「现已上 线！」。
  //   不处理的话，所有跨块的中文标题都会多空格。
  const ENCODED = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;

  return value
    .replace(
      /=\?([^?]+)\?([BbQq])\?([^?]*)\?=([ \t\r\n]*)(?==\?[^?]+\?[BbQq]\?)/g,
      (whole, charset, enc, text) => {
        try {
          // 注意：这里紧跟着下一个 encoded-word，所以**不补空格**
          return decodeWord(charset, enc, text);
        } catch {
          return whole;
        }
      },
    )
    // 剩下零散的 encoded-word（后面不是另一个 encoded-word）
    .replace(ENCODED, (whole, charset, enc, text) => {
      try {
        return decodeWord(charset, enc, text);
      } catch {
        return whole;
      }
    })
    // 折行续行（RFC 5322 §2.2.3）
    .replace(/\r?\n[ \t]+/g, ' ')
    .trim();
}

/** 解一个 encoded-word 的内部。 */
function decodeWord(charset, enc, text) {
  const cs = String(charset).toLowerCase().split('*')[0];
  if (/^b$/i.test(enc)) {
    return decodeWithCharset(Buffer.from(text, 'base64'), cs);
  }
  const raw = text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (__, h) =>
    String.fromCharCode(parseInt(h, 16)));
  return decodeWithCharset(Buffer.from(raw, 'latin1'), cs);
}

function decodeWithCharset(buf, charset) {
  // Node 自带 utf-8 / utf-16le / latin1(binary) / ascii
  if (charset === 'utf-8' || charset === 'utf8') return buf.toString('utf8');
  if (charset === 'us-ascii' || charset === 'ascii') return buf.toString('ascii');
  if (charset === 'utf-16' || charset === 'utf-16le') return buf.toString('utf16le');
  // gb2312 / gbk / gb18030 / big5 之类 Node 原生不支持。
  // 降级按 utf8 试一次，失败就原样返回（不引第三方库，这是有意的取舍）。
  const asUtf8 = buf.toString('utf8');
  if (!asUtf8.includes('\uFFFD')) return asUtf8;
  return buf.toString('latin1');
}

/** 从 `张三 <a@b.com>` 里取出名字和地址。 */
export function parseFrom(raw) {
  const s = String(raw ?? '').trim();
  const m = /^(.*?)<([^>]+)>\s*$/.exec(s);
  if (m !== null) {
    const name = m[1].trim().replace(/^"|"$/g, '');
    return { name: name === '' ? m[2].trim() : name, address: m[2].trim() };
  }
  return { name: s, address: s };
}

/** 主题去掉常见的前缀噪音（Re: / 回复: / Fwd:）。 */
export function cleanSubject(s) {
  return String(s ?? '').replace(/^\s*((re|fw|fwd|回复|转发)\s*[:：]\s*)+/i, '').trim();
}

// ─────────────────────────── IMAP 会话 ───────────────────────────

/**
 * 一个最小的 IMAP 客户端。
 *
 * 【为什么自己写】
 *   1. npm 的 `imap` 包不支持 163 需要的 ID 命令扩展
 *   2. 采集器要零依赖（包里塞十几层 node_modules 太重，也增加供应链风险）
 *   3. 我们只需要四个命令：LOGIN / ID / SELECT / SEARCH / FETCH
 *      不需要 MOVE / APPEND / 删除 / 标记已读，用不到那些复杂度
 *
 * 【安全】
 *   证书校验**开着**（不传 rejectUnauthorized: false）。
 *   2026-10-21 实测 QQ / 163 用默认校验都能连上。
 */
class ImapSession {
  constructor({ host, port, user, pass, timeoutMs = 30_000 }) {
    this.host = host;
    this.port = port;
    this.user = user;
    this.pass = pass;
    this.timeoutMs = timeoutMs;
    this.sock = null;
    this.buf = '';
    this.tagN = 0;
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.sock = tls.connect(
        // ⚠️ 不设 rejectUnauthorized:false —— 证书校验必须开着
        { host: this.host, port: this.port, servername: this.host },
        () => resolve(),
      );
      this.sock.setEncoding('utf8');
      this.sock.setTimeout(this.timeoutMs, () => {
        reject(new Error(`连接 ${this.host} 超时`));
        this.close();
      });
      this.sock.on('error', reject);
    });
  }

  /** 发一条命令，等它的 tagged 回复。返回 { ok, lines } */
  command(line) {
    return new Promise((resolve, reject) => {
      const tag = `a${++this.tagN}`;
      this.buf = '';
      const chunkLines = [];
      let settled = false;

      const onData = (chunk) => {
        this.buf += chunk;
        let idx;
        while ((idx = this.buf.indexOf('\r\n')) >= 0) {
          const l = this.buf.slice(0, idx);
          this.buf = this.buf.slice(idx + 2);
          if (l.startsWith(tag)) {
            settled = true;
            this.sock.off('data', onData);
            resolve({ ok: /\sOK\s/i.test(l), lines: chunkLines, last: l });
            return;
          }
          // 解 LITERAL+ / 服务端续传请求：我们只用 BODY.PEEK[...]，
          // 不主动发字面量，所以这里一般不会遇到
          chunkLines.push(l);
        }
      };

      this.sock.on('data', onData);
      this.sock.write(`${tag} ${line}\r\n`);
      setTimeout(() => {
        if (!settled) {
          this.sock.off('data', onData);
          reject(new Error(`${line.split(' ')[0]} 超时`));
        }
      }, this.timeoutMs).unref?.();
    });
  }

  async login() {
    const esc = String(this.pass).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const r = await this.command(`LOGIN ${this.user} "${esc}"`);
    if (!r.ok) throw new Error(`登录失败：${r.last}`);
    return r;
  }

  /**
   * 163 / 126 必须的一步：声明客户端身份（RFC 2971）。
   * 不发的话 SELECT 会被拒（Unsafe Login）。
   */
  async identify() {
    const r = await this.command(
      'ID ("name" "dsh-relay" "version" "0.4.0" "vendor" "SteelUnion" "support-email" "noreply@localhost")',
    );
    // 有些服务器不支持 ID，回 BAD；不当致命错误
    return r;
  }

  async selectInbox() {
    const r = await this.command('SELECT INBOX');
    if (!r.ok) throw new Error(`SELECT INBOX 失败：${r.last}`);
    const m = r.lines.map((l) => /^\* (\d+) EXISTS/i.exec(l)).find(Boolean);
    return { exists: m ? Number(m[1]) : 0 };
  }

  async searchSince(date) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const d = date instanceof Date ? date : new Date(date);
    const since = `${String(d.getDate()).padStart(2, '0')}-${months[d.getMonth()]}-${d.getFullYear()}`;
    const r = await this.command(`SEARCH SINCE ${since}`);
    if (!r.ok) throw new Error(`SEARCH 失败：${r.last}`);
    const line = r.lines.find((l) => /^\* SEARCH/i.test(l)) ?? '';
    const ids = line.replace(/^\* SEARCH\s*/i, '').trim();
    return ids === '' ? [] : ids.split(/\s+/);
  }

  /**
   * 拉一批邮件的头部 + UID。
   *
   * 【为什么用 BODY.PEEK 而不是 BODY】
   *   PEEK 不会把邮件标记为「已读」。
   *   采集器只是看一眼列表，不能替用户把信读掉。
   *   这是个容易忽略但很重要的细节 —— 用了 BODY 的话，
   *   用户打开邮箱会发现全变已读了。
   */
  async fetchHeaders(ids) {
    if (ids.length === 0) return [];
    const r = await this.command(
      `FETCH ${ids.join(',')} (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])`,
    );
    if (!r.ok) throw new Error(`FETCH 失败：${r.last}`);

    const mails = [];
    let cur = null;
    for (const line of r.lines) {
      const uidM = /^\* \d+ FETCH \(UID (\d+)/i.exec(line);
      if (uidM !== null) {
        cur = { uid: uidM[1], headers: {} };
        continue;
      }
      if (cur === null) continue;
      if (line === ')' || line === ')' || line.startsWith(')')) {
        if (Object.keys(cur.headers).length > 0) mails.push(cur);
        cur = null;
        continue;
      }
      const h = /^(From|Subject|Date):\s*(.*)$/i.exec(line);
      if (h !== null) {
        cur.headers[h[1].toLowerCase()] = h[2];
        continue;
      }
      // 折行的续行
      if (/^\s+\S/.test(line) && Object.keys(cur.headers).length > 0) {
        const keys = Object.keys(cur.headers);
        const k = keys[keys.length - 1];
        cur.headers[k] += ` ${line.trim()}`;
      }
    }
    return mails;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.sock?.end(); } catch { /* ignore */ }
    try { this.sock?.destroy(); } catch { /* ignore */ }
  }
}

// ─────────────────────────── 单账号采集 ───────────────────────────

/**
 * 采一个邮箱账号。
 *
 * @param box  { address, credential, needsId? }
 * @param opts { now, log, readCredential, lastUid, initialDays, maxPerRun }
 * @returns { events, watermark }
 */
export async function collectOne(box, opts) {
  const now = opts.now ?? (() => new Date());
  const srv = serverFor(box.address);
  if (srv === null) {
    return { events: [], error: `不认识的邮箱域名：${box.address}` };
  }

  let pass;
  try {
    pass = await opts.readCredential(box.credential);
  } catch (e) {
    return { events: [], error: `读凭据失败（${box.credential}）：${e.message}` };
  }
  if (typeof pass !== 'string' || pass === '') {
    return { events: [], error: `凭据为空：${box.credential}` };
  }

  const sess = new ImapSession({
    host: srv.host,
    port: srv.port,
    user: box.address,
    pass,
    timeoutMs: opts.timeoutMs ?? DEFAULTS.timeoutMs,
  });

  try {
    await sess.connect();
    await sess.login();

    // 163 / 126 必发，否则 SELECT 会被拒
    if (srv.needsId || box.needsId === true) {
      await sess.identify();
    }

    const { exists } = await sess.selectInbox();

    // 增量：从上次水位往回多退一天（防同一秒多封 + 时钟偏差）
    const initial = now().getTime() - (opts.initialDays ?? DEFAULTS.initialDays) * 86400_000;
    const lookbackMax = now().getTime() - (opts.lookbackDays ?? DEFAULTS.lookbackDays) * 86400_000;
    let sinceMs = Math.max(initial, lookbackMax);
    if (opts.lastSeenAt instanceof Date) {
      sinceMs = Math.max(opts.lastSeenAt.getTime() - 86400_000, lookbackMax);
    }
    const ids = await sess.searchSince(new Date(sinceMs));

    // 只取最近 maxPerRun 封
    const take = ids.slice(-(opts.maxPerRun ?? DEFAULTS.maxPerRun));
    const rows = await sess.fetchHeaders(take);

    const events = [];
    let newest = opts.lastSeenAt instanceof Date ? opts.lastSeenAt : null;
    for (const row of rows) {
      const from = parseFrom(decodeHeader(row.headers.from ?? ''));
      const subject = cleanSubject(decodeHeader(row.headers.subject ?? '')) || '(无主题)';
      const dateRaw = decodeHeader(row.headers.date ?? '');
      const date = dateRaw === '' ? null : new Date(dateRaw);
      if (date !== null && !Number.isNaN(date.getTime())) {
        if (newest === null || date > newest) newest = date;
      }
      events.push({
        source: 'mail',
        kind: 'new-mail',
        level: 'info', // 邮件只进窗口，不叫醒 —— 维护者 定的
        dedupeKey: `mail:${box.address}:${row.uid}`,
        summary: `${from.name}：${subject}`,
        payload: {
          uid: row.uid,
          account: box.address,
          folder: 'INBOX',
          fromName: from.name,
          fromAddress: from.address,
          subject,
          date: date !== null && !Number.isNaN(date.getTime()) ? date.toISOString() : dateRaw,
        },
      });
    }

    return { events, watermark: newest, exists, scanned: take.length };
  } catch (e) {
    return { events: [], error: String(e?.message ?? e) };
  } finally {
    sess.close();
  }
}

// ─────────────────────────── 采集器本体 ───────────────────────────

/**
 * 造邮件采集器。
 *
 * config（sources.mail）：
 *   {
 *     "enabled": true,
 *     "intervalSec": 600,
 *     "boxes": [
 *       { "address": "xxx@qq.com",  "credential": "relay-qq-mail" },
 *       { "address": "xxx@163.com", "credential": "relay-163-mail" }
 *     ]
 *   }
 *
 * 【readCredential 从哪来】
 *   由 index.js 注入（env.readCredential）。
 *   插件不能 spawn，所以读 Windows 凭据管理器的方式要先在启动时探一次，
 *   探不到就退化为「读环境变量」—— 这是 index.js 那边决定的，本文件只管调用。
 */
export function createMailCollector(cfg = {}) {
  const conf = { ...DEFAULTS, ...cfg };
  const boxes = Array.isArray(conf.boxes) ? conf.boxes : [];
  // 每个账号的水位和上次状态
  const state = new Map();

  return {
    name: 'mail',
    version: '1.0.0',
    contract: 1,
    trigger: { kind: 'interval', everySec: conf.intervalSec },

    async setup(env) {
      env?.log?.('info', 'mail collector started', { boxes: boxes.map((b) => b.address) });
    },

    async run(env) {
      if (boxes.length === 0) return [];
      if (typeof env?.readCredential !== 'function') {
        return [{
          source: 'mail',
          kind: 'collector-error',
          level: 'warn',
          dedupeKey: 'mail:no-credential-reader',
          summary: '邮件采集器拿不到凭据读取器',
          payload: { reason: 'env.readCredential missing' },
        }];
      }

      const now = env?.now ?? (() => new Date());
      const all = [];
      const errors = [];

      for (const box of boxes) {
        if (typeof box?.address !== 'string' || typeof box?.credential !== 'string') continue;
        const prev = state.get(box.address) ?? {};
        const r = await collectOne(box, {
          now,
          log: env?.log,
          readCredential: env.readCredential,
          lastSeenAt: prev.watermark ?? null,
          initialDays: conf.initialDays,
          lookbackDays: conf.lookbackDays,
          maxPerRun: conf.maxPerRun,
          timeoutMs: conf.timeoutMs,
        });

        if (r.error !== undefined) {
          errors.push({ address: box.address, error: r.error });
          // 连续失败才报，防抖
          const fails = (prev.fails ?? 0) + 1;
          state.set(box.address, { ...prev, fails });
          if (fails >= 3) {
            all.push({
              source: 'mail',
              kind: 'collector-error',
              level: 'warn',
              // 用固定键：同一个账号的失败只报一次（攒批会合并）
              dedupeKey: `mail:error:${box.address}`,
              summary: `邮件采集失败 ${fails} 次：${box.address}`,
              payload: { account: box.address, error: r.error, fails },
            });
          }
          continue;
        }

        state.set(box.address, { watermark: r.watermark ?? prev.watermark ?? null, fails: 0 });
        all.push(...r.events);

        // 体检记录（和系统采集器同一套约定）
        env?.recordRun?.({
          at: now().toISOString(),
          account: box.address,
          exists: r.exists,
          scanned: r.scanned,
          events: r.events.length,
        });
      }

      return all;
    },

    async teardown() {
      state.clear();
    },

    /** 测试用：看当前水位。 */
    _state: () => state,
  };
}

export default createMailCollector();
