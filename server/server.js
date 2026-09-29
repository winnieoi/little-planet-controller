/*
 * Little Planet · 联调服务器
 * ---------------------------------------------------------------
 * 一个进程同时提供三件事：
 *   1. 静态托管游戏页面      GET  /
 *   2. 浏览器实时通道        WS   /ws
 *   3. 后端注入口(推荐)      POST /input
 *   4. 连接状态查询          GET  /status
 *
 * 零第三方依赖，只用 Node 内置模块，无需 npm install。
 * 启动：node server/server.js
 * ---------------------------------------------------------------
 */

"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const tripo = require("./tripo.js");

const PORT = Number(process.env.PORT || 8765);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = path.resolve(__dirname, "..", "web");
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const START_AT = Date.now();

/** 已连接的实时客户端 */
const clients = new Set();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8"
};

/* ============================================================
 * 1. HTTP 部分
 * ============================================================ */

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res, code, data) {
  const body = JSON.stringify(data);
  cors(res);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || rel === "") rel = "/index.html";

  const target = path.join(ROOT, rel);
  /* 防目录穿越 */
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end("禁止访问");
    return;
  }

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 文件不存在: " + rel);
      return;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-store"
    });
    fs.createReadStream(target).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204).end();
    return;
  }

  /* Tripo 3D 生成代理（/api/tripo/*）：Key 只留在服务端；
     未配置 TRIPO_API_KEY 时自动进入 mock 模式，返回占位小屋，链路照样能跑通。 */
  if (pathname.startsWith("/api/tripo/")) {
    try {
      await tripo.handle(req, res, pathname, url);
    } catch (e) {
      json(res, 500, { ok: false, error: "Tripo 接口异常: " + e.message });
    }
    return;
  }

  /* 后端注入输入的推荐入口 */
  if (pathname === "/input" && req.method === "POST") {
    let payload;
    try {
      const raw = await readBody(req, 64 * 1024);
      payload = JSON.parse(raw || "{}");
    } catch (e) {
      json(res, 400, { ok: false, error: "无效 JSON: " + e.message });
      return;
    }
    const sent = broadcast(payload, null);
    json(res, 200, { ok: true, delivered: sent, clients: clients.size });
    return;
  }

  /* 查询当前连接情况 */
  if (pathname === "/status") {
    json(res, 200, {
      ok: true,
      uptimeSec: Math.round((Date.now() - START_AT) / 1000),
      clients: clients.size,
      detail: [...clients].map((c) => ({
        role: c.role,
        remote: c.remote,
        connectedSec: Math.round((Date.now() - c.since) / 1000)
      }))
    });
    return;
  }

  if (pathname === "/health") {
    json(res, 200, { ok: true });
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end("仅支持 GET / POST");
    return;
  }

  serveStatic(req, res, pathname);
});

/* ============================================================
 * 2. WebSocket 部分 (RFC6455 最小实现)
 * ============================================================ */

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
  );
  socket.setNoDelay(true);

  const client = {
    socket,
    role: "unknown",
    remote: req.socket.remoteAddress,
    since: Date.now(),
    buffer: Buffer.alloc(0),
    open: true
  };
  clients.add(client);
  log("客户端接入", client.remote, "当前连接数", clients.size);

  broadcast({ type: "presence", clients: clients.size }, client);

  socket.on("data", (chunk) => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    let frame;
    try {
      while ((frame = decodeFrame(client.buffer))) {
        client.buffer = frame.rest;
        handleFrame(client, frame);
      }
    } catch (e) {
      log("帧解析失败，断开连接:", e.message);
      socket.destroy();
    }
  });

  const drop = () => {
    if (!client.open) return;
    client.open = false;
    clients.delete(client);
    log("客户端断开", client.remote, "当前连接数", clients.size);
    broadcast({ type: "presence", clients: clients.size }, null);
  };

  socket.on("close", drop);
  socket.on("error", drop);
  socket.on("end", drop);
});

/** 解析一个 WebSocket 帧，返回 {opcode, payload, rest} 或 null */
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    const high = buf.readUInt32BE(offset);
    const low = buf.readUInt32BE(offset + 4);
    len = high * 4294967296 + low;
    offset += 8;
  }

  let mask = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buf.length < offset + len) return null;

  const payload = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) {
    payload[i] = masked ? buf[offset + i] ^ mask[i % 4] : buf[offset + i];
  }

  const rest = buf.subarray(offset + len);
  return { fin, opcode, payload, rest: Buffer.from(rest) };
}

function encodeFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 4294967296), 2);
    header.writeUInt32BE(len % 4294967296, 6);
  }
  header[0] = 0x81; /* FIN + text */
  return Buffer.concat([header, payload]);
}

function handleFrame(client, frame) {
  const { opcode, payload } = frame;

  /* 关闭 */
  if (opcode === 0x8) {
    safeWrite(client.socket, Buffer.from([0x88, 0x00]));
    client.socket.end();
    return;
  }
  /* Ping -> Pong */
  if (opcode === 0x9) {
    const head = Buffer.from([0x8a, payload.length]);
    safeWrite(client.socket, Buffer.concat([head, payload]));
    return;
  }
  /* Pong 忽略 */
  if (opcode === 0xa) return;
  /* 仅处理文本帧 */
  if (opcode !== 0x1) return;

  const text = payload.toString("utf8");
  let msg;
  try {
    msg = JSON.parse(text);
  } catch (e) {
    log("收到非 JSON 文本，已忽略");
    return;
  }

  /* 握手：客户端声明自己的角色 */
  if (msg && msg.type === "hello") {
    client.role = msg.client || "unknown";
    log("客户端角色:", client.role);
    broadcast({ type: "presence", clients: clients.size }, null);
    return;
  }

  /* 其余消息转发给其他客户端：
     后端发来的输入会到达浏览器，浏览器的遥测会到达后端 */
  const relayed = Object.assign({}, msg, { source: client.role });
  broadcast(relayed, client);
}

function safeWrite(socket, buf) {
  try {
    if (socket.writable) socket.write(buf);
  } catch (e) {
    /* 连接已关闭，忽略 */
  }
}

function broadcast(msg, except) {
  const text = JSON.stringify(msg);
  const frame = encodeFrame(text);
  let count = 0;
  for (const c of clients) {
    if (c === except || !c.open) continue;
    safeWrite(c.socket, frame);
    count++;
  }
  return count;
}

/* ============================================================
 * 3. 心跳与启动
 * ============================================================ */

const HEARTBEAT_MS = 30000;

setInterval(() => {
  const frame = encodeFrame(JSON.stringify({ type: "server-time", t: Date.now() }));
  for (const c of clients) safeWrite(c.socket, frame);
}, HEARTBEAT_MS).unref();

function log(...args) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log("[" + t + "] " + args.join(" "));
}

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("  口袋星球 · 联调服务器已启动");
  console.log("  ------------------------------------------");
  console.log("  游戏页面      http://localhost:" + PORT + "/");
  console.log("  WebSocket     ws://localhost:" + PORT + "/ws");
  console.log("  输入注入口    POST http://localhost:" + PORT + "/input");
  console.log("  连接状态      http://localhost:" + PORT + "/status");
  console.log("  Tripo 生成    POST http://localhost:" + PORT + "/api/tripo/generate  " +
    (tripo.hasKey() ? "（已配置 API Key）" : "（未配置 TRIPO_API_KEY，当前为 mock 模式）"));
  console.log("  ------------------------------------------");
  console.log("  静态目录      " + ROOT);
  console.log("");
  console.log("  建造模式（收集积分换建筑）：http://localhost:" + PORT + "/?build=1");
  console.log("");
  console.log("  提示：后端无需安装任何库，直接 POST JSON 即可驱动游戏。");
  console.log("");
});
