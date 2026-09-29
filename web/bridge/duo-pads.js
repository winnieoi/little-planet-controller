/*!
 * duo-pads.js —— 双人分屏的「手柄归属」规则（v1.0.0）
 *
 * 宿主页 duo.html 与座位页（index.html?seat=N）都加载这个文件，
 * 归属规则只写一份，避免两边算法漂移导致两只手柄互相打架。
 *
 *   只有 1 只手柄  → 归座位 2（座位 1 用键鼠，也就是"一人键鼠一人手柄"）
 *   有 2 只手柄及以上 → 座位 1 拿第 1 只，座位 2 拿第 2 只
 *
 * 暴露 window.DuoPads = { SEATS, list, pick, snapshot, sig, GAME_KEYS, parseCoord, bearingText }
 */
(function () {
  "use strict";

  var SEATS = [1, 2];

  /* 座位 2 必须屏蔽的本机按键：让键鼠永远只控制座位 1 */
  var GAME_KEYS = {
    KeyW: 1, KeyA: 1, KeyS: 1, KeyD: 1,
    ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1,
    Space: 1, ShiftLeft: 1, ShiftRight: 1,
    KeyE: 1, KeyV: 1, KeyM: 1, KeyJ: 1, KeyH: 1,
    Home: 1, Escape: 1
  };

  var DIRECTIONS = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"];

  /* 剔除空位与未连接，按 index 排稳，保证两个页面算出同一个顺序 */
  function list(pads) {
    var out = [];
    if (!pads) return out;
    for (var i = 0; i < pads.length; i++) {
      if (pads[i] && pads[i].connected) out.push(pads[i]);
    }
    out.sort(function (a, b) {
      return (a.index || 0) - (b.index || 0);
    });
    return out;
  }

  function pick(pads, seat) {
    var all = list(pads);
    if (!all.length) return null;
    if (seat === 1) return all.length >= 2 ? all[0] : null;
    return all.length >= 2 ? all[1] : all[0];
  }

  function round3(v) {
    return Math.round((v || 0) * 1000) / 1000;
  }

  /* 手柄对象不能跨 frame 传递，转成纯数据快照 */
  function snapshot(pad) {
    if (!pad) return null;
    var i, axes = [], buttons = [];
    for (i = 0; i < pad.axes.length; i++) axes.push(round3(pad.axes[i]));
    for (i = 0; i < pad.buttons.length; i++) {
      buttons.push({
        pressed: !!pad.buttons[i].pressed,
        value: round3(pad.buttons[i].value)
      });
    }
    return {
      connected: true,
      id: pad.id,
      index: pad.index,
      mapping: pad.mapping,
      axes: axes,
      buttons: buttons
    };
  }

  /* 变化签名：一样就不用再发一帧，省掉绝大部分 postMessage */
  function sig(snap) {
    if (!snap) return "";
    var parts = [snap.index], i;
    for (i = 0; i < snap.axes.length; i++) parts.push(snap.axes[i]);
    for (i = 0; i < snap.buttons.length; i++) {
      parts.push(snap.buttons[i].pressed ? 1 : 0, snap.buttons[i].value);
    }
    return parts.join(",");
  }

  function supportsRumble(pad) {
    if (!pad) return false;
    if (pad.vibrationActuator && typeof pad.vibrationActuator.playEffect === "function") return true;
    if (pad.hapticActuators && pad.hapticActuators[0] && typeof pad.hapticActuators[0].pulse === "function") return true;
    return false;
  }

  /* 真正把震动打到硬件上（接收方手里有真手柄时才用得上） */
  function drive(pad, strong, weak, ms) {
    if (!pad) return false;
    var duration = Math.max(20, Math.round(ms || 0));
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
        return true;
      } catch (e) {
        /* 落到旧接口 */
      }
    }
    var legacy = pad.hapticActuators;
    if (legacy && legacy[0] && typeof legacy[0].pulse === "function") {
      try {
        legacy[0].pulse(Math.max(strong, weak), duration);
        return true;
      } catch (e) {
        return false;
      }
    }
    return false;
  }

  function readAll() {
    try {
      return navigator.getGamepads ? navigator.getGamepads() : null;
    } catch (e) {
      return null;
    }
  }

  /* 把「我这边能看到的手柄」持续广播给各个座位所在的窗口。
     只要有任何一方（宿主、座位 1、座位 2）能读到某只手柄，
     它就能被送到真正需要它的那个座位上。
     targetWin(seat) 返回该座位的 window；返回 null 就跳过
     （座位跳过自己，宿主返回两个 iframe）。 */
  function broadcast(targetWin, onSeat) {
    var HEARTBEAT = 400;
    var lastSig = {};
    var lastAt = 0;

    function tick() {
      var all = readAll();
      var now = Date.now();
      var heartbeat = (now - lastAt) >= HEARTBEAT;
      if (heartbeat) lastAt = now;

      for (var i = 0; i < SEATS.length; i++) {
        var seat = SEATS[i];
        var win = null;
        try {
          win = targetWin(seat);
        } catch (e) {
          win = null;
        }

        var pad = pick(all, seat);
        if (typeof onSeat === "function") {
          try {
            onSeat(seat, pad);
          } catch (e) {
            /* 显示逻辑出错不影响手柄分发 */
          }
        }
        /* 看不到手柄就什么也不发。
           「我没看到」不是有效信息 —— 一旦发出去，就会把别处看到的有效快照顶掉，
           座位的手柄因此时有时无。看不到的一方本来就无需发言，静默即可。 */
        if (!win || !pad) continue;

        var snap = snapshot(pad);
        var s = sig(snap);
        if (!heartbeat && s === lastSig[seat]) continue;
        lastSig[seat] = s;

        try {
          win.postMessage({
            type: "duo-pads",
            seat: seat,
            pad: snap,
            rumble: supportsRumble(pad)
          }, "*");
        } catch (e) {
          /* 对方还没加载好，下一帧再说 */
        }
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  /* 收到别处转来的震动请求，就用自己手里的真手柄振出去 */
  function listenRumble() {
    window.addEventListener("message", function (e) {
      var d = e.data;
      if (!d || d.type !== "duo-rumble") return;
      drive(pick(readAll(), d.seat), d.strong, d.weak, d.ms);
    });
  }

  function parseCoord(text) {
    var m = /([\d.]+)\s*°\s*([NS])[\s\S]*?([\d.]+)\s*°\s*([EW])/.exec(text || "");
    if (!m) return null;
    return {
      lat: parseFloat(m[1]) * (m[2] === "S" ? -1 : 1),
      lon: parseFloat(m[3]) * (m[4] === "W" ? -1 : 1)
    };
  }

  /* 从 a 看 b 的八方位（大圆方位角） */
  function bearingText(a, b) {
    if (!a || !b) return "";
    var R = Math.PI / 180;
    var dLon = (b.lon - a.lon) * R;
    var y = Math.sin(dLon) * Math.cos(b.lat * R);
    var x = Math.cos(a.lat * R) * Math.sin(b.lat * R) -
      Math.sin(a.lat * R) * Math.cos(b.lat * R) * Math.cos(dLon);
    var deg = (Math.atan2(y, x) / R + 360) % 360;
    return DIRECTIONS[Math.round(deg / 45) % 8];
  }

  window.DuoPads = {
    version: "1.0.0",
    SEATS: SEATS,
    GAME_KEYS: GAME_KEYS,
    list: list,
    pick: pick,
    snapshot: snapshot,
    sig: sig,
    supportsRumble: supportsRumble,
    drive: drive,
    readAll: readAll,
    broadcast: broadcast,
    listenRumble: listenRumble,
    parseCoord: parseCoord,
    bearingText: bearingText
  };
})();
