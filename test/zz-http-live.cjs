// 真实环境 HTTP 入口测试 —— 对着运行中的 relay 打
const BASE = "http://127.0.0.1:17831/inbox";
const fs = require("node:fs");
const PROF = "
const peer = JSON.parse(fs.readFileSync(PROF + "/peers/monitor.json", "utf8"));
let pass = 0, fail = 0;
function chk(name, ok, extra = "") {
  if (ok) { console.log("PASS  " + name); pass++; }
  else { console.log("FAIL  " + name + (extra ? "  " + extra : "")); fail++; }
}
(async () => {
  // 1. 正常投递
  let r = await fetch(BASE, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ peer: "monitor", token: peer.token, level: "critical", title: "HTTP 入口验证 v0.3.0", body: "来自脚本的真实投递" }) });
  chk("POST 正常消息 → 202", r.status === 202, "实际 " + r.status);

  // 2. GET 被拒
  r = await fetch(BASE, { method: "GET" });
  chk("GET → 404", r.status === 404, "实际 " + r.status);

  // 3. 坏 JSON
  r = await fetch(BASE, { method: "POST", headers: { "content-type": "application/json" }, body: "{bad" });
  chk("坏 JSON → 400", r.status === 400, "实际 " + r.status);

  // 4. 超大 body
  let bigStatus = 0;
  try {
    r = await fetch(BASE, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ peer: "monitor", token: peer.token, level: "info", title: "big", body: "x".repeat(70000) }) });
    bigStatus = r.status;
  } catch { bigStatus = 0; }
  chk("超大 body → 413 或断连", bigStatus === 413 || bigStatus === 0, "实际 " + bigStatus);

  // 5. 错误 token（放进 inbox 后会被 validate 拒收，但 HTTP 层先收下）
  r = await fetch(BASE, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ peer: "monitor", token: "wrong-token", level: "critical", title: "错误 token 测试" }) });
  chk("错误 token 的 HTTP 投递被接受（由校验层拒收）", r.status === 202, "实际 " + r.status);

  // 6. 路径不对
  r = await fetch("http://127.0.0.1:17831/wrong", { method: "POST", body: "{}" });
  chk("错误路径 → 404", r.status === 404, "实际 " + r.status);

  console.log(`\n===== ${fail === 0 ? "ALL PASS" : "HAS FAILURES"} (${pass} passed, ${fail} failed) =====`);
})();
