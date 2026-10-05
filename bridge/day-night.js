/* ============================================================
 * day-night.js —— 昼夜一键切换（单人玩法）
 * ------------------------------------------------------------
 * 两种星球、两套切法，按钮只有一个：
 *
 *   原版星球（默认）：昼夜两版资源是同一构建的两套主题常量（白天版
 *   由官方昼夜配色逐项映射生成，游戏本体文件一行未动）。点击 = 换
 *   ?theme 参数后整页重载 —— 存档在 localStorage，不丢。
 *
 *   赛博星球（?planet=cyber）：昼夜由集成层 daylight-mode.js 运行时
 *   切换（贴图 / 灯光 / 天空 / 雾四件一起换）。点击 = 调
 *   window.LPDaylight.toggle()，不重载页面；按钮文字跟着
 *   lp-daylight-change 事件走。它自带的那个按钮藏掉，统一用这个。
 *
 * 分屏座位（?seat=N）里不画按钮：双人模式切时间由宿主页 duo.html
 * 统一做，两个画面必须同时切换。
 * ============================================================ */
(function () {
  "use strict";

  var params = new URLSearchParams(location.search);
  if (params.get("seat")) return; /* 座位侧交给宿主页 */

  var cyber = params.get("planet") === "cyber";
  var day = params.get("theme") === "day";

  /* 浏览器 UI 色（手机地址栏等）跟着主题走（原版星球专用） */
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta && day && !cyber) meta.setAttribute("content", "#d4e8d0");

  /* 位置：右上角，顶栏（top:29 一带）与手记胶囊（top:98）之间 */
  var btn = document.createElement("button");
  btn.type = "button";
  btn.id = "day-night-toggle";

  function setText(isDay) {
    btn.textContent = isDay ? "🌙 夜晚" : "☀️ 白天";
  }

  if (cyber) {
    /* 赛博星球：daylight-mode.js 默认白天，运行时切换，不重载。
       它自己的按钮（#lp-mode-toggle）藏掉，统一入口。 */
    setText(true);
    btn.title = "一键切换昼夜（赛博星球：贴图 / 灯光 / 天空 / 雾一起换，不重载）";
    btn.setAttribute("aria-label", btn.title);
    btn.addEventListener("click", function () {
      if (window.LPDaylight) window.LPDaylight.toggle();
    });
    window.addEventListener("lp-daylight-change", function (e) {
      setText(!!(e.detail && e.detail.mode === "day"));
    });
    var hideOwn = document.createElement("style");
    hideOwn.textContent = "#lp-mode-toggle{display:none!important;}";
    document.head.appendChild(hideOwn);
  } else {
    setText(day);
    btn.title = "一键切换昼夜（会重新加载画面，探索进度不会丢）";
    btn.setAttribute("aria-label", btn.title);
    btn.addEventListener("click", function () {
      if (day) params.delete("theme");
      else params.set("theme", "day");
      var q = params.toString();
      location.search = q; /* 整页重载；手记存于 localStorage，不受影响 */
    });
  }

  var css = [
    "#day-night-toggle{position:absolute;top:66px;right:36px;z-index:40;",
    "display:inline-flex;align-items:center;gap:6px;",
    "font:inherit;font-size:12px;letter-spacing:.5px;cursor:pointer;",
    "color:var(--muted);background:var(--glass);",
    "border:1px solid var(--line);border-radius:9px;padding:7px 12px;",
    "-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);",
    "transition:color .2s,border-color .2s;}",
    "#day-night-toggle:hover{color:var(--accent);border-color:var(--accent);}",
  ].join("");

  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  function mount() {
    /* 优先进双人入口的容器（#duo-entry-wrap），和「双人模式」按钮并排；
       容器里定位交给 flex，原绝对定位由 duo-entry.js 的样式覆盖掉。 */
    var wrap = document.getElementById("duo-entry-wrap");
    if (wrap) {
      wrap.appendChild(btn);
      return;
    }
    var app = document.getElementById("app") || document.body;
    app.appendChild(btn);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
