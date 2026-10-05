/* ============================================================
 * planet-switch.js —— 星球切换（原版 ↔ 赛博星球）
 * ------------------------------------------------------------
 * 原版星球是游戏本体的程序化地表；赛博星球是 57MB GLB 高精度模型
 * （web/models/cyber-planet.glb），由 web/integration/ 集成层在
 * ?planet=cyber 时接入 —— 隐藏原地表、摆放模型，角色 / 碰撞 /
 * 寻路 / 交互点 / 手柄 / 双人全部沿用原游戏逻辑。
 *
 * 本层只做一件事：右上角一个按钮，点击 = 换 ?planet 参数后整页
 * 重载（存档在 localStorage，不丢；两颗星球共用同一份进度）。
 *
 * 分屏座位（?seat=N）里不画按钮：双人模式选星球由宿主页 duo.html
 * 统一做，两个画面必须同时切换。
 * ============================================================ */
(function () {
  "use strict";

  var params = new URLSearchParams(location.search);
  if (params.get("seat")) return; /* 座位侧交给宿主页 */

  var cyber = params.get("planet") === "cyber";

  var btn = document.createElement("button");
  btn.type = "button";
  btn.id = "planet-toggle";
  btn.textContent = cyber ? "🪐 原版星球" : "🪐 赛博星球";
  btn.title = cyber
    ? "回到原版星球（低多边形霓虹小岛，切换会重新加载画面，进度不丢）"
    : "前往赛博星球（高精度模型，首次加载 57MB 需等待，进度不丢）";
  btn.setAttribute("aria-label", btn.title);
  btn.addEventListener("click", function () {
    if (cyber) params.delete("planet");
    else params.set("planet", "cyber");
    location.search = params.toString(); /* 整页重载；存档不受影响 */
  });

  var css = [
    "#planet-toggle{position:absolute;top:66px;right:36px;z-index:40;",
    "display:inline-flex;align-items:center;gap:6px;",
    "font:inherit;font-size:12px;letter-spacing:.5px;cursor:pointer;",
    "color:var(--muted);background:var(--glass);",
    "border:1px solid var(--line);border-radius:9px;padding:7px 12px;",
    "-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);",
    "transition:color .2s,border-color .2s;}",
    "#planet-toggle:hover{color:var(--accent);border-color:var(--accent);}",
  ].join("");

  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  function mount() {
    /* 进双人入口的容器（#duo-entry-wrap），和「双人模式」「昼夜」按钮并排；
       day-night.js 也在找这个容器，先后无妨 —— appendChild 保序。 */
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
