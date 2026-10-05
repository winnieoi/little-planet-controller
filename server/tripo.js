/*
 * Tripo API 接入（服务端代理）
 * ---------------------------------------------------------------
 * 玩家在网页里输入一句话（或上传一张参考图），花积分生成一座 3D 建筑模型，
 * 模型落到 web/models/buildings/ 下，网页再把它摆到星球表面上。
 *
 * 为什么必须走服务端：
 *   1. API Key 不能进浏览器（一进前端就等于公开）；
 *   2. Tripo 的 model_url 有效期只有 5 分钟，必须任务成功立刻下载落盘；
 *   3. 浏览器直连 openapi.tripo3d.ai 会被 CORS 拦掉。
 *
 * 零第三方依赖：只用 Node 内置模块 + Node 18 起自带的全局 fetch。
 *
 * 需要的环境变量：
 *   TRIPO_API_KEY=sk-...        # 不设则自动进入 mock 模式（返回占位小屋，链路照样跑通）
 *
 * 对外接口（由 server/server.js 挂载到 /api/tripo/*）：
 *   GET  /api/tripo/config                 当前模式、默认模型、是否配置了 Key
 *   POST /api/tripo/generate               {prompt} → {taskId}        文本生成
 *   POST /api/tripo/upload                 multipart 图片 → {fileToken}（可选，配合参考图）
 *   GET  /api/tripo/task/:taskId           轮询任务状态
 *   POST /api/tripo/save                   {taskId, prompt} → 下载 GLB 并落盘
 *   GET  /api/tripo/buildings              已生成的建筑清单
 *   DELETE /api/tripo/buildings?file=xxx   删除一个建筑
 * ---------------------------------------------------------------
 */

"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const BASE = "https://openapi.tripo3d.ai/v3";
const WEB_ROOT = path.resolve(__dirname, "..", "web");
/* 落盘目录默认在 web/models/buildings，但可以用环境变量指到别处 ——
   主要是为了跑测试时不往真实目录里塞垃圾文件。 */
const OUT_DIR = process.env.TRIPO_OUT_DIR
  ? path.resolve(process.env.TRIPO_OUT_DIR)
  : path.join(WEB_ROOT, "models", "buildings");
const URL_PREFIX = "/models/buildings";
const INDEX_FILE = path.join(OUT_DIR, "index.json");

/* 默认出图模型：v3.1 通用高保真；想省积分可换成 P1-20260311（游戏资产优化低模） */
const DEFAULT_MODEL = process.env.TRIPO_MODEL || "v3.1-20260211";
const DEFAULT_FACE_LIMIT = Number(process.env.TRIPO_FACE_LIMIT || 8000);

function apiKey() {
  return (process.env.TRIPO_API_KEY || "").trim();
}
function hasKey() {
  return apiKey().length > 0;
}

function log(...args) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log("[" + t + "][tripo] " + args.join(" "));
}

/* ============================================================
 * Tripo 调用
 * ============================================================ */

/* 把 Tripo 的业务码翻成玩家看得懂的话。
   直接把上游英文原文抛给前端的话，玩家只会看到一整句 "You don't have enough
   credit to create this task"，既看不懂也不知道该怎么办。 */
const CODE_HINT = {
  1001: "API Key 无效或已失效，检查 TRIPO_API_KEY 是否正确",
  1002: "API Key 权限不足，确认这个 Key 开通了 3D 生成权限",
  1004: "请求参数不合法（task_id 必须是 UUID）",
  2010: "账户额度不足，去 tripo3d.ai 充值后再试",
  4001: "接口路径不存在，可能是 Tripo 改版了 API",
  4290: "请求太频繁，被限流了，稍等一会儿再试"
};

function friendlyError(code, httpStatus, rawMsg) {
  const hint = code !== undefined && CODE_HINT[code];
  const head = "Tripo " + ((code !== undefined ? "code " + code : httpStatus) + "");
  return new Error(hint ? head + "：" + hint + "（原文：" + rawMsg + "）"
                        : head + "：" + rawMsg);
}

async function tripo(method, urlPath, body) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: {
      Authorization: "Bearer " + apiKey(),
      "Content-Type": "application/json"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (e) {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = (data && (data.message || data.msg)) || text.slice(0, 300);
    throw friendlyError(data && data.code, res.status, msg);
  }
  /* Tripo 的 HTTP 状态码可能是 200 但业务码非 0 */
  if (data && typeof data.code === "number" && data.code !== 0) {
    throw friendlyError(data.code, res.status, data.message || JSON.stringify(data));
  }
  return data || {};
}

async function createTextTask(prompt, opts) {
  const body = {
    prompt: String(prompt || "").slice(0, 1000),
    model: opts.model || DEFAULT_MODEL,
    face_limit: Number(opts.face_limit) || DEFAULT_FACE_LIMIT,
    texture: opts.texture === undefined ? true : !!opts.texture
  };
  const data = await tripo("POST", "/generation/text-to-model", body);
  return data.data && data.data.task_id;
}

async function createImageTask(fileToken, opts) {
  const body = {
    file_token: fileToken,
    model: opts.model || DEFAULT_MODEL,
    face_limit: Number(opts.face_limit) || DEFAULT_FACE_LIMIT,
    texture: opts.texture === undefined ? true : !!opts.texture
  };
  const data = await tripo("POST", "/generation/image-to-model", body);
  return data.data && data.data.task_id;
}

/* 查询 Tripo API 账户余额。
   注意：这是** API 专用额度池 **，和网页版的订阅额度不是同一个池子 ——
   账户里明明有额度、API 却报 2010，往往就是因为余额查询在这个池子里是 0。
   查询很快，但没必要每次都打，缓存 30 秒。 */
let balanceCache = { at: 0, data: null };

async function getBalance() {
  if (!hasKey()) return { balance: null, frozen: null, error: "未配置 API Key" };
  if (balanceCache.data && Date.now() - balanceCache.at < 30000) return balanceCache.data;
  try {
    const data = await tripo("GET", "/account/balance");
    const out = {
      balance: data.data ? Number(data.data.balance) : null,
      frozen: data.data ? Number(data.data.frozen) : null
    };
    balanceCache = { at: Date.now(), data: out };
    return out;
  } catch (e) {
    /* 查余额失败不应该连累主流程，退化成 null 即可 */
    return { balance: null, frozen: null, error: e.message };
  }
}

/** 上传参考图，拿到 file_token */
async function uploadImage(buffer, filename, mime) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mime || "image/png" }), filename || "ref.png");
  const res = await fetch(BASE + "/files", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey() },
    body: form
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error("上传失败 " + res.status + ": " + JSON.stringify(data));
  const d = (data && data.data) || {};
  return d.file_token || d.image_token || d.token || d.id || null;
}

async function getTask(taskId) {
  return tripo("GET", "/tasks/" + encodeURIComponent(taskId));
}

/* ============================================================
 * Mock 模式：没有 API Key 时也能把整条链路跑通
 * 直接产出一个低多边形小屋 GLB，走真实的落盘与前端解析路径。
 * ============================================================ */

const mockTasks = new Map();
/* mock 生成的"假装耗时"。默认 6 秒接近真实体验；录演示视频时可以调短，
   不然进度条占掉大半篇幅。 */
const MOCK_DURATION_MS = Number(process.env.TRIPO_MOCK_MS || 6000);

function buildMockGlb() {
  const tris = [];
  const push = (a, b, c) => {
    /* 面法线；凸体保证朝外（法线与「面心 - 体心」同向） */
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const cx = (a[0] + b[0] + c[0]) / 3, cy = (a[1] + b[1] + c[1]) / 3, cz = (a[2] + b[2] + c[2]) / 3;
    const ox = cx - 0, oy = cy - 0.5, oz = cz - 0; /* 体心约在 (0, .5, 0) */
    if (nx * ox + ny * oy + nz * oz < 0) {
      const t = b; b = c; c = t;
      nx = -nx; ny = -ny; nz = -nz;
    }
    tris.push({ a, b, c, n: [nx, ny, nz] });
  };
  const quad = (p0, p1, p2, p3) => { push(p0, p1, p2); push(p0, p2, p3); };

  const w = 0.5, h = 0.7, d = 0.5;
  const b00 = [-w, 0, -d], b10 = [w, 0, -d], b11 = [w, 0, d], b01 = [-w, 0, d];
  const t00 = [-w, h, -d], t10 = [w, h, -d], t11 = [w, h, d], t01 = [-w, h, d];

  /* 墙体（primitive 0） */
  const wallStart = 0;
  quad(b00, b01, b11, b10);
  quad(t00, t10, t11, t01);
  quad(b01, b11, t11, t01);
  quad(b10, b00, t00, t10);
  quad(b00, b01, t01, t00);
  quad(b11, b10, t10, t11);
  const wallCount = tris.length - wallStart;

  /* 屋顶（primitive 1） */
  const roofStart = tris.length;
  const apex = [0, 1.15, 0];
  push(t00, t10, apex);
  push(t10, t11, apex);
  push(t11, t01, apex);
  push(t01, t00, apex);
  const roofCount = tris.length - roofStart;

  const writePrimitive = (from, count) => {
    const pos = new Float32Array(count * 3 * 3);
    const nrm = new Float32Array(count * 3 * 3);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count; i++) {
      const t = tris[from + i];
      const vs = [t.a, t.b, t.c];
      for (let k = 0; k < 3; k++) {
        const o = (i * 3 + k) * 3;
        for (let axis = 0; axis < 3; axis++) {
          const v = vs[k][axis];
          pos[o + axis] = v;
          nrm[o + axis] = t.n[axis];
          if (v < min[axis]) min[axis] = v;
          if (v > max[axis]) max[axis] = v;
        }
      }
    }
    return { pos, nrm, min, max };
  };

  const wall = writePrimitive(wallStart, wallCount);
  const roof = writePrimitive(roofStart, roofCount);

  const chunks = [wall.pos, wall.nrm, roof.pos, roof.nrm];
  const bufferViews = [];
  let offset = 0;
  for (const buf of chunks) {
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.byteLength });
    offset += buf.byteLength;
  }
  const bin = Buffer.alloc(offset);
  let cursor = 0;
  for (const buf of chunks) {
    Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).copy(bin, cursor);
    cursor += buf.byteLength;
  }

  const accessor = (viewIndex, count, min, max) => ({
    bufferView: viewIndex,
    componentType: 5126,
    count,
    type: "VEC3",
    min,
    max
  });

  const gltf = {
    asset: { version: "2.0", generator: "little-planet-mock" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "MockHut" }],
    meshes: [{
      name: "MockHut",
      primitives: [
        { attributes: { POSITION: 0, NORMAL: 1 }, material: 0 },
        { attributes: { POSITION: 2, NORMAL: 3 }, material: 1 }
      ]
    }],
    materials: [
      { name: "wall", pbrMetallicRoughness: { baseColorFactor: [0.56, 0.61, 0.70, 1], metallicFactor: 0, roughnessFactor: 0.9 } },
      { name: "roof", pbrMetallicRoughness: { baseColorFactor: [0.88, 0.32, 0.31, 1], metallicFactor: 0, roughnessFactor: 0.85 } }
    ],
    accessors: [
      accessor(0, wallCount * 3, wall.min, wall.max),
      accessor(1, wallCount * 3, [-1, -1, -1], [1, 1, 1]),
      accessor(2, roofCount * 3, roof.min, roof.max),
      accessor(3, roofCount * 3, [-1, -1, -1], [1, 1, 1])
    ],
    bufferViews,
    buffers: [{ byteLength: bin.length }]
  };

  const jsonBuf = Buffer.from(JSON.stringify(gltf), "utf8");
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);
  const binPad = (4 - (bin.length % 4)) % 4;
  const binChunk = Buffer.concat([bin, Buffer.alloc(binPad, 0)]);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonChunk.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(binChunk.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);

  return Buffer.concat([header, jh, jsonChunk, bh, binChunk]);
}

function createMockTask(prompt) {
  const id = "mock_" + Date.now().toString(36) + "_" + crypto.randomBytes(3).toString("hex");
  mockTasks.set(id, {
    id,
    prompt: String(prompt || ""),
    createdAt: Date.now(),
    file: id + ".glb"
  });
  /* 立刻把 GLB 写好，任务"完成"时直接可读 */
  fsp.mkdir(OUT_DIR, { recursive: true })
    .then(() => fsp.writeFile(path.join(OUT_DIR, id + ".glb"), buildMockGlb()))
    .catch((e) => log("mock 文件写入失败:", e.message));
  return id;
}

function mockTaskView(id) {
  const task = mockTasks.get(id);
  if (!task) return null;
  const elapsed = Date.now() - task.createdAt;
  if (elapsed < MOCK_DURATION_MS) {
    return {
      code: 0,
      data: {
        task_id: id,
        type: "text_to_model",
        status: "running",
        progress: Math.min(95, Math.floor((elapsed / MOCK_DURATION_MS) * 95)),
        output: {}
      }
    };
  }
  return {
    code: 0,
    data: {
      task_id: id,
      type: "text_to_model",
      status: "success",
      progress: 100,
      output: {
        model_url: URL_PREFIX + "/" + task.file,
        rendered_image_url: ""
      }
    }
  };
}

/* ============================================================
 * 落盘与清单
 * ============================================================ */

function safeFile(name) {
  return String(name || "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
}

/* taskId → 该任务的缓存键。任务创建时记下，落盘时写进索引，
   之后同样的描述就能直接命中这个已有模型。
   只存在内存里：进程重启后新生成的模型不会被打上缓存键（不影响正确性，
   只是少一次省钱的命中机会），而索引里已有的缓存记录是持久的。 */
const pendingCacheKeys = new Map();

/** 归一化描述词：去首尾空、压连续空白。大小写差异也算同一个需求 */
function normalizePrompt(p) {
  return String(p || "").trim().replace(/\s+/g, " ");
}

function cacheKeyFor(prompt, opts) {
  const o = opts || {};
  const model = o.model || DEFAULT_MODEL;
  const faces = Number(o.face_limit) || DEFAULT_FACE_LIMIT;
  const tex = o.texture === undefined ? true : !!o.texture;
  return [normalizePrompt(prompt), model, faces, tex].join("|");
}

/** 在已有建筑里找同参数的成品：命中就直接复用，不再向 Tripo 扣一次钱 */
async function findCached(key) {
  const list = await readIndex();
  for (const b of list) {
    if (b.cacheKey !== key || !b.file) continue;
    try {
      await fsp.stat(path.join(OUT_DIR, b.file));
      return b;
    } catch (e) {
      /* 文件被删了就当没命中 */
    }
  }
  return null;
}

async function readIndex() {
  try {
    const raw = await fsp.readFile(INDEX_FILE, "utf8");
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    /* 没有索引就按目录重建 */
    try {
      const files = await fsp.readdir(OUT_DIR);
      const rebuilt = [];
      for (const f of files) {
        if (!f.endsWith(".glb")) continue;
        /* mock_ 开头是 mock 模式的中间产物（任务自己那份），不是玩家造出来的建筑，
           扫目录重建索引时要跳过，否则建筑列表里会冒出一条空描述的重影 */
        if (f.startsWith("mock_")) continue;
        const stat = await fsp.stat(path.join(OUT_DIR, f));
        rebuilt.push({ file: f, prompt: "", createdAt: stat.mtimeMs, size: stat.size });
      }
      return rebuilt;
    } catch (e2) {
      return [];
    }
  }
}

async function writeIndex(list) {
  await fsp.mkdir(OUT_DIR, { recursive: true });
  await fsp.writeFile(INDEX_FILE, JSON.stringify(list, null, 2), "utf8");
}

async function saveTaskModel(taskId, prompt) {
  let modelUrl = null;
  if (taskId && taskId.startsWith("mock_")) {
    const view = mockTaskView(taskId);
    if (!view || view.data.status !== "success") throw new Error("mock 任务尚未完成");
    modelUrl = URL_PREFIX + "/" + mockTasks.get(taskId).file;
  } else {
    const data = await getTask(taskId);
    const out = (data && data.data && data.data.output) || {};
    if (!data || !data.data || data.data.status !== "success") {
      throw new Error("任务尚未完成：" + ((data && data.data && data.data.status) || "unknown"));
    }
    modelUrl = out.model_url || out.pbr_model || (out.model_urls && out.model_urls[0]) || null;
    if (!modelUrl) throw new Error("任务输出里没有模型地址");
    log("下载模型:", modelUrl);
  }

  let buffer;
  if (modelUrl.startsWith(URL_PREFIX + "/")) {
    buffer = await fsp.readFile(path.join(OUT_DIR, modelUrl.slice(URL_PREFIX.length + 1)));
  } else {
    const res = await fetch(modelUrl);
    if (!res.ok) throw new Error("模型下载失败 " + res.status + "（地址可能已过期，请重新生成）");
    buffer = Buffer.from(await res.arrayBuffer());
  }
  if (buffer.readUInt32LE(0) !== 0x46546c67) throw new Error("下载到的不是 GLB 文件");

  await fsp.mkdir(OUT_DIR, { recursive: true });
  /* 先读索引再落盘。顺序反了会出问题：首次运行时 index.json 还不存在，
     readIndex() 会去扫目录重建，那时新文件已经在目录里了，就会被当成一条
     prompt 为空的桩记录收进去 —— 同一个文件在索引里出现两次。 */
  const list = await readIndex();
  const file = safeFile("b" + Date.now().toString(36) + "_" + crypto.randomBytes(2).toString("hex")) + ".glb";
  await fsp.writeFile(path.join(OUT_DIR, file), buffer);
  const entry = {
    file,
    prompt: String(prompt || "").slice(0, 200),
    taskId,
    createdAt: Date.now(),
    size: buffer.length
  };
  /* 打上缓存键，下次同样的需求直接复用这个模型，不重复扣费 */
  const key = pendingCacheKeys.get(taskId);
  if (key) {
    entry.cacheKey = key;
    pendingCacheKeys.delete(taskId);
  }
  list.push(entry);
  await writeIndex(list);

  log("已保存:", file, (buffer.length / 1024).toFixed(0) + "KB");
  return { file, url: URL_PREFIX + "/" + file, size: buffer.length };
}

/* ============================================================
 * HTTP 处理
 * ============================================================ */

function send(res, code, data) {
  const body = JSON.stringify(data);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** 极简 multipart 解析：只取字段名 → 内容 */
function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType || "");
  if (!match) throw new Error("缺少 multipart boundary");
  const boundary = Buffer.from("--" + (match[1] || match[2]));
  const out = {};
  let start = buffer.indexOf(boundary);
  if (start < 0) return out;
  start += boundary.length;
  while (start < buffer.length) {
    const end = buffer.indexOf(boundary, start);
    if (end < 0) break;
    const part = buffer.subarray(start, end);
    start = end + boundary.length;
    const sep = part.indexOf("\r\n\r\n");
    if (sep < 0) continue;
    const head = part.subarray(0, sep).toString("utf8");
    let body = part.subarray(sep + 4);
    if (body.length >= 2 && body[body.length - 2] === 13 && body[body.length - 1] === 10) {
      body = body.subarray(0, body.length - 2);
    }
    const nameMatch = /name="([^"]+)"/.exec(head);
    const fileMatch = /filename="([^"]*)"/.exec(head);
    if (!nameMatch) continue;
    out[nameMatch[1]] = { buffer: body, filename: fileMatch ? fileMatch[1] : "" };
  }
  return out;
}

/**
 * 处理 /api/tripo/* 请求。返回 true 表示已处理。
 * 由 server/server.js 在静态托管之前调用。
 */
async function handle(req, res, pathname, url) {
  if (!pathname.startsWith("/api/tripo/")) return false;

  if (pathname === "/api/tripo/config") {
    send(res, 200, {
      ok: true,
      mock: !hasKey(),
      hasKey: hasKey(),
      model: DEFAULT_MODEL,
      faceLimit: DEFAULT_FACE_LIMIT,
      buildingsUrlPrefix: URL_PREFIX,
      balance: await getBalance()
    });
    return true;
  }

  if (pathname === "/api/tripo/generate" && req.method === "POST") {
    let payload = {};
    try {
      payload = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8") || "{}");
    } catch (e) {
      send(res, 400, { ok: false, error: "无效 JSON: " + e.message });
      return true;
    }
    const prompt = String(payload.prompt || "").trim();
    if (!prompt && !payload.fileToken) {
      send(res, 400, { ok: false, error: "请输入建筑描述" });
      return true;
    }
    try {
      /* 先查缓存：同样的描述 + 模型 + 面数 + 贴图配置已经有成品，
         就直接复用，不再向 Tripo 提交任务（省一次真实扣费）。 */
      const key = cacheKeyFor(payload.fileToken ? payload.fileToken : prompt, payload);
      const hit = await findCached(key);
      if (hit) {
        log("缓存命中，直接复用:", hit.file, JSON.stringify(normalizePrompt(prompt).slice(0, 40)));
        send(res, 200, { ok: true, taskId: "cached:" + hit.file, cached: true, mock: false });
        return true;
      }

      let taskId;
      if (!hasKey()) {
        taskId = createMockTask(prompt);
        log("mock 生成:", JSON.stringify(prompt.slice(0, 40)));
      } else if (payload.fileToken) {
        taskId = await createImageTask(payload.fileToken, payload);
      } else {
        taskId = await createTextTask(prompt, payload);
      }
      if (!taskId) throw new Error("Tripo 没有返回 task_id");
      pendingCacheKeys.set(taskId, key);
      send(res, 200, { ok: true, taskId, mock: !hasKey(), cached: false });
    } catch (e) {
      log("生成失败:", e.message);
      send(res, 502, { ok: false, error: e.message });
    }
    return true;
  }

  if (pathname === "/api/tripo/upload" && req.method === "POST") {
    if (!hasKey()) {
      send(res, 200, { ok: true, fileToken: null, mock: true });
      return true;
    }
    try {
      const body = await readBody(req, 20 * 1024 * 1024);
      const parts = parseMultipart(body, req.headers["content-type"] || "");
      const file = parts.file || parts.image;
      if (!file) throw new Error("请求里没有文件字段");
      const token = await uploadImage(file.buffer, file.filename, "image/png");
      send(res, 200, { ok: true, fileToken: token });
    } catch (e) {
      send(res, 502, { ok: false, error: e.message });
    }
    return true;
  }

  if (pathname.startsWith("/api/tripo/task/")) {
    const taskId = decodeURIComponent(pathname.slice("/api/tripo/task/".length));
    if (!taskId) {
      send(res, 400, { ok: false, error: "缺少 taskId" });
      return true;
    }
    /* 缓存命中的任务不用问上游，直接伪装成一个已经 success 的任务视图，
       前端的「轮询 → 落盘」流程一行都不用改。 */
    if (taskId.startsWith("cached:")) {
      const file = taskId.slice("cached:".length);
      send(res, 200, {
        ok: true,
        cached: true,
        mock: false,
        code: 0,
        data: {
          task_id: taskId,
          type: "cached",
          status: "success",
          progress: 100,
          output: { model_url: URL_PREFIX + "/" + file }
        }
      });
      return true;
    }
    try {
      const data = taskId.startsWith("mock_") ? mockTaskView(taskId) : await getTask(taskId);
      if (!data) {
        send(res, 404, { ok: false, error: "任务不存在" });
        return true;
      }
      send(res, 200, Object.assign({ ok: true, mock: taskId.startsWith("mock_") }, data));
    } catch (e) {
      send(res, 502, { ok: false, error: e.message });
    }
    return true;
  }

  if (pathname === "/api/tripo/save" && req.method === "POST") {
    let payload = {};
    try {
      payload = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8") || "{}");
    } catch (e) {
      send(res, 400, { ok: false, error: "无效 JSON" });
      return true;
    }
    try {
      /* 缓存命中时没有真的去生成，也不需要再下载一次，直接返回已有文件 */
      const tid = String(payload.taskId || "");
      if (tid.startsWith("cached:")) {
        const file = safeFile(tid.slice("cached:".length));
        const stat = await fsp.stat(path.join(OUT_DIR, file));
        send(res, 200, {
          ok: true,
          cached: true,
          mock: false,
          file,
          url: URL_PREFIX + "/" + file,
          size: stat.size
        });
        return true;
      }
      const saved = await saveTaskModel(payload.taskId, payload.prompt);
      send(res, 200, { ok: true, mock: String(payload.taskId || "").startsWith("mock_"), ...saved });
    } catch (e) {
      log("保存失败:", e.message);
      send(res, 502, { ok: false, error: e.message });
    }
    return true;
  }

  if (pathname === "/api/tripo/buildings" && req.method === "GET") {
    const list = await readIndex();
    send(res, 200, { ok: true, buildings: list });
    return true;
  }

  if (pathname === "/api/tripo/buildings" && req.method === "DELETE") {
    const file = safeFile(url.searchParams.get("file") || "");
    if (!file || !file.endsWith(".glb")) {
      send(res, 400, { ok: false, error: "文件名不合法" });
      return true;
    }
    try {
      await fsp.unlink(path.join(OUT_DIR, file));
      const list = (await readIndex()).filter((b) => b.file !== file);
      await writeIndex(list);
      send(res, 200, { ok: true, removed: file });
    } catch (e) {
      send(res, 404, { ok: false, error: e.message });
    }
    return true;
  }

  send(res, 404, { ok: false, error: "未知的 Tripo 接口: " + pathname });
  return true;
}

module.exports = { handle, hasKey, OUT_DIR };
