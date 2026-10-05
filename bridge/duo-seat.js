/*!
 * duo-seat.js —— 分屏双人的「座位」侧接线（v1.0.0）
 *
 * 只有当 URL 带 ?seat=N 时才生效。普通单人玩法下这个文件直接退出，
 * 一行副作用都不留。
 *
 *   0. 硬件输出层只留一个座位 —— 灯条 / 自适应扳机走 WebHID，而 WebHID 的设备
 *      每个 document 各一份，两个 iframe 同时写同一只手柄会互相覆盖
 *   1. 存档按座位隔离 —— 两个实例各存各的进度，不会互相覆盖
 *   2. 手柄由别处送进来 —— 收到快照就用快照，并把震动代理回真正持柄的那一侧；
 *      一直收不到就按同一套归属规则自己读，宿主没开也不会瘫
 *   3. 座位 2 屏蔽本机键盘 —— 键鼠永远只控制座位 1
 *   4. 上报坐标与收集进度 —— 给宿主的「队友方位」用
 *
 * 必须最先加载：存档隔离与输出层归属都要赶在游戏/输出层脚本执行之前。
 */
(function () {
  "use strict";

  var seat = readSeat();
  if (!seat) return;

  var Pads = window.DuoPads;
  if (!Pads) {
    console.warn("[duo] 缺少 duo-pads.js，双人座位接线已跳过");
    return;
  }

  var JOURNAL_KEY = "little-planet-journal-v2";
  var PREFIX = "duo:" + seat + ":";
  var SOURCE_TTL = 800;

  /* 硬件输出层（灯条 / 自适应扳机 / 连续振动底噪）的独占座位。
     座位 2 是默认持柄方 —— 只插一只手柄时它归 P2 —— 由它独占最不容易出错。 */
  var OUTPUT_SEAT = 2;

  window.DUO_SEAT = seat;

  claimHardwareOutput();
  isolateJournal();
  wireInput();
  if (seat === 2) blockLocalKeyboard();
  wireReporting();
  Pads.listenRumble();
  Pads.broadcast(siblingWindow);

  /* ============================================================
   * 0. 硬件输出层只留一个座位
   * ============================================================ */

  /* 灯条与自适应扳机只能走 WebHID，而 navigator.hid.getDevices() 给的是
     「本 document 自己的一份设备实例」—— 两个 iframe 都会 open 同一只手柄，
     然后各按自己那份 DOM 状态发报文，于是灯条来回闪、扳机阻力打架。

     Gamepad API 靠 index 就能分清哪只手柄归谁，WebHID 不行：设备列表的顺序
     与 gamepad index 没有任何对应关系，硬按顺序去配就是猜。既然分不开，
     就只让一个座位开这一层，其余座位整层关掉 —— lp-dualsense.js 在 enable
     为 false 时 boot() 直接返回，连设备都不碰。

     振动不受影响：ds5-adapter 的离散振动走 Gamepad API，能按座位精确分流。 */
  function claimHardwareOutput() {
    if (seat === OUTPUT_SEAT) return;
    var lpCfg = window.LPDualSenseConfig || (window.LPDualSenseConfig = {});
    lpCfg.enable = false;
  }

  /* ============================================================
   * 1. 存档隔离
   * ============================================================ */

  /* 只改本 iframe 自己的 Storage 原型：每个 frame 有独立的 realm，
     所以这里的前缀不会污染宿主页或另一个座位 */
  function isolateJournal() {
    var proto = window.Storage && window.Storage.prototype;
    if (!proto || proto.__duoSeatPatched) return;
    proto.__duoSeatPatched = true;
    ["getItem", "setItem", "removeItem"].forEach(function (name) {
      var orig = proto[name];
      proto[name] = function (key, value) {
        return orig.call(this, key === JOURNAL_KEY ? PREFIX + key : key, value);
      };
    });
  }

  /* ============================================================
   * 2. 输入源：快照优先，自读兜底
   * ============================================================ */

  var remotePad = null;
  var remoteRumble = false;
  var remoteFrom = null;
  var remoteAt = 0;

  /* 谁把手柄数据递给我，震动请求就交给谁去打 */
  function hydrate(snap) {
    if (!remoteRumble || !snap || snap.vibrationActuator) return snap;
    snap.vibrationActuator = {
      type: "dual-rumble",
      playEffect: function (type, params) {
        post(remoteFrom, {
          type: "duo-rumble",
          seat: seat,
          strong: params && params.strongMagnitude,
          weak: params && params.weakMagnitude,
          ms: params && params.duration
        });
        return Promise.resolve("complete");
      },
      reset: function () {
        return Promise.resolve();
      }
    };
    return snap;
  }

  function padProvider() {
    if (remoteFrom && Date.now() - remoteAt < SOURCE_TTL) {
      return remotePad ? [hydrate(remotePad)] : [];
    }
    var own = Pads.pick(Pads.readAll(), seat);
    return own ? [own] : [];
  }

  function wireInput() {
    window.DS5Config = window.DS5Config || {};
    window.DS5Config.padProvider = padProvider;

    window.addEventListener("message", function (e) {
      var d = e.data;
      if (!d || typeof d !== "object") return;
      if (d.type !== "duo-pads" || d.seat !== seat) return;
      remotePad = d.pad;
      remoteRumble = !!d.rumble;
      remoteFrom = e.source || null;
      remoteAt = Date.now();
    });
  }

  /* ============================================================
   * 3. 座位 2 屏蔽本机键盘
   * ============================================================ */

  /* 游戏把 keydown 挂在 window 上；本脚本先于游戏脚本执行，
     所以同目标上先注册的捕获监听能拦下它。
     只拦 isTrusted 的真实键盘：手柄适配层是合成键盘事件来驱动游戏的，
     一刀切会把座位 2 自己的手柄也一起拦死。 */
  function blockLocalKeyboard() {
    var guard = function (e) {
      if (e.isTrusted && Pads.GAME_KEYS[e.code]) e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", guard, true);
    window.addEventListener("keyup", guard, true);
  }

  /* ============================================================
   * 4. 上报坐标与进度
   * ============================================================ */

  function wireReporting() {
    var started = false;

    function report() {
      var coord = document.getElementById("coordinates");
      var count = document.getElementById("collected-count");
      var region = document.getElementById("region-name");
      post(window.parent, {
        type: "duo-state",
        seat: seat,
        coords: coord ? coord.textContent.trim() : "",
        collected: count ? count.textContent.trim() : "",
        region: region ? region.textContent.trim() : ""
      });
    }

    function watch(el) {
      if (!el || !window.MutationObserver) return;
      new MutationObserver(report).observe(el, {
        childList: true,
        characterData: true,
        subtree: true
      });
    }

    function start() {
      if (started) return;
      started = true;
      watch(document.getElementById("coordinates"));
      watch(document.getElementById("collected-count"));
      watch(document.getElementById("region-name"));
      report();
    }

    if (document.readyState === "loading") {
      window.addEventListener("DOMContentLoaded", start);
    } else {
      start();
    }
    window.addEventListener("load", report);
  }

  /* ============================================================
   * 工具
   * ============================================================ */

  function readSeat() {
    var m = null;
    try {
      m = /[?&]seat=([0-9]+)/.exec(window.location.search);
    } catch (e) {
      m = null;
    }
    if (!m) return 0;
    var n = parseInt(m[1], 10);
    return n === 1 || n === 2 ? n : 0;
  }

  /* siblingWindow 只发给「另一个座位」：自己需要的手柄由自己的 broadcast 覆盖，
     重复发只会白白多一轮消息 */
  function siblingWindow(targetSeat) {
    if (targetSeat === seat) return null;
    try {
      return window.parent.frames["duo-seat-" + targetSeat] || null;
    } catch (e) {
      return null;
    }
  }

  function post(target, msg) {
    if (!target) return;
    try {
      target.postMessage(msg, "*");
    } catch (e) {
      /* 目标窗口还没准备好，等下一次上报 */
    }
  }
})();
