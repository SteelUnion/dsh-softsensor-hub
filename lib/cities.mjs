// cities.mjs — 城市别名映射
//
// 维护者 2026-10-23：
//   「那个 xxx 可以在 relay 中做映射表，比如城市简写，中文英文拼音，城市代码
//     都会关联到对应的城市」
//
// 【它解决什么】
//   我（agent）或用户说「哈尔滨」「haerbin」「HRB」「harbin」，
//   relay 都得认成同一个城市。不然每次查询要猜用户写的是哪种拼法。
//
// 【为什么映射表写在代码里，不写进配置】
//   这些是**稳定的常识**，不是用户配置。放配置里等于让用户手抄一份中国城市表。
//   用户配置里只放「我要关注哪几个」，别名解析在这张表里查。
//
// 【查不到怎么办】
//   查不到别名 → 直接当城市名用（Open-Meteo 的地理编码能认中文和英文）。
//   **不硬编「必须是表里的」** —— 表是加速和纠错，不是白名单。

/**
 * 别名 → 标准名。
 *
 * 【标准名怎么定】
 *   取 Open-Meteo geocoding 返回的中文名。比如「哈尔滨」返回「哈尔滨」，
 *   「Harbin」也返回「哈尔滨」。
 *
 * 【收录原则】
 *   只收常用、明确不会有歧义的。冷门城市交给 geocoding 现查。
 *   宁可查不到慢慢查，也不要映射错 —— 报错的城市比查得慢更糟。
 */
const ALIASES = {
  // ── 直辖市 ──
  北京: ['北京', 'beijing', 'bj', 'peking', '北京city', '110000'],
  上海: ['上海', 'shanghai', 'sh', '沪', '310000'],
  天津: ['天津', 'tianjin', 'tj', '120000'],
  重庆: ['重庆', 'chongqing', 'cq', '500000'],

  // ── 东北 ──
  哈尔滨: ['哈尔滨', 'haerbin', 'harbin', 'heb', 'hrb', '冰城', '230100'],
  长春: ['长春', 'changchun', 'cc', '220100'],
  沈阳: ['沈阳', 'shenyang', 'sy', '210100'],
  大连: ['大连', 'dalian', 'dl', '210200'],
  齐齐哈尔: ['齐齐哈尔', 'qiqihaer', 'qqhe', '230200'],

  // ── 华北 ──
  石家庄: ['石家庄', 'shijiazhuang', 'sjz', '130100'],
  太原: ['太原', 'taiyuan', 'ty', '140100'],
  呼和浩特: ['呼和浩特', 'huhehaote', 'hhht', '150100'],
  唐山: ['唐山', 'tangshan', 'ts', '130200'],

  // ── 华东 ──
  南京: ['南京', 'nanjing', 'nj', '320100'],
  苏州: ['苏州', 'suzhou', 'sz', '320500'],
  无锡: ['无锡', 'wuxi', 'wx', '320200'],
  杭州: ['杭州', 'hangzhou', 'hz', '330100'],
  宁波: ['宁波', 'ningbo', 'nb', '330200'],
  温州: ['温州', 'wenzhou', 'wz', '330300'],
  合肥: ['合肥', 'hefei', 'hf', '340100'],
  福州: ['福州', 'fuzhou', 'fz', '350100'],
  厦门: ['厦门', 'xiamen', 'xm', '350200'],
  南昌: ['南昌', 'nanchang', 'nc', '360100'],
  济南: ['济南', 'jinan', 'jn', '370100'],
  青岛: ['青岛', 'qingdao', 'qd', '370200'],

  // ── 华中 ──
  郑州: ['郑州', 'zhengzhou', 'zz', '410100'],
  武汉: ['武汉', 'wuhan', 'wh', '420100'],
  长沙: ['长沙', 'changsha', 'cs', '430100'],

  // ── 华南 ──
  广州: ['广州', 'guangzhou', 'gz', '440100'],
  深圳: ['深圳', 'shenzhen', 'sz2', '440300'],
  珠海: ['珠海', 'zhuhai', 'zh', '440400'],
  东莞: ['东莞', 'dongguan', 'dg', '441900'],
  佛山: ['佛山', 'foshan', 'fs', '440600'],
  南宁: ['南宁', 'nanning', 'nn', '450100'],
  海口: ['海口', 'haikou', 'hk', '460100'],
  三亚: ['三亚', 'sanya', 'sy2', '460200'],

  // ── 西南 ──
  成都: ['成都', 'chengdu', 'cd', '510100'],
  昆明: ['昆明', 'kunming', 'km', '530100'],
  贵阳: ['贵阳', 'guiyang', 'gy', '520100'],
  拉萨: ['拉萨', 'lasa', 'lasha', 'ls', '540100'],

  // ── 西北 ──
  西安: ['西安', 'xian', "xi'an", 'xa', '610100'],
  兰州: ['兰州', 'lanzhou', 'lz', '620100'],
  西宁: ['西宁', 'xining', 'xn', '630100'],
  银川: ['银川', 'yinchuan', 'yc', '640100'],
  乌鲁木齐: ['乌鲁木齐', 'wulumuqi', 'urumqi', 'wlmq', '650100'],

  // ── 江西（维护者 当前所在地，特别收录）──
  景德镇: ['景德镇', 'jingdezhen', 'jdz', '360200', '桃花', 'taohua', '桃花镇'],
  九江: ['九江', 'jiujiang', 'jj', '360400'],
  赣州: ['赣州', 'ganzhou', 'gz2', '360700'],
};

/** 别名 → 标准名 的反向索引。构建一次，之后 O(1)。 */
const REVERSE = new Map();
for (const [std, list] of Object.entries(ALIASES)) {
  for (const a of list) {
    const k = String(a).toLowerCase().trim();
    // 后写的不覆盖先写的：标准名本身优先级最高
    if (!REVERSE.has(k)) REVERSE.set(k, std);
  }
  // 标准名自己一定有
  REVERSE.set(std.toLowerCase(), std);
}

/**
 * 把任意写法解析成标准城市名。
 *
 * @param input 用户/agent 写的任意形式
 * @returns 标准名；查不到就原样返回（trim 过）
 */
export function resolveCity(input) {
  const s = String(input ?? '').trim();
  if (s === '') return null;
  const hit = REVERSE.get(s.toLowerCase());
  if (hit !== undefined) return hit;
  // 去掉「市」后缀再试一次（「哈尔滨市」→「哈尔滨」）
  const noShi = s.replace(/市$/, '');
  if (noShi !== s) {
    const hit2 = REVERSE.get(noShi.toLowerCase());
    if (hit2 !== undefined) return hit2;
  }
  // 查不到就原样用 —— 表是加速，不是白名单
  return noShi;
}

/** 某个标准城市名有哪些别名。 */
export function aliasesOf(city) {
  const std = resolveCity(city);
  return ALIASES[std] ?? [std];
}

/** 表里所有标准城市名。 */
export function knownCities() {
  return Object.keys(ALIASES);
}

/** 模糊搜索：给一段前缀或子串，返回可能匹配的城市。 */
export function searchCities(term) {
  const t = String(term ?? '').toLowerCase().trim();
  if (t === '') return [];
  const out = [];
  for (const [std, list] of Object.entries(ALIASES)) {
    if (std.toLowerCase().includes(t) || list.some((a) => String(a).toLowerCase().includes(t))) {
      out.push(std);
    }
  }
  return out;
}

export default { resolveCity, aliasesOf, knownCities, searchCities };
