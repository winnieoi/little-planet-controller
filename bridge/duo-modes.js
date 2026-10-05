/* ============================================================
 *  duo-modes.js   宿主侧玩法模块
 * ============================================================
 *
 * 双人分屏（「分屏·双实例」）下，宿主读到的两份 duo-state 上报
 * （coords / region / collected）由这里派生出三种玩法：
 *
 *   • Board  汇总板     —— 双方用时 / 累计移动 / 区域切换次数 / 当前区域
 *   • Race   速度赛     —— 谁先集齐 7 个奇迹；手动开始，先到先胜
 *   • Beacon 信标       —— 区域切换 / 收奇迹时给对方一条 8 秒提示
 *
 * 三者共享同一份上报数据，互不依赖，可单独挂载或全部启用。
 * 全部在宿主（duo.html）侧运行 —— 不动游戏本体、不动 duo-seat.js。
 *
 * 公开 API：window.DuoModes = { version, MAX, BEACON_MS, Board, Race, Beacon }
 *
 * 用法：见 trio 末尾 `install()`，duo.html 调用一次即可。
 * ============================================================ */

(function () {
  "use strict";

  var SEATS = [1, 2];
  var MAX = 7;             /* 一张地图的奇迹总数 */
  var BEACON_MS = 8000;    /* 信标持续时间 */
  var COORD_SCALE = 0.3;   /* 一个游戏内坐标单位 ≈ 0.3 m（视感估测） */
  var TICK_MS = 250;       /* render 节流（每帧 render 浪费且无意义） */

  /* ============================================================
   * 工具
   * ============================================================ */

  function fmtClock(ms) {
    if (ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var mm = Math.floor(s / 60);
    var ss = s % 60;
    return (mm < 10 ? "0" : "") + mm + ":" + (ss < 10 ? "0" : "") + ss;
  }

  function distM(a, b) {
    if (!a || !b) return 0;
    var dx = a[0] - b[0], dy = a[1] - b[1];
    return Math.sqrt(dx * dx + dy * dy) * COORD_SCALE;
  }

  function snapCoord(s) {
    if (!s || !s.coords) return null;
    var m = String(s.coords).match(/(-?\d+(?:\.\d+)?)/g);
    if (!m || m.length < 2) return null;
    var a = parseFloat(m[0]);
    var b = parseFloat(m[1]);
    if (!isFinite(a) || !isFinite(b)) return null;
    return [a, b];
  }

  /* ============================================================
   * Board  汇总板
   * ============================================================
   *
   * 累计双方从开局起的总移动距离、区域切换次数与当前区域。
   * 距离按两帧坐标差累加；区域切换只在相邻两次 region 不同时 +1。
   * 第一帧不计入（避免开局瞬间大跳）。
   */

  function Board(opts) {
    opts = opts || {};
    var last = { 1: null, 2: null };
    var totalDist = { 1: 0, 2: 0 };
    var regionSwitch = { 1: 0, 2: 0 };
    var startedAt = opts.startedAt || Date.now();
    var lastRender = 0;

    function update(seat, snap) {
      var prev = last[seat];
      if (prev && snap) {
        var pa = snapCoord(prev);
        var ca = snapCoord(snap);
        totalDist[seat] += distM(pa, ca);
        if (snap.region && prev.region && snap.region !== prev.region) {
          regionSwitch[seat]++;
        }
      }
      last[seat] = snap || null;
    }

    function render(el) {
      if (Date.now() - lastRender < TICK_MS) return;
      lastRender = Date.now();
      var elapsed = Date.now() - startedAt;
      var html = '<div class="duo-board">';
      SEATS.forEach(function (seat) {
        var s = last[seat] || { coords: "—", region: "—", collected: 0 };
        var dist = totalDist[seat].toFixed(0);
        var sw = regionSwitch[seat];
        html +=
          '<span class="duo-board-row duo-board-row-' + seat + '">' +
            '<b>P' + seat + '</b>' +
            '<span class="duo-board-region">' + (s.region || "—") + '</span>' +
            '<span class="duo-board-dist">' + dist + ' m</span>' +
            '<span class="duo-board-switch">换区 ×' + sw + '</span>' +
          '</span>';
      });
      html += '<span class="duo-board-time">' + fmtClock(elapsed) + '</span>';
      html += '</div>';
      el.innerHTML = html;
    }

    function reset() {
      last = { 1: null, 2: null };
      totalDist = { 1: 0, 2: 0 };
      regionSwitch = { 1: 0, 2: 0 };
      startedAt = Date.now();
    }

    return { update: update, render: render, reset: reset,
             totalDist: function (s) { return totalDist[s]; },
             regionSwitch: function (s) { return regionSwitch[s]; },
             startedAt: function () { return startedAt; } };
  }

  /* ============================================================
   * Race  速度赛
   * ============================================================
   *
   * 手动 start()，先到先胜 —— 一方 collected >= MAX 即结算。
   * 结算后 running=false，胜方 finished[seat] = 用时 (ms)。
   * 渲染含：双方进度条 / 当前收集数 / 当前用时 / 胜方提示 + 「再来一局」按钮。
   */

  function Race(opts) {
    opts = opts || {};
    var startedAt = 0;
    var stoppedAt = 0;
    var running = false;
    var finished = { 1: null, 2: null };
    var last = { 1: null, 2: null };
    var onFinish = opts.onFinish || null;
    var lastRender = 0;

    function start() {
      startedAt = Date.now();
      stoppedAt = 0;
      running = true;
      finished = { 1: null, 2: null };
    }

    /* 座位上报来的 collected 可能是字符串（"0"）也可能是数字，
       而且「零数据」消息会持续覆盖已经记录的真实进度。
       只接受数字型 collected，并取单调不减值 —— 字符串与回退消息静默忽略，
       避免刚坐下不到 1 秒就把刚收的奇迹「退」回去。 */
    function update(seat, snap) {
      var prev = last[seat];
      if (snap && typeof snap.collected === "number") {
        var prevC = (prev && typeof prev.collected === "number") ? prev.collected : 0;
        if (snap.collected >= prevC) last[seat] = snap;
      } else if (!snap) {
        last[seat] = null;
      }
      if (!running || finished[seat] !== null) return;
      if (snap && typeof snap.collected === "number" && snap.collected >= MAX) {
        finished[seat] = Date.now() - startedAt;
        stoppedAt = Date.now();
        running = false;
        if (typeof onFinish === "function") {
          try { onFinish(seat, finished[seat]); } catch (e) { /* 容错 */ }
        }
      }
    }

    function render(el) {
      if (Date.now() - lastRender < TICK_MS) return;
      lastRender = Date.now();
      var html = '<div class="duo-race">';
      if (!running && finished[1] === null && finished[2] === null && startedAt === 0) {
        html += '<button class="duo-race-start" type="button">开始计时</button>';
      } else {
        /* race 运行时用当前已过时间；停止后冻结在 stoppedAt，
           否则败方时间会一直走下去让胜利用时看起来像在缩水。 */
        var now = running
          ? (Date.now() - startedAt)
          : (stoppedAt ? (stoppedAt - startedAt) : 0);
        SEATS.forEach(function (seat) {
          var collected = (last[seat] && last[seat].collected) || 0;
          var pct = Math.min(100, (collected / MAX) * 100);
          var t = finished[seat] !== null ? finished[seat] : now;
          html +=
            '<span class="duo-race-row duo-race-row-' + seat + '">' +
              '<b>P' + seat + '</b>' +
              '<span class="duo-race-bar"><i style="width:' + pct + '%"></i></span>' +
              '<span class="duo-race-count">' + collected + '/' + MAX + '</span>' +
              '<span class="duo-race-time">' + fmtClock(t) + '</span>' +
            '</span>';
        });
        if (finished[1] !== null || finished[2] !== null) {
          var winner = finished[1] !== null ? 1 : 2;
          var time = finished[winner];
          html += '<span class="duo-race-winner">P' + winner + ' 胜利 · ' + fmtClock(time) + '</span>';
          html += '<button class="duo-race-again" type="button">再来一局</button>';
        }
      }
      html += '</div>';
      el.innerHTML = html;
      var startBtn = el.querySelector(".duo-race-start");
      if (startBtn) startBtn.addEventListener("click", start);
      var againBtn = el.querySelector(".duo-race-again");
      if (againBtn) againBtn.addEventListener("click", start);
    }

    return { start: start, update: update, render: render,
             isRunning: function () { return running; },
             startedAt: function () { return startedAt; },
             finished: function () { return finished; } };
  }

  /* ============================================================
   * Beacon  信标
   * ============================================================
   *
   * 一方发生「区域切换 / 收奇迹」时，在对方顶栏产生 8 秒提示。
   * 自动触发，不需要新按键（手柄空闲键已经被新系统瓜分）。
   *
   * render(el) 把当前活跃信标渲染到宿主面板，宿主按座位路由到对方 chip
   * —— 这一段路由逻辑放在 duo.html 的 update() 钩子里，
   * duo-modes 只负责产生信标，不负责决定它去哪。
   */

  function Beacon(opts) {
    var last = { 1: null, 2: null };
    var active = []; /* {seat, kind, text, expiresAt} */
    var lastRender = 0;

    function update(seat, snap) {
      var prev = last[seat];
      if (prev && snap) {
        if (snap.region && prev.region && snap.region !== prev.region) {
          push(seat, "region", "进入 " + snap.region);
        }
        var prevC = prev.collected || 0;
        var currC = snap.collected || 0;
        if (currC > prevC) {
          push(seat, "collect", "奇迹 " + currC + "/" + MAX);
        }
      }
      last[seat] = snap || null;
    }

    function push(seat, kind, text) {
      var now = Date.now();
      /* 同一 seat 同 kind 续期 —— 例如区域反复切换时只展示最新一条 */
      active = active.filter(function (b) {
        return b.expiresAt > now && !(b.seat === seat && b.kind === kind);
      });
      active.push({ seat: seat, kind: kind, text: text, expiresAt: now + BEACON_MS });
    }

    function tick() {
      var now = Date.now();
      var filtered = [];
      for (var i = 0; i < active.length; i++) {
        if (active[i].expiresAt > now) filtered.push(active[i]);
      }
      if (filtered.length !== active.length) active = filtered;
    }

    function render(el) {
      if (Date.now() - lastRender < TICK_MS) return;
      lastRender = Date.now();
      var now = Date.now();
      var html = '<div class="duo-beacon">';
      var any = false;
      for (var i = 0; i < active.length; i++) {
        var b = active[i];
        if (b.expiresAt <= now) continue;
        any = true;
        var remaining = Math.max(0, Math.ceil((b.expiresAt - now) / 1000));
        html +=
          '<span class="duo-beacon-item duo-beacon-' + b.kind + '" data-target-seat="' +
          /* 给对方看：源座位是 1 时给座位 2 那一格，反之亦然 */
          (b.seat === 1 ? 2 : 1) + '">' +
            '<b>P' + b.seat + '</b>' +
            '<span class="duo-beacon-text">' + b.text + '</span>' +
            '<span class="duo-beacon-left">' + remaining + 's</span>' +
          '</span>';
      }
      html += '</div>';
      el.innerHTML = any ? html : '<div class="duo-beacon"></div>';
    }

    function clear() { active = []; }

    return { update: update, tick: tick, render: render, clear: clear,
             active: function () { return active.slice(); } };
  }

  /* ============================================================
   * install  一行挂载
   * ============================================================
   *
   * 同时返回 board / race / beacon，宿主随时调 render。
   * 所有 render 都自带 250ms 节流，宿主每帧调一次不会浪费。
   */

  function install() {
    return {
      board: Board(),
      race: Race(),
      beacon: Beacon()
    };
  }

  window.DuoModes = {
    version: "1.0.0",
    MAX: MAX,
    BEACON_MS: BEACON_MS,
    fmtClock: fmtClock,
    Board: Board,
    Race: Race,
    Beacon: Beacon,
    install: install
  };
})();