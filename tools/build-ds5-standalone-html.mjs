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

/* 除了上面那四个"核心桥接"，index.html 里还挂着一批玩法脚本（双人、昼夜、星球切换、
   建造工坊……）。它们也必须内联，否则 file:// 下会被 CORS 拦掉，
   页面看着能开，实际渲染不出东西 —— 而且控制台报的是"Not allowed to load local resource"，
   跟"打包漏了"这个真因隔着一层，很容易查错方向。
   这份清单以前是硬编码的，新增脚本时没人回来改，结果漏了一大批。改成从 index.html 现读。 */
function bridgeScriptsInHtml(html) {
  const names = [];
  const re = /<script src="\.\/bridge\/([^"]+)"><\/script>/g;
  let m;
  while ((m = re.exec(html))) names.push(m[1]);
  return names;
}

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
/* 内联顺序以 index.html 为准，保证跟浏览器里加载的顺序完全一致 */
const inlineOrder = (() => {
  const inHtml = bridgeScriptsInHtml(html);
  assert(inHtml.length > 0, "index.html 里一个 bridge 脚本都没找到，是不是结构改过了？");
  for (const core of BRIDGE_SCRIPTS) {
    assert(inHtml.includes(core), `index.html 里缺少核心桥接脚本 ${core}`);
  }
  return inHtml;
})();

const bridgeBundles = inlineOrder.map((name) => {
  const file = path.join(SRC, "bridge", name);
  assert(fs.existsSync(file), `index.html 引用了 web/bridge/${name}，但文件不存在`);
  return `/* bridge/${name} */\n${safe(read(file))}`;
});

/* ---------- 3. 拼 HTML ---------- */
let out = html.replace(/\s*<link rel="modulepreload"[^>]*>/, "");

/* 样式表：index.html 现在不是写死的 <link rel="stylesheet">，而是在一段内联 JS 里
   运行时 createElement("link") 再 appendChild（为了按昼夜切主题）。
   所以不能只按 <link> 标签去找，得识别这段动态插入逻辑，把整个 IIFE 替换成
   一个"已经注入好样式"的桩 —— 离线版样式是内联的，不需要再发请求。 */
const CSS_HREF_RE = /css\.href\s*=\s*"\.\/assets\/"[^;]*;/;
const dynStyleOk = CSS_HREF_RE.test(out);
assert(
  dynStyleOk || /<link rel="stylesheet"[^>]*href="\.\/assets\//.test(out),
  "既没找到动态插入的样式表，也没找到 <link rel=\"stylesheet\">，index.html 的样式加载方式变了"
);

if (dynStyleOk) {
  /* 把动态插入样式的两行去掉（createElement + rel + crossOrigin + href），
     保留后面的 boot() 逻辑不动。 */
  out = out.replace(
    /var css = document\.createElement\("link"\);\s*css\.rel = "stylesheet";\s*css\.crossOrigin = "anonymous";\s*css\.href = "\.\/assets\/"[^;]*;\s*document\.head\.appendChild\(css\);/,
    "/* 样式已内联，离线版不需要动态插入 */"
  );
  assert(!/css\.href/.test(out), "动态插入样式的代码没被完整移除");
}

/* 游戏本体也是运行时动态插入的 <script type="module">。
   在 file:// 下 type="module" 会被 CORS 拦掉，所以把整段 boot() 变成空操作，
   游戏本体稍后以经典脚本的形式内联到 </body> 前。 */
const bootRe = /function boot\(\)\s*\{[\s\S]*?document\.head\.appendChild\(s\);\s*\}/;
assert(bootRe.test(out), "找不到动态插入游戏本体的 boot() 逻辑，index.html 结构变了");
out = out.replace(bootRe, "function boot() { /* 游戏本体已内联，离线版不动态加载 */ }");

/* 保险：这段 IIFE 里不能再残留指向 assets/ 的路径 */
assert(
  !/\.\/assets\//.test(out),
  "index.html 里仍有指向 assets/ 的引用，离线版加载不到：" +
    (out.match(/[^\s"']*\.\/assets\/[^\s"']*/) || [""])[0]
);

/* 离线没有后端可连：关掉 WebSocket，顺便关掉重复的顶部状态条 */
out = out.replace(
  /window\.LPControllerConfig\s*=\s*\{[^}]*\};/,
  "window.LPControllerConfig = { enableGamepad: false, hud: false, enableWs: false, telemetry: false };"
);
assert(/enableWs:\s*false/.test(out), "没能改写 LPControllerConfig");

/* 去掉外链脚本，换成内联 */
for (const name of inlineOrder) {
  const tag = new RegExp(`\\s*<script src="\\./bridge/${name.replace(".", "\\.")}"></script>`);
  assert(tag.test(out), `index.html 里找不到 <script src="./bridge/${name}">`);
  out = out.replace(tag, "");
}

const inline = bridgeBundles.map((code) => `    <script>\n${code}\n    </script>`).join("\n");

/* 样式内联到 </head> 前。index.html 原来那个动态 <link> 已经被移除，
   所以这里必须补上，否则页面会退化成白底无样式。 */
assert(out.includes("</head>"), "index.html 结构异常，没有 </head>");
out = out.replace("</head>", `    <style>\n${stylesheet}\n    </style>\n  </head>`);
assert(/<style>[\s\S]*?<\/style>/.test(out), "样式没内联成功");

assert(out.includes("</body>"), "index.html 结构异常，没有 </body>");
out = out.replace(
  "</body>",
  `${inline}\n    <script>\n${safe(gameBundle)}\n    </script>\n  </body>`
);

/* 兜底断言：所有 bridge 引用都必须已经变成内联。
   漏一个就会在 file:// 下被 CORS 拦掉，而且不报明显错误，只是画面出不来 —— 这正是之前漏掉
   六个脚本时的表现。构建时直接拦住，比等用户反馈"双击打不开"强。 */
const stillExternal = bridgeScriptsInHtml(out);
assert(
  stillExternal.length === 0,
  "还有 bridge 脚本没内联：" + stillExternal.join(", ")
);

fs.writeFileSync(OUT, out, "utf8");

const kb = (n) => (n / 1024).toFixed(0) + " KB";
const leftovers = externalScriptCount(out);
console.log("已生成 " + path.relative(ROOT, OUT));
console.log("  大小        " + kb(Buffer.byteLength(out)));
console.log("  内联脚本    " + inlineOrder.length + " 个：" + inlineOrder.join(" -> ") + " -> 游戏本体");
console.log("  外链残留    " + (leftovers ? `${leftovers} 个（异常）` : "无"));
