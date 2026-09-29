/*
 * 白天 / 夜景 模式切换（运行时，不改动游戏源码，也不改动 cyber-planet.js）
 *
 * 为什么要单独一层：这颗星球的原生配色是「赛博夜景」—— 贴图是高饱和紫蓝，
 * 场景里四盏灯也全是品红调（#ff5ef2 / #c44dff / #ff80d0）。所以「白天」不是
 * 单纯把贴图提亮，而是三件事一起做：
 *   1. 贴图换成日光化的 basecolor（tools/daylight_texture.py 离线生成）
 *   2. 天空背景换成竖直渐变（CanvasTexture：天顶深蓝 -> 地平线近白）
 *   3. 四盏灯换成日光色温与强度
 *   4. 加一层大气雾（FogExp2），让远处有空气感
 *
 * 所有原值都会先记下来，随时可切回夜景，与原版完全一致。
 *
 * 用 URL 参数控制：
 *   ?mode=day|night     默认 day
 *   ?day=A|B|C          白天贴图版本，默认 A
 *   ?sky=gradient|solid 天空：渐变 or 纯色，默认 gradient
 *   ?fog=0.006          雾密度，默认 0.006，0 为关闭
 *   ?glow=0.2           角色自发光，默认 0（关闭，实测开启反而有害）
 *   ?ui=0               隐藏右上角切换按钮
 *   ?debug=1            控制台输出日志
 *
 * 也提供接口给外部调用：
 *   window.LPDaylight.setMode('night')
 *   window.LPDaylight.setVariant('B')
 *   window.LPDaylight.setSky('solid')
 *   window.LPDaylight.setFog(0.006)
 *   window.LPDaylight.setGlow(0.2)
 */
(function () {
  "use strict";

  var params = new URLSearchParams(location.search);
  var TEXTURE_URLS = {
    A: "./textures/daylight-A.jpg",
    B: "./textures/daylight-B.jpg",
    C: "./textures/daylight-C.jpg"
  };

  var SKY = { day: 0xa8c8ea, night: 0x0d0020 };
  var GLOW_DEFAULT = 0; /*
    * 白天模式下角色的自发光强度，默认 0（关闭）。
   *
   * 一开始设成 0.38 想让角色更显眼，实测（1280x800 截图 + 像素分析，用
   * glow=0 与 glow=1 的差分精确锁定角色）结论是**反作用**：
   *
   *   强度    角色亮度  周边亮度  亮度差  色差   角色过曝%
   *   0        126      175      49     91     7
   *   0.38     152      175      23     74     26
   *   1.0      175      175       0     64     61
   *
   * 浅色地表本身就亮到 175，把角色提亮到同一亮度等于让它"隐形"，
   * 过曝还会洗掉颜色。关闭时角色比地表暗 49、色差 91，比夜景的
   * 32 / 126 还更清楚，所以默认不开。
   * 需要时可用 ?glow=0.2 打开，或 LPDaylight.setGlow(0.2)。
   */

  /*
   * 白天模式的大气雾密度（FogExp2），0 即关闭。默认 0.006。
   *
   * 这个值是扫出来的，不是拍的。以 fog=0 为基准逐像素比对，同时盯「能不能
   * 看见」和「代价多大」两个指标（1280x800 截图，只统计星球区域）：
   *
   *   密度     画面改变  明显变化像素%  对比度保留  角色亮度差/色差
   *   0.0015    0.47        0.0%        100%        15 / 71
   *   0.0025    1.29        0.0%         99%        15 / 71
   *   0.0035    2.51        0.1%         98%        15 / 70   <- 几乎看不见
   *   0.006     7.22        9.2%         94%        15 / 68   <- 取这个
   *   0.008    12.56       25.8%         91%        15 / 66
   *   0.012    26.47       52.8%         83%        14 / 60
   *
   * 星球半径只有 26 个单位，镜头通常停在 60~90，所以雾要够重才有存在感——
   * 0.0035 那档等于白给（画面平均只动了 2.5 个色阶）。但再往上到 0.008 就会
   * 吃掉 9% 的对比度、远景开始发灰。0.006 是「看得出来有空气」又几乎不损失
   * 细节的位置，角色的亮度差（15）和色差（68）基本没动。
   */
  var FOG_DEFAULT = 0.006;

  var state = {
    ready: false,
    mode: (params.get("mode") || "day").toLowerCase() === "night" ? "night" : "day",
    variant: (params.get("variant") || params.get("day") || "A").toUpperCase(),
    glow: params.has("glow") ? Math.max(0, Math.min(1, parseFloat(params.get("glow")) || 0)) : GLOW_DEFAULT,
    sky: params.get("sky") === "solid" ? "solid" : "gradient",
    fog: params.has("fog") ? Math.max(0, parseFloat(params.get("fog")) || 0) : FOG_DEFAULT,
    showUI: params.get("ui") !== "0"
  };
  if (!TEXTURE_URLS[state.variant]) state.variant = "A";

  var scene = null;
  var model = null;
  var saved = {
    lights: [],
    maps: [],
    playerGlow: [],
    background: null,      /* 背景 Color 对象本身（切到渐变天空后必须靠它切回） */
    backgroundHex: null,
    colorClass: null,      /* Color 构造器，用来造雾的颜色 */
    fog: null,
    fogSaved: false,
    remembered: false
  };
  var dayTexture = null;
  var textureClass = null;

  function log() {
    if (params.get("debug") === "1") console.log.apply(console, ["[daylight]"].concat([].slice.call(arguments)));
  }

  function findTargets() {
    scene = window.__LP_SCENE__ || null;
    if (!scene) return false;
    model = null;
    scene.traverse(function (o) {
      if (!model && o.userData && o.userData.cyberPlanet) model = o;
    });
    return !!model;
  }

  function eachMaterial(fn) {
    if (!model) return;
    model.traverse(function (o) {
      if (!o.isMesh) return;
      var mats = Array.isArray(o.material) ? o.material : [o.material];
      for (var i = 0; i < mats.length; i++) if (mats[i]) fn(mats[i], o);
    });
  }

  /* 记住原始状态，只记一次 */
  function remember() {
    if (saved.remembered) return;
    /*
     * 背景存的是 Color 对象本身而不是色值：白天要换成渐变 Texture，
     * 只留一个色值是切不回来的。
     */
    if (scene.background && scene.background.isColor) {
      saved.background = scene.background;
      saved.backgroundHex = scene.background.getHex();
      saved.colorClass = scene.background.constructor;
    }
    saved.fog = scene.fog || null;
    saved.fogSaved = true;
    saved.remembered = true;
    scene.traverse(function (o) {
      if (!o.isLight) return;
      saved.lights.push({
        light: o,
        color: o.color ? o.color.getHex() : null,
        groundColor: o.groundColor ? o.groundColor.getHex() : null,
        intensity: o.intensity
      });
    });
    eachMaterial(function (m) {
      if (m.map) {
        textureClass = textureClass || m.map.constructor;
        saved.maps.push({ material: m, map: m.map });
      }
    });
    /*
     * 角色材质的记录：它的颜色是品红（#ff40ff / #ff80d0）且 roughness=1、无自发光。
     * 夜里品红角色在黑底上很跳；白天背景一提亮就撞成一片淡粉，亮度差只剩 20 出头。
     * 所以白天模式给它补一点自发光 —— 既拉回辨识度，也贴合它本身的霓虹设定。
     */
    var playerGroup = window.__LP_WORLD__ && window.__LP_WORLD__.player && window.__LP_WORLD__.player.group;
    if (playerGroup) {
      playerGroup.traverse(function (o) {
        if (!o.isMesh || !o.material || !o.material.emissive) return;
        var mats = Array.isArray(o.material) ? o.material : [o.material];
        for (var i = 0; i < mats.length; i++) {
          var mat = mats[i];
          if (!mat.emissive) continue;
          saved.playerGlow.push({ material: mat, emissive: mat.emissive.getHex(), emissiveIntensity: mat.emissiveIntensity });
        }
      });
    }
    log("已记录原值", saved.lights.length, "盏灯 /", saved.maps.length, "张贴图引用 /", saved.playerGlow.length, "个角色材质");
  }

  /* 夜景 -> 白天：四盏灯全部换成日光 */
  function applyLights(day) {
    for (var i = 0; i < saved.lights.length; i++) {
      var rec = saved.lights[i];
      var light = rec.light;
      if (!day) {
        if (rec.color !== null) light.color.setHex(rec.color);
        if (rec.groundColor !== null && light.groundColor) light.groundColor.setHex(rec.groundColor);
        light.intensity = rec.intensity;
        continue;
      }
      if (light.isHemisphereLight) {
        light.color.setHex(0xc6dcff);            /* 天光：偏蓝的日光 */
        if (light.groundColor) light.groundColor.setHex(0xd6c9ad); /* 地面反光：暖砂色 */
        light.intensity = 2.2;
      } else if (light.isDirectionalLight) {
        if (rec.intensity > 1) {
          light.color.setHex(0xfff4e0);          /* 主平行光 = 太阳 */
          light.intensity = 3.0;
        } else {
          light.color.setHex(0xb2c8dc);          /* 补光 = 天穹散射 */
          light.intensity = 0.9;
        }
      } else if (light.isPointLight) {
        light.color.setHex(0xffeada);            /* 原粉光收敛为中性补光 */
        light.intensity = 0.9;
      } else if (light.isAmbientLight) {
        light.color.setHex(0xffffff);
        light.intensity = 1.0;
      }
    }
  }

  /* 竖直渐变天空：纯色背景没有空间感，加一条从天顶到地平线的渐变 */
  var skyTexture = null;

  function buildSkyTexture() {
    if (skyTexture) return skyTexture;
    if (!textureClass) return null;
    try {
      var canvas = document.createElement("canvas");
      canvas.width = 4;
      canvas.height = 256;
      var ctx = canvas.getContext("2d");
      var g = ctx.createLinearGradient(0, 0, 0, 256);
      g.addColorStop(0.0, "#4d84c6"); /* 天顶：较深的蓝 */
      g.addColorStop(0.42, "#8ab6e2");
      g.addColorStop(0.74, "#bedcf2");
      g.addColorStop(1.0, "#e2edf5"); /* 地平线：接近白 */
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 4, 256);
      var tex = new textureClass(canvas);
      if ("colorSpace" in tex) tex.colorSpace = "srgb";
      tex.needsUpdate = true;
      skyTexture = tex;
      log("渐变天空已生成");
      return tex;
    } catch (err) {
      console.warn("[daylight] 渐变天空创建失败，回退纯色", err);
      return null;
    }
  }

  /*
   * 大气雾：场景里根本没有 Fog 实例，拿不到构造器，所以用鸭子类型对象顶上。
   * three 的渲染器只读 isFogExp2 / color / density 三个字段，走的是 isXXX
   * 标志判断而不是 instanceof，所以普通对象也能生效。
   */
  var fogObject = null;

  function buildFog() {
    if (fogObject) return fogObject;
    if (!saved.colorClass) return null;
    try {
      fogObject = {
        isFogExp2: true,
        name: "",
        color: new saved.colorClass(0xd6e6f4),
        density: state.fog
      };
      log("大气雾已生成，density =", state.fog);
      return fogObject;
    } catch (err) {
      console.warn("[daylight] 雾创建失败", err);
      return null;
    }
  }

  function applyBackground(day) {
    if (!saved.background) return;
    if (day && state.sky === "gradient") {
      var tex = buildSkyTexture();
      if (tex) {
        if (scene.background !== tex) scene.background = tex;
        return;
      }
    }
    if (scene.background !== saved.background) scene.background = saved.background;
    saved.background.setHex(day ? SKY.day : saved.backgroundHex);
  }

  function applyFog(day) {
    if (!saved.fogSaved) return;
    if (day && state.fog > 0) {
      var fog = buildFog();
      if (fog) {
        fog.density = state.fog;
        if (scene.fog !== fog) scene.fog = fog;
        return;
      }
    }
    if (scene.fog !== saved.fog) scene.fog = saved.fog;
  }

  /* 白天模式给角色补自发光，把辨识度拉回来（原始值是 0，可放心还原） */
  function applyPlayerGlow(day) {
    for (var i = 0; i < saved.playerGlow.length; i++) {
      var rec = saved.playerGlow[i];
      if (day && state.glow > 0) {
        rec.material.emissive.setHex(rec.material.color ? rec.material.color.getHex() : 0xffffff);
        rec.material.emissiveIntensity = state.glow;
      } else {
        rec.material.emissive.setHex(rec.emissive);
        rec.material.emissiveIntensity = rec.emissiveIntensity;
      }
    }
  }

  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error("贴图加载失败: " + url)); };
      img.src = url;
    });
  }

  function buildTexture(img, reference) {
    if (!textureClass) throw new Error("拿不到 Texture 构造器（模型上没有 basecolor？）");
    var tex = new textureClass(img);
    /* 关键：从原贴图继承采样参数，否则 UV 朝向 / 包裹方式会错 */
    if (reference) {
      tex.flipY = reference.flipY;
      tex.wrapS = reference.wrapS;
      tex.wrapT = reference.wrapT;
      tex.repeat.copy(reference.repeat);
      tex.offset.copy(reference.offset);
      tex.rotation = reference.rotation;
      tex.center.copy(reference.center);
      tex.anisotropy = reference.anisotropy;
      tex.generateMipmaps = reference.generateMipmaps;
      tex.minFilter = reference.minFilter;
      tex.magFilter = reference.magFilter;
    }
    if ("colorSpace" in tex) tex.colorSpace = "srgb";
    else if ("encoding" in tex) tex.encoding = 3001; /* 老版本 three: sRGBEncoding */
    tex.needsUpdate = true;
    return tex;
  }

  function applyTexture(day) {
    return Promise.resolve().then(function () {
      if (!saved.maps.length) return;
      if (!day) {
        for (var i = 0; i < saved.maps.length; i++) {
          saved.maps[i].material.map = saved.maps[i].map;
          saved.maps[i].material.needsUpdate = true;
        }
        return;
      }
      if (dayTexture && dayTexture.url === TEXTURE_URLS[state.variant]) {
        writeTexture(dayTexture.texture);
        return;
      }
      var url = TEXTURE_URLS[state.variant];
      return loadImage(url).then(function (img) {
        var tex = buildTexture(img, saved.maps[0].map);
        dayTexture = { url: url, texture: tex };
        writeTexture(tex);
      });
    });
  }

  function writeTexture(tex) {
    for (var i = 0; i < saved.maps.length; i++) {
      saved.maps[i].material.map = tex;
      saved.maps[i].material.needsUpdate = true;
    }
  }

  function apply() {
    var day = state.mode === "day";
    applyLights(day);
    applyBackground(day);
    applyFog(day);
    applyPlayerGlow(day);
    return applyTexture(day).then(function () {
      state.ready = true;
      if (window.LPCyberPlanet) {
        window.LPCyberPlanet.mode = state.mode;
        window.LPCyberPlanet.dayVariant = state.variant;
      }
      updateButton();
      window.dispatchEvent(new CustomEvent("lp-daylight-change", { detail: { mode: state.mode, variant: state.variant } }));
      log("已应用", state.mode, state.variant);
    });
  }

  /* ---------- 右下角切换按钮（`?ui=0` 可隐藏） ---------- */
  var btn = null;
  function buildButton() {
    if (!state.showUI || btn) return;
    btn = document.createElement("button");
    btn.id = "lp-mode-toggle";
    btn.type = "button";
    btn.style.cssText = [
      "position:fixed", "right:22px", "top:74px", "z-index:40",
      "padding:7px 13px", "border-radius:999px",
      "border:1px solid rgba(178,140,255,.42)",
      "background:rgba(18,8,34,.72)",
      "color:#e9dcff",
      "font:600 12px/1 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif",
      "letter-spacing:.08em", "cursor:pointer",
      "backdrop-filter:blur(9px)", "-webkit-backdrop-filter:blur(9px)",
      "box-shadow:0 6px 22px rgba(0,0,0,.34)",
      "transition:transform .18s ease, background .18s ease"
    ].join(";");
    btn.addEventListener("mouseenter", function () { btn.style.transform = "translateY(-1px)"; });
    btn.addEventListener("mouseleave", function () { btn.style.transform = "none"; });
    btn.addEventListener("click", function () {
      setMode(state.mode === "day" ? "night" : "day");
    });
    document.body.appendChild(btn);
    updateButton();
  }

  function updateButton() {
    if (!btn) return;
    btn.textContent = state.mode === "day" ? "白天 · " + state.variant : "夜景 · 原版";
  }

  function setMode(mode) {
    state.mode = mode === "night" ? "night" : "day";
    return apply();
  }

  function setVariant(variant) {
    variant = String(variant || "").toUpperCase();
    if (!TEXTURE_URLS[variant]) return Promise.resolve(false);
    state.variant = variant;
    dayTexture = null; /* 强制重新加载 */
    return state.mode === "day" ? apply() : Promise.resolve(true);
  }

  window.LPDaylight = {
    state: state,
    setMode: setMode,
    setVariant: setVariant,
    setGlow: function (value) {
      state.glow = Math.max(0, Math.min(1, Number(value) || 0));
      return apply();
    },
    setSky: function (value) {
      state.sky = value === "solid" ? "solid" : "gradient";
      return apply();
    },
    setFog: function (value) {
      state.fog = Math.max(0, Number(value) || 0);
      fogObject = null; /* 密度变了要重建 */
      return apply();
    },
    toggle: function () { return setMode(state.mode === "day" ? "night" : "day"); },
    get isDay() { return state.mode === "day"; }
  };

  /* ---------- 启动：等模型就绪后立刻应用（加载遮罩还没淡出，看不到跳变） ---------- */
  var started = false;
  function boot() {
    if (started) return;
    if (!findTargets()) return;
    started = true;
    remember();
    buildButton();
    apply().catch(function (err) {
      console.error("[daylight]", err);
    });
  }

  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    boot();
    if (started || tries > 200) clearInterval(timer); /* 约 20 秒超时 */
  }, 100);

  window.addEventListener("lp-cyber-planet-ready", function () {
    boot();
  });
})();
