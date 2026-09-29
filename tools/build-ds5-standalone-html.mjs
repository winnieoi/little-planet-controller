/*
 * 把 web/ 打包成一个「双击就能玩、并且带 DS5 适配」的单文件 HTML。
 *
 *   node tools/build-ds5-standalone-html.mjs
 *   -> 赛博小星球-DS5离线版.html
 *
 * 和 little-planet/tools/build-standalone-html.mjs 的区别：那个只打包游戏本体，
 * 这个额外把 web/bridge/ 下的四个脚本也内联进去（顺序与 web/index.html 一致），
 * 并把后端 WebSocket 关掉 —— 离线打开时没有服务器可连，不关会每 2 秒重连一次刷控制台。
 *
 * 注意：file:// 也属于安全上下文，所以 WebHID（灯条 / 自适应扳机）在离线版里同样可用。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "web");
const OUT = path.join(ROOT, "赛博小星球-DS5离线版.html");

/* 顺序必须和 web/index.html 里一致，改了这里也要改那里（tests/test-page-wiring.mjs 会盯着） */
const BRIDGE_SCRIPTS = ["lp-controller.js", "dualsense.js", "lp-dualsense.js", "ds5-adapter.js"];

function read(p) {
  return fs.readFileSync(p, "utf8");
}

/* JS 里理论上不该出现 </script，但真的出现就会把 HTML 截断 */
function safe(code) {
  return code.replace(/<\/script/gi, "<\\/script");
}

/* 数一数"真正的"外链 <script src=...>。
   不能直接在整个文件里搜 ——— 内联进来的 ds5-adapter.js 头部注释里就写着
   <script src="./bridge/...">（那是文档），会被误判。先把 <script>…</script>
   整块挖掉再数。内联时已经把所有 </script 转义成 <\/script，所以挖块是安全的。 */
function externalScriptCount(html) {
  const stripped = html.replace(/<script[\s\S]*?<\/script>/gi, "<script></script>");
  return (stripped.match(/<script[^>]*\ssrc=/gi) || []).length;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const html = read(path.join(SRC, "index.html"));
const appScript = read(path.join(SRC, "assets/index-CS6g4Xtd.js"));
const threeScript = read(path.join(SRC, "assets/three-gtj_l2uB.js"));
const stylesheet = read(path.join(SRC, "assets/index-CundtmH4.css"));

/* ---------- 1. 游戏本体：把 ES module 拆成一个普通 <script> ---------- */
const appImportMatch = appScript.match(/^import\{([^}]+)\}from"\.\/three-[^"]+\.js";/);
const threeExportMatch = threeScript.match(/export\{([^}]+)\};?\s*$/);
assert(appImportMatch, "找不到游戏脚本里的 Three.js import 声明");
assert(threeExportMatch, "找不到 Three.js 的 export 声明");

const exportedIdentifiers = new Map(
  threeExportMatch[1].split(",").map((entry) => {
    const [internalName, publicName = internalName] = entry.trim().split(/\s+as\s+/);
    return [publicName, internalName];
  })
);

const aliases = appImportMatch[1].split(",").map((entry) => {
  const [publicName, localName = publicName] = entry.trim().split(/\s+as\s+/);
  const internalName = exportedIdentifiers.get(publicName);
  assert(internalName, `Three.js 缺少导出：${publicName}`);
  return `${publicName}:${localName}`;
});

const threeExports = [...exportedIdentifiers]
  .map(([publicName, internalName]) => `${publicName}:${internalName}`)
  .join(",");

const gameBundle = [
  "const __littlePlanetThree=(()=>{",
  threeScript.slice(0, threeExportMatch.index),
  `return{${threeExports}};`,
  "})();",
  `const{${aliases.join(",")}}=__littlePlanetThree;`,
  appScript.slice(appImportMatch[0].length)
].join("\n");

/* ---------- 2. 桥接层：原样内联，只加一行注释标注来源 ---------- */
const bridgeBundles = BRIDGE_SCRIPTS.map((name) => {
  const file = path.join(SRC, "bridge", name);
  assert(fs.existsSync(file), `缺少 web/bridge/${name}`);
  return `/* bridge/${name} */\n${safe(read(file))}`;
});

/* ---------- 3. 拼 HTML ---------- */
let out = html
  .replace(/\s*<script type="module"[^>]*src="\.\/assets\/index-[^"]+\.js"><\/script>/, "")
  .replace(/\s*<link rel="modulepreload"[^>]*>/, "")
  .replace(
    /\s*<link rel="stylesheet"[^>]*href="\.\/assets\/index-[^"]+\.css">/,
    `\n    <style>${stylesheet}</style>`
  );

/* 离线没有后端可连：关掉 WebSocket，顺便关掉重复的顶部状态条 */
out = out.replace(
  /window\.LPControllerConfig\s*=\s*\{[^}]*\};/,
  "window.LPControllerConfig = { enableGamepad: false, hud: false, enableWs: false, telemetry: false };"
);
assert(/enableWs:\s*false/.test(out), "没能改写 LPControllerConfig");

/* 去掉四个外链脚本，换成内联 */
for (const name of BRIDGE_SCRIPTS) {
  const tag = new RegExp(`\\s*<script src="\\./bridge/${name.replace(".", "\\.")}"></script>`);
  assert(tag.test(out), `index.html 里找不到 <script src="./bridge/${name}">`);
  out = out.replace(tag, "");
}

const inline = bridgeBundles.map((code) => `    <script>\n${code}\n    </script>`).join("\n");

assert(out.includes("</body>"), "index.html 结构异常，没有 </body>");
out = out.replace(
  "</body>",
  `${inline}\n    <script>\n${safe(gameBundle)}\n    </script>\n  </body>`
);

fs.writeFileSync(OUT, out, "utf8");

const kb = (n) => (n / 1024).toFixed(0) + " KB";
const leftovers = externalScriptCount(out);
console.log("已生成 " + path.relative(ROOT, OUT));
console.log("  大小        " + kb(Buffer.byteLength(out)));
console.log("  内联顺序    " + BRIDGE_SCRIPTS.join(" -> ") + " -> 游戏本体");
console.log("  外链残留    " + (leftovers ? `${leftovers} 个（异常）` : "无"));
