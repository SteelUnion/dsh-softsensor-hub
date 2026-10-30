# dsh-softsensor-hub

![License](https://img.shields.io/badge/license-MIT-blue)
![Tests](https://img.shields.io/badge/tests-793%20passed-brightgreen)
![DSH](https://img.shields.io/badge/dsh-%E2%89%A50.2.0--rc.1-orange)
![Version](https://img.shields.io/badge/version-0.6.4-lightgrey)

> **让 AI 助手知道你的电脑出事了、来邮件了、该看行情了。**
>
> 它统一收各类通知，判断该不该吵醒 AI —— 急事立刻叫，一般的事攒一批，
> 不重要的只留档。**它自己不动手，只负责"告诉"。**
>
> *Gives your AI agent a sense of the outside world — system alerts, mail, markets,
> weather — and decides what is worth waking it for.*

消息中枢。收消息、判轻重、告诉 agent。它自己不动手。

版本 0.6.4。测试 793 项全部通过。

## 0.6.4 更新了什么

**修一个会让宿主退不掉的 bug：relay 抓着的连接不肯松手。**

### 现象

DSH 桌面端更新时报：

```
desktop update: Host did not complete graceful task teardown
(exit null, signal SIGTERM, shutdown acknowledged false, graceful deadline exceeded true)
```

主机收到关闭指令后判定超时，最后 SIGHTERM 强杀。改完之前实测：关一次要等 152~569 秒。

### 根因

不是 relay "没写清理"，是**清理挂错了地方**。

读 cordis 4.0.5 源码（`fiber.ts`）确认：

```ts
// fiber.ts:114
function runDisposable(dispose: Disposable) {
  const result = dispose()
  return effectInertia.get(dispose)?.() ?? result   // 原样返回，不设超时
}

// fiber.ts:433 —— effect disposer 是**串行链**
task = task.then(() => runDisposable(disposable))
```

只要任意一个 `ctx.effect` 的 disposer 返回「永不 resolve 的 Promise」，
整条 `_unload()` 就卡死；于是 `ctx.on('dispose')` 永不派发，
relay 写在里面的 `collectors.stop()` / `httpServer.close()` / `store.close()` 一个都跑不到。

### 改法：握手模式从「资产」变「临时租借」

```
以前  连接是资产，要好好关，关不掉就等 → 进程被钉住
现在  连接是临时租借，随时可以扔      → 数据不会丢，下次采集是全新事务
```

- `ctx.effect` 的 disposer 改成**同步**做完全部清理，绝不 return Promise，
  也不 await 任何网络请求
- 新增 `inflightHandles` 登记表：relay 建的网络连接都登记，卸载时统一 `destroy()`
- 新增 `openTracked(kind, factory)` 作为**硬性约定入口**——
  relay 内所有连接必须经过它，否则卸载时没人知道该 destroy 谁
- `httpServer.close()` 后补 `closeAllConnections()`，强断 keep-alive
- 每一步清理独立 `try/catch`，失败写 `errors.jsonl`（不再静默）

### 结果

单次卸载从 **6741 ms 降到 7 ms**，进程能走到 `beforeExit → exit code=0`。

### 排障用的东西（默认关）

`config.debug.shutdownProbe: true` 会写 `<root>/logs/shutdown-probe.jsonl`，
逐条记录 disposer 每一步和 process 级信号（beforeExit / exit / SIGTERM / disconnect）。
打包出去默认不产生这份日志；同款问题再出现时改一个配置就能开。

---

## 0.6.3 更新了什么

插件行为没有变化。这次只补了开源清单要的三个仓库文件：`SECURITY.md`、Dependabot 配置、
`package-lock.json`。代码没动。

---

## 它怎么判轻重

```
采集器产出事件（磁盘、内存、邮件、行情、天气）
        ↓
按规则定级
        ↓
critical ──→ 立刻叫醒 AI
warn     ──→ 攒一批，凑够再叫
info     ──→ 只留档，不打扰
        ↓
存进事件库（可回溯、可查询）
```

**关键点：它不产生动作，只产生「该不该说」的判断。**
真正做什么由 AI 决定 —— 这样换模型、换策略都不用改这个插件。

---

---

## 三十秒上手

```powershell
npx -p @deepseek-ai/dsh dsh plugin --profile web add github:SteelUnion/dsh-softsensor-hub
```

装完重启 DSH。首次启动会从 `config.template.json` 复制一份 `config.json`，
所有 `null` 都是待填项，旁边有 `_xxx说明` 提示。然后跑一次配置向导。

---

## 它替你省什么

| 场景 | 没有它 | 有它 |
|---|---|---|
| 磁盘满了 / 内存告警 | AI 不知道，继续干活 | 主动告诉 AI，让它先收手 |
| 来了重要邮件 | 你得自己去翻 | AI 收到摘要，能替你判断 |
| 行情异动 | 你盯着屏幕 | 达到条件才通知，不刷屏 |
| 一堆无关通知 | 全推给 AI，污染上下文 | **分级过滤，只把该说的说出去** |

---

## 它解决什么问题

DSH 里有很多东西想通知你：系统告警、邮件、行情、天气。

它们各自写一套投递逻辑很啰嗦。这个插件统一收，统一判断该不该吵醒你。

判断规则可配置。默认：critical 立刻叫，warn 攒批，info 只留档。

---

## 装完发生什么

首次启动会从 `config.template.json` 复制一份 `config.json`。

配置文件里所有 `null` 都是待填项，旁边有 `_xxx说明` 提示。

然后跑一次配置向导。能自证的项自动标好，剩下的等你选。

详细步骤见 [INSTALL.md](INSTALL.md)。

---

## 四个采集器

| 采集器 | 干什么 | 默认 |
|---|---|---|
| `system` | 内存、磁盘、事件循环延迟 | 开 |
| `weather` | 天气，按城市或 IP 定位 | 开 |
| `mail` | IMAP 收邮件 | 关 |
| `finance` | 读量化库，产行情事件 | 关 |

采集器跑在插件进程里，不需要外部守护进程。

外部进程一死，采集就断，而且没人知道。这个坑踩过一次，不再踩。

---

## 目录

安装目录就是数据目录。卸载前记得备份整个目录。

```
dsh-softsensor-hub\
├── config.json          你的配置
├── logs\                所有日志
├── inbox\  archive\     消息队列
├── peers\               对端登记
├── data\                事件库、凭据库
└── lib\  test\  schema\ 代码与测试
```

数据放在别处也行。改 `config.json` 的 `root` 即可。

---

## 日志

全在 `logs\`，一行一个 JSON。

排错先看 `logs\errors.jsonl`。

每个文件管什么，见 INSTALL.md 第五节。

---

## 开发

```bash
node test/zz-all.mjs     # 全部测试
node test/zz-check.mjs   # 运维体检
node pack.mjs            # 打包到 dist/
```

打包用白名单。日志、凭据、配置不进包。

---

## 许可

MIT，见 [LICENSE](LICENSE)。
