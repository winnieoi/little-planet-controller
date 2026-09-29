/*
 * Little Planet · DualSense (DS5) 适配层
 * =================================================================
 * 文件：web/bridge/ds5-adapter.js
 * 版本：1.0.0
 *
 * 在 lp-controller.js 之上，为 PS5 DualSense 手柄提供：
 *   1. 完整映射：双摇杆 / 双扳机（模拟量）/ L1 R1 / 十字键 / 触摸板 / L3 R3
 *   2. 触觉反馈：按游戏事件给出不同的震动模式
 *   3. 屏上 HUD 与首次接入的按键提示卡
 *   4. 非 DS5 手柄的通用回退映射（Xbox / Switch Pro 等）
 *
 * 设计原则：
 *   · 不改动游戏本体，也不改动 lp-controller.js
 *   · 所有输入都通过 LPController 的公开 API 合成，复用它的按键状态机，
 *     因此不会出现"按键卡住"或两套逻辑互相覆盖的问题
 *   · 只有手柄真正产生输入时才写入移动/视角，手柄空闲时完全让位给键盘与后端
 *
 * 加载顺序（web/index.html，顺序不能颠倒）：
 *   <script>window.LPControllerConfig={enableGamepad:false}</script>
 *   <script src="./bridge/lp-controller.js"></script>
 *   <script src="./bridge/ds5-adapter.js"></script>
 * =================================================================
 */
(function () {
  "use strict";

  var VERSION = "1.0.0";

  /* ============================================================
   * 1. 配置
   * ============================================================ */

  var cfg = {
    /* 总开关 */
    enable: true,
    /* 摇杆死区，DualSense 出厂较紧，0.18 比较跟手 */
    deadzone: 0.18,
    /* 扳机被判定为"按下"的模拟量阈值 */
    triggerPress: 0.35,
    /* 扳机决定缩放速度时的倍率 */
    zoomSpeed: 1.2,
    /* 触觉反馈 */
    rumble: true,
    rumbleScale: 1.0,
    /* 屏幕左下角状态条 */
    hud: true,
    /* 首次接入手柄时的按键提示卡 */
    keycard: true,
    keycardMs: 9000,
    /* 观察页面 DOM 事件并给出震动反馈 */
    eventFeedback: true,
    /* 调试钩子：返回手柄数组的函数，留空则用 navigator.getGamepads */
    padProvider: null,
    /* 输出调试日志 */
    debug: false
  };

  if (window.DS5Config && typeof window.DS5Config === "object") {
    for (var cfgKey in window.DS5Config) {
      if (Object.prototype.hasOwnProperty.call(window.DS5Config, cfgKey)) {
        cfg[cfgKey] = window.DS5Config[cfgKey];
      }
    }
  }

  function log() {
    if (!cfg.debug || !window.console || !console.log) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift("[ds5]");
    console.log.apply(console, args);
  }

  function warn() {
    if (!window.console || !console.warn) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift("[ds5]");
    console.warn.apply(console, args);
  }

  function clamp(v, min, max) {
    v = Number(v) || 0;
    return v < min ? min : v > max ? max : v;
  }

  /* ============================================================
   * 2. 输入后端：优先复用 lp-controller，缺失时用本地兜底
   * ============================================================ */

  var ACTION_KEY = {
    jump: "Space",
    interact: "KeyE",
    run: "ShiftLeft",
    view: "KeyV",
    journal: "KeyJ",
    help: "KeyH",
    home: "Home",
    cancel: "Escape"
  };

  var HOLD_ACTIONS = { run: true };

  function localIO() {
    var held = Object.create(null);
    var codeKey = {
      Space: " ", KeyE: "e", KeyV: "v", KeyJ: "j", KeyH: "h",
      Home: "Home", Escape: "Escape", ShiftLeft: "Shift",
      KeyW: "w", KeyA: "a", KeyS: "s", KeyD: "d"
    };
    var moveHeld = Object.create(null);

    function fire(type, code) {
      var ev;
      try {
        ev = new KeyboardEvent(type, {
          code: code,
          key: codeKey[code] || code,
          bubbles: true,
          cancelable: true,
          repeat: false
        });
      } catch (e) {
        ev = document.createEvent("Event");
        ev.initEvent(type, true, true);
        ev.code = code;
        ev.key = codeKey[code] || code;
        ev.repeat = false;
      }
      window.dispatchEvent(ev);
    }

    function press(code) { if (held[code]) return; held[code] = true; fire("keydown", code); }
    function release(code) { if (!held[code]) return; delete held[code]; fire("keyup", code); }
    function tap(code) { press(code); setTimeout(function () { release(code); }, 40); }
    function toggle(code, on) { if (on) press(code); else release(code); }

    return {
      pressKey: press,
      releaseKey: release,
      tapKey: tap,
      move: function (x, y) {
        toggle("KeyD", x > cfg.deadzone);
        toggle("KeyA", x < -cfg.deadzone);
        toggle("KeyS", y > cfg.deadzone);
        toggle("KeyW", y < -cfg.deadzone);
        moveHeld.any = Math.abs(x) > cfg.deadzone || Math.abs(y) > cfg.deadzone;
      },
      look: function () {},
      zoomRate: function () {},
      hold: function (name, on) {
        var code = ACTION_KEY[name] || name;
        if (HOLD_ACTIONS[name]) { toggle(code, on); return; }
        if (on) tap(code);
      },
      tap: function (name) { tap(ACTION_KEY[name] || name); },
      status: function () { return { connected: false, source: "local" }; }
    };
  }

  var io = window.LPController || null;

  if (io) {
    io = {
      pressKey: window.LPController.pressKey,
      releaseKey: window.LPController.releaseKey,
      tapKey: window.LPController.tapKey,
      move: window.LPController.move,
      look: window.LPController.look,
      zoomRate: window.LPController.zoomRate,
      hold: window.LPController.hold,
      tap: window.LPController.tap,
      status: window.LPController.status
    };
  } else {
    warn("未找到 LPController，已启用本地兜底输入（移动/按键可用，视角与缩放不可用）");
    io = localIO();
  }

  /* ============================================================
   * 3. 手柄映射表
   * ============================================================ */

  /* 标准映射下的按键索引 */
  var BTN = {
    CROSS: 0, CIRCLE: 1, SQUARE: 2, TRIANGLE: 3,
    L1: 4, R1: 5, L2: 6, R2: 7,
    CREATE: 8, OPTIONS: 9,
    L3: 10, R3: 11,
    UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
    PS: 16, TOUCHPAD: 17
  };

  /* 按下即触发的动作 */
  var BUTTON_ACTIONS = {};
  BUTTON_ACTIONS[BTN.CROSS] = "jump";
  BUTTON_ACTIONS[BTN.CIRCLE] = "cancel";
  BUTTON_ACTIONS[BTN.SQUARE] = "interact";
  BUTTON_ACTIONS[BTN.TRIANGLE] = "view";
  BUTTON_ACTIONS[BTN.CREATE] = "help";
  BUTTON_ACTIONS[BTN.OPTIONS] = "journal";

  /* 动作 -> 震动模式 */
  var ACTION_RUMBLE = {
    jump: "jump",
    interact: "interact",
    view: "view",
    journal: "menu",
    help: "menu",
    cancel: "cancel",
    home: "view"
  };

  /* 触发一个动作：合成按键 + 必要的 DOM 兜底 + 震动反馈 */
  function tapAction(name) {
    io.tap(name);
    /* Escape 关闭 <dialog> 是浏览器的默认动作，合成的 KeyboardEvent 触发不了它，
       手柄用户按下 ○ 就得自己把弹窗收掉，否则会卡在手记/说明里出不来。 */
    if (name === "cancel") dismissDialogs();
    if (ACTION_RUMBLE[name]) playPattern(ACTION_RUMBLE[name]);
  }

  /* 震动模式：s 主马达强度 / w 副马达强度 / ms 时长 / gap 最小触发间隔 */
  var PATTERNS = {
    connect: { s: 0.25, w: 0.50, ms: 240, gap: 0 },
    jump: { s: 0.18, w: 0.38, ms: 70, gap: 0 },
    land: { s: 0.55, w: 0.25, ms: 110, gap: 140 },
    interact: { s: 0.30, w: 0.62, ms: 95, gap: 0 },
    view: { s: 0.32, w: 0.34, ms: 120, gap: 0 },
    menu: { s: 0.14, w: 0.30, ms: 60, gap: 0 },
    cancel: { s: 0.42, w: 0.18, ms: 90, gap: 0 },
    pick: { s: 0.70, w: 0.95, ms: 280, gap: 0 },
    region: { s: 0.10, w: 0.34, ms: 320, gap: 0 },
    notify: { s: 0.35, w: 0.55, ms: 150, gap: 700 },
    ready: { s: 0.05, w: 0.22, ms: 55, gap: 900 },
    blocked: { s: 0.90, w: 0.35, ms: 220, gap: 0 },
    test: { s: 0.60, w: 0.60, ms: 200, gap: 0 }
  };

  /* ============================================================
   * 4. 震动引擎
   * ============================================================ */

  var activePad = null;
  var lastRumble = "";
  var lastRumbleAt = 0;
  var patternAt = Object.create(null);

  function hasRumble(pad) {
    if (!pad) return false;
    if (pad.vibrationActuator && typeof pad.vibrationActuator.playEffect === "function") return true;
    if (pad.hapticActuators && pad.hapticActuators[0] && typeof pad.hapticActuators[0].pulse === "function") return true;
    return false;
  }

  function vibrate(strong, weak, ms) {
    if (!cfg.rumble) return false;

    /* 1) DS5 优先走 WebHID。
         这是整个项目唯一在真机上按字节验证过的振动通道
         （valid_flag0 必须 0xFF 那套），灯条和自适应扳机也挂在同一条报文上。
         Gamepad API 的 vibrationActuator 只能算兜底。 */
    var hid = window.LPDualSense;
    if (hid && typeof hid.pulse === "function" && hid.isConnected && hid.isConnected()) {
      if (hid.pulse(strong * cfg.rumbleScale, weak * cfg.rumbleScale, ms)) {
        lastRumbleAt = nowMs();
        return true;
      }
    }

    /* 2) 其它手柄 / WebHID 没接上时，退回 Gamepad API */
    var pad = activePad;
    if (!hasRumble(pad)) return false;

    strong = clamp(strong * cfg.rumbleScale, 0, 1);
    weak = clamp(weak * cfg.rumbleScale, 0, 1);
    var duration = Math.max(20, Math.round(ms));

    var act = pad.vibrationActuator;
    if (act && typeof act.playEffect === "function") {
      try {
        var p = act.playEffect("dual-rumble", {
          startDelay: 0,
          duration: duration,
          weakMagnitude: weak,
          strongMagnitude: strong
        });
        if (p && typeof p.catch === "function") p.catch(function () {});
        lastRumbleAt = nowMs();
        return true;
      } catch (e) {
        /* 落到旧接口 */
      }
    }

    var legacy = pad.hapticActuators;
    if (legacy && legacy[0] && typeof legacy[0].pulse === "function") {
      try {
        legacy[0].pulse(Math.max(strong, weak), duration);
        lastRumbleAt = nowMs();
        return true;
      } catch (e) {
        return false;
      }
    }
    return false;
  }

  function playPattern(name, scale) {
    var p = PATTERNS[name];
    if (!p) return false;
    var now = nowMs();
    if (p.gap && patternAt[name] && now - patternAt[name] < p.gap) return false;
    patternAt[name] = now;
    var s = typeof scale === "number" ? scale : 1;
    /* 只有真正送到硬件才记账，status() 里的 lastRumble 才是可信的 */
    var played = vibrate(p.s * s, p.w * s, p.ms);
    if (played) lastRumble = name;
    return played;
  }

  function nowMs() {
    return (window.performance && performance.now) ? performance.now() : Date.now();
  }

  /* ============================================================
   * 5. 手柄识别与轮询
   * ============================================================ */

  var padName = "";
  var padKind = "";
  var padConnected = false;
  var moveHeld = false;
  var lookHeld = false;
  var zoomValue = 0;
  var runHeld = false;
  var actionsDown = Object.create(null);

  function detectKind(id) {
    var s = String(id || "").toLowerCase();
    if (s.indexOf("dualsense") >= 0 || s.indexOf("0ce6") >= 0) return "DualSense";
    if (s.indexOf("dualsense edge") >= 0 || s.indexOf("0df2") >= 0) return "DualSense Edge";
    if (s.indexOf("wireless controller") >= 0 || s.indexOf("054c") >= 0) return "PlayStation 手柄";
    if (s.indexOf("xbox") >= 0 || s.indexOf("xinput") >= 0) return "Xbox 手柄";
    if (s.indexOf("pro controller") >= 0 || s.indexOf("switch") >= 0) return "Switch 手柄";
    return "标准手柄";
  }

  function shortPadName(id) {
    var kind = detectKind(id);
    var m = /vendor:\s*([0-9a-f]{4})\s*product:\s*([0-9a-f]{4})/i.exec(String(id || ""));
    if (m) return kind + " · " + m[1] + ":" + m[2];
    return kind;
  }

  function readPads() {
    if (typeof cfg.padProvider === "function") {
      try {
        return cfg.padProvider();
      } catch (e) {
        return null;
      }
    }
    if (!navigator.getGamepads) return null;
    try {
      return navigator.getGamepads();
    } catch (e) {
      return null;
    }
  }

  function pickPad(pads) {
    if (!pads) return null;
    for (var i = 0; i < pads.length; i++) {
      var pad = pads[i];
      if (pad && pad.connected !== false) return pad;
    }
    return null;
  }

  /* 跨页面推来的手柄是每帧新建的快照对象，不能用引用判等，
     否则每帧都会误判成"刚接入"，连接震动会被打成连发 */
  function samePad(a, b) {
    if (!a || !b) return false;
    return a === b || (a.index === b.index && a.id === b.id);
  }

  function btn(pad, idx) {
    var b = pad.buttons && pad.buttons[idx];
    return !!(b && b.pressed);
  }

  function trig(pad, idx) {
    var b = pad.buttons && pad.buttons[idx];
    if (!b) return 0;
    if (typeof b.value === "number") return clamp(b.value, 0, 1);
    return b.pressed ? 1 : 0;
  }

  function axis(v, dz) {
    v = Number(v) || 0;
    var a = Math.abs(v);
    if (a < dz) return 0;
    return (v < 0 ? -1 : 1) * ((a - dz) / (1 - dz));
  }

  function onPadConnect(pad) {
    activePad = pad;
    padName = String(pad.id || "");
    padKind = detectKind(padName);
    padConnected = true;
    log("手柄接入", padName, "震动:", hasRumble(pad));
    playPattern("connect");
    showKeycard();
    updateHud();
  }

  function releaseEverything() {
    if (moveHeld) { io.move(0, 0); moveHeld = false; }
    if (lookHeld) { io.look(0, 0); lookHeld = false; }
    if (runHeld) { io.hold("run", false); runHeld = false; }
    if (zoomValue !== 0) { zoomValue = 0; io.zoomRate(0); }
    actionsDown = Object.create(null);
  }

  function onPadDisconnect() {
    log("手柄断开");
    releaseEverything();
    activePad = null;
    padConnected = false;
    padName = "";
    padKind = "";
    hideKeycard();
    updateHud();
  }

  function poll() {
    if (!cfg.enable) return;

    var pad = pickPad(readPads());

    if (!pad) {
      if (activePad) onPadDisconnect();
      return;
    }
    if (samePad(pad, activePad)) {
      /* 同一只手柄的新一帧快照：刷新数据，但不重复触发"刚接入" */
      activePad = pad;
    } else {
      onPadConnect(pad);
    }

    var dz = cfg.deadzone;

    /* --- 移动：左摇杆，十字键优先 --- */
    var mx = axis(pad.axes && pad.axes[0], dz);
    var my = axis(pad.axes && pad.axes[1], dz);

    var dpadX = 0;
    var dpadY = 0;
    if (btn(pad, BTN.UP)) dpadY = -1;
    if (btn(pad, BTN.DOWN)) dpadY = 1;
    if (btn(pad, BTN.LEFT)) dpadX = -1;
    if (btn(pad, BTN.RIGHT)) dpadX = 1;
    if (dpadX !== 0 || dpadY !== 0) { mx = dpadX; my = dpadY; }

    var moving = mx !== 0 || my !== 0;
    if (moving) {
      io.move(mx, my);
      moveHeld = true;
    } else if (moveHeld) {
      io.move(0, 0);
      moveHeld = false;
    }

    /* --- 视角：右摇杆 --- */
    var lx = axis(pad.axes && pad.axes[2], dz);
    var ly = axis(pad.axes && pad.axes[3], dz);
    var looking = lx !== 0 || ly !== 0;
    if (looking) {
      io.look(lx, ly);
      lookHeld = true;
    } else if (lookHeld) {
      io.look(0, 0);
      lookHeld = false;
    }

    /* --- 扳机：L2 奔跑（模拟量），R2 拉近 --- */
    var lt = trig(pad, BTN.L2);
    var rt = trig(pad, BTN.R2);

    var wantRun = lt > cfg.triggerPress;
    if (wantRun !== runHeld) {
      runHeld = wantRun;
      io.hold("run", wantRun);
    }

    /* 从阈值处从 0 连续升上去 —— 原来直接乘 rt，会在 0.35 处从 0 跳到 0.42 */
    var zoom = 0;
    if (rt > cfg.triggerPress) {
      zoom += cfg.zoomSpeed * ((rt - cfg.triggerPress) / (1 - cfg.triggerPress));
    }
    if (btn(pad, BTN.R1)) zoom += cfg.zoomSpeed;
    if (btn(pad, BTN.L1)) zoom -= cfg.zoomSpeed;
    if (zoom !== zoomValue) {
      zoomValue = zoom;
      io.zoomRate(zoom);
    }

    /* --- 按下即触发的动作 --- */
    for (var idx in BUTTON_ACTIONS) {
      var name = BUTTON_ACTIONS[idx];
      if (btn(pad, Number(idx))) {
        if (!actionsDown[name]) {
          actionsDown[name] = true;
          tapAction(name);
        }
      } else if (actionsDown[name]) {
        delete actionsDown[name];
      }
    }

    /* --- 额外按键 --- */
    handleExtra(pad, BTN.TOUCHPAD, "touchpad");
    handleExtra(pad, BTN.L3, "l3");
    handleExtra(pad, BTN.R3, "r3");
  }

  var extraDown = Object.create(null);

  function handleExtra(pad, idx, tag) {
    var down = btn(pad, idx);
    if (down) {
      if (extraDown[tag]) return;
      extraDown[tag] = true;
      if (tag === "touchpad") {
        clickById("home-camera");
        playPattern("view");
      } else if (tag === "l3") {
        tapAction("home");
      } else if (tag === "r3") {
        tapAction("cancel");
      }
    } else if (extraDown[tag]) {
      delete extraDown[tag];
    }
  }

  function clickById(id) {
    var el = document.getElementById(id);
    if (!el) return;
    try {
      el.click();
    } catch (e) {
      /* 忽略 */
    }
  }

  /* 关掉所有打开的 <dialog>：先点它的关闭按钮让游戏自己的收尾逻辑照常跑，
     按钮没生效时再兜底调 close()，保证不会卡在弹窗里出不来 */
  function dismissDialogs() {
    var list = document.querySelectorAll("dialog[open]");
    for (var i = 0; i < list.length; i++) {
      var dlg = list[i];
      try {
        var btn = dlg.querySelector(".dialog-close");
        if (btn) btn.click();
        if (dlg.open && typeof dlg.close === "function") dlg.close();
      } catch (e) {
        /* 忽略 */
      }
    }
  }

  /* ============================================================
   * 6. 观察游戏事件 -> 震动反馈
   * ============================================================ */

  var observers = [];

  function observeText(el, pattern, opts) {
    if (!el || !window.MutationObserver) return;
    var ignoreEmpty = !opts || opts.ignoreEmpty !== false;
    var last = (el.textContent || "").trim();

    var obs = new MutationObserver(function () {
      var value = (el.textContent || "").trim();
      if (value === last) return;
      last = value;
      if (ignoreEmpty && value === "") return;
      playPattern(pattern);
    });
    obs.observe(el, { childList: true, characterData: true, subtree: true });
    observers.push(obs);
  }

  function observeHidden(el, pattern) {
    if (!el || !window.MutationObserver) return;
    var wasHidden = !!el.hidden;
    var obs = new MutationObserver(function () {
      var hidden = !!el.hidden;
      if (hidden === wasHidden) return;
      wasHidden = hidden;
      if (!hidden) playPattern(pattern);
    });
    obs.observe(el, { attributes: true, attributeFilter: ["hidden"] });
    observers.push(obs);
  }

  /* 落地：游戏每帧把 canvas 的 data-jumping 写成 "true"/"false"，
     从 true 掉回 false 就是落地（或走下平台），给一下闷振。
     这是适配层里唯一一个游戏没直接给事件的反馈，所以只能这样读。 */
  function observeJumping() {
    var el = document.getElementById("world");
    if (!el || !window.MutationObserver) return;
    var wasAir = el.dataset.jumping === "true";
    var obs = new MutationObserver(function () {
      var air = el.dataset.jumping === "true";
      if (air === wasAir) return;
      wasAir = air;
      if (!air) playPattern("land", 0.7);
    });
    obs.observe(el, { attributes: true, attributeFilter: ["data-jumping"] });
    observers.push(obs);
  }

  function watchGame() {
    if (!cfg.eventFeedback) return;
    observeText(document.getElementById("toast"), "notify");
    observeText(document.getElementById("collected-count"), "pick");
    observeText(document.getElementById("region-name"), "region");
    observeText(document.getElementById("view-toggle") && document.querySelector("#view-toggle span"), "view");
    observeHidden(document.getElementById("interaction"), "ready");
    observeJumping();
  }

  /* ============================================================
   * 7. HUD 与按键提示卡
   * ============================================================ */

  var hudEl = null;
  var hudDot = null;
  var hudPad = null;
  var hudMeta = null;
  var hudLink = null;
  var cardEl = null;
  var cardTimer = null;

  function buildHud() {
    if (!cfg.hud || hudEl) return;
    hudEl = document.createElement("div");
    hudEl.id = "ds5-hud";
    hudEl.style.cssText = [
      "position:fixed", "left:14px", "bottom:14px", "z-index:98",
      "pointer-events:none", "max-width:280px",
      "font:12px/1.6 -apple-system,'PingFang SC',system-ui,sans-serif",
      "padding:8px 12px", "border-radius:12px",
      "background:rgba(10,0,20,.74)", "color:#e8dcff",
      "border:1px solid rgba(170,90,255,.35)",
      "letter-spacing:.3px"
    ].join(";");
    hudEl.innerHTML =
      '<div style="display:flex;align-items:center;gap:6px">' +
      '<span id="ds5-dot" style="width:7px;height:7px;border-radius:50%;background:#6a5a7c;display:inline-block"></span>' +
      '<b id="ds5-pad" style="font-weight:600">未检测到手柄</b></div>' +
      '<div id="ds5-meta" style="opacity:.72;font-size:11px">请按一下手柄任意键唤醒</div>' +
      /* 这一行是唯一可点的：WebHID 授权必须由用户手势发起 */
      '<button id="ds5-link" type="button" style="' + [
        "display:none", "margin-top:7px", "pointer-events:auto", "cursor:pointer",
        "font:inherit", "padding:3px 9px", "border-radius:999px",
        "background:rgba(20,40,70,.85)", "color:#9fd8ff",
        "border:1px solid rgba(64,180,255,.4)", "letter-spacing:.3px"
      ].join(";") + '">接入灯条 / 自适应扳机</button>';
    document.body.appendChild(hudEl);

    hudDot = hudEl.querySelector("#ds5-dot");
    hudPad = hudEl.querySelector("#ds5-pad");
    hudMeta = hudEl.querySelector("#ds5-meta");
    hudLink = hudEl.querySelector("#ds5-link");

    hudLink.addEventListener("click", function () {
      var hid = window.LPDualSense;
      if (!hid || typeof hid.toggle !== "function") return;
      try { hid.toggle(); } catch (e) { /* 忽略 */ }
      updateHud();
    });
  }

  function updateHud() {
    if (!hudEl) return;
    var st = null;
    try {
      st = io.status ? io.status() : null;
    } catch (e) {
      st = null;
    }
    var backendOk = !!(st && st.connected);
    hudPad.textContent = padConnected ? shortPadName(padName) : "未检测到手柄";
    hudDot.style.background = padConnected ? "#7df0b0" : "#6a5a7c";

    var bits = [];
    bits.push(backendOk ? "后端已连接" : "后端未连接");
    bits.push(cfg.rumble && hasRumble(activePad) ? "震动可用" : "震动不可用");
    if (padConnected && padKind === "DualSense") bits.push("DS5 模式");
    hudMeta.textContent = padConnected ? bits.join(" · ") : "请按一下手柄任意键唤醒";

    /* 灯条 / 自适应扳机只有 WebHID 那条路能给，必须用户点一下授权。
       输出层整体停用时（分屏双人里座位 2 独占这一层）按钮也不能画 ——
       画出来只会点了没反应。 */
    var hid = window.LPDualSense;
    if (!hudLink) return;
    if (!hid || !hid.supported || hid.config.enable === false) {
      hudLink.style.display = "none";
      return;
    }
    hudLink.style.display = "inline-block";
    if (hid.isConnected()) {
      hudLink.textContent = "● 灯条 · 自适应扳机 已接入（点击断开）";
      hudLink.style.color = "#b8f5d0";
      hudLink.style.borderColor = "rgba(29,158,117,.5)";
    } else {
      hudLink.textContent = "○ 接入灯条 / 自适应扳机（WebHID）";
      hudLink.style.color = "#9fd8ff";
      hudLink.style.borderColor = "rgba(64,180,255,.4)";
    }
  }

  function hideKeycard() {
    if (cardTimer) {
      clearTimeout(cardTimer);
      cardTimer = null;
    }
    if (cardEl && cardEl.parentNode) cardEl.parentNode.removeChild(cardEl);
    cardEl = null;
  }

  function showKeycard() {
    if (!cfg.keycard) return;
    hideKeycard();

    cardEl = document.createElement("div");
    cardEl.id = "ds5-keycard";
    cardEl.style.cssText = [
      "position:fixed", "right:14px", "bottom:14px", "z-index:98",
      "pointer-events:none", "max-width:300px",
      "font:12px/1.75 -apple-system,'PingFang SC',system-ui,sans-serif",
      "padding:10px 14px", "border-radius:12px",
      "background:rgba(10,0,20,.82)", "color:#e8dcff",
      "border:1px solid rgba(120,220,255,.35)",
      "letter-spacing:.3px"
    ].join(";");

    var rows = [
      ["左摇杆 / 十字键", "移动"],
      ["右摇杆", "环视星球"],
      ["×", "跳跃"],
      ["□", "互动"],
      ["△", "切换视角"],
      ["○", "取消路线"],
      ["L2", "奔跑（模拟量）"],
      ["R2 / R1", "拉近"],
      ["L1", "拉远"],
      ["触摸板", "镜头回正"],
      ["L3 / R3", "回到草原 / 取消"],
      ["Options / Create", "探索手记 / 操作说明"]
    ];

    var html = '<div style="font-weight:600;margin-bottom:6px;color:#9fe8ff">DualSense 按键表</div>';
    for (var i = 0; i < rows.length; i++) {
      html += '<div style="display:flex;gap:10px;justify-content:space-between">' +
        '<span style="opacity:.85">' + rows[i][0] + '</span>' +
        '<span style="opacity:.6">' + rows[i][1] + '</span></div>';
    }
    cardEl.innerHTML = html;
    document.body.appendChild(cardEl);

    cardTimer = setTimeout(hideKeycard, cfg.keycardMs);
  }

  /* ============================================================
   * 8. 对外 API
   * ============================================================ */

  window.DS5 = {
    version: VERSION,
    patterns: Object.keys(PATTERNS),

    rumble: function (nameOrStrong, weak, ms) {
      if (typeof nameOrStrong === "string") return playPattern(nameOrStrong);
      return vibrate(nameOrStrong, weak, ms);
    },
    setRumble: function (on) {
      cfg.rumble = !!on;
      updateHud();
      return cfg.rumble;
    },
    keycard: showKeycard,
    hideKeycard: hideKeycard,
    mapping: {
      buttons: {
        "0": "jump（×）", "1": "cancel（○）", "2": "interact（□）", "3": "view（△）",
        "4": "zoomOut（L1）", "5": "zoomIn（R1）", "6": "run（L2）", "7": "zoomIn（R2）",
        "8": "help（Create）", "9": "journal（Options）",
        "10": "home（L3）", "11": "cancel（R3）",
        "12-15": "move（十字键）", "17": "cameraHome（触摸板）"
      },
      axes: { "0/1": "move（左摇杆）", "2/3": "look（右摇杆）" }
    },
    status: function () {
      var st = null;
      try {
        st = io.status ? io.status() : null;
      } catch (e) {
        st = null;
      }
      return {
        version: VERSION,
        enabled: cfg.enable,
        pad: padConnected ? { id: padName, kind: padKind } : null,
        rumbleSupported: hasRumble(activePad),
        rumbleEnabled: cfg.rumble,
        lastRumble: lastRumble,
        lastRumbleAgoMs: lastRumbleAt ? Math.round(nowMs() - lastRumbleAt) : null,
        move: moveHeld,
        look: lookHeld,
        run: runHeld,
        zoom: zoomValue,
        backend: st ? !!st.connected : false,
        source: st ? st.source : "unknown"
      };
    }
  };

  /* ============================================================
   * 9. 启动
   * ============================================================ */

  function loop() {
    if (cfg.enable) {
      try {
        poll();
      } catch (e) {
        warn("轮询异常，已跳过本帧", e && e.message);
      }
    }
    requestAnimationFrame(loop);
  }

  function boot() {
    if (!cfg.enable) return;
    buildHud();
    watchGame();
    setInterval(updateHud, 400);
    requestAnimationFrame(loop);
    log("DS5 适配层已就绪 v" + VERSION, "震动:", cfg.rumble);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
