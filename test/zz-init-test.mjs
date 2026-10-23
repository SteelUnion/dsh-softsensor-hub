// zz-init-test.mjs — 引导配置（三态）测试
//
// 约定 D1：「写完测试，问一句『这个测试如果代码错了会不会红』。答不上就是白写。」
//
// 本文件每条都问过：
//   三态判据错了 → 红（全 null 不提醒 / 有 null 不提醒）
//   false 当 null   → 红（跳过项被重复提醒）
//   拒绝 null 写入  → 红（能写进去就失去了"未处理"语义）

import {
  ITEMS,
  hasPending,
  hasPendingBlocking,
  readItemStates,
  decide,
  isComplete,
  isCompleteBlocking,
  renderList,
  buildIssueEvent,
  evaluate,
} from '../lib/init.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 内存状态桩。 */
function mkState() {
  const m = new Map();
  return {
    get: (k, d) => (m.has(k) ? m.get(k) : d),
    set: (k, v) => { m.set(k, v); },
    del: (k) => m.delete(k),
    _map: m,
  };
}

/** 环境桩：默认全部"不满足"，这样三态判定不会被 probe 干扰。 */
function mkEnv(over = {}) {
  return {
    dataDir: () => 'E:\\SteelUnion\\data\\relay',
    checkDirWritable: () => ({ ok: true }),
    hintPath: () => 'C:\\Users\\x\\.dsh\\AGENTS.md',
    readHintVersion: () => ({ exists: false, version: null }),
    hintVersion: () => 1,
    locations: () => [],
    moduleList: () => [{ name: 'system', enabled: false }],
    checkLatestVersion: async () => ({ current: '0.5.0', latest: null, newer: false }),
    ...over,
  };
}

async function main() {
  // ── 1. 三态：从没配过 → 全 null ──
  {
    const s = mkState();
    const items = await readItemStates(s);
    ok('五项齐全', items.length === ITEMS.length, `实际 ${items.length}`);
    ok('全 null', items.every((it) => it.value === null));
    ok('有 null → 提醒', hasPending(items) === true);
    ok('有 null → 阻塞', hasPendingBlocking(items) === true);
    ok('不完整', (await isComplete(s)) === false);
  }

  // ── 2. 部分完成 → 仍是 null 的项要提醒 ──
  {
    const s = mkState();
    await decide(s, 'dataDir', true);
    await decide(s, 'hint', false);
    const items = await readItemStates(s);
    ok('true 保留', items.find((x) => x.key === 'dataDir').value === true);
    ok('false 保留', items.find((x) => x.key === 'hint').value === false);
    ok('其余仍 null', items.filter((x) => x.value === null).length === ITEMS.length - 2);
    ok('仍有 null → 提醒', hasPending(items) === true);
  }

  // ── 3. 全 true / false → 不提醒（"不扰民"）──
  {
    const s = mkState();
    for (const it of ITEMS) await decide(s, it.key, it.key === 'hint' ? false : true);
    const items = await readItemStates(s);
    ok('全定案 → 不提醒', hasPending(items) === false);
    ok('全定案 → 不阻塞', hasPendingBlocking(items) === false);
    ok('全定案 → complete', (await isComplete(s)) === true);
    ok('全定案 → completeBlocking', (await isCompleteBlocking(s)) === true);
  }

  // ── 4. 只差不阻塞项（version）→ 不阻塞、但仍算未完成 ──
  {
    const s = mkState();
    for (const it of ITEMS) {
      if (it.key === 'version') continue;   // 留 null
      await decide(s, it.key, true);
    }
    const items = await readItemStates(s);
    ok('version 留 null', items.find((x) => x.key === 'version').value === null);
    ok('不阻塞项未定 → 不阻塞', hasPendingBlocking(items) === false);
    ok('但整体仍未完成', hasPending(items) === true);
    ok('isComplete=false', (await isComplete(s)) === false);
    ok('isCompleteBlocking=true', (await isCompleteBlocking(s)) === true);
  }

  // ── 5. 拒绝写 null（三态语义不能被破坏）──
  {
    const s = mkState();
    let threw = false;
    try {
      await decide(s, 'dataDir', null);
    } catch {
      threw = true;
    }
    ok('拒绝写入 null', threw);
    ok('拒绝后仍是 null', s.get('init:dataDir', null) === null);
  }

  // ── 6. 拒绝未知项 ──
  {
    const s = mkState();
    let threw = false;
    try {
      await decide(s, 'nonexistent', true);
    } catch {
      threw = true;
    }
    ok('拒绝未知项', threw);
  }

  // ── 7. 坏数据（存了字符串）当 null 处理 —— 提醒总比静默强 ──
  {
    const s = mkState();
    s.set('init:dataDir', 'garbage');
    const items = await readItemStates(s);
    ok('坏值当 null', items.find((x) => x.key === 'dataDir').value === null);
    ok('坏值 → 仍提醒', hasPending(items) === true);
  }

  // ── 8. renderList 三项标记各出现 + 阻塞/可选分开 ──
  {
    const s = mkState();
    await decide(s, 'dataDir', true);
    await decide(s, 'hint', false);
    const items = await readItemStates(s);
    const text = renderList(items);
    ok('有 ✅ 标记', text.includes('✅'));
    ok('有 ⏭ 标记', text.includes('⏭'));
    ok('有 ⬜ 标记', text.includes('⬜'));
    // 【2026-10-23】标题改成「必填 N/M」—— 分母只数阻塞项。
    // 位置/版本是可选项，不该算进「还有几项待配」。
    ok('有必填进度', /必填 \d+\/\d+/.test(text), text.split('\n')[0]);
    ok('可选项单独成段', text.includes('可选'), text);
    // 三条必填（dataDir / hint / modules）都在标题段里
    const blockingCount = items.filter((it) => it.blocking !== false).length;
    ok('必填项数 = 3', blockingCount === 3, String(blockingCount));
    ok('可选段含位置', text.includes('位置'), text);
    ok('可选段含版本', text.includes('插件版本'), text);
  }

  // ── 9. 事件：阻塞项未定 ──
  //
  // 【2026-10-23 改期望】维护者 定：配置未完成默认静默，只有"真卡住"才叫醒。
  //   buildIssueEvent 现在对未传 level 的情况一律给 info，
  //   是否升级成 critical 由 evaluate() 按「探测是否失败」决定（见用例 11b）。
  {
    const s = mkState();
    const items = await readItemStates(s);
    const evt = buildIssueEvent(items);
    ok('有 pending 时默认 level=info（不叫醒）', evt.level === 'info', evt.level);
    ok('summary 含"待配置"', evt.summary.includes('待配置'), evt.summary);
    ok('payload 带 items', Array.isArray(evt.payload.items) && evt.payload.items.length === ITEMS.length);
    ok('dedupeKey 稳定', typeof evt.dedupeKey === 'string' && evt.dedupeKey.startsWith('relay-init:'));
  }

  // ── 10. 事件：只剩不阻塞项 → info（不叫醒）──
  {
    const s = mkState();
    for (const it of ITEMS) {
      if (it.key === 'version') continue;
      await decide(s, it.key, true);
    }
    const items = await readItemStates(s);
    const evt = buildIssueEvent(items);
    ok('只剩不阻塞项 → info', evt.level === 'info', evt.level);
  }

  // ── 11. evaluate：全新安装，探测有失败项 → 叫醒 ──
  //
  //   【2026-10-23 定案】叫醒的判据是「探测失败」，不是「填没填完」。
  //   全新机器上 hint 文件不存在、模块全关 —— 这确实算"还没配好"，
  //   该叫人；而只是位置/版本没选（探测通过）时保持静默。
  //   下面用例 11a 验证静默的那一半，11b 验证叫醒的那一半。
  {
    const s = mkState();
    const r = await evaluate(s, mkEnv());
    ok('evaluate 有未定项', r.items.some((x) => x.value === null));
    ok('evaluate 产事件', r.event !== null);
    ok('探测失败项存在 → 叫醒（critical）', r.event?.level === 'critical', r.event?.level);
  }

  // ── 11a. 探测都通过、只剩偏好项没选 → 不叫醒 ──
  {
    const s = mkState();
    const env = mkEnv({
      findHintFiles: () => [{ path: 'C:\\x\\AGENTS.md', layer: 'global', version: 1 }],
      moduleList: () => [{ name: 'system', enabled: true }],
    });
    const r = await evaluate(s, env);
    ok('探测全通过 → 不叫醒（info）', r.event?.level === 'info', r.event?.level);
    ok('三项已自动定案', Array.isArray(r.settled) && r.settled.length >= 1, JSON.stringify(r.settled));
  }

  // ── 12. evaluate：全定案 → complete=true + 无事件 ──
  {
    const s = mkState();
    for (const it of ITEMS) await decide(s, it.key, true);
    const r = await evaluate(s, mkEnv());
    ok('evaluate 完成', r.complete === true);
    ok('evaluate 不产事件', r.event === null);
  }

  // ── 11b. evaluate：真卡住（探测失败）→ critical 叫醒 ──
  //
  //   【2026-10-23 新增】这是方案 A 的关键：
  //     能自证的项被 settle() 收掉后，如果剩下的阻塞项是"探测失败"（目录不在、
  //     文件不存在），那就是真配坏了，必须叫醒；只在"人的选择"没做时静默。
  {
    const s = mkState();
    const env = mkEnv({
      // dataDir 不可写 → 探测失败 → 真卡住
      checkDirWritable: () => ({ ok: false, reason: '目录不存在' }),
    });
    const r = await evaluate(s, env);
    const dd = r.items.find((x) => x.key === 'dataDir');
    ok('探测失败的阻塞项仍是 null', dd?.value === null, JSON.stringify(dd?.value));
    ok('探测失败 → 事件 critical', r.event?.level === 'critical', r.event?.level);
  }

  // ── 13. probe 异常不炸，记为 detail ──
  {
    const s = mkState();
    const env = mkEnv({
      locations: () => { throw new Error('boom'); },
    });
    let threw = false;
    let r = null;
    try {
      r = await evaluate(s, env);
    } catch {
      threw = true;
    }
    ok('probe 抛错不崩', threw === false);
    const loc = r?.items.find((x) => x.key === 'location');
    ok('记下探测失败', typeof loc?.detail === 'string' && loc.detail.includes('探测失败'), loc?.detail);
  }

  // ── 14. settle：能自证的项自动定案，涉及偏好的项不动 ──
  //
  //   【2026-10-23 改】原来是"probe ok 但 value 仍 null"——那时没有 settle()。
  //   维护者 指出：探测成功却永远挂 null，用户不知道要不要点。
  //   现在 autoSettle 的三项（dataDir / hint / modules）探测通过就自动 true；
  //   location / version 属人的选择，仍是 null。
  {
    const s = mkState();
    const env = mkEnv();   // dataDir 可写 → probe ok
    const items = await evaluate(s, env);
    const dd = items.items.find((x) => x.key === 'dataDir');
    ok('探测通过 → 自动定案为 true', dd.value === true, `value=${JSON.stringify(dd.value)}`);
    ok('probe ok 记录 alreadyOk', dd.alreadyOk === true);
    ok('autosettle 项被收掉', Array.isArray(items.settled) && items.settled.includes('dataDir'), JSON.stringify(items.settled));
    const loc = items.items.find((x) => x.key === 'location');
    ok('偏好项不被自动定案', loc.value === null, `value=${JSON.stringify(loc.value)}`);
  }

  // ── 15. 事件必须带 id ──
  //
  //   【2026-10-23 真炸过】
  //     buildIssueEvent 原先没给 id。存储 key 就是 evt.id，于是写成字面量 'undefined'。
  //     storageDomain 打开时校验每条已存记录 —— 那条坏记录让整个域打不开，
  //     连带 state 全部退回文件后端。
  //     实测日志：stored record 'undefined' in table 'events' does not match its schema
  {
    const s = mkState();
    const items = await readItemStates(s);
    const evt = buildIssueEvent(items);
    ok('★ 事件有 id', typeof evt.id === 'string' && evt.id !== '', JSON.stringify(evt.id));
    ok('★ id 不是字符串 undefined', evt.id !== 'undefined', JSON.stringify(evt.id));
    // 【写成 typeof 判断，不要直接 .includes】—— 缺 id 时 evt.id 是 undefined，
    // 直接调方法会让整个测试文件崩掉，前面几条断言的结果都看不到了。
    // 测试本身也要经得起被测代码坏掉。
    ok('id 带源前缀', typeof evt.id === 'string' && evt.id.includes('relay-init'), String(evt.id));

    // 每次产出不同的 id（不能撞车，否则第二条被幂等丢弃）
    const evt2 = buildIssueEvent(items);
    ok('两次产出 id 不同', evt.id !== evt2.id, `${evt.id} vs ${evt2.id}`);

    // evaluate 走的也是同一条路
    const r = await evaluate(s, mkEnv());
    ok('★ evaluate 的事件也有 id', typeof r.event?.id === 'string' && r.event.id !== '', String(r.event?.id));
  }

  // ── 汇总 ──
  //
  // 【格式必须与 zz-all.mjs 的正则对齐】
  //   zz-all 用 /\((?:(\d+) passed)?,\s*(\d+) failed\)/ 抓统计行。
  //   我第一版只打了中文「N 项通过」，结果 zz-all 显示 0 / 0 ——
  //   测试跑了，但总数统计不到，等于没测。
  //   照 zz-finance-test.mjs 的格式来。
  if (fail > 0) {
    console.log('');
    for (const f of failures) console.log(`    ✗ ${f}`);
  }
  console.log(`\n===== ${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} (${pass} passed, ${fail} failed) =====`);
  if (fail > 0) process.exitCode = 1;
  return { pass, fail };
}

const result = await main();
export default result;
