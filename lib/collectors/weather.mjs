// collectors/weather.mjs — 天气采集器
//
// 契约：lib/collector.mjs（CONTRACT_VERSION = 1）
// 历史：lib/butler-spec.mjs 的 weather 表（key = `<城市>/<YYYY-MM-DD>`）
//
// 【数据源：Open-Meteo】
//   维护者 2026-10-22 选型。理由（实测）：
//     - 免密钥、免注册、免绑卡
//     - 非商用每天 1 万次，我们一天最多 4 次
//     - 数据含 CMA（中国气象局）等 30+ 政府模型
//     - 纯 HTTP GET，返回 JSON
//   微软 Azure Maps 是转售 AccuWeather，要 Azure 订阅密钥，且必须传经纬度。
//   两者对我们都不缺精度，差的是"要不要管一把密钥"。
//
// 【刷新规则】维护者 2026-10-23 定
//   「一天只刷新两次，第一次是启动时，若无当日数据则获取一次。
//     第二次是六小时后。」
//   实现上不按"整点"，按**距上次取数的时间差**：
//     now - lastFetchAt >= refreshHours  → 取数
//   这样两个场景自动统一：
//     一直开机：15 分钟 tick 一次，到 6 小时自然触发
//     关机重开：启动时算出来早就超了，立刻补取
//
// 【保留 10 天】
//   取到新数据后，删掉 10 天前的记录。按日期 key，删起来是逐个 key 删。
//
// 【骤升骤降】
//   维护者 原话：「大幅升降温都报一下」。
//   判据用"今天最低 vs 昨天最高"（体感落差最大），"今天最高 vs 昨天最低"（升温）。
//
// 【位置】
//   维护者 原话：「位置默认自动从本地获取，可选，可添加，有一个列表」
//   「如果定位失败用北京……要求设定默认地理位置」
//   「用户设置后，不再主动更新默认地址」
//   所以：config 有 locations → 用 config（用户的决定最高优先）；
//        没有 → IP 定位；IP 也失败 → 北京兜底 + 产 issue 问用户。
//
// 【硬边界】不 spawn / exec。只用 fetch（Node 18+ 内置）。

import { weatherKey } from '../butler-spec.mjs';

/** 默认值。都可由 config 的 sources.weather 覆盖。 */
export const DEFAULTS = {
  /** 定时器多久自检一次。真正的"6 小时取一次"靠时间戳判断，不靠这个。 */
  intervalSec: 900,
  /** 距上次成功取数多少小时才再取。 */
  refreshHours: 6,
  /** 保留几天历史。 */
  keepDays: 10,
  /** 城市列表。空 = 走 IP 定位。 */
  locations: [],
  /** IP 定位失败时的兜底城市。 */
  fallbackCity: '北京',
  /** 是否允许 IP 定位。 */
  geoIp: true,
  /** 骤降/骤升阈值（摄氏度，按绝对值）。 */
  thresholds: {
    warnC: 5,
    criticalC: 8,
  },
  /** 日常天气报告的级别。downgrade 到 info 就只留档。 */
  dailyLevel: 'info',
  /** 连续几次取数失败才报（C3 约定：失败连续 3 次才报）。 */
  failThreshold: 3,
  /** 单次 HTTP 超时。 */
  timeoutMs: 10_000,
};

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const IP_URL = 'http://ip-api.com/json/?fields=status,city,lat,lon,country,regionName';

// ─────────────────────────── 小工具 ───────────────────────────

/** 本地日期 YYYY-MM-DD。不用 toISOString（那是 UTC，晚上 8 点后会差一天）。 */
export function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 把城市列表归一成 [{name, lat?, lon?}]。接受字符串或对象。 */
export function parseLocations(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const item of input) {
    if (typeof item === 'string') {
      const name = item.trim();
      if (name !== '') out.push({ name, lat: null, lon: null, primary: out.length === 0 });
      continue;
    }
    if (item !== null && typeof item === 'object') {
      const name = String(item.name ?? '').trim();
      if (name === '') continue;
      const lat = Number(item.lat);
      const lon = Number(item.lon);
      out.push({
        name,
        lat: Number.isFinite(lat) ? lat : null,
        lon: Number.isFinite(lon) ? lon : null,
        primary: item.primary === true || out.length === 0,
      });
    }
  }
  return out;
}

/** WMO 天气代码 → 中文。只覆盖常见的那几个，其余给「未知」。 */
export function weatherCodeZh(code) {
  const map = {
    0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
    45: '雾', 48: '冻雾',
    51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨',
    56: '冻毛毛雨', 57: '强冻毛毛雨',
    61: '小雨', 63: '中雨', 65: '大雨',
    66: '冻雨', 67: '强冻雨',
    71: '小雪', 73: '中雪', 75: '大雪', 77: '米雪',
    80: '小阵雨', 81: '阵雨', 82: '强阵雨',
    85: '小阵雪', 86: '强阵雪',
    95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷阵雨伴冰雹',
  };
  return map[code] ?? `未知(${code})`;
}

/** 四舍五入到一位小数。 */
function round1(v) {
  return Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
}

/**
 * 算温差。返回 { delta, kind } 或 null。
 *
 * 【判据：同量对比】（2026-10-23 修正）
 *   降温：今天最低 − 昨天最低
 *   升温：今天最高 − 昨天最高
 *
 * 【为什么不能拿"今天最低"减"昨天最高"】
 *   那是第一次的写法，被测试抓出来了：
 *     昨天 8~13℃，今天还是 8~13℃（一度都没变）
 *     降 = 8 − 13 = −5，报出「骤降 5℃」—— 假的。
 *   5 度是**昼夜温差**，不是天气变化。
 *   同量比同量才叫"变化"：最低比最低，最高比最高。
 *
 * 【取绝对值大的那个】
 *   同一天既可能"最低降了 8 度"又"最高只降 2 度"。
 *   只报最显著的那一个，避免同一天两条骤变事件。
 *
 * @param today   { minC, maxC } 今天的预报
 * @param prevDay { minC, maxC } 前一天的记录
 */
export function computeSwing(today, prevDay) {
  if (today === null || prevDay === null) return null;
  const vals = [today.minC, today.maxC, prevDay.minC, prevDay.maxC];
  if (!vals.every((v) => Number.isFinite(v))) return null;

  const minDelta = today.minC - prevDay.minC;   // 负数 = 最低温降了
  const maxDelta = today.maxC - prevDay.maxC;   // 正数 = 最高温升了
  const pickMin = Math.abs(minDelta) >= Math.abs(maxDelta);
  const delta = pickMin ? minDelta : maxDelta;
  return { delta: Math.round(delta * 10) / 10, kind: delta < 0 ? 'drop' : 'rise' };
}

/** 差值落在哪一级。没到阈值返回 null。 */
export function gradeSwing(delta, thresholds = DEFAULTS.thresholds) {
  const abs = Math.abs(delta);
  const warn = thresholds?.warnC ?? DEFAULTS.thresholds.warnC;
  const crit = thresholds?.criticalC ?? DEFAULTS.thresholds.criticalC;
  if (abs >= crit) return 'critical';
  if (abs >= warn) return 'warn';
  return null;
}

// ─────────────────────────── HTTP ───────────────────────────

/** 带超时的 fetch。失败抛错，由调用方决定怎么降级。 */
async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'dsh-relay/weather' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 城市名 → 坐标。Open-Meteo 的地理编码，免密钥。 */
export async function geocode(city, timeoutMs = DEFAULTS.timeoutMs) {
  const url = `${GEOCODE_URL}?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`;
  const j = await fetchJson(url, timeoutMs);
  const hit = j?.results?.[0];
  if (hit === undefined) throw new Error(`找不到城市：${city}`);
  return { name: hit.name ?? city, lat: hit.latitude, lon: hit.longitude, country: hit.country ?? null };
}

/**
 * IP 定位。
 *
 * 【为什么用 ip-api.com】
 *   免密钥、一次 GET、返回 lat/lon。不需要浏览器定位 API
 *   （那个要 WinRT，等于 spawn，破 relay 硬边界）。
 *
 * 失败抛错 —— 由调用方降级到 fallbackCity。
 */
export async function locateByIp(timeoutMs = DEFAULTS.timeoutMs) {
  const j = await fetchJson(IP_URL, timeoutMs);
  if (j?.status !== 'success') throw new Error(`IP 定位失败：${j?.message ?? j?.status ?? 'unknown'}`);
  if (!Number.isFinite(j.lat) || !Number.isFinite(j.lon)) throw new Error('IP 定位返回的坐标不合法');
  return { name: j.city ?? '未知', lat: j.lat, lon: j.lon, country: j.country ?? null, region: j.regionName ?? null };
}

/**
 * 取一天的天气。
 *
 * @returns { current, daily, forecast }
 */
export async function fetchWeather(lat, lon, timeoutMs = DEFAULTS.timeoutMs) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m',
    daily: 'temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max',
    timezone: 'Asia/Shanghai',
    forecast_days: '3',
  });
  const j = await fetchJson(`${FORECAST_URL}?${params.toString()}`, timeoutMs);
  const cur = j?.current;
  const d = j?.daily;
  if (cur === undefined || d === undefined) throw new Error('Open-Meteo 返回结构不完整');
  if (!Array.isArray(d.time) || d.time.length === 0) throw new Error('Open-Meteo 没有返回任何日期');

  const days = d.time.map((date, i) => ({
    date,
    maxC: round1(d.temperature_2m_max?.[i]),
    minC: round1(d.temperature_2m_min?.[i]),
    code: d.weather_code?.[i] ?? null,
    precipProb: d.precipitation_probability_max?.[i] ?? null,
  }));

  return {
    current: {
      tempC: round1(cur.temperature_2m),
      feelsC: round1(cur.apparent_temperature),
      humidity: cur.relative_humidity_2m ?? null,
      code: cur.weather_code ?? null,
      windKmh: round1(cur.wind_speed_10m),
      at: cur.time ?? null,
    },
    daily: days[0] ?? null,
    forecast: days.slice(1),
  };
}

// ─────────────────────────── 事件构造 ───────────────────────────

/** 一条日常天气摘要。维护者 原话：「天气这些通知到 agent 后，agent 会主动告知用户」。 */
export function buildDailyEvent({ city, date, data, level = 'info', cityTag = null }) {
  const t = data.today ?? data.daily;
  if (t === null) return null;
  const cur = data.current ?? {};
  const parts = [`${city}`, weatherCodeZh(t.code)];
  if (Number.isFinite(t.minC) && Number.isFinite(t.maxC)) parts.push(`${t.minC}~${t.maxC}℃`);
  if (Number.isFinite(cur.tempC)) parts.push(`现 ${cur.tempC}℃`);
  if (Number.isFinite(t.precipProb) && t.precipProb >= 30) parts.push(`降水 ${t.precipProb}%`);

  return {
    source: 'weather',
    kind: 'daily',
    level,
    // 同城同日只报一次。带上 slot 可以让"刷新过"也算不同事件。
    dedupeKey: `weather:${cityTag ?? city}:${date}`,
    summary: parts.join(' '),
    /**
     * 【payload 只留最小字段】（维护者 2026-10-23）
     *   「每天提醒两次的时候，默认状态只提示默认地址，这是让 relay 替 agent 节省上下文。」
     *   完整数据（current/daily/forecast 全部字段）已经在 weather 表的记录里，
     *   要看详情读表 / 用 `relay.mjs weather <城市>` 查。
     *   塞进 payload 只会占 agent 的上下文，而且和表里的数据重复。
     */
    payload: {
      city,
      date,
      minC: Number.isFinite(t.minC) ? t.minC : null,
      maxC: Number.isFinite(t.maxC) ? t.maxC : null,
      weather: weatherCodeZh(t.code),
    },
  };
}

/** 一条骤升骤降告警。 */
export function buildSwingEvent({ city, date, swing, data, cityTag = null }) {
  if (swing === null) return null;
  const level = gradeSwing(swing.delta, data.thresholds);
  if (level === null) return null;

  const dir = swing.delta < 0 ? '骤降' : '骤升';
  const abs = Math.abs(swing.delta).toFixed(1);
  const t = data.today ?? data.daily;
  const range = Number.isFinite(t?.minC) && Number.isFinite(t?.maxC)
    ? `${t.minC}~${t.maxC}℃`
    : '';

  return {
    source: 'weather',
    kind: swing.delta < 0 ? 'temperature-drop' : 'temperature-rise',
    level,
    dedupeKey: `weather:${cityTag ?? city}:${date}:swing`,
    summary: `${city} ${dir} ${abs}℃${range ? `，今天 ${range}` : ''}`,
    /**
     * 【骤变事件保留对比数字】—— 这是它存在的理由，不能砍。
     *   但也不放整份 forecast：要历史去读表。
     */
    payload: {
      city,
      date,
      deltaC: swing.delta,
      direction: swing.kind,
      today: t ?? null,
      previous: data.previous ?? null,
    },
  };
}

// ─────────────────────────── 采集器本体 ───────────────────────────

/**
 * 造一个天气采集器。
 *
 * @param cfg config.json 的 sources.weather
 * @param deps 可选注入（测试用）：{ fetchWeather, geocode, locateByIp, now }
 */
export function createWeatherCollector(cfg = {}, deps = {}) {
  const conf = { ...DEFAULTS, ...cfg, thresholds: { ...DEFAULTS.thresholds, ...(cfg.thresholds ?? {}) } };
  const api = {
    fetchWeather: deps.fetchWeather ?? fetchWeather,
    geocode: deps.geocode ?? geocode,
    locateByIp: deps.locateByIp ?? locateByIp,
  };

  let failStreak = 0;
  let started = false;
  /** 解析好的位置缓存：城市名 → { name, lat, lon }。进程内缓存，省得每次重查。 */
  const resolved = new Map();
  /** 上次成功取数的时间（毫秒）。从 state 读回来的记忆值。 */
  let lastFetchAt = 0;

  /**
   * 决定用哪些位置。
   *
   * 优先级（维护者 定）：
   *   ① config 里写了 locations → 用 config（用户的决定最高）
   *   ② 没写 → IP 定位
   *   ③ IP 也失败 → fallbackCity（北京）+ 产 issue
   *
   * 一旦确定了，写进 state，**之后不再自动更新** ——
   * 「不会出现 ip 切换了，地址就马上跟着换的情况」。
   */
  async function resolveLocations(env) {
    const fromState = env.state.get(`${'weather:'}locations`, null);
    // 状态里已经定过 → 直接用（这就是"不再自动更新"）
    if (Array.isArray(fromState) && fromState.length > 0) {
      return { locations: fromState, source: 'state', notice: null };
    }

    const fromCfg = parseLocations(conf.locations);
    if (fromCfg.length > 0) {
      const out = await ensureCoords(fromCfg);
      env.state.set('weather:locations', out);
      return { locations: out, source: 'config', notice: null };
    }

    if (conf.geoIp) {
      try {
        const ip = await api.locateByIp(conf.timeoutMs);
        const out = [{ name: ip.name, lat: ip.lat, lon: ip.lon, primary: true, via: 'ip' }];
        env.state.set('weather:locations', out);
        return { locations: out, source: 'ip', notice: null };
      } catch (e) {
        // 降级：用兜底城市，但要说清楚 —— 不静默
        const out = [{ name: conf.fallbackCity, lat: null, lon: null, primary: true, via: 'fallback' }];
        const withCoords = await ensureCoords(out);
        env.state.set('weather:locations', withCoords);
        return {
          locations: withCoords,
          source: 'fallback',
          notice: `IP 定位失败（${String(e?.message ?? e)}），已用 ${conf.fallbackCity} 兜底，请在 init 里改`,
        };
      }
    }

    const out = await ensureCoords([{ name: conf.fallbackCity, lat: null, lon: null, primary: true }]);
    env.state.set('weather:locations', out);
    return { locations: out, source: 'fallback', notice: null };
  }

  /** 补坐标：config 里可能只写了城市名。 */
  async function ensureCoords(list) {
    const out = [];
    for (const loc of list) {
      if (Number.isFinite(loc.lat) && Number.isFinite(loc.lon)) {
        out.push(loc);
        continue;
      }
      if (resolved.has(loc.name)) {
        out.push({ ...loc, ...resolved.get(loc.name) });
        continue;
      }
      try {
        const g = await api.geocode(loc.name, conf.timeoutMs);
        // 【城市名以 Open-Meteo 返回的为准】
        //   用户写"哈尔滨"，返回可能是"哈尔滨市"。显示用返回的，查询用用户写的，
        //   否则 key 会因语言/别名漂移而重复。
        resolved.set(loc.name, { lat: g.lat, lon: g.lon });
        out.push({ ...loc, lat: g.lat, lon: g.lon });
      } catch {
        // 查不到坐标的城市跳过，不阻塞其他城市
      }
    }
    return out;
  }

  /** 读历史：某城市最近 keepDays 天。 */
  function readHistory(env, city) {
    const out = [];
    for (let i = 0; i < conf.keepDays + 1; i++) {
      const d = localDate(new Date(Date.now() - i * DAY_MS));
      const rec = env.state.get(`weather:day:${city}/${d}`, null);
      if (rec !== null) out.push(rec);
    }
    // 旧 → 新，方便取"前一天"
    return out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }

  /** 写一天的记录，并顺手清理超过 keepDays 的。 */
  function writeHistory(env, rec) {
    env.state.set(`weather:day:${rec.city}/${rec.date}`, rec);
    const cutoff = localDate(new Date(Date.now() - conf.keepDays * DAY_MS));
    // 清理：只清自己城市的旧记录
    for (let i = conf.keepDays + 1; i < conf.keepDays + 40; i++) {
      const d = localDate(new Date(Date.now() - i * DAY_MS));
      if (d > cutoff) continue;
      const k = `weather:day:${rec.city}/${d}`;
      if (env.state.get(k, undefined) !== undefined) env.state.del?.(k);
    }
  }

  return {
    name: 'weather',
    version: '1.0.0',
    contract: 1,
    trigger: { kind: 'interval', everySec: conf.intervalSec },

    async setup(env) {
      if (started) return;
      started = true;
      const t = env?.state?.get?.('weather:lastFetchAt', null);
      if (typeof t === 'number' && Number.isFinite(t)) lastFetchAt = t;
      env?.log?.('info', 'weather collector started', {
        refreshHours: conf.refreshHours, keepDays: conf.keepDays, lastFetchAt,
      });
    },

    async run(env) {
      const now = env?.now?.() ?? new Date();
      const nowMs = now.getTime();
      const today = localDate(now);
      const events = [];

      // ① 时间闸门：距上次成功取数不足 refreshHours，就什么都不做。
      //
      //   【这就是"一天两次"的全部实现】
      //     一直开机 → 15 分钟 tick，到 6 小时自然过闸
      //     关机重开 → 启动时 now - lastFetchAt 早就超了，立刻补取
      //   两种场景同一个判断，不需要区分"第一次"和"第二次"。
      if (lastFetchAt > 0) {
        const ageMs = nowMs - lastFetchAt;
        if (ageMs < conf.refreshHours * HOUR_MS) {
          return [];
        }
      }

      // ② 定位置（第一次会写 state，之后直接读）
      let locInfo;
      try {
        locInfo = await resolveLocations(env);
      } catch (e) {
        failStreak += 1;
        return failStreak >= conf.failThreshold ? [errorEvent(`位置解析失败：${String(e?.message ?? e)}`, now)] : [];
      }
      if (locInfo.notice !== null) {
        events.push({
          source: 'weather',
          kind: 'location-fallback',
          level: 'warn',
          dedupeKey: 'weather:location:fallback',
          summary: `天气位置待确认：${conf.fallbackCity}`,
          payload: { notice: locInfo.notice, locations: locInfo.locations },
        });
      }

      // ②.5 城市数上限（维护者 2026-10-23）
      //
      // 【为什么要有】
      //   每多一个城市就多一次 API 请求。列表写 20 个 = 一天 80 次。
      //   免费额度是一万次，够用，但要防「列表写几十个」导致刷新变慢。
      const MAX_CITIES = conf.maxCities ?? 20;
      let cities = locInfo.locations;
      let overLimit = false;
      if (cities.length > MAX_CITIES) {
        overLimit = true;
        cities = cities.slice(0, MAX_CITIES);
        events.push({
          source: 'weather',
          kind: 'too-many-cities',
          level: 'warn',
          dedupeKey: 'weather:too-many-cities',
          summary: `天气城市 ${locInfo.locations.length} 个，已只采前 ${MAX_CITIES} 个`,
          payload: { total: locInfo.locations.length, max: MAX_CITIES },
        });
      }

      // ②.6 首次定位 → 告诉用户现在用的是哪（维护者 2026-10-23）
      //
      //   「拿的到就问是不是这个地址」「默认状态只提示默认地址」
      //   这是 info：进窗口留档，不叫醒。要改说一声就行。
      const primaryName = cities[0]?.name ?? null;
      if (locInfo.source === 'ip' || locInfo.source === 'fallback') {
        const prev = env.state.get('weather:primaryName', null);
        if (prev !== primaryName) {
          env.state.set('weather:primaryName', primaryName);
          events.push({
            source: 'weather',
            kind: 'primary-location',
            level: 'info',
            dedupeKey: `weather:primary:${primaryName}`,
            summary: `天气默认位置：${primaryName}${locInfo.source === 'ip' ? '（IP 定位）' : '（兜底）'}`,
            payload: {
              primary: primaryName,
              source: locInfo.source,
              all: cities.map((c) => c.name),
              note: '要改就说「改成 <城市>」。可以加多个城市，但日常只报这个默认的。',
            },
          });
        }
      }

      // ③ 逐城市取数
      //
      //   【所有城市都拉、都存、都记历史】
      //     但**只有默认城市（第一个）才产骤变事件和日常报告** ——
      //     维护者：「所有的什么温度骤降，都只落在默认地址上。」
      //     其他城市存着，等用户问到再由 relay 算好给结论。
      let okCount = 0;
      for (const loc of cities) {
        const isPrimary = loc === cities[0] || loc.name === primaryName;
        try {
          const data = await api.fetchWeather(loc.lat, loc.lon, conf.timeoutMs);
          okCount += 1;
          // 「昨天」的锚点：严格早于 today（不能用"最近一条"，那可能是今天早上的）
          const prevRows = readHistory(env, loc.name).filter((r) => String(r.date) < today);
          const yesterday = prevRows.pop() ?? null;
          const todayPrev = yesterday?.daily ?? null;

          // 记历史（所有城市都记）
          writeHistory(env, {
            city: loc.name,
            date: today,
            fetchedAt: now.toISOString(),
            current: data.current,
            daily: data.daily,
            forecast: data.forecast,
          });

          // 以下只对默认城市产事件
          if (!isPrimary) continue;

          // 骤升骤降（只在有前一天数据时判）
          const todayDaily = data.daily;
          if (todayPrev !== null && todayDaily !== null) {
            const swing = computeSwing(todayDaily, todayPrev);
            const swingEvt = buildSwingEvent({
              city: loc.name,
              date: today,
              swing,
              data: {
                today: todayDaily,
                previous: todayPrev,
                thresholds: conf.thresholds,
              },
            });
            if (swingEvt !== null) events.push(swingEvt);
          }

          // 日常报告
          const dailyEvt = buildDailyEvent({
            city: loc.name,
            date: today,
            data,
            level: conf.dailyLevel,
          });
          if (dailyEvt !== null) events.push(dailyEvt);
        } catch (e) {
          // 单城失败不影响其他城市
          env?.log?.('warn', 'weather fetch failed', { city: loc.name, error: String(e?.message ?? e) });
        }
      }

      // ④ 成败记账
      if (okCount > 0) {
        failStreak = 0;
        lastFetchAt = nowMs;
        env?.state?.set?.('weather:lastFetchAt', nowMs);
      } else {
        failStreak += 1;
        if (failStreak >= conf.failThreshold) {
          failStreak = 0;
          events.push(errorEvent('天气连续多次取数失败', now));
        }
      }

      // ⑤ 体检记录（C7：每轮都记，不只有告警时记）
      env?.recordRun?.({
        at: now.toISOString(),
        kind: 'weather',
        cities: locInfo.locations.map((l) => l.name),
        ok: okCount,
        events: events.length,
        source: locInfo.source,
      });

      return events;
    },

    async teardown() {
      started = false;
      resolved.clear();
    },
  };
}

/** 造一条采集器错误事件。 */
function errorEvent(message, now) {
  return {
    source: 'weather',
    kind: 'collector-error',
    level: 'warn',
    dedupeKey: `weather:error:${localDate(now)}`,
    summary: `天气采集器：${String(message).slice(0, 40)}`,
    payload: { message: String(message), at: now.toISOString() },
  };
}

export default createWeatherCollector();
