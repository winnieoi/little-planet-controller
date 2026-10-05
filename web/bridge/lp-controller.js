/*
 * Little Planet · 输入桥接层 (lp-controller.js)
 * ---------------------------------------------------------------
 * 作用：把手柄 (Gamepad API) 和后端指令 (WebSocket / HTTP) 转换成
 *      《口袋星球》游戏能识别的原生输入事件，无需修改游戏源码。
 *
 * 原理：
 *   游戏通过 window 上的 keydown / keyup 维护按键状态 (使用 event.code)，
 *   通过画布的 pointerdown / pointermove 实现视角拖拽，
 *   通过画布的 wheel 实现缩放。
 *   本层构造同类型的合成事件并派发，游戏主逻辑完全无感知。
 *
 * 修改游戏逻辑时应同步检查本文件顶部的 KEY / BUTTON 映射表。
 * ---------------------------------------------------------------
 * 版本: 1.0.0
 */
(function () {
  "use strict";

  var VERSION = "1.0.0";

  /* ============================================================
   * 1. 配置
   * ============================================================ */

  var cfg = {
    /* WebSocket 地址。留空表示自动推导：
       同源部署推到 /ws，file:// 打开则退回本机 8765 */
    wsUrl: "",
    enableWs: true,
    enableGamepad: true,
    /* 左下角显示连接状态，联调时可关闭 */
    hud: true,
    /* 上报游戏状态给后端，便于后端观测 */
    telemetry: true,
    telemetryIntervalMs: 500,
    /* 摇杆死区 */
    deadzone: 0.22,
    /* 满摇杆时的视角速度 (像素/秒) */
    lookSpeed: 420,
    /* 摇杆回中后多久松开虚拟拖拽 */
    lookIdleMs: 300,
    /* 缩放速度 (档位/秒)，正数表示拉近 */
    zoomSpeed: 1.2,
    reconnectMs: 2000
  };

  if (window.LPControllerConfig) {
    for (var k in window.LPControllerConfig) {
      if (Object.prototype.hasOwnProperty.call(window.LPControllerConfig, k)) {
        cfg[k] = window.LPControllerConfig[k];
      }
    }
  }

  /* ============================================================
   * 2. 按键与手柄映射表
   * ============================================================ */

  /* 语义动作 -> 键盘 event.code */
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

  /* 需要在按下期间持续生效的动作 (长按型) */
  var HOLD_ACTIONS = { run: true };

  /* 标准手柄 (standard mapping) 映射 */
  var GAMEPAD_BUTTON = {
    0: "jump",      /* A / 叉 */
    1: "cancel",    /* B / 圈 */
    2: "interact",  /* X / 方 */
    3: "view",      /* Y / 三角 */
    8: "help",      /* Select / Share */
    9: "journal"    /* Start / Options */
  };

  /* ============================================================
   * 3. 合成输入：按键
   * ============================================================ */

  var heldKeys = Object.create(null);

  var CODE_KEY = {
    Space: " ", KeyE: "e", KeyV: "v", KeyJ: "j", KeyH: "h",
    Home: "Home", Escape: "Escape", ShiftLeft: "Shift",
    KeyW: "w", KeyA: "a", KeyS: "s", KeyD: "d"
  };

  function fireKey(type, code) {
    var ev;
    try {
      ev = new KeyboardEvent(type, {
        code: code,
        key: CODE_KEY[code] || code,
        bubbles: true,
        cancelable: true,
        repeat: false
      });
    } catch (e) {
      ev = document.createEvent("Event");
      ev.initEvent(type, true, true);
      ev.code = code;
      ev.key = CODE_KEY[code] || code;
      ev.repeat = false;
    }
    window.dispatchEvent(ev);
  }

  function pressKey(code) {
    if (heldKeys[code]) return;
    heldKeys[code] = true;
    fireKey("keydown", code);
  }

  function releaseKey(code) {
    if (!heldKeys[code]) return;
    delete heldKeys[code];
    fireKey("keyup", code);
  }

  function tapKey(code) {
    pressKey(code);
    /* 等一帧再松开，保证游戏能在 keydown 里读取到 */
    setTimeout(function () {
      releaseKey(code);
    }, 40);
  }

  function releaseAllKeys() {
    for (var code in heldKeys) releaseKey(code);
  }

  /* ============================================================
   * 4. 合成输入：视角拖拽与缩放
   * ============================================================ */

  var canvas = null;
  var dragActive = false;
  var dragId = 7;
  var dragX = 0;
  var dragY = 0;
  var lastLookAt = 0;
  var pointerPatched = false;

  function getCanvas() {
    if (!canvas) canvas = document.getElementById("world");
    return canvas;
  }

  /* 合成指针没有真实的指针捕获目标，直接兜住异常 */
  function patchPointerCapture(el) {
    if (pointerPatched || !el || !el.setPointerCapture) return;
    pointerPatched = true;
    var original = el.setPointerCapture.bind(el);
    el.setPointerCapture = function (id) {
      try {
        original(id);
      } catch (e) {
        /* 合成指针事件没有活跃指针，忽略即可 */
      }
    };
  }

  function firePointer(type, x, y) {
    var el = getCanvas();
    if (!el) return;
    var ev;
    try {
      ev = new PointerEvent(type, {
        pointerId: dragId,
        pointerType: "mouse",
        isPrimary: true,
        buttons: 1,
        button: 0,
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true
      });
    } catch (e) {
      ev = document.createEvent("MouseEvents");
      ev.initMouseEvent(type, true, true, window, 0, 0, 0, x, y);
    }
    el.dispatchEvent(ev);
  }

  function beginDrag() {
    var el = getCanvas();
    if (!el || dragActive) return;
    patchPointerCapture(el);
    dragActive = true;
    dragX = window.innerWidth / 2;
    dragY = window.innerHeight / 2;
    firePointer("pointerdown", dragX, dragY);
    /* 先移动超过 5px 阈值，游戏的 moved 标记会置位，
       这样松开时不会被误判成"点击地面走到该处" */
    dragX += 6;
    firePointer("pointermove", dragX, dragY);
  }

  function endDrag() {
    if (!dragActive) return;
    dragActive = false;
    firePointer("pointerup", dragX, dragY);
  }

  function applyLook(dx, dy) {
    if (!dragActive) return;
    dragX += dx;
    dragY += dy;

    /* 指针移出视口就回到中心重新起拖，避免坐标漂移 */
    var margin = 8;
    if (dragX < margin || dragX > window.innerWidth - margin ||
        dragY < margin || dragY > window.innerHeight - margin) {
      firePointer("pointerup", dragX, dragY);
      dragActive = false;
      beginDrag();
      return;
    }
    firePointer("pointermove", dragX, dragY);
  }

  function applyZoom(deltaY) {
    var el = getCanvas();
    if (!el) return;
    var ev;
    try {
      ev = new WheelEvent("wheel", {
        deltaY: deltaY,
        deltaMode: 0,
        bubbles: true,
        cancelable: true
      });
    } catch (e) {
      ev = document.createEvent("Event");
      ev.initEvent("wheel", true, true);
      ev.deltaY = deltaY;
    }
    el.dispatchEvent(ev);
  }

  /* ============================================================
   * 5. 输入状态机
   * ============================================================ */

  var state = {
    moveX: 0,        /* -1 左 / +1 右 */
    moveY: 0,        /* -1 前 / +1 后 */
    lookX: 0,        /* -1..1 左右视角 */
    lookY: 0,
    zoomRate: 0,     /* 正数拉近 */
    source: "none"
  };

  /* 点按型动作的当前按下状态 (用于上升沿判定) */
  var actionsDown = Object.create(null);
  /* 长按型动作的当前按下状态 (用于状态同步) */
  var holdDown = Object.create(null);

  function actionToCode(name) {
    if (ACTION_KEY[name]) return ACTION_KEY[name];
    /* 允许后端直接传 event.code */
    return name;
  }

  function setAction(name, down) {
    var code = actionToCode(name);
    if (!code) return;
    if (HOLD_ACTIONS[name]) {
      if (down) {
        holdDown[name] = true;
        pressKey(code);
      } else {
        delete holdDown[name];
        releaseKey(code);
      }
      return;
    }
    /* 点按型动作只在上升沿触发一次 */
    if (down) {
      if (!actionsDown[name]) {
        actionsDown[name] = true;
        tapKey(code);
      }
    } else {
      delete actionsDown[name];
    }
  }

  function setMove(x, y) {
    state.moveX = clamp(x, -1, 1);
    state.moveY = clamp(y, -1, 1);
  }

  function setLook(x, y) {
    state.lookX = clamp(x, -1, 1);
    state.lookY = clamp(y, -1, 1);
  }

  function clamp(v, min, max) {
    v = Number(v) || 0;
    return v < min ? min : v > max ? max : v;
  }

  function applyMoveToKeys() {
    var dz = cfg.deadzone;
    var x = state.moveX;
    var y = state.moveY;

    toggle("KeyD", x > dz);
    toggle("KeyA", x < -dz);
    toggle("KeyS", y > dz);
    toggle("KeyW", y < -dz);
  }

  function toggle(code, on) {
    if (on) pressKey(code);
    else releaseKey(code);
  }

  /* ============================================================
   * 6. 主循环：应用模拟量输入
   * ============================================================ */

  var lastTime = 0;

  function loop(now) {
    if (!lastTime) lastTime = now;
    var dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;

    applyMoveToKeys();

    var lookMag = Math.sqrt(state.lookX * state.lookX + state.lookY * state.lookY);
    if (lookMag > cfg.deadzone) {
      if (!dragActive) beginDrag();
      lastLookAt = now;
      applyLook(state.lookX * cfg.lookSpeed * dt, state.lookY * cfg.lookSpeed * dt);
    } else if (dragActive && now - lastLookAt > cfg.lookIdleMs) {
      endDrag();
    }

    if (Math.abs(state.zoomRate) > 0.01) {
      /* deltaY 为负表示拉近 */
      applyZoom(-state.zoomRate * 400 * dt);
    }

    requestAnimationFrame(loop);
  }

  /* ============================================================
   * 7. 后端通信
   * ============================================================ */

  var socket = null;
  var connected = false;
  var retryTimer = null;
  var telemetryTimer = null;

  function resolveWsUrl() {
    if (cfg.wsUrl) return cfg.wsUrl;
    if (location.protocol === "http:" || location.protocol === "https:") {
      var proto = location.protocol === "https:" ? "wss://" : "ws://";
      return proto + location.host + "/ws";
    }
    return "ws://localhost:8765/ws";
  }

  function send(obj) {
    if (!socket || socket.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      return false;
    }
  }

  /* 有没有后端，探测结果缓存起来（null = 还没探过）。
     静态托管（GitHub Pages、对象存储这类）只有静态文件，没有 /ws 端点：
     直接连会在控制台刷一条 WebSocket failed，接着按重连间隔无限重试，
     日志全是这种噪音，还会让人误以为页面坏了。所以先确认后端在不在。 */
  var backendProbe = null;
  var pendingProbe = null;

  function probeBackendOnce() {
    if (backendProbe !== null) return Promise.resolve(backendProbe);
    if (pendingProbe) return pendingProbe;
    if (typeof fetch !== "function" || location.protocol === "file:") {
      backendProbe = false;
      return Promise.resolve(false);
    }
    pendingProbe = fetch("/api/tripo/config", { cache: "no-store" })
      .then(function (res) {
        var ct = (res.headers.get("content-type") || "").toLowerCase();
        /* 静态托管的 404 给的是一页 HTML —— 状态码不对或不是 JSON 都算没后端 */
        backendProbe = res.ok && ct.indexOf("json") >= 0;
        return backendProbe;
      })
      .catch(function () {
        backendProbe = false;
        return false;
      })
      .then(function (v) {
        pendingProbe = null;
        return v;
      });
    return pendingProbe;
  }

  function connect() {
    if (!cfg.enableWs || typeof WebSocket === "undefined") return;
    if (backendProbe === null) {
      probeBackendOnce().then(function (has) {
        if (has) connect();
      });
      return;
    }
    if (!backendProbe) return;
    var url = resolveWsUrl();
    try {
      socket = new WebSocket(url);
    } catch (e) {
      scheduleRetry();
      return;
    }

    socket.onopen = function () {
      connected = true;
      updateHud();
      send({ type: "hello", client: "browser", version: VERSION, ua: navigator.userAgent });
      log("已连接后端", url);
    };

    socket.onmessage = function (ev) {
      var data;
      try {
        data = JSON.parse(ev.data);
      } catch (e) {
        log("收到非 JSON 消息，已忽略", ev.data);
        return;
      }
      handleMessage(data);
    };

    socket.onclose = function () {
      connected = false;
      socket = null;
      updateHud();
      scheduleRetry();
    };

    socket.onerror = function () {
      connected = false;
      updateHud();
    };
  }

  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(function () {
      retryTimer = null;
      connect();
    }, cfg.reconnectMs);
  }

  /* 后端 -> 浏览器 指令处理 */
  function handleMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    state.source = msg.source || "websocket";

    switch (msg.type) {
      /* 组合状态，推荐流式发送 */
      case "state":
        if (msg.move) setMove(toAxis(msg.move, 0), toAxis(msg.move, 1));
        if (msg.look) setLook(toAxis(msg.look, 0), toAxis(msg.look, 1));
        if (typeof msg.zoom === "number") state.zoomRate = msg.zoom;
        if (Array.isArray(msg.hold)) syncHolds(msg.hold);
        if (Array.isArray(msg.taps)) {
          for (var i = 0; i < msg.taps.length; i++) setAction(msg.taps[i], true);
          setTimeout(function () {
            for (var j = 0; j < msg.taps.length; j++) setAction(msg.taps[j], false);
          }, 60);
        }
        break;

      case "move":
        setMove(num(msg.x), num(msg.y));
        break;

      case "look":
        setLook(num(msg.x), num(msg.y));
        break;

      case "zoom":
        /* 持续速率 */
        if (typeof msg.rate === "number") state.zoomRate = msg.rate;
        /* 离散档位 */
        if (typeof msg.delta === "number") applyZoom(-msg.delta * 120);
        break;

      case "button":
        setAction(msg.name, msg.pressed !== false);
        break;

      case "tap":
        setAction(msg.name, true);
        setTimeout(function () {
          setAction(msg.name, false);
        }, 60);
        break;

      case "key":
        if (msg.action === "press") pressKey(msg.code);
        else if (msg.action === "release") releaseKey(msg.code);
        else tapKey(msg.code);
        break;

      case "reset":
        releaseAllKeys();
        resetState();
        break;

      case "ping":
        send({ type: "pong", t: msg.t });
        break;

      default:
        log("未知指令类型", msg.type);
    }
  }

  function syncHolds(list) {
    var wanted = Object.create(null);
    for (var i = 0; i < list.length; i++) wanted[list[i]] = true;
    /* 释放已经不在列表里的长按动作 */
    for (var name in holdDown) {
      if (!wanted[name]) setAction(name, false);
    }
    for (var n in wanted) {
      if (!holdDown[n]) setAction(n, true);
    }
  }

  function resetState() {
    state.moveX = state.moveY = 0;
    state.lookX = state.lookY = 0;
    state.zoomRate = 0;
    for (var name in holdDown) setAction(name, false);
    for (var tap in actionsDown) setAction(tap, false);
    applyMoveToKeys();
    endDrag();
  }

  function toAxis(arr, i) {
    return Array.isArray(arr) ? num(arr[i]) : 0;
  }

  function num(v) {
    return typeof v === "number" && isFinite(v) ? v : 0;
  }

  /* ============================================================
   * 8. 手柄
   * ============================================================ */

  var gamepadName = "";

  function pollGamepad() {
    if (!cfg.enableGamepad || !navigator.getGamepads) return;
    var pads = navigator.getGamepads();
    for (var i = 0; i < pads.length; i++) {
      var pad = pads[i];
      if (!pad || !pad.connected) continue;

      gamepadName = pad.id;
      var dz = cfg.deadzone;

      /* 左摇杆移动：轴向上为负，转成"前为 -1" */
      var mx = deadzone(pad.axes[0] || 0, dz);
      var my = deadzone(pad.axes[1] || 0, dz);
      setMove(mx, my);

      /* 右摇杆视角 */
      var lx = deadzone(pad.axes[2] || 0, dz);
      var ly = deadzone(pad.axes[3] || 0, dz);
      setLook(lx, ly);

      /* 扳机：左跑动，右拉近 */
      var lt = pad.buttons[6] ? pad.buttons[6].value : 0;
      var rt = pad.buttons[7] ? pad.buttons[7].value : 0;
      setAction("run", lt > 0.5);
      state.zoomRate = rt > 0.5 ? cfg.zoomSpeed : 0;

      /* 肩键缩放 */
      if (pad.buttons[4] && pad.buttons[4].pressed) state.zoomRate = -cfg.zoomSpeed;
      if (pad.buttons[5] && pad.buttons[5].pressed) state.zoomRate = cfg.zoomSpeed;

      /* 十字键移动 */
      if (pad.buttons[12] && pad.buttons[12].pressed) setMove(state.moveX, -1);
      if (pad.buttons[13] && pad.buttons[13].pressed) setMove(state.moveX, 1);
      if (pad.buttons[14] && pad.buttons[14].pressed) setMove(-1, state.moveY);
      if (pad.buttons[15] && pad.buttons[15].pressed) setMove(1, state.moveY);

      /* 功能键 */
      for (var idx in GAMEPAD_BUTTON) {
        var btn = pad.buttons[idx];
        if (!btn) continue;
        setAction(GAMEPAD_BUTTON[idx], btn.pressed);
      }
      state.source = "gamepad";
      break;
    }
  }

  function deadzone(v, dz) {
    var a = Math.abs(v);
    if (a < dz) return 0;
    /* 重新映射到 0..1，避免刚出死区就跳变 */
    return (v < 0 ? -1 : 1) * ((a - dz) / (1 - dz));
  }

  /* ============================================================
   * 9. 状态显示与遥测
   * ============================================================ */

  var hudEl = null;

  function buildHud() {
    if (!cfg.hud) return;
    hudEl = document.createElement("div");
    hudEl.id = "lp-controller-hud";
    hudEl.style.cssText = [
      "position:fixed", "top:10px", "left:50%", "transform:translateX(-50%)",
      "z-index:99", "pointer-events:none",
      "font:12px/1.5 -apple-system,PingFang SC,sans-serif",
      "padding:4px 12px", "border-radius:999px",
      "background:rgba(12,0,24,.72)", "color:#e0c0ff",
      "border:1px solid rgba(224,64,208,.35)",
      "letter-spacing:.4px", "white-space:nowrap"
    ].join(";");
    document.body.appendChild(hudEl);
    updateHud();
  }

  function updateHud() {
    if (!hudEl) return;
    var link = connected ? "已连接后端" : "后端未连接";
    var pad = gamepadName ? "手柄已接入" : "无手柄";
    hudEl.textContent = (connected ? "● " : "○ ") + link + " · " + pad + " · 输入源 " + state.source;
    hudEl.style.color = connected ? "#b8f5d0" : "#e0c0ff";
    hudEl.style.borderColor = connected ? "rgba(29,158,117,.45)" : "rgba(224,64,208,.35)";
  }

  function startTelemetry() {
    if (!cfg.telemetry || telemetryTimer) return;
    telemetryTimer = setInterval(function () {
      var el = getCanvas();
      if (!el) return;
      send({
        type: "telemetry",
        version: VERSION,
        ready: el.dataset.ready === "true",
        view: el.dataset.view || "",
        zoom: el.dataset.zoom || "",
        source: state.source,
        move: [state.moveX, state.moveY],
        look: [state.lookX, state.lookY],
        held: Object.keys(heldKeys)
      });
    }, cfg.telemetryIntervalMs);
  }

  function log() {
    if (!window.console || !console.log) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift("[lp-controller]");
    console.log.apply(console, args);
  }

  /* ============================================================
   * 10. 对外 API (供页面或控制台直接调用)
   * ============================================================ */

  window.LPController = {
    version: VERSION,

    move: function (x, y) { setMove(x, y); },
    look: function (x, y) { setLook(x, y); },
    zoomRate: function (r) { state.zoomRate = num(r); },
    zoomStep: function (n) { applyZoom(-num(n) * 120); },
    tap: function (name) { setAction(name, true); setTimeout(function () { setAction(name, false); }, 60); },
    hold: function (name, on) { setAction(name, on); },
    pressKey: pressKey,
    releaseKey: releaseKey,
    tapKey: tapKey,

    reset: resetState,
    status: function () {
      return {
        version: VERSION,
        connected: connected,
        wsUrl: resolveWsUrl(),
        gamepad: gamepadName || null,
        source: state.source,
        move: [state.moveX, state.moveY],
        look: [state.lookX, state.lookY],
        held: Object.keys(heldKeys)
      };
    },
    send: send,
    actions: ACTION_KEY,
    actionNames: Object.keys(ACTION_KEY)
  };

  /* ============================================================
   * 11. 启动
   * ============================================================ */

  function boot() {
    buildHud();
    requestAnimationFrame(loop);
    connect();
    startTelemetry();

    if (cfg.enableGamepad && navigator.getGamepads) {
      setInterval(pollGamepad, 16);
      window.addEventListener("gamepadconnected", function (e) {
        gamepadName = e.gamepad.id;
        updateHud();
        log("手柄已接入", e.gamepad.id);
      });
      window.addEventListener("gamepaddisconnected", function () {
        gamepadName = "";
        updateHud();
        log("手柄已断开");
      });
    }

    /* 页面失焦时清空输入，避免按键卡住 */
    window.addEventListener("blur", function () {
      releaseAllKeys();
      resetState();
    });

    log("输入桥接层已就绪 v" + VERSION);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
