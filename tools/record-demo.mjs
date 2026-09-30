/*
 * record-demo.mjs —— 录制「收集积分 → 文字生成建筑 → 展示新物品」演示视频
 * ---------------------------------------------------------------------------
 * 用法：
 *   1) 先起服务（建议开小一点 mock 时长，进度条才好看）：
 *        TRIPO_MOCK_MS=900 node server/server.js
 *   2) 再录：
 *        node tools/record-demo.mjs [输出路径]
 *
 * 原理：Chrome headless + CDP
 *   - Page.startScreencast 抓真实渲染帧（比截图轮询帧率稳得多）
 *   - Runtime.evaluate 驱动页面，走 tripo-build.js 自己的 DOM 输入通道
 *   - Input.dispatchMouseEvent 拖拽鼠标转视角，把新建筑转到镜头前
 *   帧按 CDP 时间戳落盘，交给 ffmpeg 合成 30fps mp4。
 *
 * 三个踩过的坑（改参数前先看）：
 *   1. 不加 --use-angle=metal 会退回 SwiftShader 软件渲染，1280x720 只剩 5fps；
 *      加上之后跑满 60fps。
 *   2. jpeg quality 高于 75 会被编码拖死（85→15fps，75→60fps）。别贪画质。
 *   3. screencast 出来的视口高 633 是奇数，libx264 直接拒收，
 *      必须过一道 scale=trunc(iw/2)*2:trunc(ih/2)*2。
 *
 * 环境变量：
 *   LP_URL      页面地址，默认 http://localhost:8765/?build=1
 *   LP_CHROME   Chrome 可执行文件路径
 *   LP_FFMPEG   ffmpeg 路径
 *
 * 注意：如果服务端开了提示词缓存，同样的描述会秒回已有模型，视频里就看不到
 * 「生成中」过程了。重录前先清掉 web/models/buildings/index.json 里对应记录的
 * cacheKey 字段，让它老老实实走一遍生成。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.LP_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FFMPEG = process.env.LP_FFMPEG || "ffmpeg";
const FFMPEG_PROBE = FFMPEG.includes("/") ? FFMPEG.replace(/ffmpeg$/, "ffprobe") : "ffprobe";
const URL = process.env.LP_URL || "http://localhost:8765/?build=1";

const STAMP = Date.now().toString(36);
const PORT = 9400 + (Date.now() % 300);
const USER_DIR = path.join("/tmp", "lp-chrome-" + STAMP);
const FRAME_DIR = path.join("/tmp", "lp-frames-" + STAMP);
const OUT = process.argv[2] || path.join(ROOT, "docs", "tripo-build-demo.mp4");

fs.mkdirSync(FRAME_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  "--headless=new",
  "--remote-debugging-port=" + PORT,
  "--user-data-dir=" + USER_DIR,
  "--no-first-run", "--no-default-browser-check",
  "--window-size=1280,720",
  "--use-angle=metal", "--enable-unsafe-swiftshader",
  "--hide-scrollbars", "--disable-lcd-text",
  "--force-device-scale-factor=1",
  "about:blank"
], { stdio: "ignore" });
process.on("exit", () => { try { chrome.kill("SIGKILL"); } catch (e) {} });

async function waitDevtools() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return await r.json(); } catch (e) {}
    await sleep(300);
  }
  throw new Error("devtools 没起来，检查 Chrome 路径是否正确");
}
await waitDevtools();
const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = new WebSocket(tabs.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((res, rej) => { page.onopen = res; page.onerror = rej; });

let pid = 0;
const pending = new Map();
let recording = false;
let frameSeq = 0;
const frames = [];

page.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Page.screencastFrame") {
    const { data, sessionId, metadata } = m.params;
    if (recording) {
      const file = path.join(FRAME_DIR, "f" + String(frameSeq++).padStart(5, "0") + ".jpg");
      fs.writeFileSync(file, Buffer.from(data, "base64"));
      frames.push({ file, t: metadata.timestamp });
    }
    ps("Page.screencastFrameAck", { sessionId }).catch(() => {});
  }
};

function ps(method, params = {}) {
  const mid = ++pid;
  page.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((res) => pending.set(mid, res));
}
async function ev(expr) {
  const r = await ps("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) {
    throw new Error("页面报错: " + r.result.exceptionDetails.text + " " +
      (r.result.exceptionDetails.exception?.description || ""));
  }
  return r.result?.result?.value;
}
async function waitFor(expr, timeout, label) {
  const t0 = Date.now();
  for (;;) {
    if (await ev(expr)) return Date.now() - t0;
    if (Date.now() - t0 > timeout) throw new Error("等待超时: " + (label || expr));
    await sleep(40);
  }
}
async function drag(x0, y0, x1, y1, steps, durMs) {
  await ps("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; /* easeInOut，转起来才不僵 */
    await ps("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(x0 + (x1 - x0) * e),
      y: Math.round(y0 + (y1 - y0) * e),
      button: "left", buttons: 1
    });
    await sleep(durMs / steps);
  }
  await ps("Input.dispatchMouseEvent", { type: "mouseReleased", x: x1, y: y1, button: "left", buttons: 0, clickCount: 1 });
}

const T = {};
const mark = (k) => { T[k] = Date.now(); };

await ps("Page.enable");
await ps("Runtime.enable");

mark("nav");
await ps("Page.navigate", { url: URL });
await ev("new Promise(r=>{ if(document.readyState==='complete') r(1); else addEventListener('load',()=>r(1)); })");
await waitFor("!!(window.LPBuild && LPBuild.status().ready)", 30000, "LPBuild ready");
await sleep(3500); /* 等贴图/模型上完，别让开场画面是糊的 */

/* 清干净画面：隐藏手柄状态 HUD，重置积分与建筑，保证每次从 20 分开始 */
await ev(`(function(){
  var h = document.getElementById('ds5-hud'); if (h) h.style.display = 'none';
  localStorage.setItem('lp.tripo.credits.v1','20');
  localStorage.removeItem('lp.tripo.seen.v1');
  localStorage.setItem('lp.tripo.buildings.v1','[]');
  document.getElementById('collected-count').textContent = '0';
  var p = document.getElementById('tripo-panel'); if (p) p.classList.remove('is-open');
  return 1;
})()`);
await sleep(700);

/* ---------------- 开始录制 ---------------- */
mark("recStart");
recording = true;
await ps("Page.startScreencast", { format: "jpeg", quality: 75, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 });
await sleep(300);

/* 1) 展开建造面板 */
mark("panel");
await ev(`document.getElementById('tripo-panel').classList.add('is-open')`);
await sleep(650);

/* 2) 收集一个奇迹 → +30 积分
      #collected-count 上挂着 MutationObserver，改文本即刻触发，不用等 2 秒轮询 */
mark("collect");
await ev(`document.getElementById('collected-count').textContent = '1'`);
const collectLag = await waitFor(
  `(document.querySelector('#tripo-panel .tp-credits')||{}).textContent === '50'`, 3000, "积分涨到 50");
console.log("收集响应延迟", collectLag, "ms");
await sleep(Math.max(420, 1000 - collectLag * 0.45)); /* 留够时间看清 toast */

/* 3) 输入描述：房子 */
mark("type");
await ev(`(function(){var t=document.querySelector('#tripo-panel textarea');t.value='房';t.dispatchEvent(new Event('input',{bubbles:true}));return 1;})()`);
await sleep(300);
await ev(`(function(){var t=document.querySelector('#tripo-panel textarea');t.value='房子';t.dispatchEvent(new Event('input',{bubbles:true}));return 1;})()`);
await sleep(430);

/* 4) 点生成 → 扣 40 积分，进度条开始跑 */
mark("generate");
await ev(`document.querySelector('#tripo-panel .tp-go').click()`);
await sleep(350);

/* 5) 等模型落盘并摆上星球（前端 2 秒轮询一次，通常 2 秒多完成） */
mark("buildWait");
const buildLag = await waitFor(`LPBuild.status().buildings === 1`, 20000, "建筑出现");
console.log("生成+摆放耗时", buildLag, "ms");
mark("buildDone");
await sleep(420);

/* 6) 转视角展示新建筑 */
mark("showcase");
for (let i = 0; i < 3; i++) {
  /* deltaY 正值是拉远，负值才是拉近 */
  await ps("Input.dispatchMouseEvent", { type: "mouseWheel", x: 440, y: 330, deltaX: 0, deltaY: -120, button: "none", buttons: 0 });
  await sleep(95);
}
await sleep(180);
await drag(430, 300, 700, 274, 28, 1450);
await sleep(1250);

mark("recEnd");
recording = false;
await ps("Page.stopScreencast");
await sleep(150);
chrome.kill("SIGKILL");

/* ---------------- 合成视频 ---------------- */
const usable = frames.filter((f) => fs.existsSync(f.file));
if (usable.length < 30) throw new Error("帧太少（" + usable.length + "），录制可能失败");
console.log("抓到帧数:", usable.length);

let listTxt = "";
for (let i = 0; i < usable.length; i++) {
  const cur = usable[i];
  const next = usable[i + 1];
  const dur = next ? Math.max(0.008, Math.min(0.25, next.t - cur.t)) : 0.05;
  listTxt += `file '${cur.file}'\nduration ${dur.toFixed(4)}\n`;
}
listTxt += `file '${usable[usable.length - 1].file}'\n`;
fs.writeFileSync(path.join(FRAME_DIR, "list.txt"), listTxt, "utf8");

const span = usable[usable.length - 1].t - usable[0].t;
console.log("原始跨度:", span.toFixed(2), "秒 →", (usable.length / span).toFixed(1), "fps");

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const ff = spawn(FFMPEG, [
  "-y", "-f", "concat", "-safe", "0", "-i", path.join(FRAME_DIR, "list.txt"),
  "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
  "-fps_mode", "cfr", "-r", "30",
  "-c:v", "libx264", "-preset", "slow", "-crf", "20",
  "-pix_fmt", "yuv420p", "-movflags", "+faststart",
  OUT
], { stdio: "ignore" });
await new Promise((res, rej) => ff.on("close", (c) => (c === 0 ? res() : rej(new Error("ffmpeg 退出码 " + c)))));

const probe = await new Promise((res) => {
  const p = spawn(FFMPEG_PROBE, ["-v", "error", "-show_entries",
    "format=duration,size:stream=width,height,r_frame_rate,nb_frames", "-of", "json", OUT],
    { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.on("close", () => res(out));
});
console.log("输出:", OUT);
console.log(probe.trim());

console.log("\n各阶段耗时(秒):");
console.log("  面板展开      ", ((T.collect - T.panel) / 1000).toFixed(2));
console.log("  收集→打字     ", ((T.type - T.collect) / 1000).toFixed(2));
console.log("  打字→点生成   ", ((T.generate - T.type) / 1000).toFixed(2));
console.log("  生成+摆放     ", ((T.buildDone - T.generate) / 1000).toFixed(2));
console.log("  展示          ", ((T.recEnd - T.showcase) / 1000).toFixed(2));
console.log("  合计          ", ((T.recEnd - T.recStart) / 1000).toFixed(2));
process.exit(0);
