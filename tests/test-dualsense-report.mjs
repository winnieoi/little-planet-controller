/*
 * 报文布局回归测试。
 *
 * 最重要的一条：**只在右扳机上用的调用方，拿到的 47 字节必须和原始版本逐字节一致。**
 * 我们用 tests/fixtures/dualsense-original.js（加入左扳机之前的版本）做对照，
 * 遍历所有效果类型比对 peek() 的输出。
 */
import { createEnv, createSuite, BRIDGE, ROOT } from "./harness.mjs";
import path from "node:path";

export default async function run() {
  const s = createSuite("dualsense.js 报文布局");

  /* ---------- 1. 基础报文常量 ---------- */
  const env = createEnv({ quiet: true, hid: undefined });
  env.load("dualsense.js");
  const DS = env.sandbox.DualSense;

  s.group("基础报文");
  const base = DS.newReport();
  s.eq(base.length, 47, "报文长度 47");
  s.eq(base[0], 0xff, "data[0] valid_flag0 = 0xFF（拼错会让扳机被静默忽略）");
  s.eq(base[1], 0xf7, "data[1] valid_flag1 = 0xF7");
  s.eq(base[38], 0x06, "data[38] valid_flag2 = 0x06");
  s.eq(base[41], 0x02, "data[41] lightbar_setup = 0x02");
  s.eq(base[42], 0x03, "data[42] led_brightness = 0x03");
  s.eq(DS.OFF.TRIG_R, 10, "右扳机 mode 在 data[10]");
  s.eq(DS.OFF.TRIG_R_P, 11, "右扳机参数从 data[11] 开始");
  s.eq(DS.OFF.TRIG_L, 21, "左扳机 mode 在 data[21]（= 右扳机 + 11）");
  s.eq(DS.OFF.TRIG_L_P, 22, "左扳机参数从 data[22] 开始");
  s.eq(DS.OFF.LED, 44, "灯条 R 在 data[44]");

  /* ---------- 2. 和原始版本逐字节比对（只动右扳机） ---------- */
  s.group("右扳机路径与原始版本逐字节一致");
  {
    const oldEnv = createEnv({ quiet: true });
    oldEnv.load(path.join(ROOT, "tests", "fixtures", "dualsense-original.js"));
    const OldDS = oldEnv.sandbox.DualSense;

    const cases = [
      ["continuous", { force: 200 }],
      ["continuous", { from: 3, force: 90 }],
      ["section", { start: 3, force: 255 }],
      ["effectex", { start: 2, force: 180, freq: 12 }],
      ["weapon", { start: 2, end: 7, strength: 5 }],
      ["bow", { start: 0, end: 7, strength: 7, snap: 8 }],
      ["feedback", { start: 4, end: 6, force: 200 }],
      ["vibration", { start: 2, force: 120, freq: 16 }],
      ["simpleWeapon", { start: 1, end: 8, force: 210 }],
      ["simpleFeedback", { start: 0, force: 160 }]
    ];

    let allSame = true;
    const diffs = [];
    for (const [kind, opts] of cases) {
      const a = DS.create(1).pads[0].led(17, 200, 90).rumble(33, 77).effect(kind, opts).peek();
      const b = OldDS.create(1).pads[0].led(17, 200, 90).rumble(33, 77).effect(kind, opts).peek();
      const same = a.length === b.length && a.every((v, i) => v === b[i]);
      if (!same) {
        allSame = false;
        diffs.push(kind + JSON.stringify(opts));
      }
    }
    s.ok(allSame, `10 种效果 × 灯条 × 振动 全部一致`, diffs.join(", "));

    const ids = DS.create(1).pads[0].effect("weapon", { start: 2, end: 7, strength: 5 }).peek();
    s.eq(ids[21], 0, "只用右扳机时 data[21] 保持 0（不写左扳机）");

    const raw = DS.newReport();
    DS.applyTrigger(raw, DS.MODE.BOW, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    s.eq(raw[10], DS.MODE.BOW, "applyTrigger 三参数调用仍然写右扳机 mode");
    s.eq(raw[11], 1, "applyTrigger 三参数调用仍然写右扳机参数");
    s.eq(raw[21], 0, "applyTrigger 三参数调用不碰左扳机");
  }

  /* ---------- 3. 左扳机 ---------- */
  s.group("左扳机");
  {
    const pad = DS.create(1).pads[0];
    const d = pad.effect("weapon", { side: "left", start: 4, end: 5, strength: 7 }).peek();
    s.eq(d[21], 0x25, "左扳机 mode = WEAPON(0x25)");
    s.eq(d[22], (1 << 4) | (1 << 5), "左扳机 zones = 4|5 = 48");
    s.eq(d[23], 0, "左扳机 zones 高位 = 0");
    s.eq(d[24], 7, "左扳机 strength = 7");
    s.eq(d[10], 0x05, "右扳机同时被显式关掉（默认 OFF=0x05）");

    const both = DS.create(1).pads[0]
      .effect("continuous", { force: 110 })
      .effect("bow", { side: "left", start: 0, end: 7, strength: 6, snap: 7 })
      .peek();
    s.eq(both[10], 0x01, "左右可以同时有不同效果：右=CONTINUOUS");
    s.eq(both[21], 0x22, "左右可以同时有不同效果：左=BOW");

    const cleared = DS.create(1).pads[0]
      .effect("weapon", { side: "left", start: 4, end: 5, strength: 7 })
      .clearTrigger("left")
      .peek();
    s.eq(cleared[21], 0x05, "clearTrigger('left') 把左扳机切成 OFF");

    const bothClear = DS.create(1).pads[0]
      .effect("continuous", { force: 110 })
      .effect("weapon", { side: "left", start: 4, end: 5, strength: 7 })
      .clearTrigger("both")
      .peek();
    s.eq(bothClear[10], 0x05, "clearTrigger('both') 关右");
    s.eq(bothClear[21], 0x05, "clearTrigger('both') 关左");
  }

  /* ---------- 4. 去重与发送 ---------- */
  s.group("flush 去重");
  {
    const e2 = createEnv({ quiet: true });
    e2.load("dualsense.js");
    e2.makeHid();
    const dev = e2.hidDevice;
    const pad = e2.sandbox.DualSense.create(1).pads[0];
    await pad.attach(dev);

    pad.led(10, 20, 30).rumble(40, 50);
    const first = await pad.flush();
    const second = await pad.flush();
    s.ok(first, "第一次 flush 真的发了一帧");
    s.eq(second, false, "状态没变时第二次 flush 被跳过（省 HID 带宽）");
    s.eq(dev.reports.length, 1, "假设备只收到 1 个报文");

    pad.effect("weapon", { side: "left", start: 4, end: 5, strength: 7 });
    const third = await pad.flush();
    s.ok(third, "只改左扳机也会触发一次发送");
    s.eq(dev.reports.length, 2, "假设备收到第 2 个报文");
    const last = dev.reports[dev.reports.length - 1];
    s.eq(last.reportId, 0x02, "report id 是 0x02（USB 有线）");
    s.eq(last.data[21], 0x25, "发出去的左扳机 mode 正确");
    s.eq(last.data[0], 0xff, "发出去的 valid_flag0 是 0xFF");

    const forced = await pad.flush(true);
    s.ok(forced, "force=true 时即使没变化也强发（防止手柄丢效果）");
  }

  return s;
}
