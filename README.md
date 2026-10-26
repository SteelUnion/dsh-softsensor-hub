# dsh-softsensor-hub

> **让 AI 助手知道你的电脑出事了、来邮件了、该看行情了。**
>
> 它统一收各类通知，判断该不该吵醒 AI —— 急事立刻叫，一般的事攒一批，
> 不重要的只留档。**它自己不动手，只负责"告诉"。**
>
> *Gives your AI agent a sense of the outside world — system alerts, mail, markets,
> weather — and decides what is worth waking it for.*

消息中枢。收消息、判轻重、告诉 agent。它自己不动手。

版本 0.6.2。测试 793 项，全过。

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
