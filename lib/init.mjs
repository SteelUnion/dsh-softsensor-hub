// init.mjs — relay 引导配置（向导）
//
// 维护者 2026-10-23 定：
//   「如果没走过配置流程，每一项都应该是 null，如果列表里有 null，
//     就触发条件提醒，如果都是 true 或者 false，那就不提醒了。」
//
// 【三态，这是本文件的核心】
//   null  = 还没处理（从没配过 / 配到一半 / 保存失败 → 都要提醒）
//   true  = 用户做了，做成了
//   false = 用户明确**跳过**了（"我不想要这个"）
//
//   所以提醒条件只有一个：**还有 null**。
//   全 true / 全 false / 混合 → 都不提醒。这就是"不扰民"。
//
// 【为什么要区分 null 和 false】
//   false 是用户的决定，不是我忘了。把"用户不要"当成"还没做"，
//   就会天天问同一个问题 —— 那才是最扰民的。
//
// 【配置中断怎么办】
//   每完成一项就立刻写 state（`init:<项>` = true/false）。
//   中断了，那几项留着 null，下次启动照样提醒，**而且从断点继续**，
//   已经定过的不重问。
//
// 【怎么叫人】
//   产一条 issue 事件，交给 relay 现成的 trySteer 链路：
//   idle → followup（开新轮次）；busy → steer（插下一步）。
//   这条链路 index.js 里已经有了，本文件不自己实现唤醒。

import { STATE_PREFIX, TABLES } from './butler-spec.mjs';
import { newEventId } from './event.mjs';

/**
 * 把长路径缩短给人看。
 *
 * 只用于 detail 显示 —— 完整路径会写进 payload，要的时候能查到。
 */
function shortPath(p) {
  const s = String(p ?? '');
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  if (home !== '' && s.startsWith(home)) return `~${s.slice(home.length)}`;
  return s;
}

/** 五项。顺序 = 呈现顺序 = 处理顺序。 */
export const ITEMS = [
  {
    key: 'dataDir',
    title: '数据目录',
    hint: 'relay 的 inbox / peers / 事件库放哪。默认已由 profile 的 root 指定。',
    /** 能自证：目录存在且可访问就够了，不需要人来点头。 */
    autoSettle: true,
    /** 检查现有条件是否已经满足；满足就不必问。 */
    async probe(env) {
      const dir = env.dataDir();
      if (typeof dir !== 'string' || dir === '') {
        return { ok: false, detail: '未配置 root' };
      }
      const r = env.checkDirWritable(dir);
      return r.ok ? { ok: true, detail: dir } : { ok: false, detail: r.reason };
    },
  },
  {
    key: 'hint',
    title: '提示语',
    hint:
      '按 agent 实际加载顺序找 AGENTS.md（$DSH_HOME → ~/.agents → 项目链），' +
      '看有没有 relay-hint。三层都是你的文件，我不擅自改 —— 缺了会问你。',
    /** 能自证：hint 已在且版本够，就是配好了。文件是用户的，我们只读判断。 */
    autoSettle: true,
    /**
     * 探测顺序 = `dsh-agent-instructions` 的真实加载顺序（手册原文）：
     *   ① $DSH_HOME/AGENTS.md            用户全局
     *   ② <agentsHome>/AGENTS.md         共享
     *   ③ 项目根 → 会话 cwd 的每个目录    项目链（从宽泛到具体）
     *
     * 【为什么不直接猜 $DSH_HOME】（2026-10-23 维护者 纠正）
     *   我第一版只查第 ① 个路径，于是报「找不到 AGENTS.md」——
     *   而实际上 维护者 给的两份都在第 ③ 层（工作区）。
     *   教训：不要猜「默认地址」，要照 agent 实际的读取链找。
     *
     * 【判据分成两问，不要混】
     *   A. 有没有文件？        → 三层都没有 = 该问「要不要建」
     *   B. 文件里有没有 hint？ → 有文件没 hint = 该问「要不要加一行」
     *   混成一个判断，就会对着已有文件提「建个新的」。
     */
    async probe(env) {
      const found = env.findHintFiles();
      if (!Array.isArray(found) || found.length === 0) {
        return { ok: false, detail: '三层都没有 AGENTS.md', noFile: true };
      }
      const need = env.hintVersion();
      // 找第一个带 hint 且版本够的
      const withHint = found.filter((f) => f.version !== null);
      if (withHint.length === 0) {
        return {
          ok: false,
          detail: `${found.length} 个 AGENTS.md 里都没有 relay 提示`,
          noHint: true,
          files: found,
        };
      }
      const newest = withHint.reduce((a, b) => (b.version > a.version ? b : a));
      if (newest.version < need) {
        return {
          ok: false,
          detail: `${newest.path} 是旧版本 v${newest.version}，当前要 v${need}`,
          outdated: true,
          files: found,
        };
      }
      return { ok: true, detail: `v${newest.version} @ ${shortPath(newest.path)}`, files: found };
    },
  },
  {
    key: 'location',
    title: '位置',
    // 【不阻塞】（维护者 2026-10-23）
    //   「位置根本不是问题啊，默认用地址，默认地址可以切换，列表可添加」
    //   有默认值（IP 定位）就不该卡人。真正定位成功/失败由 weather 采集器产事件说。
    blocking: false,
    hint: '天气默认城市。没设过就自动用 IP 定位，定下来后不会被 IP 变化覆盖。要改说一声。',
    async probe(env) {
      const locs = env.locations();
      if (Array.isArray(locs) && locs.length > 0) {
        const names = locs.map((l) => (typeof l === 'string' ? l : l.name) ?? l);
        const primary = typeof locs[0] === 'object' && locs[0] !== null ? locs[0].name : locs[0];
        return { ok: true, detail: names.join(', '), primary };
      }
      // 没设过 → 不阻塞，可以用默认值
      return { ok: true, detail: '未指定，将用 IP 定位', usesDefault: true };
    },
  },
  {
    key: 'modules',
    title: '模块开关',
    hint: '要启用哪些采集器：system / mail / finance / weather。',
    /** 能自证：配方里已经有模块开着，就说明用户做过选择。 */
    autoSettle: true,
    async probe(env) {
      const list = env.moduleList();
      if (!Array.isArray(list) || list.length === 0) {
        return { ok: false, detail: '没有可用模块' };
      }
      const on = list.filter((m) => m.enabled === true).map((m) => m.name);
      // 有任何一个开着就算这项处理过 —— 用户已经做过选择
      if (on.length > 0) return { ok: true, detail: on.join(', ') };
      return { ok: false, detail: '全部关闭' };
    },
  },
  {
    key: 'version',
    title: '插件版本',
    // 不阻塞：查不到更新是正常的（断网、限流）
    blocking: false,
    hint: '每天第一次启动时查一次 GitHub，看有没有新版。',
    async probe(env) {
      const r = await env.checkLatestVersion();
      if (r === null || r.error !== undefined) {
        // 查不到 = 不算未完成。这项永远不该把用户卡住。
        return { ok: true, detail: r?.error !== undefined ? `跳过（${r.error}）` : '跳过' };
      }
      if (r.latest === null) return { ok: true, detail: '未启用检查' };
      if (r.newer) return { ok: false, detail: `有新版 ${r.latest}（当前 ${r.current}）` };
      return { ok: true, detail: `已是最新 ${r.current}` };
    },
  },
];

/** 提醒条件：还有 null 就算没配完。 */
export function hasPending(items) {
  return items.some((it) => it.value === null);
}

/** 提醒条件（只看阻塞项）：还有 blocking 项的值为 null。 */
export function hasPendingBlocking(items) {
  return items.some((it) => it.value === null && it.blocking !== false);
}

/**
 * 读当前五项的状态。
 *
 * @param state 形如 { get(k, d), set(k, v) } 的状态接口
 * @returns {Promise<{key,title,hint,blocking,value,detail}[]>}
 */
export async function readItemStates(state) {
  const out = [];
  for (const item of ITEMS) {
    const raw = state.get(`${STATE_PREFIX.INIT}${item.key}`, null);
    // 只认三态。别的值（坏数据）一律当 null 处理 —— 提醒总比静默强。
    const value = raw === true ? true : raw === false ? false : null;
    out.push({
      key: item.key,
      title: item.title,
      hint: item.hint,
      blocking: item.blocking !== false,
      value,
      detail: null,
    });
  }
  return out;
}

/**
 * 自动定案：探测通过的**阻塞项**直接打 true。
 *
 * 【为什么需要它】（维护者 2026-10-23）
 *   实测发现「插件版本」一直是 null —— 因为探测成功不等于定案：
 *   probe() 只写 detail，value 仍要人调 decide()。
 *   于是明明已经就绪的项，清单上永远挂着「待设置」，用户也不知道该不该点。
 *
 * 【规则：只自动收**能自证的**项】
 *   探测结论是客观事实的（目录可写、模块开着）→ 自动 true。
 *   涉及用户偏好的（位置、要不要装新版）→ 不自动，留给人。
 *   这里用 spec.autoSettle === true 显式声明，不靠猜。
 *
 * 【幂等】
 *   已经 true/false 的不动；只处理 null。
 *   所以每次启动跑一遍是安全的，不会覆盖用户的 false。
 *
 * @returns 本次被自动定案的 key 列表
 */
export async function settle(state, env) {
  const items = await probeAll(state, env);
  const settled = [];
  for (const it of items) {
    if (it.value !== null) continue;
    const spec = ITEMS.find((x) => x.key === it.key);
    if (spec?.autoSettle !== true) continue;
    if (it.alreadyOk !== true) continue;
    await decide(state, it.key, true, `自动定案：${it.detail ?? ''}`);
    settled.push(it.key);
  }
  return settled;
}

/**
 * 跑一遍探测，刷新每项的 detail 和建议值。
 *
 * 探测不改变 value —— value 只由用户决定。
 * 探测的意义是：给你看"现在是什么情况"，帮你决定选 true 还是 false。
 *
 * @param state 状态接口
 * @param env   环境能力（由 index.js 注入）
 */
export async function probeAll(state, env) {
  const items = await readItemStates(state);
  for (const item of items) {
    const spec = ITEMS.find((x) => x.key === item.key);
    if (spec === undefined) continue;
    try {
      const r = await spec.probe(env);
      item.detail = r.detail ?? null;
      item.alreadyOk = r.ok === true;
    } catch (e) {
      item.detail = `探测失败：${String(e?.message ?? e)}`;
      item.alreadyOk = false;
    }
  }
  return items;
}

/**
 * 用户对某一项做出选择。
 *
 * @param state 状态接口
 * @param key   项名
 * @param value true（做了）/ false（跳过）
 * @param reason 可选，记下来备查
 */
export async function decide(state, key, value, reason = null) {
  if (!ITEMS.some((x) => x.key === key)) throw new Error(`未知的初始化项：${key}`);
  if (value !== true && value !== false) {
    // 只允许两个终态。null 只能由"从没写过"自然产生，不能被显式写入。
    throw new Error(`初始化项 ${key} 只能设为 true 或 false，收到 ${JSON.stringify(value)}`);
  }
  state.set(`${STATE_PREFIX.INIT}${key}`, value);
  if (reason !== null) state.set(`${STATE_PREFIX.INIT}${key}:reason`, String(reason));
  return { ok: true, key, value };
}

/** 全部项是否都已定案（没有 null）。 */
export async function isComplete(state) {
  const items = await readItemStates(state);
  return !hasPending(items);
}

/** 阻塞项是否都已定案。不阻塞项不参与判定。 */
export async function isCompleteBlocking(state) {
  const items = await readItemStates(state);
  return !hasPendingBlocking(items);
}

/**
 * 「配置完成」标记 —— 用于**只触发一次**的收尾动作。
 *
 * 【为什么不能只看 isComplete】
 *   五项都不是 null，只能说"现在配完了"。可每次启动都会再判断一遍，
 *   如果直接拿它当触发条件，收尾动作（比如抓一天数据）每次启动都会重跑。
 *
 * 【标记怎么用】
 *   const first = !state.get(INIT_COMPLETE, false);
 *   ...做完收尾动作...
 *   state.set(INIT_COMPLETE, true);
 *   崩溃在中间？标记没写，下次启动会再来一次 —— 收尾动作必须幂等。
 */
export const INIT_COMPLETE = `${STATE_PREFIX.INIT}complete`;

/** 全部定案且从未标记过完成 → true（即"该跑收尾动作了"）。 */
export async function shouldFireComplete(state) {
  const items = await readItemStates(state);
  if (hasPending(items)) return false;
  return state.get(INIT_COMPLETE, false) !== true;
}

/** 标记收尾动作已执行。 */
export function markComplete(state, detail = null) {
  state.set(INIT_COMPLETE, true);
  if (detail !== null) state.set(`${INIT_COMPLETE}:at`, new Date().toISOString());
}

/**
 * 渲染成一段给人看的清单。
 *
 * 一次展示全部，逐项设置 —— 维护者 2026-10-23 要的 A+B。
 *
 * 【阻塞项与可选项分开列】（2026-10-23 修）
 *   位置、版本检查不阻塞 —— 它们有合理默认值（IP 定位 / 查不到就跳过）。
 *   混在一起报「还有 5 项」会让人误以为全都要配。
 */
export function renderList(items) {
  const blocking = items.filter((it) => it.blocking !== false);
  const optional = items.filter((it) => it.blocking === false);
  const doneB = blocking.filter((it) => it.value !== null).length;
  const lines = [`relay 初始化（必填 ${doneB}/${blocking.length}）`];

  const row = (it) => {
    const mark = it.value === true ? '✅' : it.value === false ? '⏭ ' : '⬜';
    const tail = it.value === null
      ? (it.alreadyOk === true ? `检测到已就绪：${it.detail ?? ''}` : `待设置 ${it.detail ? `（${it.detail}）` : ''}`)
      : (it.detail ? `（${it.detail}）` : '');
    return { mark, text: `  ${mark} ${it.title}${tail}` };
  };

  for (const it of blocking) lines.push(row(it).text);
  if (optional.length > 0) {
    const doneO = optional.filter((it) => it.value !== null).length;
    lines.push('');
    lines.push(`  ── 可选（${doneO}/${optional.length}，不配也能跑）──`);
    for (const it of optional) lines.push(row(it).text);
  }

  const pendingB = blocking.filter((it) => it.value === null);
  const pendingO = optional.filter((it) => it.value === null);
  if (pendingB.length > 0) {
    lines.push('');
    lines.push(`必填还差 ${pendingB.length} 项：${pendingB.map((p) => p.title).join('、')}`);
  } else if (pendingO.length > 0) {
    lines.push('');
    lines.push(`必填已全，剩下 ${pendingO.length} 项可选：${pendingO.map((p) => p.title).join('、')}`);
  }
  return lines.join('\n');
}

/**
 * 造一条 issue 事件 —— 交给 relay 的投递链路。
 *
 * 【为什么走事件，不直接叫醒】
 *   init 跑在插件 apply() 里，那时还没有会话、没有 agent。
 *   直接调 followup 拿不到 agent（手册 §2.1：定时器里没有 agent）。
 *   所以只产事件，由 relay 现有的 trySteer / inject 链路决定怎么送。
 *
 * @param items  probeAll 的结果
 * @param opts   { level }
 */
export function buildIssueEvent(items, opts = {}) {
  const pending = items.filter((it) => it.value === null);
  const blocking = pending.filter((it) => it.blocking !== false);
  const optional = pending.filter((it) => it.blocking === false);

  // 【摘要只数阻塞项】（2026-10-23 修）
  //   之前用 pending.length，把位置/版本也算进去，于是明明位置已不阻塞，
  //   摘要还是「还有 5 项」。维护者 看到就以为全都没配。
  //   摘要只报**真正卡住流程**的那几项；可选项另起一句带过。
  const head = blocking.length > 0
    ? `relay 待配置：还有 ${blocking.length} 项（${blocking.map((p) => p.title).join('、')}）`
    : `relay 可选配置：${optional.length} 项（${optional.map((p) => p.title).join('、')}）`;
  const tail = blocking.length > 0 && optional.length > 0
    ? `；另有 ${optional.length} 项可选`
    : '';

  return {
    // 【id 必须有】（2026-10-23 踩过）
    //   事件库的存储 key 就是 evt.id。没有 id 时 key 会写成字面量 'undefined'，
    //   而 storageDomain 打开时会校验每一条已存记录 —— 那条坏记录让整个域打不开，
    //   连带 state 全退回文件后端。
    //   event.mjs 的 validateEvent() 会自动补 id，但 routeEvent() 是直接入库、
    //   不走校验，所以这里必须自己给。
    id: newEventId('relay-init'),
    source: 'relay-init',
    kind: 'init-pending',
    // 【2026-10-23 方案 A】默认 info —— 配置没填完不该叫醒人。
    //   只有调用方明确判定了「真卡住」（探测失败）才传 critical 上来。
    //   判定在 evaluate()：stuck = nullptr 且 blocking 且 alreadyOk !== true。
    level: opts.level ?? 'info',
    // 同一天同一批只报一次：骨架里不含时间，天然去重
    dedupeKey: `relay-init:${pending.map((p) => p.key).sort().join(',')}`,
    summary: `${head}${tail}`,
    payload: {
      blockingCount: blocking.length,
      optionalCount: optional.length,
      items: items.map((it) => ({
        key: it.key,
        title: it.title,
        value: it.value,
        blocking: it.blocking,
        detail: it.detail,
      })),
      rendered: renderList(items),
    },
  };
}

/**
 * 一次性跑完：自动定案 → 读状态 → 探测 → 决定要不要产事件。
 *
 * 【2026-10-23 改：加了 settle】
 *   以前它"不改 state"，于是探测通过的项永远停在 null（同 settle() 的注释）。
 *   现在它会先自动收掉能自证的项，再判断还有没有剩下的。
 *   依旧幂等：全 true/false 时 settle 什么都不做。
 *
 * @returns {{ complete: boolean, items, event: object|null, settled: string[] }}
 */
export async function evaluate(state, env) {
  const settled = await settle(state, env);
  const items = await probeAll(state, env);
  const pendingBlocking = hasPendingBlocking(items);
  const pendingAny = hasPending(items);

  // 【叫醒与否，看的是"卡住没卡住"，不是"填没填完"】（2026-10-23 方案 A）
  //
  //   已经能自证的项在 settle() 里自动变 true，剩下的 null 分两种：
  //     ① 探测**失败**（目录不存在、文件不在）→ 真的卡住了 → critical，该叫醒
  //     ② 探测通过但没定案（位置、版本这类人的选择）→ 不卡 → info，别打扰
  //
  //   如果一律按 critical，用户每次启动都被问一遍；
  //   如果一律 info，"真的配坏了"就再也没人知道 —— 两个极端都不对。
  const stuck = items.filter((it) => it.value === null && it.blocking !== false && it.alreadyOk !== true);

  if (pendingBlocking) {
    return {
      complete: false,
      settled,
      items,
      event: buildIssueEvent(items, { level: stuck.length > 0 ? 'critical' : 'info' }),
    };
  }
  // 阻塞项都定了，只剩不阻塞项（比如版本）→ 也只是 info，不动采集器
  if (pendingAny) {
    return { complete: true, settled, items, event: buildIssueEvent(items, { level: 'info' }) };
  }
  return { complete: true, settled, items, event: null };
}

export default {
  ITEMS,
  hasPending,
  hasPendingBlocking,
  readItemStates,
  probeAll,
  settle,
  decide,
  isComplete,
  isCompleteBlocking,
  shouldFireComplete,
  markComplete,
  INIT_COMPLETE,
  renderList,
  buildIssueEvent,
  evaluate,
  TABLES,
};
