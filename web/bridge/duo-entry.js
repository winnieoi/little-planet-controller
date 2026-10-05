/* ============================================================
 * duo-entry.js —— 双人合作模式入口（单人玩法）
 * ------------------------------------------------------------
 * 在单人页面右上角画一个「👥 双人模式」按钮，一键进入
 * 双人分屏（./duo.html），当前昼夜主题跟着带过去。
 *
 * 按钮与昼夜切换按钮（day-night.js）并排放在同一个
 * 容器 #duo-entry-wrap 里；day-night.js 的 mount 会优先
 * 找这个容器，找不到才独立绝对定位（向后兼容）。
 *
 * 分屏座位（?seat=N）里不画：座位是 iframe，宿主页已经有入口。
 * ============================================================ */
(function () {
  "use strict";

  var params = new URLSearchParams(location.search);
  if (params.get("seat")) return; /* 座位侧不显示 */

  /* 入口容器：右上角，顶栏与手记胶囊之间（与原昼夜按钮同一位置） */
  var wrap = document.createElement("div");
  wrap.id = "duo-entry-wrap";

  var link = document.createElement("a");
  link.id = "duo-entry-link";
  /* 当前星球与昼夜主题都带进双人模式，进来是什么样就是什么样 */
  var carry = [];
  if (params.get("theme") === "day") carry.push("theme=day");
  if (params.get("planet") === "cyber") carry.push("planet=cyber");
  link.href = "./duo.html" + (carry.length ? "?" + carry.join("&") : "");
  link.textContent = "👥 双人模式";
  link.title = "一块屏幕，两位玩家：分屏合作版（P1 键鼠 + P2 手柄）";
  link.setAttribute("aria-label", link.title);

  var css = [
    /* 容器：flex 横排，按钮共用一套玻璃样式 */
    "#duo-entry-wrap{position:absolute;top:66px;right:36px;z-index:40;",
    /* flex-wrap + justify-content:flex-end：窄屏放不下时整排往下折行、右对齐，
       不要横向溢出到屏幕外（按钮 flex:none 之后就不再自己缩了） */
    "display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:8px;}",
    /* position:static 是必需的，不是保险：后面几个桥接脚本（planet-switch、
       tripo-build、bgm）画出来的按钮都自带 position:absolute + top/right，
       那是给"没有容器时独立摆放"用的。进了容器不重置的话，它们脱离 flex 流，
       全部叠在容器右下角互相压住（实测 #planet-toggle 与 #tripo-build-btn
       重叠在 y=132 那一行）。这里的选择器带了 id + 元素名，比它们各自的
       #id 选择器多一个元素权重，所以不论样式表先后都能压住。 */
    "#duo-entry-wrap > a,#duo-entry-wrap > button{",
    "position:static;right:auto;top:auto;",
    /* flex:none + nowrap：窄屏放不下时整块换行，不要压缩按钮
       —— 否则「白天」会被拆成「白/天」两行、按钮高度参差不齐 */
    "flex:none;white-space:nowrap;",
    "display:inline-flex;align-items:center;gap:6px;",
    "font:inherit;font-size:12px;letter-spacing:.5px;cursor:pointer;",
    "color:var(--muted);background:var(--glass);",
    "border:1px solid var(--line);border-radius:9px;padding:7px 12px;",
    "text-decoration:none;",
    "-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);",
    "transition:color .2s,border-color .2s;}",
    "#duo-entry-wrap > a:hover,#duo-entry-wrap > button:hover{",
    "color:var(--accent);border-color:var(--accent);}",
    /* 让开游戏自己的「小小奇迹」胶囊（aside.journal-pill）。
       胶囊是水平居中的，视口一窄就向右压进按钮排的地盘 —— 实测 560~1024px
       都有重叠（到 1280px 才错开），不是只有手机。胶囊的纵向位置在 760px
       处从 y77-129 变成 y28-80，所以这里分两档跟着往下让。
       档位不是拍脑袋：按钮排宽 436px、右距 36px，胶囊宽 188px 且居中，
       两者在 top 相同的情况下要 视口 ≥ 1132px 才错得开（实测 1100 仍压着 16px）。
       取 1200 留点余量给字号/字体差异。 */
    "@media (max-width:1199px){#duo-entry-wrap{top:92px;}}",
    "@media (max-width:759px){#duo-entry-wrap{top:140px;}}",
    /* day-night 的按钮原本是独立绝对定位；进了容器就交给 flex（上面已通用处理，这里留个明确记录） */
    "#duo-entry-wrap > button#day-night-toggle{position:static;right:auto;top:auto;}",
    /* 入口按钮稍微强调一点，让人一眼看见 */
    "#duo-entry-link{color:var(--accent);border-color:var(--line);}",
    "#duo-entry-link:hover{border-color:var(--accent);}",
  ].join("");

  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  wrap.appendChild(link);

  function mount() {
    var app = document.getElementById("app") || document.body;
    app.appendChild(wrap);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
