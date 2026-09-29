/*!
 * dualsense.js —— PS5 DualSense (DS5) 网页控制库
 *
 * 灯条 / 振动 / 自适应扳机，浏览器里直接用。零依赖，不需要构建工具。
 *
 *   <script src="dualsense.js"></script>
 *   <script>
 *     const ds = DualSense.create();
 *     // 用户点一下按钮再连（浏览器要求手势）
 *     button.onclick = async () => { await ds.connect(); };
 *     // 每帧调用
 *     function loop(){
 *       ds.pads[0].effect('continuous', { force: 180 });
 *       ds.update();
 *       requestAnimationFrame(loop);
 *     }
 *   </script>
 *
 * 输入走 Gamepad API（DualSense.readGamepads()），输出走 WebHID。
 * 为什么不用 WebHID 读输入？因为 input report 要自己解析 63 字节的位域，
 * 而 Gamepad API 已经帮你解析好了，还带标准映射。输出则反过来 —— 灯条、
 * 扳机、振动这些 Gamepad API 完全不给，必须 WebHID。
 *
 * 只在 Chrome / Edge 桌面版可用。Safari / Firefox 没有 WebHID。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.DualSense = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ==========================================================================
     报文布局
     依据 Linux 内核 hid-playstation.c 与 Ohjurot DualSense-Windows 的
     DS5_Output.cpp，两个独立实现的偏移完全一致。
     Python 侧（sakura_out.py）用的是同一张表，两边有交叉校验测试。

     WebHID 的 sendReport(0x02, data) 里 data **不含** report id，
     所以下标就是设备 data 的下标：
       data[0]      valid_flag0        ★ 必须是 0xFF
       data[1]      valid_flag1
       data[2]      motor_right
       data[3]      motor_left
       data[8]      mute_button_led
       data[10]     右扳机 mode        ★
       data[11..20] 右扳机 param0..9
       data[21]     左扳机 mode
       data[38]     valid_flag2
       data[41]     lightbar_setup
       data[42]     led_brightness
       data[44..46] lightbar R/G/B
     ========================================================================== */
  const DATA_LEN = 47;

  const OFF = {
    VALID0: 0, VALID1: 1, RUMBLE_R: 2, RUMBLE_L: 3,
    MUTE_LED: 8, POWER_SAVE: 9,
    TRIG_R: 10, TRIG_R_P: 11,
    TRIG_L: 21, TRIG_L_P: 22,
    AUDIO2: 37, VALID2: 38,
    LB_SETUP: 41, LED_BRIGHT: 42, PLAYER_LEDS: 43,
    LED: 44,                       // R；G=45, B=46
  };

  /* 标志位。三个权威实现（Linux 内核 / Ohjurot / Sakura）都用 0xFF + 0xF7，
     语义是"全部启用"。
     ★★ 不要"优化"成按位拼装。曾经用位标志拼出 0xE3，结果手柄**静默忽略
     所有扳机效果**——灯条和振动照常工作，hid_write 也返回成功，没有任何报错。
     这个坑花了一整天才定位到。 */
  const VF0 = 0xff;
  const VF1 = 0xf7;
  const VF2 = 0x02 | 0x04;         // 灯条设置控制 + 兼容振动模式2

  /* 扳机效果模式（取自权威实现） */
  const MODE = {
    OFF: 0x05,
    CONTINUOUS: 0x01,              // 全程持续阻力
    SECTION: 0x02,                 // 分段阻力
    EFFECT_EX: 0x26,               // 精细控制
    WEAPON: 0x25,                  // 两段式，像枪机
    BOW: 0x22,                     // 回顶，像弓弦
    FEEDBACK: 0x21,                // 分区力度
    VIBRATION: 0x26,               // 扳机内振动
    SIMPLE_WEAPON: 0x02,
    SIMPLE_FEEDBACK: 0x01,
  };

  const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
  const i255 = v => Math.round(clamp(v, 0, 255));
  const i7 = v => Math.round(clamp(v, 0, 7));

  /* ==========================================================================
     参数打包
     ★ 所有值必须取整。s*255/9 会得到浮点，而 Uint8Array 对浮点的截断行为
     不可控（可能和预期差 1），实测吃过这个亏。
     ========================================================================== */
  const pos255 = v => i255(v * 255 / 9);      // 0~9 档 -> 0~255

  function buildParams(kind, o) {
    const p = new Array(10).fill(0);
    o = o || {};
    const force = o.force === undefined ? 200 : o.force;
    const start = o.start === undefined ? 2 : o.start;
    const end = o.end === undefined ? 7 : o.end;
    const freq = o.freq === undefined ? 10 : o.freq;
    // strength 直接就是报文里的那个 0~7 的字节。给了它就用它，
    // 否则从 force(0~255) 折算 —— 两个口径都能用。
    const strength = o.strength !== undefined ? i7(o.strength) : i7(force / 32);

    switch (kind) {
      case 'continuous':
        p[0] = pos255(o.from === undefined ? 0 : o.from);   // startPosition
        p[1] = i255(force);
        break;

      case 'section':
        p[0] = pos255(start);
        p[1] = i255(force);
        break;

      case 'effectex': {
        // 注意：这里是 255 - startPosition，和别的效果方向相反
        p[0] = i255(255 - start * 255 / 9);
        p[1] = 0x02;                                        // keepEffect
        const f = i255(force);
        p[3] = f; p[4] = f; p[5] = f;                       // forces
        p[8] = i255(Math.max(1, Math.floor(freq / 2)));     // frequency
        break;
      }

      case 'weapon': {
        const a = clamp(Math.round(start), 2, 7);
        const b = clamp(Math.round(end), a + 1, 8);
        const mask = (1 << a) | (1 << b);
        p[0] = mask & 0xff; p[1] = (mask >> 8) & 0xff;
        p[2] = strength;
        break;
      }

      case 'bow': {
        const a = clamp(Math.round(start), 0, 8);
        const b = clamp(Math.round(end), a + 1, 8);
        const mask = (1 << a) | (1 << b);
        p[0] = mask & 0xff; p[1] = (mask >> 8) & 0xff;
        p[2] = strength;
        // 回顶力 0~8。默认 5；《蛛网蜘蛛》那种"丝快绷断了"的警告要更大的值。
        p[3] = o.snap === undefined ? 5 : Math.round(clamp(o.snap, 0, 8));
        break;
      }

      case 'feedback': {
        let zones = 0, forces = 0;
        for (let i = Math.round(start); i <= Math.round(end) && i < 10; i++) {
          zones |= (1 << i);
          forces |= ((i7(force / 32) & 7) << (3 * i));
        }
        p[0] = zones & 0xff;  p[1] = (zones >> 8) & 0xff;
        p[2] = forces & 0xff; p[3] = (forces >> 8) & 0xff;
        p[4] = (forces >> 16) & 0xff; p[5] = (forces >> 24) & 0xff;
        break;
      }

      case 'vibration':
        p[0] = pos255(start);
        p[1] = i255(force);
        p[2] = i255(Math.max(1, freq));
        break;

      case 'simpleWeapon':
        p[0] = pos255(start);
        p[1] = pos255(end);
        p[2] = i255(force);
        break;

      case 'simpleFeedback':
        p[0] = pos255(start);
        p[1] = i255(force);
        break;
    }
    return p;
  }

  const EFFECT_MODE = {
    off: MODE.OFF,
    continuous: MODE.CONTINUOUS,
    section: MODE.SECTION,
    effectex: MODE.EFFECT_EX,
    weapon: MODE.WEAPON,
    bow: MODE.BOW,
    feedback: MODE.FEEDBACK,
    vibration: MODE.VIBRATION,
    simpleWeapon: MODE.SIMPLE_WEAPON,
    simpleFeedback: MODE.SIMPLE_FEEDBACK,
  };

  function newReport() {
    const d = new Uint8Array(DATA_LEN);
    d[OFF.VALID0] = VF0;
    d[OFF.VALID1] = VF1;
    d[OFF.VALID2] = VF2;
    d[OFF.LB_SETUP] = 0x02;
    d[OFF.LED_BRIGHT] = 0x03;
    return d;
  }

  function applyTrigger(d, mode, params) {
    d[OFF.TRIG_R] = mode & 0xff;
    for (let i = 0; i < params.length && i < 10; i++) {
      d[OFF.TRIG_R_P + i] = params[i] & 0xff;
    }
  }
  function applyLed(d, rgb) {
    d[OFF.LED] = i255(rgb[0]); d[OFF.LED + 1] = i255(rgb[1]); d[OFF.LED + 2] = i255(rgb[2]);
  }
  function applyRumble(d, left, right) {
    d[OFF.RUMBLE_L] = i255(left); d[OFF.RUMBLE_R] = i255(right);
  }

  function hexDump(d) {
    let out = '';
    for (let i = 0; i < d.length; i += 16) {
      out += `[${String(i).padStart(2, '0')}] `
        + Array.from(d.slice(i, i + 16)).map(v => v.toString(16).padStart(2, '0')).join(' ')
        + '\n';
    }
    return out;
  }

  /* ==========================================================================
     单只手柄
     ========================================================================== */
  class Pad {
    constructor(index) {
      this.index = index === undefined ? 0 : index;
      this.device = null;
      this.name = '';
      this.available = true;        // WebHID 是否可用
      this.note = '';
      this.error = null;

      this._led = [0, 0, 0];
      this._rumble = [0, 0];
      this._trigger = { mode: MODE.OFF, params: [] };

      this._sentLed = null;
      this._sentRumble = null;
      this._sentTrigger = null;
      this._lastFlush = 0;
      this.stats = { sent: 0, skipped: 0, failed: 0 };
    }

    get connected() { return !!(this.device && this.device.opened); }

    /** 弹出设备选择器并打开。必须在用户手势里调用（浏览器要求）。 */
    async open(options) {
      if (typeof navigator === 'undefined' || !navigator.hid) {
        this.available = false;
        this.note = '此浏览器不支持 WebHID，请用 Chrome / Edge 桌面版';
        throw new Error(this.note);
      }
      const filters = (options && options.filters) || [{ vendorId: 0x054c }];
      const picked = await navigator.hid.requestDevice({ filters });
      if (!picked || !picked.length) {
        this.note = '没有选择设备';
        throw new Error(this.note);
      }
      // 支持一次选多个：把没被占用的都收进来
      const fresh = picked.filter(d => !(options && options.taken && options.taken.has(d)));
      const dev = fresh[0] || picked[0];
      if (!dev.opened) await dev.open();
      this.device = dev;
      this.name = dev.productName || 'DualSense';
      this.note = '已连接';
      // 立刻点一下灯条，确认输出通道是通的
      const d = newReport();
      applyLed(d, [0, 255, 0]);
      await this._write(d);
      return dev;
    }

    close() {
      const dev = this.device;
      this.device = null;
      this._sentLed = this._sentRumble = this._sentTrigger = null;
      this._lastFlush = 0;
      if (dev && dev.opened) { try { dev.close(); } catch (e) { /* 忽略 */ } }
    }

    /* ---------- 设定期望状态（不发送） ---------- */

    /** led(255,0,0) 或 led([255,0,0]) */
    led(r, g, b) {
      if (Array.isArray(r)) { this._led = [r[0], r[1], r[2]]; }
      else { this._led = [r, g, b]; }
      return this;
    }

    /** rumble(左马达, 右马达)，各 0~255 */
    rumble(left, right) {
      this._rumble = [left, right === undefined ? left : right];
      return this;
    }

    /**
     * 自适应扳机。
     *   pad.effect('continuous', { force: 200 })   全程阻力
     *   pad.effect('bow', { force: 200 })          回顶（过载警告那种）
     *   pad.effect('bow', { start:0, end:7, strength:7, snap:8 })  更强的回顶
     *   pad.effect('off')                          清除
     * kind 见 DualSense.EFFECTS
     *
     * weapon / bow 的 strength 是报文里那个 0~7 的字节；不给就用 force 折算。
     * bow 的 snap（回顶力 0~8）默认 5。
     */
    effect(kind, opts) {
      if (!kind || kind === 'off') return this.clearTrigger();
      const mode = EFFECT_MODE[kind];
      if (mode === undefined) throw new Error('未知的扳机效果: ' + kind);
      this._trigger = { mode, params: buildParams(kind, opts) };
      return this;
    }

    clearTrigger() {
      this._trigger = { mode: MODE.OFF, params: [] };
      return this;
    }

    /* ---------- 发送 ---------- */

    /**
     * 把当前状态写出去。带去重 + 定期强发。
     *
     * 为什么要"定期强发"（默认 0.5 秒）？因为手柄可能因为内部状态重置而丢掉
     * 效果，只靠去重就再也发不出去了 —— 表现为"阻力用着用着没了"。
     *
     * 每帧调用是安全的，内部会跳过没变化的帧。
     */
    async flush(force) {
      if (!this.connected) return false;
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const same = this._sentLed && this._sentRumble && this._sentTrigger
        && this._led[0] === this._sentLed[0] && this._led[1] === this._sentLed[1]
        && this._led[2] === this._sentLed[2]
        && this._rumble[0] === this._sentRumble[0] && this._rumble[1] === this._sentRumble[1]
        && this._trigger.mode === this._sentTrigger.mode
        && this._trigger.params.join(',') === this._sentTrigger.params.join(',');

      const stale = now - this._lastFlush > 500;
      if (!force && same && !stale) { this.stats.skipped++; return false; }

      this._lastFlush = now;
      const d = newReport();
      applyLed(d, this._led);
      applyRumble(d, this._rumble[0], this._rumble[1]);
      applyTrigger(d, this._trigger.mode, this._trigger.params);

      const ok = await this._write(d);
      if (ok) {
        this._sentLed = this._led.slice();
        this._sentRumble = this._rumble.slice();
        this._sentTrigger = { mode: this._trigger.mode, params: this._trigger.params.slice() };
        this.stats.sent++;
      }
      return ok;
    }

    async _write(d) {
      if (!this.device) return false;
      try {
        await this.device.sendReport(0x02, d);
        return true;
      } catch (e) {
        this.error = e;
        this.stats.failed++;
        return false;
      }
    }

    /** 拼出这一帧会发出去的报文（调试用，不发送） */
    peek() {
      const d = newReport();
      applyLed(d, this._led);
      applyRumble(d, this._rumble[0], this._rumble[1]);
      applyTrigger(d, this._trigger.mode, this._trigger.params);
      return d;
    }

    hex() { return hexDump(this.peek()); }
  }

  /* ==========================================================================
     管理器：多个手柄 + 每帧更新
     ========================================================================== */
  class Manager {
    constructor(n) {
      this.pads = [];
      for (let i = 0; i < (n || 2); i++) this.pads.push(new Pad(i));
      this._taken = new Set();
    }

    get count() { return this.pads.filter(p => p.connected).length; }

    /** 连接第 index 个手柄（会弹出选择器，必须在用户手势里调用） */
    async connect(index) {
      const pad = this.pads[index === undefined ? 0 : index];
      if (!pad) throw new Error('没有第 ' + index + ' 个手柄槽位');
      const dev = await pad.open({ taken: this._taken });
      this._taken.add(dev);
      return pad;
    }

    /** 每帧调用一次即可 */
    update(force) {
      return Promise.all(this.pads.map(p => p.flush(force)));
    }

    /** 全部关掉灯、振动、扳机效果 */
    async reset() {
      for (const p of this.pads) {
        if (!p.connected) continue;
        p.led(0, 0, 0).rumble(0, 0).clearTrigger();
        await p.flush(true);
      }
    }

    disconnectAll() { this.pads.forEach(p => p.close()); this._taken.clear(); }
  }

  /* ==========================================================================
     输入：Gamepad API
     ========================================================================== */
  const BUTTONS = {
    cross: 0, circle: 1, square: 2, triangle: 3,
    l1: 4, r1: 5, l2: 6, r2: 7,
    create: 8, options: 9, l3: 10, r3: 11,
    up: 12, down: 13, left: 14, right: 15, ps: 16,
  };

  /** 读出所有已连接手柄的标准化状态 */
  function readGamepads() {
    const out = [];
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return out;
    const list = navigator.getGamepads();
    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      if (!g || !g.connected) continue;
      const btn = n => (g.buttons[n] ? g.buttons[n].value : 0);
      const pressed = n => !!(g.buttons[n] && g.buttons[n].pressed);
      const axes = g.axes || [];
      out.push({
        index: i, id: g.id, mapping: g.mapping,
        l2: btn(6), r2: btn(7),            // 模拟量 0~1
        l1: pressed(4), r1: pressed(5),
        cross: pressed(0), circle: pressed(1),
        square: pressed(2), triangle: pressed(3),
        up: pressed(12), down: pressed(13), left: pressed(14), right: pressed(15),
        lx: axes[0] || 0, ly: axes[1] || 0,
        rx: axes[2] || 0, ry: axes[3] || 0,
        raw: g,
      });
    }
    return out;
  }

  /**
   * 边沿检测小工具：给"按一下切换"这类逻辑用。
   *   const edge = DualSense.edges(2);
   *   const trig = edge.update(DualSense.readGamepads().map(p => p.l2 > 0.5));
   */
  function edges(n) {
    const prev = new Array(n).fill(false);
    return {
      update(cur) {
        const out = [];
        for (let i = 0; i < n; i++) {
          const c = !!cur[i];
          out.push(c && !prev[i]);
          prev[i] = c;
        }
        return out;
      },
    };
  }

  /* ==========================================================================
     导出
     ========================================================================== */
  return {
    create: (n) => new Manager(n),
    Manager, Pad,
    readGamepads, edges,
    newReport, buildParams, hexDump,
    DATA_LEN, OFF, MODE, EFFECTS: Object.keys(EFFECT_MODE),
    applyTrigger, applyLed, applyRumble,
  };
});
