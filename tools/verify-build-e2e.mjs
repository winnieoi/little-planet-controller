/*
 * 建造工坊端到端验证：在真实浏览器里把「收集 → 生成 → 落盘 → 摆上星球」跑一遍，
 * 然后回到磁盘上核对索引，确认没有重复登记、缓存也真的复用。
 *
 *   node tools/verify-build-e2e.mjs
 *
 * 和 tests/test-tripo-cache.mjs 的分工：那边只打 HTTP 接口，不起浏览器；
 * 这边开真实 Chrome，验证前端（积分、面板、three.js 摆放）和服务端（落盘、索引）咬合得上。
 *
 * 三个坑，改参数前先看：
 *   1. 必须用 --use-angle=metal，否则走软件渲染，帧率从 60 掉到 5，脚本会误判超时
 *   2. screencast 的 jpeg quality 别超过 75，再高帧率会崩
 *   3. 截图高度必须是偶数，奇数会让 libx264 直接拒绝编码
 *
 * 安全：服务器用隔离的 /tmp 输出目录 + 端口 8802，并显式删掉 TRIPO_API_KEY 强制 mock，
 * 跑多少次都不会真扣费，也不会污染 web/models/buildings。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const NODE = process.execPath;

/* Chrome 路径：macOS 走默认安装位置，Linux/CI 用 CHROME_PATH 覆盖 */
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
/* 无头渲染后端：macOS 上 metal 最快，其他平台用各自默认值 */
const GL_ARGS = process.platform === "darwin" ? ["--use-angle=metal", "--enable-unsafe-swiftshader"] : [];

const PORT = Number(process.env.E2E_PORT || 8802);
const CDP_PORT = Number(process.env.E2E_CDP || 9333);
const MOCK_MS = Number(process.env.E2E_MOCK_MS || 900);
const OUT = process.env.E2E_OUT_DIR || mkdtempSync(path.join(tmpdir(), "lp-e2e-"));
const BASE = `http://127.0.0.1:${PORT}`;
const SHOT = process.env.E2E_SHOT || path.join(tmpdir(), "lp-e2e-shot.png");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(cond, label, detail) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? "  → " + detail : ""}`); }
  return !!cond;
}

/* ---------------- 起服务器（隔离目录 + mock 模式） ---------------- */
const server = spawn(NODE, [path.join(ROOT, "server", "server.js")], {
  cwd: ROOT,
  env: Object.assign({}, process.env, {
    PORT: String(PORT),
    TRIPO_OUT_DIR: OUT,
    TRIPO_MOCK_MS: String(MOCK_MS),
    TRIPO_API_KEY: undefined
  }),
  stdio: ["ignore", "pipe", "pipe"]
});
/* 上面给 TRIPO_API_KEY 传 undefined，spawn 会把它序列化成空串，hasKey() 仍为 false；
   保险起见再从环境里删掉 */
delete process.env.TRIPO_API_KEY;
server.stdout.on("data", () => {});
server.stderr.on("data", (d) => process.stderr.write("[server] " + d));
process.on("exit", () => { try { server.kill("SIGKILL"); } catch (e) {} });

for (let i = 0; i < 60; i++) {
  try { const c = await (await fetch(BASE + "/api/tripo/config")).json(); if (c.ok) break; } catch (e) {}
  await sleep(150);
}

/* ---------------- 开 Chrome ---------------- */
const USER_DIR = mkdtempSync(path.join(tmpdir(), "lp-e2e-chrome-"));
const chrome = spawn(CHROME, [
  "--headless=new",
  "--remote-debugging-port=" + CDP_PORT,
  "--user-data-dir=" + USER_DIR,
  "--no-first-run", "--no-default-browser-check",
  "--window-size=1280,720",
  ...GL_ARGS,
  "--hide-scrollbars",
  "--force-device-scale-factor=1",
  "about:blank"
], { stdio: "ignore" });
process.on("exit", () => { try { chrome.kill("SIGKILL"); } catch (e) {} });

for (let i = 0; i < 80; i++) {
  try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) break; } catch (e) {}
  await sleep(300);
}
const tabs = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = new WebSocket(tabs.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((res, rej) => { page.onopen = res; page.onerror = rej; });

let mid = 0;
const pending = new Map();
page.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const ps = (method, params = {}) => {
  const id = ++mid;
  page.send(JSON.stringify({ id, method, params }));
  return new Promise((res) => pending.set(id, res));
};
async function ev(expr) {
  const r = await ps("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) {
    throw new Error("页面报错: " + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
  }
  return r.result?.result?.value;
}
async function waitFor(expr, timeout, label) {
  const t0 = Date.now();
  for (;;) {
    if (await ev(expr)) return Date.now() - t0;
    if (Date.now() - t0 > timeout) throw new Error("等待超时: " + (label || expr));
    await sleep(50);
  }
}

try {
  await ps("Page.enable");
  await ps("Runtime.enable");
  await ps("Page.navigate", { url: BASE + "/?build=1" });
  await waitFor("!!(window.LPBuild && LPBuild.status().ready)", 30000, "LPBuild ready");

  /* 清掉上一次的存档，保证是干净的第一局 */
  await ev(`(function(){
    localStorage.removeItem('lp.tripo.credits.v1');
    localStorage.removeItem('lp.tripo.buildings.v1');
    localStorage.removeItem('lp.tripo.seen.v1');
    document.getElementById('collected-count').textContent = '0';
    return 1;
  })()`);
  await sleep(600);

  console.log("\n[开局]");
  check((await ev(`LPBuild.status().credits`)) === 20, "初始积分 20");
  check((await ev(`LPBuild.status().buildings`)) === 0, "场上还没有建筑");

  /* 收集 3 次：20 → 110，够造两座（每座 40） */
  console.log("\n[收集]");
  for (let n = 1; n <= 3; n++) {
    await ev(`document.getElementById('collected-count').textContent = '${n}'`);
    await sleep(200);
  }
  const credits = await ev(`LPBuild.status().credits`);
  check(credits === 110, "收集 3 次后积分 110", String(credits));

  /* 第一次生成 */
  console.log("\n[第一次生成]");
  await ev(`(function(){
    var t = document.querySelector('#tripo-panel textarea');
    t.value = '端到端验证塔';
    t.dispatchEvent(new Event('input', { bubbles: true }));
    return 1;
  })()`);
  await sleep(250);
  await ev(`document.querySelector('#tripo-panel .tp-go').click()`);
  const lag1 = await waitFor("LPBuild.status().buildings === 1", 30000, "第一座建筑出现");
  console.log(`  生成+摆放耗时 ${lag1} ms`);
  check((await ev(`LPBuild.status().credits`)) === 70, "扣掉 40，剩 70");

  /* 第二次：同样描述，应当命中缓存 —— 不产生新文件，但照样扣分并摆一座 */
  console.log("\n[第二次同描述生成（应命中缓存）]");
  await ev(`(function(){
    var t = document.querySelector('#tripo-panel textarea');
    t.value = '端到端验证塔';
    t.dispatchEvent(new Event('input', { bubbles: true }));
    return 1;
  })()`);
  await sleep(250);
  await ev(`document.querySelector('#tripo-panel .tp-go').click()`);
  const lag2 = await waitFor("LPBuild.status().buildings === 2", 30000, "第二座建筑出现");
  console.log(`  缓存命中耗时 ${lag2} ms（应明显短于首次）`);
  check(lag2 < lag1, "缓存命中比首次快", `${lag2}ms vs ${lag1}ms`);
  check((await ev(`LPBuild.status().credits`)) === 30, "再扣 40，剩 30");

  /* 回磁盘核对 —— 这一整段就是为之前那个「重复登记」的 bug 准备的 */
  console.log("\n[磁盘核对]");
  const glbs = readdirSync(OUT).filter((f) => f.endsWith(".glb") && !f.startsWith("mock_"));
  check(glbs.length === 1, "磁盘上只有 1 个建筑 GLB（缓存复用没有重复落盘）", glbs.join(","));

  const idx = JSON.parse(readFileSync(path.join(OUT, "index.json"), "utf8"));
  const real = idx.filter((b) => !String(b.file).startsWith("mock_"));
  check(real.length === 1, "索引里只有 1 条建筑记录（没有重复登记）", `实得 ${real.length} 条`);
  check(!!real[0] && !!real[0].cacheKey, "记录带缓存键", real[0] && real[0].cacheKey);
  check(!!real[0] && real[0].cacheKey.indexOf("端到端验证塔") === 0, "缓存键以描述开头", real[0] && real[0].cacheKey);
  check(!!real[0] && !!real[0].prompt, "记录里有描述（不是空 prompt 的桩记录）", JSON.stringify(real[0] && real[0].prompt));

  /* 模型要能通过 HTTP 取到，前端才摆得上去。这条专门盯 TRIPO_OUT_DIR 的坑：
     输出目录被指到别处时，/models/buildings/ 必须跟着走，不能还去查 web/ 静态目录 */
  console.log("\n[模型可取]");
  const r = await fetch(BASE + "/models/buildings/" + real[0].file);
  check(r.ok, "输出目录里的模型能通过 URL 取到", "status " + r.status);
  if (r.ok) {
    const buf = Buffer.from(await r.arrayBuffer());
    check(buf.readUInt32LE(0) === 0x46546c67, "取到的是合法 GLB");
    check(
      /gltf-binary|octet-stream/.test(r.headers.get("content-type") || ""),
      "Content-Type 是模型类型",
      r.headers.get("content-type")
    );
  }
  /* 顺手确认目录穿越被挡住 */
  const evil = await fetch(BASE + "/models/buildings/..%2f..%2f..%2fpackage.json");
  check(!evil.ok, "目录穿越请求被挡住", "status " + evil.status);

  /* 刷新后应当恢复出两座建筑 */
  console.log("\n[刷新持久化]");
  await ps("Page.navigate", { url: BASE + "/?build=1" });
  await waitFor("!!(window.LPBuild && LPBuild.status().ready)", 30000, "LPBuild ready（刷新后）");
  await sleep(1200);
  const after = await ev(`LPBuild.status().buildings`);
  check(after === 2, "刷新后仍恢复出 2 座建筑", String(after));
  const creditsAfter = await ev(`LPBuild.status().credits`);
  check(creditsAfter === 30, "积分也保留为 30", String(creditsAfter));

  /* 留个截图当证据 */
  const shot = await ps("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(SHOT, Buffer.from(shot.result.data, "base64"));
  console.log(`\n截图: ${SHOT}`);
} catch (e) {
  failures++;
  console.log("\n✗ 过程抛异常: " + (e && e.stack ? e.stack : e));
} finally {
  try { chrome.kill("SIGKILL"); } catch (e) {}
  try { server.kill("SIGKILL"); } catch (e) {}
  if (process.env.E2E_KEEP !== "1") {
    /* Chrome 退出时可能还在写 profile，直接删会 ENOTEMPTY，失败就算了别影响结论 */
    for (const d of [OUT, USER_DIR]) {
      try { rmSync(d, { recursive: true, force: true }); } catch (e) {}
    }
  }
}

console.log("\n" + "=".repeat(56));
console.log(failures === 0 ? "端到端验证全部通过" : `有 ${failures} 项失败`);
process.exit(failures ? 1 : 0);
