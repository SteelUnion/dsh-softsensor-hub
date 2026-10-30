修一个会让宿主退不掉的 bug：relay 抓着的连接不肯松手。

## 现象

DSH 桌面端更新时报：

```
desktop update: Host did not complete graceful task teardown
(exit null, signal SIGTERM, shutdown acknowledged false, graceful deadline exceeded true)
```

主机收到关闭指令后判定超时，最后 SIGTERM 强杀。改之前实测：关一次要等 152~569 秒。

## 根因

不是 relay "没写清理"，是清理挂错了地方。

读 cordis 4.0.5 源码（`fiber.ts`）确认：

```ts
// fiber.ts:114
function runDisposable(dispose: Disposable) {
  const result = dispose()
  return effectInertia.get(dispose)?.() ?? result   // 原样返回，不设超时
}

// fiber.ts:433 —— effect disposer 是串行链
task = task.then(() => runDisposable(disposable))
```

只要任意一个 `ctx.effect` 的 disposer 返回「永不 resolve 的 Promise」，整条 `_unload()` 就卡死；于是 `ctx.on('dispose')` 永不派发，relay 写在里面的 `collectors.stop()` / `httpServer.close()` / `store.close()` 一个都跑不到。

## 改法：握手模式从「资产」变「临时租借」

```
以前  连接是资产，要好好关，关不掉就等 → 进程被钉住
现在  连接是临时租借，随时可以扔      → 数据不会丢，下次采集是全新事务
```

- `ctx.effect` 的 disposer 改成**同步**做完全部清理，绝不 return Promise，也不 await 任何网络请求
- 新增 `inflightHandles` 登记表：relay 建的网络连接都登记，卸载时统一 `destroy()`
- 新增 `openTracked(kind, factory)` 作为**硬性约定入口** —— relay 内所有连接必须经过它，否则卸载时没人知道该 destroy 谁
- `httpServer.close()` 后补 `closeAllConnections()`，强断 keep-alive
- 每一步清理独立 `try/catch`，失败写 `errors.jsonl`（不再静默）

## 结果

单次卸载从 6741 ms 降到 7 ms，进程能走到 `beforeExit → exit code=0`。

## 排障用的东西（默认关）

`config.debug.shutdownProbe: true` 会写 `<root>/logs/shutdown-probe.jsonl`，逐条记录 disposer 每一步和 process 级信号（beforeExit / exit / SIGTERM / disconnect）。打包出去默认不产生这份日志；同款问题再出现时改一个配置就能开。

## 验收

```
node test/zz-all.mjs   →  19 个套件，793 项通过，0 项失败
```
