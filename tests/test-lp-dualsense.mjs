/*
 * lp-dualsense.js（DS5 输出层）测试。
 *
 * 分两部分：
 *   A. 纯逻辑 —— RequestEngine 在 node 里直接跑，不需要任何 DOM
 *   B. 胶水层 —— 在假浏览器里启动，验证"拿不到 WebHID 时是静默空操作"
 *      以及"接上真手柄（假 HID 设备）后真的往报文里写了灯条和扳机"
 */
import { createEnv, createSuite } from "./harness.mjs";

const BASE = {
  ready: true,
  region: "meadow",
  swimming: false,
  moving: false,
  jumping: false,
  view: "follow",
  running: false,
  promptVisible: false,
  collected: 0
};

export default async function run() {
  const s = createSuite("lp-dualsense.js 输出层");

  /* ================================================================
   * A. 引擎纯逻辑
   * ================================================================ */
  const env = createEnv({ quiet: true });
  env.load("dualsense.js");
  env.load("lp-dualsense.js");
  const LPD = env.sandbox.LPDualSense;
  const engine = LPD._test.createEngine();

  const step = (over, dt = 1 / 60) => engine.step({ ...BASE, ...over }, dt);

  s.group("区域配色");
  s.eq(JSON.stringify(LPD.regionColor("meadow")), JSON.stringify(env.sandbox.LPDualSense.REGION.meadow.rgb), "meadow 取到自己的颜色");
  s.ok(LPD.regionColor("meadow")[1] > LPD.regionColor("meadow")[0], "赛博草原偏绿");
  s.ok(LPD.regionColor("volcano")[0] > 200, "熔岩高地偏红");
  s.ok(LPD.regionColor("未知区域").length === 3, "未知区域有兜底色，不会返回 undefined");
  s.eq(Object.keys(LPD.REGION).length, 8, "8 个区域（7 个地标区 + 海洋）");

  s.group("灯条跟随状态");
  {
    let out = null;
    for (let i = 0; i < 60; i++) out = step({});
    s.ok(out.led[1] > out.led[0] && out.led[1] > out.led[2], "草原上灯条是绿的");

    const before = out.led.slice();
    for (let i = 0; i < 60; i++) out = step({ swimming: true });
    s.ok(out.led[2] > before[2], "进水后蓝色分量上升");
    s.ok(out.led[1] < before[1], "进水后绿色分量下降");

    const swim = out.led.slice();
    for (let i = 0; i < 60; i++) out = step({});
    s.ok(out.led[2] < swim[2], "上岸后蓝色分量回落");

    const follow = out.led.slice();
    for (let i = 0; i < 60; i++) out = step({ view: "globe" });
    s.ok(out.led[0] < follow[0] && out.led[1] < follow[1], "星球视角下灯条整体压暗");

    const dim = out.led.slice();
    for (let i = 0; i < 60; i++) out = step({ jumping: true, view: "globe" });
    s.ok(out.led[1] > dim[1], "空中灯条提亮");
  }

  s.group("换区域是渐变不是硬切");
  {
    const e = LPD._test.createEngine();
    const a = e.step({ ...BASE, region: "volcano" }, 1 / 60).led.slice();
    const b = e.step({ ...BASE, region: "snow" }, 1 / 60).led;
    s.ok(b[2] > a[2] && b[0] < a[0], "一帧之内只走了一小段，颜色朝新区域移动");
    s.ok(b[0] > 100, "没有瞬间跳成极光青（否则会闪一下）");
    for (let i = 0; i < 120; i++) e.step({ ...BASE, region: "snow" }, 1 / 60);
    const done = e.step({ ...BASE, region: "snow" }, 1 / 60).led;
    s.ok(done[2] > 220 && done[0] < 130, "两秒后完全变成极光基站的颜色");
  }

  s.group("收集到奇迹：灯条闪白");
  {
    const e = LPD._test.createEngine();
    for (let i = 0; i < 30; i++) e.step({ ...BASE, collected: 0 }, 1 / 60);
    const before = e.step({ ...BASE, collected: 0 }, 1 / 60).led.slice();
    const at = e.step({ ...BASE, collected: 1 }, 1 / 60).led;
    s.ok(at[0] > before[0] && at[2] > before[2], "计数 +1 的瞬间灯条向暖白偏移");
    s.ok(at[0] >= 200, "闪得很明显");
    for (let i = 0; i < 70; i++) e.step({ ...BASE, collected: 1 }, 1 / 60);
    const after = e.step({ ...BASE, collected: 1 }, 1 / 60).led;
    s.ok(Math.abs(after[0] - before[0]) < 12 && Math.abs(after[1] - before[1]) < 12, "1 秒后回到区域色");
  }

  s.group("靠近地标：灯条呼吸");
  {
    const e = LPD._test.createEngine();
    let min = 999;
    let max = -1;
    for (let i = 0; i < 180; i++) {
      const led = e.step({ ...BASE, promptVisible: true }, 1 / 60).led;
      min = Math.min(min, led[0]);
      max = Math.max(max, led[0]);
    }
    s.ok(max - min > 25, "呼吸有明显起伏", `幅度 ${max - min}`);
  }

  s.group("振动：连续底噪");
  {
    const idle = LPD._test.createEngine();
    let out = null;
    for (let i = 0; i < 30; i++) out = idle.step({ ...BASE }, 1 / 60);
    s.eq(out.rumble[0], 0, "站着不动不振");

    const walk = LPD._test.createEngine();
    let wmax = 0;
    for (let i = 0; i < 120; i++) { out = walk.step({ ...BASE, moving: true }, 1 / 60); wmax = Math.max(wmax, out.rumble[0]); }
    s.ok(wmax > 20 && wmax < 90, "走路是中等强度的底噪", `峰值 ${wmax}`);

    const run = LPD._test.createEngine();
    let rmax = 0;
    for (let i = 0; i < 120; i++) { out = run.step({ ...BASE, moving: true, running: true }, 1 / 60); rmax = Math.max(rmax, out.rumble[0]); }
    s.ok(rmax > wmax, "奔跑比走路强", `${rmax} > ${wmax}`);

    const swim = LPD._test.createEngine();
    for (let i = 0; i < 60; i++) out = swim.step({ ...BASE, swimming: true }, 1 / 60);
    s.ok(out.rumble[0] > 0 && out.rumble[0] < wmax, "游泳比走路轻");

    const air = LPD._test.createEngine();
    for (let i = 0; i < 30; i++) out = air.step({ ...BASE, jumping: true, moving: true }, 1 / 60);
    s.ok(out.rumble[0] <= 30, "空中只剩很轻的风声（跳的那一下由事件脉冲负责）");

    const load = LPD._test.createEngine();
    for (let i = 0; i < 30; i++) out = load.step({ ...BASE, ready: false, moving: true }, 1 / 60);
    s.eq(out.rumble[0], 0, "还没加载完不振");
  }

  s.group("振动：事件脉冲（ds5-adapter 走这里）");
  {
    const e = LPD._test.createEngine();
    e.pulse(255, 200, 0.15);
    const first = e.step({ ...BASE }, 1 / 60);
    s.ok(first.rumble[0] > 180, "脉冲第一帧就很强", String(first.rumble[0]));
    let last = first;
    for (let i = 0; i < 20; i++) last = e.step({ ...BASE }, 1 / 60);
    s.eq(last.rumble[0], 0, "0.15 秒后脉冲结束归零");

    const d = LPD._test.createEngine();
    d.pulse(255, 255, 0.1);
    let early = 0;
    for (let i = 0; i < 6; i++) early = Math.max(early, d.step({ ...BASE }, 1 / 60).rumble[0]);
    s.ok(early > 100, "第一段响");
    for (let i = 0; i < 12; i++) d.step({ ...BASE }, 1 / 60);
    s.eq(d.step({ ...BASE }, 1 / 60).rumble[0], 0, "两段之间真的静下来过");

    const mixed = LPD._test.createEngine();
    for (let i = 0; i < 10; i++) mixed.step({ ...BASE, moving: true }, 1 / 60);
    mixed.pulse(255, 255, 0.2);
    const onTop = mixed.step({ ...BASE, moving: true }, 1 / 60);
    s.ok(onTop.rumble[0] > 150, "脉冲叠在底噪上是相加的（收集时不会把走路声吃掉）");
  }

  s.group("自适应扳机");
  {
    const e = LPD._test.createEngine();
    const out = e.step({ ...BASE }, 1 / 60);
    s.eq(out.trigR.kind, "continuous", "R2 用持续阻力");
    s.eq(out.trigR.opts.force, 110, "R2 阻力值来自配置");
    s.eq(out.trigL.kind, "weapon", "L2 用两段式档位");
    s.eq(out.trigL.opts.side, "left", "L2 效果发给左扳机");
    s.eq(out.trigL.opts.start, 4, "L2 档位起点 = 4/9 ≈ 44%");
    s.eq(out.trigL.opts.strength, 7, "L2 档位强度 7");

    const loading = LPD._test.createEngine().step({ ...BASE, ready: false }, 1 / 60);
    s.eq(loading.trigR, null, "加载中不给扳机加阻力");
    s.eq(loading.trigL, null, "加载中不给扳机加阻力");
  }

  s.group("引擎容错");
  {
    const e = LPD._test.createEngine();
    s.ok(!!e.step({ ...BASE }, 0), "dt=0 不炸");
    s.ok(!!e.step({ ...BASE }, 5), "dt=5 秒（切标签页回来）被夹住，不炸");
    s.ok(!!e.step({}, 1 / 60), "缺字段的 sample 也不炸");
  }

  /* ================================================================
   * B. 胶水层
   * ================================================================ */

  s.group("浏览器不支持 WebHID 时完全静默");
  {
    const e = createEnv({ quiet: true, hid: undefined });   // 没有 navigator.hid
    e.load("dualsense.js");
    e.load("lp-dualsense.js");
    const api = e.sandbox.LPDualSense;
    s.eq(api.supported, false, "supported = false");
    s.eq(api.isConnected(), false, "isConnected() = false");
    s.eq(api.pulse(1, 1, 100), false, "pulse() 返回 false（调用方应退回 Gamepad API）");
    s.eq(e.byId.has("lp-ds5-chip"), false, "不会硬塞一个用不了的状态条");
    let threw = false;
    try { e.tick(16); e.tick(16); } catch (err) { threw = true; }
    s.eq(threw, false, "每帧跑下来不抛异常");
  }

  s.group("ds5-adapter 在场时不再画自己的状态条");
  {
    const e = createEnv({ quiet: true });
    e.sandbox.navigator.hid = e.makeHid();
    e.load("dualsense.js");
    e.sandbox.DS5 = { version: "1.0.0" };    // 假装 ds5-adapter 已经加载（真实页面里它更早赋值）
    e.load("lp-dualsense.js");
    s.eq(e.byId.has("lp-ds5-chip"), false, "hud=auto 且 DS5 存在 -> 不画自己的状态条");
  }

  s.group("ds5-adapter 不在时才画自己的状态条");
  {
    const e = createEnv({ quiet: true });
    e.sandbox.navigator.hid = e.makeHid();
    e.load("dualsense.js");
    e.load("lp-dualsense.js");
    s.eq(e.byId.has("lp-ds5-chip"), true, "没有 DS5 -> 自己画一条，功能不会丢");
  }

  s.group("接上真手柄：灯条与扳机真的写进报文");
  {
    const e = createEnv({ quiet: true });
    const hid = e.makeHid();
    e.sandbox.navigator.hid = hid;
    e.load("dualsense.js");
    e.load("lp-dualsense.js");

    /* 造一个"游戏已经跑起来"的页面状态 */
    const world = e.document.getElementById("world");
    world.dataset.ready = "true";
    world.dataset.region = "volcano";
    world.dataset.moving = "true";
    e.document.getElementById("interaction").hidden = true;   // 附近没有地标，灯条不呼吸

    const api = e.sandbox.LPDualSense;
    s.eq(api.supported, true, "supported = true");

    await api.connect();
    s.eq(api.isConnected(), true, "connect() 之后 isConnected() = true");
    s.eq(e.hidDevice.opened, true, "HID 设备被打开");

    e.hidDevice.reports.length = 0;
    for (let i = 0; i < 20; i++) e.tick(16);

    s.ok(e.hidDevice.reports.length > 0, "帧循环真的在写手柄", String(e.hidDevice.reports.length));
    const rep = e.hidDevice.reports[e.hidDevice.reports.length - 1];
    s.eq(rep.reportId, 0x02, "report id 0x02");
    s.eq(rep.data[0], 0xff, "valid_flag0 = 0xFF");
    s.ok(rep.data[44] > 150 && rep.data[45] < 120, "灯条是熔岩红（R 高 G 低）", `${rep.data[44]},${rep.data[45]},${rep.data[46]}`);
    s.eq(rep.data[10], 0x01, "R2 = CONTINUOUS");
    s.eq(rep.data[11], 0, "R2 startPosition = 0");
    s.eq(rep.data[12], 110, "R2 force = 110");
    s.eq(rep.data[21], 0x25, "L2 = WEAPON");
    s.eq(rep.data[22], 48, "L2 zones = 4|5");
    s.eq(rep.data[24], 7, "L2 strength = 7");
    s.ok(rep.data[3] > 0 || rep.data[2] > 0, "走路时有振动（马达字节非零）");

    /* 事件脉冲由 ds5-adapter 调进来 */
    e.hidDevice.reports.length = 0;
    s.eq(api.pulse(1, 0.7, 300), true, "pulse() 被 WebHID 接管");
    for (let i = 0; i < 4; i++) e.tick(16);
    const hit = e.hidDevice.reports.map((r) => Math.max(r.data[2], r.data[3]));
    s.ok(Math.max(...hit) > 150, "脉冲期间马达字节明显抬高", String(Math.max(...hit)));

    /* 暂停页面 -> 必须停下来 */
    e.hidDevice.reports.length = 0;
    e.document.visibilityState = "hidden";
    e.document.dispatch("visibilitychange");
    for (let i = 0; i < 3; i++) e.tick(16);
    const hidden = e.hidDevice.reports[e.hidDevice.reports.length - 1];
    s.eq(hidden.data[2], 0, "切到后台时右马达归零");
    s.eq(hidden.data[3], 0, "切到后台时左马达归零");
    e.document.visibilityState = "visible";
    e.document.dispatch("visibilitychange");

    /* 断开 -> 全部归零 + 状态复位 */
    e.hidDevice.reports.length = 0;
    api.disconnect();
    const off = e.hidDevice.reports[e.hidDevice.reports.length - 1];
    s.eq(api.isConnected(), false, "断开后 isConnected() = false");
    s.eq(off.data[44], 0, "断灯条");
    s.eq(off.data[2], 0, "断振动");
    s.eq(off.data[10], 0x05, "关右扳机");
    s.eq(off.data[21], 0x05, "关左扳机");
  }

  s.group("自动重连");
  {
    const e = createEnv({ quiet: true });
    const hid = e.makeHid();
    e.sandbox.navigator.hid = hid;
    e.load("dualsense.js");
    e.load("lp-dualsense.js");
    const api = e.sandbox.LPDualSense;
    await new Promise((r) => setTimeout(r, 0));      // 让 getDevices().then 跑完
    await new Promise((r) => setTimeout(r, 0));
    s.eq(api.isConnected(), true, "之前授权过就自动接上，不用再点一次");
    s.eq(e.hidDevice.opened, true, "设备被打开");
  }

  return s;
}
