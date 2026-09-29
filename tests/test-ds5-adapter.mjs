/*
 * ds5-adapter.js 测试：输入映射 + 振动路由。
 *
 * 用一个假 DualSense 驱动真实的适配层，和仓库里那份 ds5-selftest.html 是一回事，
 * 区别是这里跑在 node 里，可以进 CI。
 *
 * 重点验证合并后新增的那条：**振动优先走 WebHID（LPDualSense.pulse），
 * WebHID 没接上才退回 Gamepad API 的 vibrationActuator。**
 */
import { createEnv, createSuite } from "./harness.mjs";

function boot(env, ds5Config) {
  if (ds5Config) env.sandbox.DS5Config = ds5Config;
  env.load("lp-controller.js");
  env.load("ds5-adapter.js");
  return env.sandbox.DS5;
}

/* 适配层只把意图写进 LPController 的状态，真正合成按键的是 lp-controller
   自己的 rAF 循环，所以中间隔一帧。tests 里统一用这个 helper 连跑两帧。 */
function settle(env) {
  env.tick(16);
  env.tick(16);
}

/* 造一个完整的页面：游戏里那几个被观察的节点都要在 */
function pageEnv(over) {
  const env = createEnv({ quiet: true, ...over });
  const world = env.document.getElementById("world");
  world.dataset.ready = "true";
  world.dataset.region = "meadow";
  world.dataset.moving = "false";
  world.dataset.jumping = "false";
  env.document.getElementById("collected-count").textContent = "0";
  env.document.getElementById("region-name").textContent = "Clover Fields";
  env.document.getElementById("interaction").hidden = true;
  return env;
}

export default function run() {
  const s = createSuite("ds5-adapter.js 输入与振动");

  /* ================================================================
   * 1. 输入映射（不接 WebHID，纯 Gamepad API 路径）
   * ================================================================ */
  s.group("摇杆与十字键");
  {
    const env = pageEnv({ hid: undefined });
    env.sandbox.LPControllerConfig = { enableGamepad: false, hud: false, enableWs: false, telemetry: false };
    const DS5 = boot(env);
    const pad = env.makePad();
    const LP = env.sandbox.LPController;

    env.tick(16);
    s.eq(JSON.stringify(LP.status().move), "[0,0]", "手柄不动时没有输入");

    pad.axes = [0.9, 0, 0, 0];
    settle(env);
    s.ok(LP.status().move[0] > 0.5, "左摇杆向右 -> move.x 为正");
    s.eq(JSON.stringify(LP.status().held.filter((c) => c === "KeyD")), '["KeyD"]', "合成了 KeyD");

    pad.axes = [0, 0, 0, 0];
    settle(env);
    settle(env);
    s.eq(JSON.stringify(LP.status().move), "[0,0]", "摇杆回中 -> 输入归零");
    s.eq(LP.status().held.length, 0, "回中后不留下卡住的按键", LP.status().held.join(","));

    pad.buttons[12].pressed = true;      // 十字键上
    settle(env);
    s.eq(LP.status().move[1], -1, "十字键上 = 向前");
    pad.buttons[12].pressed = false;

    pad.axes = [0.9, 0, 0, 0];
    pad.buttons[14].pressed = true;      // 十字键左同时压着摇杆右
    settle(env);
    s.eq(LP.status().move[0], -1, "十字键优先于摇杆");
    pad.buttons[14].pressed = false;
    pad.axes = [0, 0, 0, 0];
    settle(env);

    /* 死区 */
    pad.axes = [0.1, 0, 0, 0];
    settle(env);
    s.eq(LP.status().move[0], 0, "死区内的轻微漂移被吃掉");
    pad.axes = [0, 0, 0, 0];
    settle(env);
    s.ok(DS5.status().pad !== null, "status() 认出手柄");
  }

  s.group("按键映射");
  {
    const env = pageEnv({ hid: undefined });
    env.sandbox.LPControllerConfig = { enableGamepad: false, hud: false, enableWs: false, telemetry: false };
    boot(env);
    const pad = env.makePad();

    const press = (idx) => {
      env.keyEvents.length = 0;
      pad.buttons[idx].pressed = true;
      env.tick(16);
      pad.buttons[idx].pressed = false;
      env.tick(16);
      return env.keyEvents.filter((e) => e.type === "keydown").map((e) => e.code);
    };

    s.eq(JSON.stringify(press(0)), '["Space"]', "× -> 跳跃");
    s.eq(JSON.stringify(press(2)), '["KeyE"]', "□ -> 互动");
    s.eq(JSON.stringify(press(3)), '["KeyV"]', "△ -> 切换视角");
    s.eq(JSON.stringify(press(1)), '["Escape"]', "○ -> 取消");
    s.eq(JSON.stringify(press(9)), '["KeyJ"]', "Options -> 探索手记");
    s.eq(JSON.stringify(press(8)), '["KeyH"]', "Create -> 操作说明");
    s.eq(JSON.stringify(press(10)), '["Home"]', "L3 -> 回到草原");
    s.eq(JSON.stringify(press(11)), '["Escape"]', "R3 -> 取消");

    env.clickLog.length = 0;
    pad.buttons[17].pressed = true;
    env.tick(16);
    pad.buttons[17].pressed = false;
    env.tick(16);
    s.eq(JSON.stringify(env.clickLog), '["home-camera"]', "触摸板 -> 点游戏自己的镜头回正按钮");
  }

  s.group("扳机");
  {
    const env = pageEnv({ hid: undefined });
    env.sandbox.LPControllerConfig = { enableGamepad: false, hud: false, enableWs: false, telemetry: false };
    const DS5 = boot(env);
    const pad = env.makePad();
    const LP = env.sandbox.LPController;
    const zoom = () => DS5.status().zoom;

    pad.buttons[6].value = 0.2;
    env.tick(16);
    s.eq(LP.status().held.indexOf("ShiftLeft") >= 0, false, "L2 只推 20% 不算奔跑");
    pad.buttons[6].value = 0.8;
    env.tick(16);
    s.ok(LP.status().held.indexOf("ShiftLeft") >= 0, "L2 推过阈值 > 算奔跑");

    pad.buttons[6].value = 0;
    pad.buttons[7].value = 0.35;
    env.tick(16);
    s.eq(zoom(), 0, "R2 刚好在阈值上 -> 缩放为 0（没有跳变）");

    pad.buttons[7].value = 0.675;         // 阈值 0.35 到 1 的正中间
    env.tick(16);
    s.near(zoom(), 0.6, 0.02, "R2 半程 -> 半速（0.6 = 1.2 × 0.5）");

    pad.buttons[7].value = 1;
    env.tick(16);
    s.near(zoom(), 1.2, 0.001, "R2 推到底 -> 满速 1.2");

    pad.buttons[7].value = 0.351;
    env.tick(16);
    s.ok(zoom() > 0 && zoom() < 0.02, "刚过阈值时速度接近 0，不会突然跳到 0.42", String(zoom()));

    pad.buttons[7].value = 0;
    pad.buttons[5].pressed = true;
    env.tick(16);
    s.near(zoom(), 1.2, 0.001, "R1 满速拉近");
    pad.buttons[5].pressed = false;
    pad.buttons[4].pressed = true;
    env.tick(16);
    s.near(zoom(), -1.2, 0.001, "L1 满速拉远");
    pad.buttons[4].pressed = false;
    env.tick(16);
    s.eq(zoom(), 0, "松开 -> 停止缩放");
  }

  s.group("拔出释放");
  {
    const env = pageEnv({ hid: undefined });
    env.sandbox.LPControllerConfig = { enableGamepad: false, hud: false, enableWs: false, telemetry: false };
    const DS5 = boot(env);
    const pad = env.makePad();
    const LP = env.sandbox.LPController;

    pad.axes = [1, 0, 0, 0];
    pad.buttons[6].value = 1;
    pad.buttons[7].value = 1;
    settle(env);
    s.ok(LP.status().held.length > 0, "拔之前确实有输入");

    env.pads = [];
    settle(env);
    settle(env);
    s.eq(JSON.stringify(LP.status().move), "[0,0]", "拔出手柄 -> 移动归零，不会一直往前走");
    s.ok(LP.status().held.length === 0, "拔出手柄 -> 不留下卡住的按键", LP.status().held.join(","));
    s.eq(DS5.status().zoom, 0, "拔出手柄 -> 停止缩放");
  }

  /* ================================================================
   * 2. 振动路由（合并后的关键改动）
   * ================================================================ */
  s.group("振动：WebHID 没接上时退回 Gamepad API");
  {
    const env = pageEnv({ hid: undefined });
    env.sandbox.LPControllerConfig = { enableGamepad: false, hud: false, enableWs: false, telemetry: false };
    boot(env);
    const pad = env.makePad();

    pad.buttons[0].pressed = true;
    env.tick(16);
    pad.buttons[0].pressed = false;
    env.tick(16);
    s.ok(pad.rumbleCalls.length > 0, "按下 × 时调用了 vibrationActuator", String(pad.rumbleCalls.length));
    const call = pad.rumbleCalls[pad.rumbleCalls.length - 1];
    s.eq(call.type, "dual-rumble", "用的是 dual-rumble");
    s.ok(call.params.strongMagnitude > 0 && call.params.duration > 0, "力度与时长都大于 0");
  }

  s.group("振动：DS5 的 WebHID 接上后改走 WebHID");
  {
    const env = pageEnv();
    env.sandbox.navigator.hid = env.makeHid();
    env.sandbox.LPControllerConfig = { enableGamepad: false, hud: false, enableWs: false, telemetry: false };
    env.load("dualsense.js");
    env.load("lp-dualsense.js");
    boot(env);
    const pad = env.makePad();
    const calls = [];
    env.sandbox.LPDualSense.pulse = (strong, weak, ms) => {
      calls.push({ strong, weak, ms });
      return true;
    };
    env.sandbox.LPDualSense.isConnected = () => true;

    pad.buttons[0].pressed = true;
    env.tick(16);
    pad.buttons[0].pressed = false;
    env.tick(16);

    s.ok(calls.length > 0, "按下 × 时调用了 LPDualSense.pulse");
    s.eq(pad.rumbleCalls.length, 0, "没有再去碰 vibrationActuator（避免两条通道打架）");
    const jump = calls.find((c) => c.ms <= 90);
    s.ok(!!jump, "跳跃用的是短脉冲", JSON.stringify(calls));
    s.ok(jump.strong > 0 && jump.weak > 0, "主副马达都有力度");
    s.ok(jump.strong <= 1 && jump.weak <= 1, "力度是 0~1（交给输出层换算成 0~255）");

    /* WebHID 断了要能自动退回 */
    calls.length = 0;
    env.sandbox.LPDualSense.isConnected = () => false;
    pad.buttons[2].pressed = true;
    env.tick(16);
    pad.buttons[2].pressed = false;
    env.tick(16);
    s.eq(calls.length, 0, "WebHID 断开后不再走 pulse");
    s.ok(pad.rumbleCalls.length > 0, "自动退回 vibrationActuator");
  }

  s.group("振动：游戏事件（观察 DOM）");
  {
    const env = pageEnv({ hid: undefined });
    env.sandbox.LPControllerConfig = { enableGamepad: false, hud: false, enableWs: false, telemetry: false };
    boot(env);
    const pad = env.makePad();
    env.tick(16);

    const before = pad.rumbleCalls.length;
    env.document.getElementById("collected-count").textContent = "1";
    for (const o of env.observers) if (o.target && o.target.id === "collected-count") o.fire();
    s.ok(pad.rumbleCalls.length > before, "收集到奇迹（计数变化）会振");
    const pick = pad.rumbleCalls[pad.rumbleCalls.length - 1];
    s.ok(pick.params.strongMagnitude >= 0.5, "收集用的是最重的那一档");

    /* 落地：dataset.jumping 从 true 变 false */
    const world = env.document.getElementById("world");
    world.dataset.jumping = "true";
    for (const o of env.observers) if (o.target === world && o.options.attributeFilter) o.fire();
    const beforeLand = pad.rumbleCalls.length;
    world.dataset.jumping = "false";
    for (const o of env.observers) if (o.target === world && o.options.attributeFilter) o.fire();
    s.ok(pad.rumbleCalls.length > beforeLand, "落地会振一下");
  }

  s.group("总开关与状态");
  {
    const env = pageEnv({ hid: undefined });
    env.sandbox.LPControllerConfig = { enableGamepad: false, hud: false, enableWs: false, telemetry: false };
    const DS5 = boot(env);
    const pad = env.makePad();
    env.tick(16);
    s.eq(DS5.setRumble(false), false, "setRumble(false) 生效");
    const before = pad.rumbleCalls.length;
    pad.buttons[0].pressed = true;
    env.tick(16);
    s.eq(pad.rumbleCalls.length, before, "关掉振动后不再调用硬件");
    DS5.setRumble(true);

    const st = DS5.status();
    s.eq(st.pad.kind, "DualSense", "识别出手柄型号");
    s.ok(Array.isArray(DS5.patterns) && DS5.patterns.indexOf("pick") >= 0, "暴露了震动模式表");
    s.ok(!!DS5.mapping.buttons["7"], "暴露了按键映射表");
  }

  s.group("HUD");
  {
    const env = pageEnv();
    env.sandbox.navigator.hid = env.makeHid();
    env.sandbox.LPControllerConfig = { enableGamepad: false, hud: false, enableWs: false, telemetry: false };
    env.load("dualsense.js");
    env.load("lp-dualsense.js");
    boot(env);
    env.advance(500);                      // updateHud 是 400ms 一次
    const link = env.byId.get("ds5-link");
    s.ok(!!link, "HUD 里有接入按钮");
    s.eq(link.style.display, "inline-block", "支持 WebHID 时按钮可见");
    s.ok(/接入/.test(link.textContent), "未连接时文案是「接入」", link.textContent);
  }

  s.group("lp-controller 缺失时的兜底");
  {
    const env = pageEnv({ hid: undefined });
    env.sandbox.LPControllerConfig = { enableGamepad: false, hud: false, enableWs: false, telemetry: false };
    env.load("lp-controller.js");
    delete env.sandbox.LPController;          // 假装它没加载成功
    env.load("ds5-adapter.js");
    const pad = env.makePad();
    let threw = false;
    try { env.tick(16); pad.buttons[0].pressed = true; env.tick(16); } catch (e) { threw = true; }
    s.eq(threw, false, "没有 LPController 也不白屏、不抛异常");
    s.ok(!!env.sandbox.DS5.status(), "status() 仍然可用");
  }

  return s;
}
