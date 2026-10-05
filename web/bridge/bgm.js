/* ============================================================
 * bgm.js —— 背景音乐（无缝无限循环）
 * ------------------------------------------------------------
 * 音频来源：web/bgm/bgm-loop.ogg（主用）/ .mp3（兜底），
 * 由 tools/make-bgm-loop.mjs 从原视频音轨加工而来 —— 已切掉结尾
 * 淡出，并把尾段交叉淡化回开头，所以首尾相接处没有断点。
 *
 * 播放优先走 Web Audio：把整个文件解码成 AudioBuffer 后用
 * BufferSource 的 loop 循环 —— 采样级精确，不会因为解码器补零
 * 而在接缝处"咯噔"一下。<audio loop> 只是拿不到 AudioBuffer
 * 时的兜底（比如拿不到文件的旧浏览器）。
 *
 * 离线单文件版没有外部文件可加载：构建脚本会把音频以 data: URI
 * 写进 window.LPBGM_SRC，这里直接解 base64 解码，不需要 fetch，
 * 所以 file:// 下同样有音乐。
 *
 * 浏览器不允许带声音自动播放：先静默起，等第一次点击/按键再启动。
 * 分屏座位（?seat=N）里不画按钮：声音由宿主页统一管。
 *
 * 手动控制：右上角按钮，或按 M 键。状态存 localStorage。
 * URL 参数 ?bgm=0 强制静音开场，?bgm=1 强制开声。
 * ============================================================ */
(function () {
  "use strict";

  var params = new URLSearchParams(location.search);
  if (params.get("seat")) return; /* 座位侧交给宿主页 */

  var OGG = "./bgm/bgm-loop.ogg";
  var MP3 = "./bgm/bgm-loop.mp3";
  var INLINE = window.LPBGM_SRC || null; /* 离线单文件版：data: URI */
  var VOL = 0.5;
  var FADE_IN = 2.0;
  var FADE_OUT = 0.4;
  var STORE_MUTED = "lp:bgm:muted";

  var muted = params.get("bgm") === "1" ? false
            : params.get("bgm") === "0" ? true
            : localStorage.getItem(STORE_MUTED) === "1";

  /* ---------- 播放核心 ---------- */
  var ctx = null, gain = null, buffer = null, node = null;
  var el = null;                 /* 兜底的 <audio> */
  var ready = false, started = false;

  function now() { return ctx ? ctx.currentTime : 0; }

  function ensureCtx() {
    if (ctx) return ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    gain = ctx.createGain();
    gain.gain.value = muted ? 0 : VOL;
    gain.connect(ctx.destination);
    return ctx;
  }

  /* 拿到音频字节：离线版解 data: URI，在线版 fetch 相对路径 */
  function loadBytes(done, fail) {
    if (INLINE) {
      try {
        var b64 = INLINE.slice(INLINE.indexOf(",") + 1);
        var bin = atob(b64);
        var u8 = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        done(u8.buffer);
      } catch (e) { fail(e); }
      return;
    }
    if (typeof fetch !== "function") { fail(new Error("no fetch")); return; }
    fetch(OGG)
      .then(function (r) { return r.ok ? r.arrayBuffer() : fetch(MP3).then(function (r2) {
        if (!r2.ok) throw new Error("音频加载失败");
        return r2.arrayBuffer();
      }); })
      .then(done, fail);
  }

  function fallbackElement() {
    if (el) return;
    el = new Audio();
    el.loop = true;
    el.preload = "auto";
    el.volume = VOL;
    el.muted = muted;
    if (INLINE) {
      el.src = INLINE;
    } else {
      /* ogg 优先（Vorbis 天然无缝），不支持的浏览器会自己退到 mp3 */
      var o = document.createElement("source"); o.src = OGG; o.type = "audio/ogg";
      var m = document.createElement("source"); m.src = MP3; m.type = "audio/mpeg";
      el.appendChild(o); el.appendChild(m);
    }
  }

  function load() {
    if (ready) return;
    var c = ensureCtx();
    if (!c || typeof c.decodeAudioData !== "function") { ready = true; fallbackElement(); return; }
    loadBytes(function (bytes) {
      c.decodeAudioData(bytes, function (decoded) {
        buffer = decoded;
        ready = true;
        if (!muted) tryStart();
      }, function () { ready = true; fallbackElement(); if (!muted) tryStart(); });
    }, function () { ready = true; fallbackElement(); if (!muted) tryStart(); });
  }

  function startNode() {
    if (!buffer || !ctx) return false;
    stopNode(0);
    node = ctx.createBufferSource();
    node.buffer = buffer;
    node.loop = true;                 /* 采样级循环，无解码器补零造成的空隙 */
    node.connect(gain);
    gain.gain.cancelScheduledValues(now());
    gain.gain.setValueAtTime(0, now());
    gain.gain.linearRampToValueAtTime(VOL, now() + FADE_IN);
    node.start(0);
    started = true;
    return true;
  }

  function stopNode(fade) {
    if (!node) return;
    var n = node;
    node = null;
    try {
      gain.gain.cancelScheduledValues(now());
      gain.gain.setValueAtTime(gain.gain.value, now());
      gain.gain.linearRampToValueAtTime(0, now() + (fade === undefined ? FADE_OUT : fade));
      n.stop(now() + (fade === undefined ? FADE_OUT : fade) + 0.05);
    } catch (e) { /* 已经停了就算了 */ }
    started = false;
  }

  function tryStart() {
    if (muted) return;
    if (!ctx) ensureCtx();
    if (ctx && ctx.state === "suspended" && ctx.resume) ctx.resume();
    if (ready && buffer) { startNode(); return; }
    if (ready && el) { var p = el.play(); if (p && p.catch) p.catch(function () {}); return; }
    load();
  }

  function applyMute() {
    if (gain) {
      gain.gain.cancelScheduledValues(now());
      gain.gain.setValueAtTime(gain.gain.value, now());
      gain.gain.linearRampToValueAtTime(muted ? 0 : VOL, now() + (muted ? FADE_OUT : FADE_IN));
    }
    if (el) el.muted = muted;
    if (muted) {
      stopNode();
      if (el) el.pause();
    } else {
      tryStart();
    }
    try { localStorage.setItem(STORE_MUTED, muted ? "1" : "0"); } catch (e) {}
    paint();
  }

  /* ---------- 按钮 ---------- */
  var btn = document.createElement("button");
  btn.type = "button";
  btn.id = "bgm-toggle";

  function paint() {
    var on = !muted;
    btn.textContent = on ? "♪ 音乐" : "🔇 静音";
    btn.title = on
      ? "背景音乐播放中（点一下静音，或按 M 键）"
      : "背景音乐已静音（点一下播放，或按 M 键）";
    btn.setAttribute("aria-label", btn.title);
    btn.setAttribute("aria-pressed", String(!on));
  }
  paint();

  btn.addEventListener("click", function () { muted = !muted; applyMute(); });

  window.addEventListener("keydown", function (e) {
    if (e.repeat) return;
    /* 输入框里打字不算 */
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.key === "m" || e.key === "M") { muted = !muted; applyMute(); }
  });

  var style = document.createElement("style");
  style.textContent = [
    "#bgm-toggle{position:absolute;top:66px;right:36px;z-index:40;",
    "display:inline-flex;align-items:center;gap:6px;",
    "font:inherit;font-size:12px;letter-spacing:.5px;cursor:pointer;",
    "color:var(--muted);background:var(--glass);",
    "border:1px solid var(--line);border-radius:9px;padding:7px 12px;",
    "-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);",
    "transition:color .2s,border-color .2s;}",
    "#bgm-toggle:hover{color:var(--accent);border-color:var(--accent);}",
    /* 进了双人入口的容器就交给 flex 排，别再各自绝对定位 */
    "#duo-entry-wrap > button#bgm-toggle{position:static;right:auto;top:auto;}",
  ].join("");
  document.head.appendChild(style);

  function mount() {
    var wrap = document.getElementById("duo-entry-wrap");
    if (wrap) { wrap.appendChild(btn); return; }
    var app = document.getElementById("app") || document.body;
    app.appendChild(btn);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();

  /* ---------- 自动播放策略：等第一次交互 ---------- */
  function kick() {
    if (muted) return;
    tryStart();
  }
  /* 首次交互后即可去掉监听；手势内调用才有效，所以保留到真正播起来为止 */
  ["pointerdown", "keydown", "touchstart"].forEach(function (ev) {
    window.addEventListener(ev, function once() {
      kick();
      if (started || (el && !el.paused)) window.removeEventListener(ev, once);
    }, { passive: true });
  });

  /* 切到后台就停，回来再续 —— 别在后台一直响 */
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      stopNode(0.2);
      if (el) el.pause();
    } else if (!muted) {
      tryStart();
    }
  });

  /* 对外留个口子，方便控制台或别的桥接脚本控制 */
  window.LPBGM = {
    toggle: function () { muted = !muted; applyMute(); },
    setMuted: function (v) { muted = !!v; applyMute(); },
    isMuted: function () { return muted; },
    play: function () { muted = false; applyMute(); },
    pause: function () { muted = true; applyMute(); },
    /* 排查用：到底走的哪条路、有没有真的播起来。
       没有音频输出设备的环境（headless）里 state 也可能是 running。 */
    status: function () {
      return {
        muted: muted,
        ready: ready,
        mode: buffer ? "webaudio" : el ? "element" : "none",
        inline: !!INLINE,
        ctx: ctx ? ctx.state : null,
        decodedSeconds: buffer ? +buffer.duration.toFixed(3) : null,
        looping: node ? node.loop : el ? el.loop : null,
        elementPaused: el ? el.paused : null,
      };
    },
  };

  if (!muted) load();
})();
