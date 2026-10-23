# INSTALL — 安装与配置指南

> 本文给**人**看，也给**agent**看。
> 装失败时，把「六、排错」整段丢给 agent，它能照着症状自己查。

---

## 一、安装

### 目录结构

插件是**一个目录**，解压即可用。所有文件按相对位置互相找到，**不依赖任何绝对路径**。

```
dsh-softsensor-hub\
├── package.json            代码清单
├── LICENSE
├── README.md               功能说明
├── INSTALL.md              本文
├── cordis.patch.yml        DSH 装载入口
├── config.template.json    配置模板（首次启动复制成 config.json）
├── config.json             ← 你的配置（首次启动后生成）
├── lib\                    代码
│   ├── index.js
│   ├── init.mjs            配置向导逻辑
│   └── collectors\         system / mail / finance / weather
├── schema\                 规则 schema
├── test\                   自测脚本
├── inbox\                  运行时：待处理消息
├── archive\                运行时：已归档消息
├── peers\                  运行时：对端登记
├── logs\                   运行时：**所有日志**
├── data\                   运行时：事件库、凭据库
└── vault.json              运行时：加密凭据（有密码才生成）
```

### 装到哪

放进 DSH profile 的 `node_modules`（或按你的插件管理器方式安装）。

**关键**：`config.json` 里的 `root` 留 `null`，数据就落在**插件目录本身**——卸载重装时记得备份这个目录。

---

## 二、首次启动会做什么

```
启动
 ├─ config.json 不存在？ → 从 config.template.json 复制一份
 │                          （每个 null 旁边都有 _xxx说明，照着填）
 ├─ 建运行时目录：inbox / archive / peers / logs
 └─ 跑配置向导：
      ① 自动定案：能自证的项（数据目录、提示语、模块开关）直接标 true
      ② 剩下的留 null，产一条 **info** 事件（不叫醒你）
      ③ 真卡住时才 critical（见下）
```

### 什么叫「真卡住」

| 情况 | 级别 | 会不会叫你 |
|---|---|---|
| 探测**失败**（目录不存在、文件不在） | `critical` | ✅ 会 |
| 探测通过、只是你还没选（位置、版本） | `info` | ❌ 不会 |

---

## 三、配置文件

### 位置

```
<插件目录>\config.json
```

首次启动自动从 `config.template.json` 生成。**已存在时绝不覆盖。**

### 三态标记

向导的五项都支持三态：

| 值 | 含义 |
|---|---|
| `null` | 还没处理 |
| `true` | 做了 |
| `false` | 你明确跳过 |

**只要还有 `null`，清单就显示「待配置」**；全 true/false 就不再提醒。

### 常用键

| 键 | 说明 | 默认 |
|---|---|---|
| `root` | 数据目录。`null` = 用安装目录 | `null` |
| `enabled` | 总开关 | `true` |
| `gameMode.flagFile` | 标记文件存在时压制 warn/info | `game-mode.on` |
| `quietHours` | 免打扰时段 | `{enabled:false, start:23, end:7}` |
| `rate` | 流量：每轮 ≤2 次、每小时 ≤5 次 | 见模板 |

---

## 四、四个模块怎么调

### `sources.system` — 系统监控（默认开）

内嵌在插件进程里，**不需要外部守护进程**。

```json
"sources": {
  "system": {
    "enabled": true,
    "intervalSec": 60,
    "memoryPercent": 90,
    "memoryCriticalPercent": 95,
    "diskPercent": 90,
    "diskPath": null,
    "hysteresisPercent": 3
  }
}
```

- `diskPath` 留 `null` → 自动取**用户目录所在卷**
- `hysteresisPercent` 是回差，防止在阈值附近反复报警

### `sources.mail` — 邮件（默认关）

```json
"sources": {
  "mail": {
    "enabled": true,
    "boxes": [
      { "address": "you@qq.com", "credential": "relay-qq-mail" }
    ]
  }
}
```

- `credential` 是**凭据名**，不是密码
- 凭据优先级：环境变量 `DSH_RELAY_QQ_MAIL` > `vault.json`
- QQ/163 需要邮箱侧先开 IMAP 并拿授权码（不是登录密码）

### `sources.finance` — 金融（默认关）

```json
"sources": {
  "finance": {
    "enabled": true,
    "dbPath": null,
    "codes": ["600362", "000001"],
    "at": "09:00",
    "maxAgeDays": 7
  }
}
```

- **`dbPath` 必须填**（SQLite 量化库的完整路径）。留 `null` → 采集器静默跳过，记 `no-dbpath`，**不报错也不产事件**
- `maxAgeDays`：库太旧就不出行情，只发一条「库旧了」

### `sources.weather` — 天气（默认开）

```json
"sources": {
  "weather": {
    "enabled": true,
    "locations": [{ "name": "北京" }],
    "geoIp": true,
    "refreshHours": 6
  }
}
```

- `locations` 留空 → 走 IP 定位
- 第一个城市为主城市；设定后不会被 IP 变化覆盖

---

## 五、日志在哪

**全部在 `logs\`**（根目录只留配置与数据）。

| 文件 | 内容 |
|---|---|
| `errors.jsonl` | 内部异常。**排错第一站** |
| `received.jsonl` / `rejected.jsonl` | 收消息、拒收及原因 |
| `steered.jsonl` / `steer-skipped.jsonl` | 唤醒成功/被跳过 |
| `turn-stop.jsonl` | 回合收尾时的补投 |
| `batches.jsonl` | 攒批记录 |
| `quiet-release.jsonl` | 免打扰释放 |
| `alerts-local.jsonl` | 本地告警留档 |
| `peers-down.jsonl` / `peer-recovered.jsonl` | 对端状态 |
| `http-listening.jsonl` / `http-received.jsonl` | HTTP 通道 |
| `collector-runs.jsonl` | 采集器每次运行 |
| `config-init.jsonl` | 首次生成配置的记录 |

**格式**：一行一个 JSON，`at` 字段是 ISO 时间。

---

## 六、排错（给 agent 用）

### 先看这三个地方

1. `logs\errors.jsonl` — 有没有异常
2. `logs\collector-runs.jsonl` — 采集器跑了没、结果如何
3. `config.json` — 值是不是还是模板的 `null`

### 症状对照表

| 症状 | 先查 | 常见原因 |
|---|---|---|
| 装完什么都没发生 | `logs\` 目录在不在 | 插件没加载，或 `root` 指向了别处 |
| 一直提示「待配置」 | `config.json` 里是不是 `null` | 向导没跑完；或探测失败 |
| 收不到消息 | `logs\inbox` 里有文件吗 | `interface.file.enabled` 关了 |
| 收消息但被拒 | `logs\rejected.jsonl` 的 `reason` | `token-mismatch` = token 不一致；`unpaired` = 对端没登记在 `peers\` |
| 叫不醒 | `logs\steered.jsonl` 有没有 | 流量限了 / 免打扰 / 游戏模式开着 |
| 金融没数据 | `config.json` 的 `finance.dbPath` | 是 `null` 或路径错；看 `logs\collector-runs.jsonl` 的 `no-dbpath` |
| 邮件没数据 | `config.json` 的 `mail.boxes` | 空的；或凭据名对不上 |
| 磁盘项 unavailable | `system.diskPath` | 路径不存在；留 `null` 会自动选 |

### 常用命令

```powershell
# 自检（配对与结构）
node test/wiring.mjs

# 运维体检（读 logs\ 与事件库）
node test/zz-check.mjs

# 全部测试
node test/zz-all.mjs
```

### 让 agent 自查

```
读 <插件目录>\INSTALL.md 的「六、排错」，然后：
1. 看 logs\errors.jsonl 最后 20 行
2. 看 config.json 里还有哪些 null
3. 按症状对照表给出结论与修复命令
```

---

## 七、卸载

1. 备份 `config.json`、`vault.json`、`peers\`
2. 删除插件目录
3. 如果凭据存在 Windows 凭据管理器里，自行清理（插件不碰它）

---

## 八、版本

当前 `0.6.1`。查新版：`init.checkGitHub` 为 true 时，每天首次启动查一次 GitHub Releases（查不到就静默，不阻塞）。
