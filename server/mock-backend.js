/*
 * Little Planet · 模拟后端手柄
 * ---------------------------------------------------------------
 * 用途：在后端程序写好之前，先用它验证「后端 -> 网页」这条链路是否通畅。
 *      它做的事情和后端完全一样：向 /input 接口 POST JSON。
 *
 * 用法：
 *   node server/mock-backend.js            交互模式，键盘实时操控
 *   node server/mock-backend.js demo       脚本模式，自动走一遍动作
 *   node server/mock-backend.js status     只看当前连接情况
 *
 * 交互模式按键：
 *   W A S D  移动      Shift 奔跑     空格 跳跃
 *   E 互动    V 切换视角    J 手记     H 帮助
 *   Q 左右转视角        Z 拉近 / X 拉远
 *   R 重置     Ctrl+C 退出
 * ---------------------------------------------------------------
 */

"use strict";

const http = require("node:http");

const HOST = process.env.TARGET_HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8765);
const BASE = { host: HOST, port: PORT };

function post(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        ...BASE,
        path: "/input",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        }
      },
      (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(out));
          } catch (e) {
            resolve({ ok: false, raw: out });
          }
        });
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    http
      .get({ ...BASE, path }, (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(out));
          } catch (e) {
            resolve({ ok: false, raw: out });
          }
        });
      })
      .on("error", reject);
  });
}

async function guard() {
  try {
    await get("/health");
  } catch (e) {
    console.error("");
    console.error("  无法连接联调服务器 " + HOST + ":" + PORT);
    console.error("  请先在另一个终端运行：node server/server.js");
    console.error("");
    process.exit(1);
  }
}

/* ============================================================
 * 脚本模式：自动演示一遍完整动作
 * ============================================================ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function demo() {
  const steps = [
    ["向前行走 2 秒", { type: "state", move: [0, -1], hold: ["run"] }, 2000],
    ["转向右侧视角", { type: "state", move: [0, -1], look: [1, 0] }, 900],
    ["跳跃", { type: "state", move: [0, 0], taps: ["jump"] }, 700],
    ["向右横向移动", { type: "state", move: [1, 0] }, 1200],
    ["拉近镜头", { type: "zoom", rate: 1.2 }, 700],
    ["恢复镜头", { type: "zoom", rate: -1.2 }, 700],
    ["切换星球视角", { type: "tap", name: "view" }, 1500],
    ["切回跟随视角", { type: "tap", name: "view" }, 800],
    ["互动", { type: "tap", name: "interact" }, 600],
    ["停止移动", { type: "state", move: [0, 0], look: [0, 0], hold: [] }, 200]
  ];

  for (const [label, payload, wait] of steps) {
    const res = await post(payload);
    console.log(
      "  " + label.padEnd(18, " ") +
      " -> 送达 " + (res.delivered ?? 0) + " 个页面" +
      (res.delivered === 0 ? "  (没有页面在监听，请先打开游戏页面)" : "")
    );
    await sleep(wait);
  }

  await post({ type: "reset" });
  console.log("\n  演示结束。");
}

/* ============================================================
 * 交互模式：用键盘实时驱动游戏
 * ============================================================ */

const KEY_ACTION = {
  " ": "jump",
  e: "interact",
  v: "view",
  j: "journal",
  h: "help"
};

async function interactive() {
  const status = await get("/status");
  console.log("");
  console.log("  当前连接到联调服务器的页面数：" + status.clients);
  if (!status.clients) {
    console.log("  提示：请先打开 http://localhost:" + PORT + "/ 再操作");
  }
  console.log("");
  console.log("  W A S D 移动 | Shift 奔跑 | 空格 跳跃 | E 互动 | V 视角");
  console.log("  Q 转视角 | Z 拉近 | X 拉远 | R 重置 | Ctrl+C 退出");
  console.log("");

  const held = { w: false, a: false, s: false, d: false, shift: false };
  const timers = {};
  let lookX = 0;
  let zoom = 0;

  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  /* 终端只能可靠拿到"按下"，用一个短超时模拟"松开" */
  const HOLD_MS = 220;
  function hold(key, apply, release) {
    apply();
    push(held, lookX, zoom);
    clearTimeout(timers[key]);
    timers[key] = setTimeout(() => {
      release();
      push(held, lookX, zoom);
    }, HOLD_MS);
  }

  stdin.on("data", async (key) => {
    if (key === "\u0003") {
      await post({ type: "reset" });
      console.log("\n  已退出。\n");
      process.exit(0);
    }

    const k = key.toLowerCase();

    if (k in held) {
      hold(k, () => (held[k] = true), () => (held[k] = false));
      return;
    }

    if (k === "q") {
      hold("q", () => (lookX = -1), () => (lookX = 0));
      return;
    }
    if (k === "z") {
      hold("z", () => (zoom = 1.2), () => (zoom = 0));
      return;
    }
    if (k === "x") {
      hold("x", () => (zoom = -1.2), () => (zoom = 0));
      return;
    }
    if (k === "r") {
      await post({ type: "reset" });
      console.log("  已重置");
      return;
    }
    if (k in KEY_ACTION) {
      await post({ type: "tap", name: KEY_ACTION[k] });
      console.log("  动作: " + KEY_ACTION[k]);
    }
  });

  /* 20Hz 心跳，保证长按状态在页面端不丢失 */
  setInterval(() => {
    if (held.w || held.a || held.s || held.d || held.shift) {
      push(held, lookX, zoom);
    }
  }, 50);
}

function push(held, lookX, zoom) {
  const moveX = (held.d ? 1 : 0) - (held.a ? 1 : 0);
  const moveY = (held.s ? 1 : 0) - (held.w ? 1 : 0);
  return post({
    type: "state",
    move: [moveX, moveY],
    look: [lookX, 0],
    zoom: zoom,
    hold: held.shift ? ["run"] : []
  });
}

/* ============================================================
 * 入口
 * ============================================================ */

(async () => {
  await guard();
  const mode = process.argv[2] || "repl";

  if (mode === "demo") {
    await demo();
    process.exit(0);
  }
  if (mode === "status") {
    console.log(JSON.stringify(await get("/status"), null, 2));
    process.exit(0);
  }
  await interactive();
})().catch((e) => {
  console.error("运行出错:", e.message);
  process.exit(1);
});
