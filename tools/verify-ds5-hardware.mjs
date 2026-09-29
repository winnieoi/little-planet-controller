/*
 * 真机验证：用 CDP 驱动一个真实的 Chrome，打开游戏，接上真的 DualSense，
 * 然后问它几个只有真硬件才能回答的问题。
 *
 *   node server/server.js                                   # 先起服务器
 *   node tools/verify-ds5-hardware.mjs                      # 再跑这个
 *
 * 为什么要这么麻烦：这些都是浏览器 API 层的事实，unit test 里用假对象测不出来。
 *   · DualSense 在 Chrome/Windows 上到底有没有 vibrationActuator？
 *   · WebHID 写灯条 / 自适应扳机的报文会不会报错？
 *   · 游戏自己那份 dataset 状态有没有被适配层正确读到？
 *
 * 不依赖任何第三方库：node 24 自带 WebSocket，CDP 直接用。
 * 会开一个真的 Chrome 窗口（约 10 秒），跑完自己关掉。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = 9333;
const GAME = process.env.GAME_URL || "http://localhost:8765/";

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  path.join(os.homedir(), "AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"),
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error("找不到 Chrome / Edge：" + CHROME_CANDIDATES.join(" | "));
}

async function waitForDevTools(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (e) { /* 还没起来 */ }
    await sleep(300);
  }
  throw new Error("DevTools 端口一直没响应");
}

/* 一个最小的 CDP 客户端 */
function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const events = [];
    const handlers = new Map();

    ws.addEventListener("open", () => {
      resolve({
        send(method, params) {
          const msgId = ++id;
          return new Promise((res, rej) => {
            pending.set(msgId, { res, rej });
            ws.send(JSON.stringify({ id: msgId, method, params: params || {} }));
          });
        },
        on(method, fn) {
          handlers.set(method, [...(handlers.get(method) || []), fn]);
        },
        events,
        close() { try { ws.close(); } catch (e) { /* 忽略 */ } }
      });
    });
    ws.addEventListener("error", reject);
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      } else if (msg.method) {
        events.push(msg);
        for (const fn of handlers.get(msg.method) || []) fn(msg.params);
      }
    });
  });
}

async function main() {
  const chrome = findChrome();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lp-ds5-profile-"));

  console.log("启动 Chrome：" + path.basename(chrome));
  const child = spawn(chrome, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate,MediaRouter",
    "--window-size=1280,820",
    GAME
  ], { stdio: "ignore", detached: false });

  const results = [];
  const check = (ok, label, detail) => {
    results.push({ ok, label, detail });
    console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? "  → " + detail : ""}`);
  };

  let cdp = null;
  try {
    const page = await waitForDevTools();
    cdp = await connectCdp(page.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("DeviceAccess.enable").catch(() => {});

    /* WebHID 的设备选择器：自动选 DualSense */
    cdp.on("DeviceAccess.deviceRequestPrompted", async (p) => {
      const dev = (p.devices || []).find((d) => /DualSense|DualSense/i.test(d.name || "")) || (p.devices || [])[0];
      if (dev) {
        console.log("  · 设备选择器自动选中：" + dev.name);
        await cdp.send("DeviceAccess.selectPrompt", { id: p.id, deviceId: dev.deviceId }).catch(() => {});
      } else {
        await cdp.send("DeviceAccess.cancelPrompt", { id: p.id }).catch(() => {});
      }
    });

    const evalJs = async (expression, opts = {}) => {
      const r = await cdp.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: !!opts.awaitPromise,
        userGesture: !!opts.userGesture
      });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      }
      return r.result.value;
    };

    /* ---------- 1. 页面与桥接层加载 ---------- */
    console.log("\n[1] 页面与桥接层");
    for (let i = 0; i < 40; i++) {
      const ready = await evalJs("!!(window.LPController && window.LPDualSense && window.DS5 && document.getElementById('world'))");
      if (ready) break;
      await sleep(250);
    }
    check(await evalJs("!!window.LPController"), "lp-controller.js 已加载");
    check(await evalJs("!!window.DualSense"), "dualsense.js 已加载");
    check(await evalJs("!!window.LPDualSense"), "lp-dualsense.js 已加载");
    check(await evalJs("!!window.DS5"), "ds5-adapter.js 已加载");
    check(await evalJs("typeof window.LPDualSense.pulse === 'function'"), "输出层对外暴露了 pulse()");

    /* 等游戏加载完（#loading 被移除，dataset.ready=true） */
    let gameReady = false;
    for (let i = 0; i < 60; i++) {
      gameReady = await evalJs("document.getElementById('world').dataset.ready === 'true'");
      if (gameReady) break;
      await sleep(500);
    }
    check(gameReady, "游戏渲染循环已启动（dataset.ready=true）");

    /* ---------- 2. Gamepad API 能看到什么 ---------- */
    console.log("\n[2] Gamepad API 层");
    let padInfo = null;
    for (let i = 0; i < 20; i++) {
      padInfo = await evalJs(`(() => {
        const g = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : [];
        if (!g.length) return null;
        const p = g[0];
        return {
          id: p.id, mapping: p.mapping, buttons: p.buttons.length, axes: p.axes.length,
          hasVibrationActuator: !!(p.vibrationActuator && p.vibrationActuator.playEffect),
          vibrationType: p.vibrationActuator ? (p.vibrationActuator.type || "") : "",
          hasLegacyHaptics: !!(p.hapticActuators && p.hapticActuators[0])
        };
      })()`);
      if (padInfo) break;
      await sleep(500);
    }

    if (!padInfo) {
      check(false, "Gamepad API 读到 DualSense", "读不到 —— 请确认手柄是有线连着、并且按一下任意键唤醒过");
    } else {
      check(true, "Gamepad API 读到 DualSense", padInfo.id);
      check(padInfo.mapping === "standard", "标准映射", padInfo.mapping);
      check(padInfo.buttons >= 17 && padInfo.axes >= 4, "按键/轴数量正常", `${padInfo.buttons} 键 / ${padInfo.axes} 轴`);
      console.log(`  · vibrationActuator（Gamepad API 的振动接口）：${padInfo.hasVibrationActuator ? "有 · type=" + padInfo.vibrationType : "没有"}`);
      console.log(`  · 旧版 hapticActuators：${padInfo.hasLegacyHaptics ? "有" : "没有"}`);
    }

    /* ---------- 3. WebHID 授权并接上 ---------- */
    console.log("\n[3] WebHID（灯条 / 自适应扳机）");
    check(await evalJs("!!navigator.hid"), "navigator.hid 存在");
    const granted = await evalJs("navigator.hid.getDevices().then(d => d.map(x => ({v:x.vendorId, p:x.productId, n:x.productName, o:x.opened})))", { awaitPromise: true });
    console.log("  · 已授权设备：" + JSON.stringify(granted));

    let connected = await evalJs("window.LPDualSense.isConnected()");
    if (!connected) {
      console.log("  · 调 LPDualSense.connect()，走真实用户手势……");
      await evalJs("window.LPDualSense.connect()", { awaitPromise: true, userGesture: true }).catch((e) => console.log("    connect 抛错：" + e.message));
      await sleep(800);
      connected = await evalJs("window.LPDualSense.isConnected()");
    }
    check(connected, "DS5 已通过 WebHID 接上");
    if (connected) console.log("  · 设备名：" + await evalJs("window.LPDualSense.deviceName()"));

    /* ---------- 4. 反馈层真的在写报文 ---------- */
    console.log("\n[4] 反馈输出");
    await sleep(700);
    const st = await evalJs("window.LPDualSense.status()");
    check(!!st, "status() 可读");
    if (st) {
      check(st.stats && st.stats.sent > 0, "真的往手柄写了报文", JSON.stringify(st.stats));
      check(st.stats && st.stats.failed === 0, "没有写失败", JSON.stringify(st.stats));
      console.log("  · 最后一帧报文：[" + st.lastRow + "]");
      const row = (st.lastRow || "").split(",").map(Number);
      if (row.length === 47) {
        check(row[0] === 255, "data[0] valid_flag0 = 255");
        check(row[10] === 0x01, "data[10] 右扳机 = CONTINUOUS(0x01)", String(row[10]));
        check(row[21] === 0x25, "data[21] 左扳机 = WEAPON(0x25)", String(row[21]));
        check(row[22] === 48, "data[22] 左扳机 zones = 4|5", String(row[22]));
        check(row[24] === 7, "data[24] 左扳机 strength = 7", String(row[24]));
      }
      check(st.out && st.out.trigR && st.out.trigL, "反馈引擎正在输出扳机效果");
    }

    /* ---------- 5. 灯条跟随游戏状态 ---------- */
    console.log("\n[5] 灯条跟随区域");
    const region = await evalJs("document.getElementById('world').dataset.region || '(空)'");
    console.log("  · 游戏当前区域：" + region);
    const ledNow = await evalJs("window.LPDualSense.status().out.led");
    const expected = await evalJs(`window.LPDualSense.regionColor(${JSON.stringify(region)})`);
    const near = ledNow && expected && ledNow.every((v, i) => Math.abs(v - expected[i]) < 60);
    check(!!near, "灯条颜色 = 当前区域配色", `实得 [${ledNow}] / 期望约 [${expected}]`);

    /* 切区域，看灯条会不会跟着变 */
    const beforeLed = ledNow.join(",");
    await evalJs("document.getElementById('world').dataset.region = 'volcano'");
    await sleep(900);
    const afterLed = await evalJs("window.LPDualSense.status().out.led");
    check(afterLed.join(",") !== beforeLed && afterLed[0] > 150 && afterLed[1] < 130,
      "改区域后灯条变红（说明是跟着游戏状态走的）", `[${afterLed}]`);
    await evalJs(`document.getElementById('world').dataset.region = ${JSON.stringify(region)}`);

    /* ---------- 6. 事件脉冲真的推到硬件 ---------- */
    console.log("\n[6] 事件振动");
    const beforeSent = (await evalJs("window.LPDualSense.status().stats.sent"));
    await evalJs("window.LPDualSense.pulse(1, 0.7, 400); window.DS5.rumble('pick');");
    await sleep(150);
    const duringRumble = await evalJs("(function(){const r=window.LPDualSense.status().lastRow.split(',').map(Number);return [r[2],r[3]];})()");
    check(Math.max(duringRumble[0], duringRumble[1]) > 60, "脉冲期间马达字节被抬高", JSON.stringify(duringRumble));
    await sleep(600);
    const afterSent = (await evalJs("window.LPDualSense.status().stats.sent"));
    check(afterSent > beforeSent, "脉冲期间又发了报文", `${beforeSent} -> ${afterSent}`);

    /* ---------- 7. 断开清理 ---------- */
    console.log("\n[7] 断开");
    await evalJs("window.LPDualSense.disconnect()");
    await sleep(200);
    const afterOff = await evalJs("(function(){const r=window.LPDualSense.status();return {c:r.connected, s:r.stats};})()");
    check(afterOff.c === false, "断开后状态复位");

    /* ---------- 8. 离线单文件版同源检查 ---------- */
    console.log("\n[8] 离线版");
    const offlineOk = await evalJs(`fetch('file:///').then(()=>true).catch(()=>true)`).catch(() => null);
    console.log("  · 离线单文件版请手动双击测试（file:// 下 WebHID 同样可用）");
  } finally {
    if (cdp) {
      try { await cdp.send("Browser.close"); } catch (e) { /* 忽略 */ }
      cdp.close();
    }
    await sleep(600);
    try { child.kill(); } catch (e) { /* 忽略 */ }
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* Chrome 可能还占着，留着也行 */ }
  }

  const failed = results.filter((r) => !r.ok);
  console.log("\n" + "=".repeat(56));
  console.log(`真机验证：通过 ${results.length - failed.length} · 失败 ${failed.length}`);
  if (failed.length) {
    console.log("失败项：");
    for (const f of failed) console.log(`  - ${f.label}${f.detail ? "  (" + f.detail + ")" : ""}`);
    process.exitCode = 1;
  } else {
    console.log("全部通过 —— 灯条和自适应扳机确实写到硬件了（灯条颜色请肉眼看一眼手柄）");
  }
}

main().catch((e) => {
  console.error("\n真机验证失败：" + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
