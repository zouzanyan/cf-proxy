// 通过 cf-proxy 代理连接 WS echo 服务器，验证双向通信
// 用法：node test/ws-client-test.mjs <代理地址> <目标ws url> <token>
// 示例：node test/ws-client-test.mjs ws://127.0.0.1:8792 ws://127.0.0.1:9393 <token>
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");

const [proxyBase, targetUrl, token] = process.argv.slice(2);
if (!proxyBase || !targetUrl || !token) {
  console.error("usage: node ws-client-test.mjs <proxyBase> <targetWsUrl> <token>");
  process.exit(1);
}

const ws = new WebSocket(`${proxyBase}/proxy/${targetUrl}`, {
  headers: { "x-proxy-token": token },
});

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

ws.on("unexpectedResponse", (req, res) =>
  fail(`handshake rejected: HTTP ${res.statusCode} ${(res.headers["content-type"] || "")}`)
);
ws.on("open", () => {
  console.log("[client] OPEN (handshake through proxy succeeded)");
  ws.send("hello-cf-proxy");
});
ws.on("message", (data) => {
  const text = data.toString();
  console.log(`[client] MSG: ${text}`);
  if (text === "echo: hello-cf-proxy") {
    console.log("PASS: round-trip through proxy OK");
    process.exit(0);
  }
});
ws.on("error", (e) => fail(e.message));
setTimeout(() => fail("timeout waiting for echo"), 20000);
