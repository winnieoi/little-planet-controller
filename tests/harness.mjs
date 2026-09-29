/*
 * 一个够用的假浏览器，用来在 node 里直接跑 web/bridge/ 下的真实脚本。
 *
 * 目标不是模拟浏览器，而是把三个 IIFE 跑起来并让它们互相看见：
 *   dualsense.js  -> window.DualSense
 *   lp-controller -> window.LPController
 *   lp-dualsense  -> window.LPDualSense
 *   ds5-adapter   -> window.DS5
 *
 * 时间、rAF、定时器全部手工推进，所以测试是确定性的。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BRIDGE = path.join(ROOT, "web", "bridge");

/* ------------------------------------------------------------------ */
/* 虚拟时钟                                                            */
/* ------------------------------------------------------------------ */

function createClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();

  function schedule(fn, delay, repeat) {
    const id = ++seq;
    timers.set(id, { at: now + Math.max(0, delay || 0), fn, repeat: repeat ? Math.max(1, delay || 1) : 0 });
    return id;
  }

  return {
    now: () => now,
    setTimeout: (fn, d) => schedule(fn, d, false),
    setInterval: (fn, d) => schedule(fn, d, true),
    clearTimeout: (id) => timers.delete(id),
    clearInterval: (id) => timers.delete(id),
    /* 推进到 now + ms，途中该跑的回调都跑 */
    advance(ms) {
      const target = now + ms;
      let guard = 0;
      for (;;) {
        let next = null;
        for (const [, t] of timers) {
          if (t.at <= target && (!next || t.at < next.at)) next = t;
        }
        if (!next) break;
        if (++guard > 10000) throw new Error("定时器回调疑似死循环");
        now = next.at;
        if (next.repeat) next.at = now + next.repeat;
        else timers.delete([...timers.entries()].find(([, t]) => t === next)[0]);
        next.fn();
      }
      now = target;
    },
    pending: () => timers.size
  };
}

/* ------------------------------------------------------------------ */
/* 元素                                                                */
/* ------------------------------------------------------------------ */

function createElement(tag, env) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    id: "",
    dataset: {},
    style: {},
    children: [],
    parentNode: null,
    hidden: false,
    open: false,
    textContent: "",
    type: "",
    _listeners: {},
    _html: "",

    get className() { return this._class || ""; },
    set className(v) { this._class = v; },

    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = String(v);
      /* 把这坨 HTML 里出现的 id 注册进文档，够 querySelector 用 */
      const re = /id="([^"]+)"/g;
      let m;
      while ((m = re.exec(this._html))) {
        const child = createElement("div", env);
        child.id = m[1];
        child.parentNode = this;
        env.byId.set(m[1], child);
      }
    },

    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      if (child.id) env.byId.set(child.id, child);
      return child;
    },

    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },

    setAttribute(name, value) {
      if (name === "id") { this.id = value; env.byId.set(value, this); }
      if (name === "hidden") this.hidden = true;
      this[name] = value;
    },
    getAttribute(name) { return this[name]; },

    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const l = this._listeners[type];
      if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
    },
    dispatch(type, ev) {
      const l = this._listeners[type] || [];
      for (const fn of l.slice()) fn(ev || { type, target: this });
    },
    /* DOM 的真名是 dispatchEvent，脚本里两种写法都有，都认 */
    dispatchEvent(ev) { this.dispatch(ev.type, ev); return true; },
    click() { this.dispatch("click"); env.clickLog.push(this.id || this.tagName); },

    /* 简化版：先在自己注册的 id 里找，再退回全局 */
    querySelector(sel) {
      if (sel && sel[0] === "#") {
        const id = sel.slice(1);
        return (this.children || []).find((c) => c.id === id) || env.byId.get(id) || null;
      }
      if (sel === "dialog[open]") return null;
      return null;
    },
    querySelectorAll() { return []; },
    closest() { return null; },
    focus() {},
    close() { this.open = false; }
  };
  return el;
}

/* ------------------------------------------------------------------ */
/* 环境                                                                */
/* ------------------------------------------------------------------ */

export function createEnv(options = {}) {
  const env = {
    byId: new Map(),
    clickLog: [],
    observers: [],
    keyEvents: [],
    frames: []
  };

  const clock = createClock();
  const doc = {
    readyState: "complete",
    visibilityState: options.visibilityState || "visible",
    body: null,
    _listeners: {},

    getElementById(id) {
      if (!env.byId.has(id)) {
        /* 游戏页面上存在、但适配层只是"可能读一下"的节点也建出来，
           这样测试能覆盖真实调用路径 */
        const el = createElement("div", env);
        el.id = id;
        env.byId.set(id, el);
      }
      return env.byId.get(id);
    },
    createElement: (tag) => createElement(tag, env),
    addEventListener(type, fn) { (doc._listeners[type] = doc._listeners[type] || []).push(fn); },
    removeEventListener() {},
    dispatch(type, ev) { for (const fn of (doc._listeners[type] || []).slice()) fn(ev || { type }); },
    querySelector(sel) {
      if (sel && sel[0] === "#") {
        const id = sel.slice(1).split(" ")[0];
        return env.byId.get(id) || (sel.includes(" ") ? createElement("span", env) : null);
      }
      return null;
    },
    querySelectorAll(sel) { return sel === "dialog[open]" ? (env.openDialogs || []) : []; },
    createEvent: () => ({ initEvent() {}, initMouseEvent() {} })
  };
  doc.body = createElement("body", env);
  env.byId.set("__body", doc.body);

  const winListeners = {};
  const sandbox = {
    console: options.quiet
      ? { log() {}, warn() {}, error() {}, info() {} }
      : console,
    document: doc,
    navigator: { getGamepads: () => (env.pads || []), hid: options.hid === undefined ? undefined : options.hid },
    location: { protocol: "http:", host: "localhost:8765" },
    performance: { now: () => clock.now() },
    requestAnimationFrame: (fn) => { env.frames.push(fn); return env.frames.length; },
    cancelAnimationFrame: () => {},
    setTimeout: clock.setTimeout,
    setInterval: clock.setInterval,
    clearTimeout: clock.clearTimeout,
    clearInterval: clock.clearInterval,
    innerWidth: 1280,
    innerHeight: 720,
    addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const l = winListeners[type];
      if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
    },
    dispatchEvent(ev) {
      env.keyEvents.push({ type: ev.type, code: ev.code });
      for (const fn of (winListeners[ev.type] || []).slice()) fn(ev);
      return true;
    },
    KeyboardEvent: class KeyboardEvent {
      constructor(type, init) { this.type = type; Object.assign(this, init || {}); }
    },
    PointerEvent: class PointerEvent {
      constructor(type, init) { this.type = type; Object.assign(this, init || {}); }
    },
    WheelEvent: class WheelEvent {
      constructor(type, init) { this.type = type; Object.assign(this, init || {}); }
    },
    Event: class Event { constructor(type) { this.type = type; } },
    MutationObserver: class MutationObserver {
      constructor(cb) { this.cb = cb; this.records = []; env.observers.push(this); }
      observe(el, opts) { this.target = el; this.options = opts || {}; }
      disconnect() {}
      takeRecords() { return []; }
      /* 测试里手动触发 */
      fire() { this.cb([{ target: this.target }], this); }
    },
    WebSocket: options.WebSocket,
    __env: env
  };

  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const context = vm.createContext(sandbox);

  env.sandbox = sandbox;
  env.context = context;
  env.document = doc;
  env.clock = clock;

  /* 加载一个脚本文件（相对 web/bridge/） */
  env.load = (file, base) => {
    const full = path.isAbsolute(file) ? file : path.join(base || BRIDGE, file);
    const code = fs.readFileSync(full, "utf8");
    vm.runInContext(code, context, { filename: full });
  };

  /* 跑一帧 rAF（所有已注册的回调） */
  env.tick = (ms = 16) => {
    clock.advance(ms);
    const pending = env.frames.slice();
    env.frames.length = 0;
    for (const fn of pending) fn(clock.now());
  };

  env.advance = (ms) => { clock.advance(ms); return env.tick(0); };

  /* 造一只假手柄 */
  env.makePad = (over) => {
    const buttons = [];
    for (let i = 0; i < 18; i++) buttons.push({ pressed: false, value: 0 });
    const pad = {
      id: "DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)",
      index: 0,
      connected: true,
      mapping: "standard",
      axes: [0, 0, 0, 0],
      buttons,
      timestamp: 0,
      rumbleCalls: [],
      vibrationActuator: {
        type: "dual-rumble",
        playEffect(type, params) {
          pad.rumbleCalls.push({ type, params: params || {} });
          return Promise.resolve("complete");
        },
        reset() { return Promise.resolve(); }
      },
      ...over
    };
    env.pads = [pad];
    return pad;
  };

  /* 造一只假 DS5 HID 设备 */
  env.makeHid = () => {
    const device = {
      vendorId: 0x054c,
      productId: 0x0ce6,
      productName: "DualSense Wireless Controller",
      opened: false,
      reports: [],
      open() { this.opened = true; return Promise.resolve(); },
      close() { this.opened = false; return Promise.resolve(); },
      sendReport(reportId, data) {
        this.reports.push({ reportId, data: Array.from(data) });
        return Promise.resolve();
      },
      addEventListener() {}
    };
    const hid = {
      _devices: [device],
      _listeners: {},
      requestDevice() { device.opened = true; return Promise.resolve([device]); },
      getDevices() { return Promise.resolve(this._devices); },
      addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
      dispatch(type, ev) { for (const fn of (this._listeners[type] || []).slice()) fn(ev); }
    };
    env.hidDevice = device;
    return hid;
  };

  return env;
}

/* ------------------------------------------------------------------ */
/* 迷你断言                                                            */
/* ------------------------------------------------------------------ */

export function createSuite(name) {
  const results = { name, pass: 0, fail: 0, lines: [] };
  const api = {
    ok(cond, label, detail) {
      if (cond) { results.pass++; results.lines.push(`  ✓ ${label}`); }
      else { results.fail++; results.lines.push(`  ✗ ${label}${detail ? "  → " + detail : ""}`); }
      return !!cond;
    },
    eq(actual, expected, label) {
      const good = Object.is(actual, expected);
      return api.ok(good, label, good ? "" : `期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}`);
    },
    near(actual, expected, tol, label) {
      const good = Math.abs(actual - expected) <= tol;
      return api.ok(good, label, good ? "" : `期望 ${expected}±${tol}，实得 ${actual}`);
    },
    group(title) { results.lines.push(`\n[${title}]`); },
    results
  };
  return api;
}
