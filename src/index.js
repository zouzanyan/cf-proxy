/**
 * cf-proxy — Cloudflare Worker 通用 API 反向代理
 *
 * 用法（假设部署在 https://cf-proxy.<你的子域>.workers.dev）：
 *   /proxy/http(s)://api.example.com/path -> api.example.com/path
 *
 * 鉴权：所有请求必须携带 x-proxy-token: <token>（或 Authorization: Bearer <token>）
 *   该鉴权头会被剔除，不会转发给上游；业务 API Key 头原样透传。
 *
 * 部署：Dashboard 粘贴本文件即可（见 README），无需构建工具。
 */

// ══════════════════════════════════════════════════════════════
// 配置区（按需修改；Dashboard 的 Variables / Secrets 同名变量优先级更高）
// ══════════════════════════════════════════════════════════════
const CONFIG = {
  // 访问令牌：非空 = 强制鉴权，请求须带 x-proxy-token: <token> 或 Authorization: Bearer <token>
  // 留空 "" = 不鉴权（不建议公开部署时留空）
  // 推荐做法：这里保持空串，Dashboard 部署后在 Settings → Variables and Secrets 配置 PROXY_TOKEN（Secret 类型）
  PROXY_TOKEN: "",

  // /proxy 通用转发的域名限制：
  //   "*" 或 ""          = 放开任意域名（默认）
  //   "a.com,b.com"      = 仅允许列表内域名，其余返回 403
  ALLOWED_HOSTS: "*",

  // CORS 允许来源："*" = 全放开；也可填 "https://your-site.com" 收紧
  CORS_ALLOW_ORIGIN: "*",

  // 客户端 IP 白名单（可选）：
  //   "" 或 "*"           = 不限制（默认）
  //   "1.2.3.4,5.6.7.0/24" = 仅允许列表内的 IP / IPv4 CIDR 段（逗号分隔），其余 403
  // 依据 CF-Connecting-IP 头判定；本地 dev 时该头可能不存在，配置白名单后会被拒
  IP_WHITELIST: "",

  // 请求头清洗模式：
  //   "clean"（默认）= 只透传 API 必需头（content-type / authorization / x-* 自定义头等），
  //                    丢弃浏览器指纹（sec-*、user-agent、referer、origin、accept-language 等），
  //                    所有请求统一使用 DEFAULT_USER_AGENT，看起来完全一致
  //   "passthrough"  = 客户端头原样透传（保留浏览器/SDK 特征）
  HEADER_MODE: "clean",

  // clean 模式下统一使用的 User-Agent
  DEFAULT_USER_AGENT:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
};

// ══════════════════════════════════════════════════════════════
// 以下为实现，一般无需改动
// ══════════════════════════════════════════════════════════════

/** 读取配置：环境变量（Dashboard/wrangler.toml）优先，其次代码内 CONFIG */
function getSetting(env, key) {
  const v = env ? env[key] : undefined;
  return v !== undefined && v !== "" ? v : CONFIG[key];
}

function isHostAllowed(hostname, allowed) {
  return allowed.includes("*") || allowed.includes(hostname);
}

/** IPv4 转整数；非法返回 null */
function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!/^\d+$/.test(p) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** 客户端 IP 是否命中白名单（支持精确 IP 与 IPv4 CIDR，IPv6 仅精确匹配） */
function isIpAllowed(ip, list) {
  if (list.length === 0 || list.includes("*")) return true;
  if (!ip) return false; // 白名单模式下取不到客户端 IP 一律拒绝
  for (const entry of list) {
    if (entry === ip) return true;
    if (entry.includes("/")) {
      const [net, bitsStr] = entry.split("/");
      const bits = Number(bitsStr);
      const netInt = ipv4ToInt(net);
      const ipInt = ipv4ToInt(ip);
      if (netInt === null || ipInt === null || !(bits >= 0 && bits <= 32)) continue;
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      if ((ipInt & mask) === (netInt & mask)) return true;
    }
  }
  return false;
}

// clean 模式下保留的请求头白名单（API 调用必需/常用）
const CLEAN_KEEP_HEADERS = new Set([
  "content-type",
  "accept",
  "accept-charset",
  "authorization",
  "api-key",
  "anthropic-version",
  "range",
  // 条件请求 / 缓存协商
  "if-match",
  "if-none-match",
  "if-modified-since",
  "if-unmodified-since",
  "if-range",
]);

/** 构造转发给上游的请求头 */
function buildForwardHeaders(request, env) {
  const headers = new Headers();
  const mode = getSetting(env, "HEADER_MODE");
  const proxyToken = getSetting(env, "PROXY_TOKEN");

  for (const [key, value] of request.headers.entries()) {
    const k = key.toLowerCase();
    if (STRIP_REQUEST_HEADERS.has(k)) continue;
    // 剔除代理自身的鉴权头，保留业务 API Key
    if (proxyToken && k === "authorization" && value === `Bearer ${proxyToken}`) continue;
    if (k === "x-proxy-token") continue;

    if (mode === "passthrough") {
      headers.set(key, value);
      continue;
    }
    // clean 模式：白名单 + x-* 自定义头（x-api-key、x-goog-api-key 等）
    if (CLEAN_KEEP_HEADERS.has(k) || k.startsWith("x-")) {
      headers.set(key, value);
    }
  }

  if (mode !== "passthrough") {
    // 所有请求统一 UA，抹掉个人浏览器特征
    headers.set("user-agent", getSetting(env, "DEFAULT_USER_AGENT"));
  }
  return headers;
}

// 不透传给上游的请求头（避免 IP 暴露 / CF 专有头污染）
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-worker",
  "cf-ew-via",
  "cf-trace-id",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
  "x-proxy-token",
  "cdn-loop",
  "accept-encoding", // 由 fetch 自行协商压缩，避免解压错乱
]);

const CORS_HEADERS = {
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-max-age": "86400",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": getSetting(null, "CORS_ALLOW_ORIGIN"),
      ...CORS_HEADERS,
    },
  });
}

function checkAuth(request, env) {
  const token = getSetting(env, "PROXY_TOKEN");
  if (!token) return true; // 未配置令牌 = 不鉴权
  const auth = request.headers.get("authorization") || "";
  const bare = request.headers.get("x-proxy-token") || "";
  return auth === `Bearer ${token}` || bare === token;
}

async function handleProxy(request, env, targetUrl) {
  // 鉴权
  if (!checkAuth(request, env)) {
    return jsonResponse({ error: "unauthorized", hint: "设置 x-proxy-token 请求头" }, 401);
  }

  // 转发请求头（按 HEADER_MODE 清洗，剔除代理自身的鉴权头）
  const headers = buildForwardHeaders(request, env);

  // 构造上游请求：保留原始方法与 body（GET/HEAD 无 body）
  const method = request.method;
  const hasBody = !["GET", "HEAD"].includes(method);
  const upstreamRequest = new Request(targetUrl, {
    method,
    headers,
    body: hasBody ? request.body : undefined,
    // 服务端跟随重定向，保证客户端始终只面对本 Worker 一个出口
    redirect: "follow",
  });

  let upstream;
  try {
    upstream = await fetch(upstreamRequest);
  } catch (err) {
    return jsonResponse({ error: "upstream_fetch_failed", message: String(err) }, 502);
  }

  // 响应透传（自动支持 SSE / chunked 流式）
  const responseHeaders = new Headers(upstream.headers);
  // 删除会被 Workers 运行时拒绝/干扰的头
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  responseHeaders.delete("transfer-encoding");
  responseHeaders.set("access-control-allow-origin", getSetting(null, "CORS_ALLOW_ORIGIN"));
  for (const [k, v] of Object.entries(CORS_HEADERS)) responseHeaders.set(k, v);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

/**
 * WebSocket 代理：客户端 WS 握手 → 上游 WS 服务器，双向数据由 CF 运行时自动转发。
 * 握手头（Upgrade / Connection / Sec-WebSocket-*）必须原样保留，不能走 clean 模式清洗。
 *
 * WS 鉴权（浏览器握手带不了自定义头，故支持两种凭证；刻意不支持 URL 参数——token 会落日志）：
 *   1. 子协议伪装：客户端 new WebSocket(url, token)，token 出现在
 *      Sec-WebSocket-Protocol 头中；代理校验后从转发头中删除（上游无感知）
 *   2. 常规头：x-proxy-token / Authorization: Bearer（代码客户端）
 */
async function handleWebSocket(request, env, target) {
  const expected = getSetting(env, "PROXY_TOKEN");

  const protoItems = (request.headers.get("sec-websocket-protocol") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const authorized =
    !expected ||
    checkAuth(request, env) ||
    protoItems.includes(expected);
  if (!authorized) {
    return jsonResponse({ error: "unauthorized", hint: "token 可放 x-proxy-token 头或 Sec-WebSocket-Protocol（子协议伪装）" }, 401);
  }

  // 剔除鉴权痕迹，避免泄漏给上游
  const headers = new Headers(request.headers);
  for (const k of STRIP_REQUEST_HEADERS) headers.delete(k);
  headers.delete("x-proxy-token");
  // 关键：剥掉压缩扩展协商。上游若接受 permessage-deflate，CF 运行时的 WS 管道会挂起
  // （实测 postman-echo 卡死）。禁用协商后整条链路用明文帧，稳定优先。
  headers.delete("sec-websocket-extensions");
  if (expected && headers.get("authorization") === `Bearer ${expected}`) {
    headers.delete("authorization");
  }
  if (expected && protoItems.length > 0) {
    const kept = protoItems.filter((i) => i !== expected);
    if (kept.length > 0) headers.set("sec-websocket-protocol", kept.join(", "));
    else headers.delete("sec-websocket-protocol");
  }

  try {
    const upstream = await fetch(target.toString(), { method: "GET", headers });
    // 严格客户端（如 ws 库）要求服务端回显选中的子协议：
    // 客户端用子协议伪装时，把 token 回显为"被选中的子协议"
    if (upstream.status === 101 && upstream.webSocket) {
      const respHeaders = new Headers(upstream.headers);
      respHeaders.delete("sec-websocket-extensions"); // 请求侧已禁用协商，防御性清掉响应侧
      if (expected && protoItems.includes(expected)) {
        respHeaders.set("sec-websocket-protocol", expected);
      }
      return new Response(null, {
        status: 101,
        statusText: upstream.statusText,
        headers: respHeaders,
        webSocket: upstream.webSocket,
      });
    }
    return upstream;
  } catch (err) {
    return jsonResponse({ error: "websocket_upstream_failed", message: String(err) }, 502);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+|\/+$/g, ""); // 去首尾斜杠

    // 客户端 IP 白名单（作用于全部请求）
    const ipList = getSetting(env, "IP_WHITELIST")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const clientIp = request.headers.get("cf-connecting-ip") || "";
    if (!isIpAllowed(clientIp, ipList)) {
      return jsonResponse({ error: "ip_not_allowed" }, 403);
    }

    // CORS 预检
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": getSetting(null, "CORS_ALLOW_ORIGIN"),
          ...CORS_HEADERS,
        },
      });
    }

    // 健康检查
    if (path === "" || path === "health") {
      return jsonResponse({ status: "ok" });
    }

    // 通用转发：/proxy/http(s)://host/path（WebSocket 用 ws(s)://）
    if (path === "proxy" || path.startsWith("proxy/")) {
      const raw = request.url.split("/proxy/")[1];
      let target;
      try {
        target = new URL(decodeURIComponent(raw));
      } catch {
        return jsonResponse({ error: "invalid_target_url" }, 400);
      }

      // WebSocket 代理：握手请求（Upgrade: websocket）原样透传，
      // 运行时自动建立客户端 ↔ 上游的双向管道
      const isWsUpgrade = (request.headers.get("upgrade") || "").toLowerCase() === "websocket";
      if (isWsUpgrade) {
        // ws:// -> http://, wss:// -> https://（fetch 按 http(s) URL 发起，CF 处理升级）
        if (target.protocol === "ws:") target.protocol = "http:";
        if (target.protocol === "wss:") target.protocol = "https:";
      } else if (target.protocol !== "https:" && target.protocol !== "http:") {
        // 普通请求：http / https 均支持，其余协议（ftp: 等）fetch 本身不支持
        return jsonResponse({ error: "unsupported_protocol", supported: ["http:", "https:", "ws:", "wss:"] }, 400);
      }
      const allowed = getSetting(env, "ALLOWED_HOSTS").split(",").map((s) => s.trim()).filter(Boolean);
      if (!isHostAllowed(target.hostname, allowed)) {
        return jsonResponse({ error: "host_not_allowed", allowed }, 403);
      }
      if (isWsUpgrade) {
        return handleWebSocket(request, env, target);
      }
      return handleProxy(request, env, target.toString());
    }

    return jsonResponse(
      {
        error: "not_found",
        usage: "/proxy/<完整HTTPS URL>",
      },
      404
    );
  },
};
