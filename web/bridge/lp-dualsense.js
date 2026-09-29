/*
 * Little Planet · DualSense (DS5) 输出层 (lp-dualsense.js)
 * ---------------------------------------------------------------
 * 分工（和 ds5-adapter.js 各管一半，边界很清楚）：
 *
 *   ds5-adapter.js  输入映射 + 离散事件振动 + HUD / 按键表
 *   lp-dualsense.js **硬件输出**：灯条、自适应扳机、连续振动（走/跑/游的底噪）
 *
 * 为什么分开：Gamepad API 只能拿到输入，DS5 的灯条和自适应扳机必须走 WebHID；
 * 而离散事件（收集、换区、按键）ds5-adapter 已经有一张调好的 13 种模式表，
 * 没必要做两遍。所以本层只做 Gamepad API 给不了的那部分。
 *
 * 关键点 —— 本层**完全不碰输入**：
 *   · 不调 LPController 的任何写入接口，只读 dataset 与 status()
 *   · 所有游戏状态都来自游戏自己每帧写的 DOM（canvas.dataset.*），不是我们加的钩子
 *   · WebHID 不可用 / 没点击连接 / 手柄拔了 —— 三种情况都是静默空操作
 *
 * 依赖：同目录 dualsense.js（UMD，挂 window.DualSense）
 * 只在 Chrome / Edge 桌面版可用（WebHID）。
 * ---------------------------------------------------------------
 * 版本: 1.1.0
 */
(function () {
  "use strict";

  var VERSION = "1.1.0";

  /* ============================================================
   * 1. 配置（页面里 window.LPDualSenseConfig = {...} 覆盖）
   * ============================================================ */

  var cfg = {
    enable: true,
    /* "auto" = 只有在 ds5-adapter 没加载时才自己画状态条（合并后由后者画） */
    hud: "auto",
    /* 之前授权过就自动接上，不用再点一次 */
    autoConnect: true,
    led: true,
    rumble: true,
    triggers: true,
    /* 灯条整体亮度 0~1 */
    ledLevel: 1,
    /* 连续振动基准（0~255） */
    walkRumble: 46,
    runRumble: 92,
    swimRumble: 34,
    /* R2 的持续阻力（0~255） */
    zoomResistance: 110,
    /* L2 在 50% 处的「奔跑档位」墙 */
    runDetentStart: 4,
    runDetentEnd: 5,
    runDetentStrength: 7,
    /* 靠近地标时灯条呼吸频率 */
    promptBreathHz: 1.6,
    /* 灯条在收集到奇迹时的闪白时长 */
    flashSeconds: 0.9
  };

  if (window.LPDualSenseConfig) {
    for (var ck in window.LPDualSenseConfig) {
      if (Object.prototype.hasOwnProperty.call(window.LPDualSenseConfig, ck)) {
        cfg[ck] = window.LPDualSenseConfig[ck];
      }
    }
  }

  /* ============================================================
   * 2. 区域配色（区域 id 取自游戏 assets/index-*.js 里的 ve 表）
   * ============================================================ */

  var REGION = {
    meadow:  { cn: "赛博草原",   rgb: [ 92, 255, 138] },
    forest:  { cn: "霓虹森林",   rgb: [ 43, 255, 198] },
    desert:  { cn: "工业绿洲",   rgb: [255, 176,  32] },
    coast:   { cn: "数据海湾",   rgb: [ 47, 168, 255] },
    reef:    { cn: "量子珊瑚礁", rgb: [164,  92, 255] },
    volcano: { cn: "熔岩高地",   rgb: [255,  74,  46] },
    snow:    { cn: "极光基站",   rgb: [108, 242, 255] },
    ocean:   { cn: "微光之海",   rgb: [ 16,  80, 200] }
  };

  var REGION_FALLBACK = [200, 120, 255];
  var WATER_TINT = [10, 60, 190];
  var FLASH_TINT = [255, 245, 210];
  var WHITE = [255, 255, 255];

  function regionColor(id) {
    var r = REGION[id];
    return r ? r.rgb.slice() : REGION_FALLBACK.slice();
  }

  function clamp255(v) {
    v = Math.round(v);
    return v < 0 ? 0 : v > 255 ? 255 : v;
  }

  function mix(a, b, t) {
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t
    ];
  }

  function scale(a, k) { return [a[0] * k, a[1] * k, a[2] * k]; }

  /* ============================================================
   * 3. 反馈引擎（纯逻辑，不碰 DOM / 不碰手柄，可在 node 里单测）
   *
   *   var e = createEngine();
   *   e.pulse(l, r, durSec, delaySec);      // 事件脉冲
   *   e.flash();                            // 灯条闪一下
   *   e.step(sample, dt);                   // -> { led, rumble, trigR, trigL }
   *
   * sample：ready / region / swimming / moving / jumping / view /
   *         running / promptVisible / collected
   * ============================================================ */

  function createEngine() {
    return {
      t: 0,
      pulses: [],
      ledBase: null,
      flashLevel: 0,
      prev: null,
      out: { led: [0, 0, 0], rumble: [0, 0], trigR: null, trigL: null },

      pulse: function (left, right, dur, delay) {
        this.pulses.push({
          age: 0,
          delay: delay > 0 ? delay : 0,
          dur: dur > 0.001 ? dur : 0.05,
          l: left,
          r: right
        });
      },

      flash: function () { this.flashLevel = 1; },

      step: function (s, dt) {
        if (!(dt > 0)) dt = 0;
        if (dt > 0.1) dt = 0.1;          // 切标签页回来时不要一步跳很远
        this.t += dt;

        var prev = this.prev;
        if (prev && s.collected > prev.collected) this.flash();

        /* ---- 连续振动底噪 ---- */
        var left = 0;
        var right = 0;
        if (s.ready) {
          if (s.jumping) {
            left = right = 22;                       // 空中：一点风声，别盖掉起跳那下
          } else if (s.swimming) {
            var sw = Math.sin(2 * Math.PI * 1.3 * this.t);
            left = cfg.swimRumble * (1 + 0.22 * sw);
            right = cfg.swimRumble * (1 - 0.22 * sw);
          } else if (s.moving) {
            if (s.running) {
              var gp = Math.sin(2 * Math.PI * 7 * this.t);   // 奔跑：左右交替的马蹄
              left = cfg.runRumble * (1 + 0.35 * gp);
              right = cfg.runRumble * (1 - 0.35 * gp);
            } else {
              var wk = Math.sin(2 * Math.PI * 3.2 * this.t); // 走路：慢一点的呼吸
              left = cfg.walkRumble * (1 + 0.18 * wk);
              right = cfg.walkRumble * (1 - 0.18 * wk);
            }
          }
        }

        /* ---- 叠事件脉冲 ---- */
        var keep = [];
        for (var i = 0; i < this.pulses.length; i++) {
          var p = this.pulses[i];
          p.age += dt;
          if (p.age < p.delay) { keep.push(p); continue; }
          var k = (p.age - p.delay) / p.dur;
          if (k >= 1) continue;
          var env = (1 - k) * (1 - k);      // 快起慢落，才有「敲一下」的手感
          left += p.l * env;
          right += p.r * env;
          keep.push(p);
        }
        this.pulses = keep;

        /* ---- 灯条 ---- */
        var target = regionColor(s.region);
        if (s.swimming) target = mix(target, WATER_TINT, 0.45);
        if (s.view === "globe") target = scale(target, 0.55);
        if (s.jumping) target = scale(target, 1.25);

        if (!this.ledBase) this.ledBase = target.slice();
        else this.ledBase = mix(this.ledBase, target, 1 - Math.exp(-dt / 0.12));

        var led = this.ledBase.slice();
        if (s.promptVisible && s.ready) {
          var br = 0.5 + 0.5 * Math.sin(2 * Math.PI * cfg.promptBreathHz * this.t);
          led = mix(led, WHITE, 0.18 + 0.22 * br);
        }
        if (this.flashLevel > 0) {
          this.flashLevel = Math.max(0, this.flashLevel - dt / cfg.flashSeconds);
          led = mix(led, FLASH_TINT, this.flashLevel * this.flashLevel);
        }
        if (!s.ready) led = scale(led, 0.25);

        led = [
          clamp255(led[0] * cfg.ledLevel),
          clamp255(led[1] * cfg.ledLevel),
          clamp255(led[2] * cfg.ledLevel)
        ];

        /* ---- 自适应扳机 ---- */
        var trigR = null;
        var trigL = null;
        if (cfg.triggers && s.ready) {
          trigR = { kind: "continuous", opts: { from: 0, force: cfg.zoomResistance } };
          trigL = {
            kind: "weapon",
            opts: {
              side: "left",
              start: cfg.runDetentStart,
              end: cfg.runDetentEnd,
              strength: cfg.runDetentStrength
            }
          };
        }

        this.prev = {
          region: s.region,
          collected: s.collected | 0
        };

        this.out = {
          led: led,
          rumble: [clamp255(left), clamp255(right)],
          trigR: trigR,
          trigL: trigL
        };
        return this.out;
      }
    };
  }

  /* ============================================================
   * 4. 浏览器胶水层
   * ============================================================ */

  var supported = typeof navigator !== "undefined" && !!navigator.hid;
  var engine = createEngine();
  var pad = null;
  var chip = null;
  var note = "";
  var noteUntil = 0;
  var visible = true;
  var lastFrame = 0;
  var listeners = [];
  var warnedOnce = false;

  function log() {
    if (!window.console || !console.log) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift("[lp-dualsense]");
    console.log.apply(console, args);
  }

  /* ---------- 读游戏状态：全部来自游戏自己写的 DOM ---------- */

  var canvas = null;
  var interactionEl = null;
  var collectedEl = null;
  var statusCache = null;
  var statusAge = 1;

  function safeStatus() {
    try {
      return (window.LPController && window.LPController.status)
        ? window.LPController.status() : null;
    } catch (e) {
      return null;
    }
  }

  function sampleGame(dt) {
    if (!canvas) canvas = document.getElementById("world");
    if (!interactionEl) interactionEl = document.getElementById("interaction");
    if (!collectedEl) collectedEl = document.getElementById("collected-count");

    var d = canvas ? canvas.dataset : null;

    /* LPController.status() 要分配对象，20Hz 取一次足够 */
    statusAge += dt;
    if (!statusCache || statusAge > 0.05) {
      statusAge = 0;
      statusCache = safeStatus();
    }

    var running = !!(statusCache && statusCache.held &&
      statusCache.held.indexOf("ShiftLeft") >= 0);

    return {
      ready: !!d && d.ready === "true",
      region: (d && d.region) || "",
      swimming: !!d && d.swimming === "true",
      moving: !!d && d.moving === "true",
      jumping: !!d && d.jumping === "true",
      view: (d && d.view) || "follow",
      running: running,
      promptVisible: !!(interactionEl && !interactionEl.hidden),
      collected: collectedEl ? (parseInt(collectedEl.textContent, 10) || 0) : 0
    };
  }

  /* ---------- 每帧 ---------- */

  function frame(now) {
    requestAnimationFrame(frame);
    if (!cfg.enable || !pad || !pad.connected) return;

    if (!lastFrame) lastFrame = now;
    var dt = (now - lastFrame) / 1000;
    lastFrame = now;

    var out;
    try {
      out = engine.step(sampleGame(dt), dt);
    } catch (e) {
      log("结算反馈时出错，跳过这一帧", e);
      return;
    }

    try {
      if (cfg.led) pad.led(out.led[0], out.led[1], out.led[2]);
      if (cfg.rumble) pad.rumble(visible ? out.rumble[0] : 0, visible ? out.rumble[1] : 0);
      if (out.trigR) pad.effect(out.trigR.kind, out.trigR.opts);
      else pad.clearTrigger();
      if (out.trigL) pad.effect(out.trigL.kind, out.trigL.opts);
      else pad.clearTrigger("left");
      pad.flush();
    } catch (e) {
      log("写手柄时出错，跳过这一帧", e);
    }
  }

  /* ---------- 连接 / 断开 ---------- */

  function ensureManager() {
    if (pad) return pad;
    if (!window.DualSense) {
      note = "dualsense.js 没加载";
      log(note);
      return null;
    }
    pad = window.DualSense.create(1).pads[0];
    return pad;
  }

  function notify() {
    paintChip();
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](api.status()); } catch (e) { /* 忽略 */ }
    }
  }

  function connect() {
    /* enable 为 false 表示本层整体停用（例如分屏双人时不由这个座位管输出）。
       它必须挡住手动 connect，否则"停用"只停了一半 —— 页面里若有人调
       LPDualSense.connect()，照样会把设备开起来，和另一个座位抢同一只手柄。 */
    if (!cfg.enable) return Promise.resolve(false);
    if (!supported) {
      say("此浏览器不支持 WebHID，请用 Chrome / Edge 桌面版");
      return Promise.resolve(false);
    }
    if (!ensureManager()) return Promise.resolve(false);
    return pad.open({ filters: [{ vendorId: 0x054c, productId: 0x0ce6 }] })
      .then(function () {
        note = "";
        say("已连接 " + pad.name);
        log("DS5 已连接", pad.name);
        notify();
        return true;
      })
      .catch(function (e) {
        note = e && e.message ? e.message : String(e);
        say(note);
        log("连接未完成：" + note);
        notify();
        return false;
      });
  }

  function autoConnect() {
    if (!supported || !navigator.hid.getDevices) return;
    navigator.hid.getDevices().then(function (list) {
      var dev = null;
      for (var i = 0; i < list.length; i++) {
        if (list[i].vendorId === 0x054c) { dev = list[i]; break; }
      }
      if (!dev || !ensureManager()) return;
      pad.attach(dev).then(function () {
        say("已自动接上 " + pad.name);
        log("自动接上 DS5", pad.name);
        notify();
      }).catch(function (e) {
        /* 别的标签页占着设备时会走到这里，不用打扰用户 */
        log("自动连接失败：" + (e && e.message ? e.message : e));
      });
    }).catch(function () { /* 忽略 */ });
  }

  function disconnect() {
    if (!pad || !pad.connected) return;
    var name = pad.name;
    try {
      pad.led(0, 0, 0).rumble(0, 0).clearTrigger("both");
      pad.flush(true);
    } catch (e) { /* 忽略 */ }
    pad.close();
    engine = createEngine();
    say("已断开 " + name);
    log("DS5 已断开");
    notify();
  }

  /* ---------- 备用状态条（只有 ds5-adapter 不在时才画） ---------- */

  function buildChip() {
    if (chip || !supported) return;
    if (cfg.hud === false) return;
    if (cfg.hud === "auto" && window.DS5) return;   // ds5-adapter 会画，别重复

    chip = document.createElement("button");
    chip.id = "lp-ds5-chip";
    chip.type = "button";
    chip.style.cssText = [
      "position:fixed", "top:44px", "left:50%", "transform:translateX(-50%)",
      "z-index:99", "cursor:pointer",
      "font:12px/1.5 -apple-system,PingFang SC,sans-serif",
      "padding:3px 11px", "border-radius:999px",
      "background:rgba(12,0,24,.72)", "color:#9fd8ff",
      "border:1px solid rgba(64,180,255,.35)",
      "letter-spacing:.4px", "white-space:nowrap"
    ].join(";");
    chip.addEventListener("click", function () { api.toggle(); });
    document.body.appendChild(chip);
    paintChip();
  }

  function paintChip() {
    if (!chip) return;
    var on = !!(pad && pad.connected);
    if (note && performance.now() < noteUntil) {
      chip.textContent = "DS5 · " + note;
      chip.style.color = "#ffd08a";
      chip.style.borderColor = "rgba(255,190,80,.45)";
      return;
    }
    chip.textContent = on
      ? "● DS5 已连接 · " + (pad.name || "DualSense") + " · 点击断开"
      : "○ DS5 未连接 · 点击接入灯条与自适应扳机";
    chip.style.color = on ? "#b8f5d0" : "#9fd8ff";
    chip.style.borderColor = on ? "rgba(29,158,117,.45)" : "rgba(64,180,255,.35)";
  }

  function say(msg) {
    note = msg;
    noteUntil = performance.now() + 4000;
    paintChip();
  }

  /* ---------- 启动 ---------- */

  function boot() {
    if (!cfg.enable) return;

    if (!supported) {
      log("此浏览器没有 navigator.hid（需要 Chrome / Edge 桌面版），DS5 输出层不启用");
      return;
    }
    if (!window.DualSense) {
      log("没找到 dualsense.js，DS5 输出层不启用");
      return;
    }

    buildChip();

    if (navigator.hid.addEventListener) {
      navigator.hid.addEventListener("disconnect", function (e) {
        if (pad && pad.device === e.device) {
          pad.close();
          engine = createEngine();
          say("手柄已拔出");
          log("DS5 已拔出");
          notify();
        }
      });
    }

    document.addEventListener("visibilitychange", function () {
      visible = document.visibilityState !== "hidden";
      if (!visible && pad && pad.connected) {
        try { pad.rumble(0, 0).flush(true); } catch (e) { /* 忽略 */ }
      }
    });

    window.addEventListener("pagehide", function () {
      if (!pad || !pad.connected) return;
      try {
        pad.led(0, 0, 0).rumble(0, 0).clearTrigger("both");
        pad.flush(true);
      } catch (e) { /* 忽略 */ }
    });

    requestAnimationFrame(frame);
    if (cfg.autoConnect) autoConnect();
    setInterval(paintChip, 500);
    log("DS5 输出层已就绪 v" + VERSION);
  }

  /* ============================================================
   * 5. 对外 API
   * ============================================================ */

  var api = {
    version: VERSION,
    supported: supported,
    config: cfg,

    connect: connect,
    disconnect: disconnect,
    toggle: function () {
      if (pad && pad.connected) { disconnect(); return false; }
      return connect();
    },
    isConnected: function () { return !!(pad && pad.connected); },
    deviceName: function () { return pad ? pad.name : ""; },
    onEvent: function (fn) { if (typeof fn === "function") listeners.push(fn); },

    /**
     * 事件脉冲振动（ds5-adapter 的 13 种模式走这里）。
     * strong / weak 是 0~1 的强度，ms 是时长。
     * 返回 true 表示确实交给 DS5 硬件了；false 表示本层没接管（调用方该走别的路）。
     */
    pulse: function (strong, weak, ms, delayMs) {
      if (!cfg.enable || !cfg.rumble) return false;
      if (!pad || !pad.connected) return false;
      var l = Math.max(0, Math.min(1, Number(strong) || 0)) * 255;
      var r = Math.max(0, Math.min(1, Number(weak) || 0)) * 255;
      engine.pulse(l, r, (Number(ms) || 100) / 1000, (Number(delayMs) || 0) / 1000);
      return true;
    },

    /** 灯条闪一下（收集到奇迹时用） */
    flash: function () { engine.flash(); },

    setEnabled: function (on) {
      cfg.enable = !!on;
      if (!on && pad && pad.connected) {
        try { pad.led(0, 0, 0).rumble(0, 0).clearTrigger("both").flush(true); } catch (e) { /* 忽略 */ }
      }
      return cfg.enable;
    },

    status: function () {
      return {
        version: VERSION,
        supported: supported,
        connected: !!(pad && pad.connected),
        name: pad ? pad.name : "",
        note: note,
        led: cfg.led,
        rumble: cfg.rumble,
        triggers: cfg.triggers,
        /* sent/skipped/failed 是实际发出去的报文计数，排障时最有用的三个数：
           sent 一直是 0 说明循环没跑；failed 涨说明设备被别的程序占着。 */
        stats: pad ? pad.stats : null,
        lastRow: pad && pad.connected ? Array.from(pad.peek()).join(",") : "",
        out: engine.out
      };
    },

    regionColor: regionColor,
    REGION: REGION,
    _test: { createEngine: createEngine }
  };

  window.LPDualSense = api;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
