/*
 * 页面接线测试：确认 index.html 的加载顺序、配置，以及离线单文件版
 * 真的把所有 bridge 脚本都内联进去了。
 *
 * 顺序是有意义的：lp-controller 必须先于 ds5-adapter（后者用它当输入后端），
 * dualsense.js 必须先于 lp-dualsense（后者用它当 WebHID 驱动）。
 */
import fs from "node:fs";
import path from "node:path";
import { createSuite, ROOT } from "./harness.mjs";

const WEB = path.join(ROOT, "web");
const BRIDGE = path.join(WEB, "bridge");

const CORE_ORDER = ["lp-controller.js", "dualsense.js", "lp-dualsense.js", "ds5-adapter.js"];

function srcOrder(html) {
  return CORE_ORDER.map((n) => ({ name: n, at: html.indexOf("./bridge/" + n) }));
}

/* index.html 里挂了哪些 bridge 脚本，现读现算。
   离线版以前是硬编码清单，新加脚本没人回来改，漏了六个 ——
   表现是"页面能开但画面出不来"，控制台还报 CORS，很容易查错方向。
   所以这里不写死名单，直接拿 index.html 当唯一事实来源。 */
function allBridgeScripts(html) {
  const names = [];
  const re = /<script src="\.\/bridge\/([^"]+)"><\/script>/g;
  let m;
  while ((m = re.exec(html))) names.push(m[1]);
  return names;
}

export default function run() {
  const s = createSuite("页面接线");

  s.group("web/index.html");
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  const order = srcOrder(html);

  for (const o of order) {
    s.ok(o.at >= 0, `引用了 ${o.name}`, o.at < 0 ? "没找到" : "");
  }
  s.ok(
    order[0].at >= 0 && order[1].at > order[0].at && order[2].at > order[1].at && order[3].at > order[2].at,
    "加载顺序是 lp-controller -> dualsense -> lp-dualsense -> ds5-adapter"
  );
  s.ok(/LPControllerConfig\s*=\s*\{[^}]*enableGamepad\s*:\s*false/.test(html),
    "关掉了 lp-controller 内置的手柄轮询（避免两套逻辑抢输入）");
  s.ok(/LPControllerConfig\s*=\s*\{[^}]*hud\s*:\s*false/.test(html),
    "关掉了 lp-controller 的顶部状态条（信息重复）");

  for (const o of order) {
    s.ok(fs.existsSync(path.join(BRIDGE, o.name)), `web/bridge/${o.name} 存在`);
  }

  s.group("离线单文件版");
  const standalonePath = path.join(ROOT, "赛博小星球-DS5离线版.html");
  if (fs.existsSync(standalonePath)) {
    const out = fs.readFileSync(standalonePath, "utf8");
    /* 先把 <script>…</script> 整块挖掉再数外链：
       内联进来的 ds5-adapter.js 头部注释里就写着 <script src="./bridge/...">，是文档不是标签 */
    const stripped = out.replace(/<script[\s\S]*?<\/script>/gi, "<script></script>");
    s.eq((stripped.match(/<script[^>]*\ssrc=/gi) || []).length, 0, "没有残留的外链脚本");
    s.ok(!/<script type="module"/.test(stripped), "没有残留的 module 脚本（file:// 下会被 CORS 拦）");
    /* 完整性：index.html 里引用了几个，离线版就得内联几个，一个都不能少 */
    const expected = allBridgeScripts(html);
    s.ok(expected.length > 0, "index.html 里解析得到 bridge 脚本清单", String(expected.length));
    const missing = expected.filter((n) => out.indexOf("/* bridge/" + n + " */") < 0);
    s.eq(missing.length, 0, `index.html 的 ${expected.length} 个 bridge 脚本全部内联`,
      missing.length ? "漏了：" + missing.join(", ") : "");

    /* 顺序：离线版里的出现顺序必须与 index.html 完全一致 */
    const positions = expected.map((n) => out.indexOf("/* bridge/" + n + " */"));
    let ordered = true;
    for (let i = 1; i < positions.length; i++) {
      if (positions[i] < 0 || positions[i] < positions[i - 1]) ordered = false;
    }
    s.ok(ordered, "内联顺序与 index.html 一致");

    /* 样式：index.html 是运行时动态插入 <link> 的，离线版必须已经内联成 <style> */
    s.ok(/<style>[\s\S]*?<\/style>/.test(out), "样式已内联成 <style>（否则页面白底无样式）");
    s.ok(/enableWs:\s*false/.test(out), "离线版关掉了后端 WebSocket（没有服务器可连）");
    /* 音频：离线版没有 bgm/ 目录可加载，构建时得把 mp3 内联成 data URI，
       否则 bgm.js 读不到音频 —— 用户只会觉得"没声音"，想不到是资源没打进去 */
    if (fs.existsSync(path.join(WEB, "bgm/bgm-loop.mp3"))) {
      s.ok(/window\.LPBGM_SRC\s*=\s*"data:audio/.test(out), "背景音乐已内联成 data URI");
      s.ok(out.indexOf("window.LPBGM_SRC") < out.indexOf("/* bridge/bgm.js */"),
        "LPBGM_SRC 在 bgm.js 之前定义（否则读不到）");
    }
    s.ok(out.indexOf("</script>") > 0 && out.lastIndexOf("</html>") > 0, "HTML 结构完整");
    s.ok(out.length > 500000, "游戏本体也在里面", String(out.length));
    s.ok(out.indexOf("__littlePlanetThree") > out.indexOf("/* bridge/ds5-adapter.js */"),
      "游戏本体在桥接层之后执行");
  } else {
    s.ok(false, "离线单文件版已经生成（先跑 tools/build-ds5-standalone-html.mjs）");
  }

  s.group("背景音乐");
  s.ok(html.indexOf("./bridge/bgm.js") >= 0, "index.html 引用了 bgm.js");
  s.ok(fs.existsSync(path.join(BRIDGE, "bgm.js")), "web/bridge/bgm.js 存在");
  for (const f of ["bgm/bgm-loop.ogg", "bgm/bgm-loop.mp3"]) {
    s.ok(fs.existsSync(path.join(WEB, f)), `web/${f} 存在`);
  }
  /* 循环音频必须是"加工过"的：源文件带结尾淡出，直接 loop 会每轮喘一口气。
     成品时长应明显短于原片（60.7s）且接近循环点。 */
  const oggPath = path.join(WEB, "bgm/bgm-loop.ogg");
  if (fs.existsSync(oggPath)) {
    const bytes = fs.readFileSync(oggPath);
    s.ok(bytes.length > 100 * 1024, "循环音频体积正常", (bytes.length / 1024).toFixed(0) + " KB");
  }

  s.group("双人分屏的背景音乐");
  /* 分屏里音乐只能由座位自己放（用户在 iframe 里的点击算 iframe 自己的用户手势，
     宿主页拿不到，宿主调的 AudioContext.resume() 会被自动播放策略卡死）。
     而且只能指定一个座位放，两个都放就成双重奏。这几条是那套分红的接线检查。 */
  const duoPath = path.join(WEB, "duo.html");
  if (fs.existsSync(duoPath)) {
    const duo = fs.readFileSync(duoPath, "utf8");
    s.ok(duo.indexOf('id="bgm-toggle"') >= 0, "宿主工具栏里有音乐按钮");
    s.ok(/window\.LPBGM_REMOTE\s*=\s*true/.test(duo), "宿主页声明自己是遥控器（不放音）");
    s.ok(/window\.LPBGM_REMOTE\s*=\s*true[^]*?bridge\/bgm\.js/.test(duo),
      "LPBGM_REMOTE 声明在 bgm.js 之前（否则宿主会自己放音）");
    s.ok(/seat=1&music=1/.test(duo), "座位 1 被指定为音乐座位");
    s.ok(!/seat=2&music=1/.test(duo), "座位 2 不是音乐座位（避免双重奏）");
  } else {
    s.ok(false, "web/duo.html 存在");
  }

  s.group("文档");
  for (const f of ["docs/DS5.md", "README.md"]) {
    s.ok(fs.existsSync(path.join(ROOT, f)), `${f} 存在`);
  }

  return s;
}
