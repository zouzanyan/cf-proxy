// 本地 WebSocket echo 服务器，用于测试 cf-proxy 的 WS 透传
// 启动：node test/ws-echo-server.mjs  (需 NODE_PATH 指向含 ws 包的 node_modules)
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { WebSocketServer } = require("ws");

const PORT = Number(process.argv[2] || 9393);
const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws, req) => {
  console.log(`[server] client connected from ${req.socket.remoteAddress}`);
  console.log(`[server] sec-websocket-protocol: ${req.headers["sec-websocket-protocol"] || "(none)"}`);
  ws.send("welcome from echo server");
  ws.on("message", (data) => {
    const text = data.toString();
    console.log(`[server] got: ${text}`);
    ws.send(`echo: ${text}`);
  });
  ws.on("close", () => console.log("[server] client closed"));
});

console.log(`[server] ws echo server listening on ws://127.0.0.1:${PORT}`);
