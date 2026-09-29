/* ============================================================
 * tripo-build.js —— 收集积分 → Tripo 生成建筑 → 摆上星球
 * ------------------------------------------------------------
 * 玩法闭环：
 *   收集奇迹 → 攒积分 → 花积分生成 3D 建筑 → 自动摆在角色脚边 → 存起来，下次进还在
 *
 * 三条不变量（与整套工程一致）：
 *   1. 游戏本体一行不改
 *   2. 零第三方依赖（不引入 GLTFLoader，自己解析 GLB）
 *   3. API Key 不进浏览器，全部走服务端 /api/tripo/*
 *
 * 两个绕过去的坎：
 *   A. 页面里拿不到 THREE 命名空间（游戏是打包好的 ES Module）。
 *      → 从场景里已有的实例反推构造器：mesh.constructor 就是 Mesh，
 *        mesh.geometry.constructor 就是 BufferGeometry，以此类推。
 *        这样既不依赖打包产物导出的符号名，也不受 three 版本影响。
 *   B. GLTFLoader 没暴露出来。
 *      → 自写精简 GLB 解析（glTF 2.0 子集：节点变换、多图元、
 *        POSITION/NORMAL/TEXCOORD_0、uint16/uint32 索引、PBR 基础色贴图）。
 *        Tripo 输出的 GLB 全部落在这个子集里。
 *
 * 需要场景钩子 window.__LP_SCENE__ / __LP_WORLD__（赛博星球副本自带；
 * 原版星球请用 ?build=1，它会加载带钩子的副本资源，见 tools/add-lp-hook.mjs）。
 * 调试：LPBuild.status() / LPBuild.grant(100)
 * ============================================================ */
(function () {
  "use strict";

  /* ---------- 可调参数 ---------- */
  var CFG = {
    START_CREDITS: 20,      // 初始积分
    PER_COLLECT: 30,        // 每收集一个奇迹
    COST: 40,               // 生成一次消耗
    REFUND: 15,             // 拆除建筑返还
    GROUND_R: 26.17,        // 地表基准半径（脚底对齐值，见 tools/fit-planet.mjs）
    SINK: 0.15,             // 往下埋一点，避免在原版星球起伏处悬空
    TARGET_H: 3.0,          // 建筑目标高度（角色身高约 1.56）
    MIN_DIST: 2.2,          // 摆在角色多远处
    MAX_DIST: 3.6,
    MIN_GAP: 2.6,           // 建筑之间的最小间距（避免叠在一起）
    MAX_BUILDINGS: 24       // 上限，避免刷屏
  };

  var LS_CREDITS = "lp.tripo.credits.v1";
  var LS_SEEN = "lp.tripo.seen.v1";
  var LS_LIST = "lp.tripo.buildings.v1";

  var state = {
    ready: false,
    mock: false,
    busy: false,
    buildings: [],
    // 由场景反推出来的 three 构造器
    T: null
  };

  window.LPBuild = {
    cfg: CFG,
    state: state,
    status: function () {
      return {
        ready: state.ready,
        mock: state.mock,
        credits: readCredits(),
        buildings: state.buildings.length,
        hasScene: !!(window.__LP_SCENE__ && window.__LP_WORLD__)
      };
    },
    grant: function (n) { addCredits(n); paint(); },
    /* 直接生成并摆放（调试用，面板里点按钮走的是同一条路） */
    build: function (prompt) { return generateAndPlace(prompt, null, null); },
    /* 把一个 GLB 地址直接摆到星球上（调试 / 手动放本地模型用） */
    placeFromUrl: function (url, height) {
      if (!ctxRef) return Promise.reject(new Error("场景还没准备好"));
      return fetch(url)
        .then(function (r) { return r.arrayBuffer(); })
        .then(loadModelFromGLB)
        .then(function (model) {
          var placed = placeOnSurface(model, ctxRef.world, height);
          ctxRef.scene.add(placed.object);
          return { scale: placed.scale, position: placed.object.position.toArray() };
        });
    },
    clearAll: function () {
      var list = state.buildings.slice();
      return Promise.all(list.map(removeBuilding)).then(function () { return list.length; });
    }
  };

  /* ============================================================
   * 1. 积分
   * ============================================================ */

  function readCredits() {
    var v = parseInt(localStorage.getItem(LS_CREDITS) || "", 10);
    if (!isFinite(v)) {
      v = CFG.START_CREDITS;
      localStorage.setItem(LS_CREDITS, String(v));
    }
    return v;
  }
  function addCredits(n) {
    var v = Math.max(0, readCredits() + n);
    localStorage.setItem(LS_CREDITS, String(v));
    return v;
  }
  function spend() {
    if (readCredits() < CFG.COST) return false;
    addCredits(-CFG.COST);
    return true;
  }

  /* 收集检测：游戏把已收集数量写在 #collected-count 里。
     不看游戏内部变量，只盯 DOM，配合 localStorage 记基线，刷新不重复发奖。 */
  function readCollected() {
    var el = document.getElementById("collected-count");
    var n = el ? parseInt(el.textContent || "", 10) : NaN;
    return isFinite(n) ? n : 0;
  }
  function syncCollected() {
    var now = readCollected();
    var seen = parseInt(localStorage.getItem(LS_SEEN) || "0", 10);
    if (!isFinite(seen)) seen = 0;
    if (now > seen) {
      var gain = (now - seen) * CFG.PER_COLLECT;
      addCredits(gain);
      localStorage.setItem(LS_SEEN, String(now));
      toast("收集 +" + gain + " 积分");
      paint();
    } else if (now < seen) {
      localStorage.setItem(LS_SEEN, String(now)); /* 重置进度后同步基线 */
    }
  }

  /* ============================================================
   * 2. 等场景 + 反推 three 构造器
   * ============================================================ */

  function waitForGame() {
    return new Promise(function (resolve, reject) {
      var started = performance.now();
      (function check() {
        if (window.__LP_SCENE__ && window.__LP_WORLD__) {
          resolve({ scene: window.__LP_SCENE__, world: window.__LP_WORLD__ });
          return;
        }
        if (performance.now() - started > 20000) {
          reject(new Error("等待游戏场景超时 —— 请用 ?build=1 打开（会加载带场景钩子的副本）"));
          return;
        }
        requestAnimationFrame(check);
      })();
    });
  }

  /**
   * 从场景里已有的对象身上取构造器。
   * 打包产物只导出混淆过的符号（export{Bh as A,...}），但实例自己的
   * constructor 永远指向真正的类，这是最稳的一条路。
   */
  function harvestThree(scene) {
    var mesh = null, stdMat = null, map = null;
    scene.traverse(function (o) {
      if (!mesh && o.isMesh && o.geometry && o.geometry.attributes && o.geometry.attributes.position) mesh = o;
      if (!stdMat && o.material) {
        var m = Array.isArray(o.material) ? o.material[0] : o.material;
        if (m && m.isMeshStandardMaterial) stdMat = m;
      }
      if (!map && o.material) {
        var mm = Array.isArray(o.material) ? o.material[0] : o.material;
        if (mm && mm.map) map = mm.map;
      }
    });
    if (!mesh) throw new Error("场景里找不到可用的网格，无法接管渲染类");
    var mat = stdMat || (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) || null;

    /* 关键：geometry.attributes.position.constructor 拿到的往往是
       Float32BufferAttribute（BufferAttribute 的子类），它的构造函数会
       无条件执行 `new Float32Array(array)`。直接拿它去建索引缓冲，
       Uint16/Uint32 索引会被强转成浮点，WebGL 按整型位模式乱读，
       结果就是一个三角形都画不出来（且不报错）。
       这里沿原型链上溯，直到找到"原样保留数组类型"的那个基类。 */
    var BufferAttribute = mesh.geometry.attributes.position.constructor;
    var probe = new Uint16Array([1, 2, 3]);
    var guard = 0;
    while (guard++ < 6) {
      try {
        var test = new BufferAttribute(probe, 1);
        if (test.array && test.array instanceof Uint16Array) break;
      } catch (e) { /* 构造失败就继续上溯 */ }
      var up = Object.getPrototypeOf(BufferAttribute.prototype);
      if (!up || !up.constructor) break;
      BufferAttribute = up.constructor;
    }

    return {
      Object3D: Object.getPrototypeOf(mesh.constructor.prototype).constructor,
      Mesh: mesh.constructor,
      BufferGeometry: mesh.geometry.constructor,
      BufferAttribute: BufferAttribute,
      Vector3: mesh.position.constructor,
      Quaternion: mesh.quaternion.constructor,
      Matrix4: mesh.matrix.constructor,
      Material: mat ? mat.constructor : null,
      Color: mat && mat.color ? mat.color.constructor : null,
      Texture: map ? map.constructor : null
    };
  }

  /* ============================================================
   * 3. GLB 解析（glTF 2.0 子集）
   * ============================================================ */

  var COMP = {
    5120: { C: Int8Array, size: 1, get: function (d, o) { return d.getInt8(o); } },
    5121: { C: Uint8Array, size: 1, get: function (d, o) { return d.getUint8(o); } },
    5122: { C: Int16Array, size: 2, get: function (d, o) { return d.getInt16(o, true); } },
    5123: { C: Uint16Array, size: 2, get: function (d, o) { return d.getUint16(o, true); } },
    5125: { C: Uint32Array, size: 4, get: function (d, o) { return d.getUint32(o, true); } },
    5126: { C: Float32Array, size: 4, get: function (d, o) { return d.getFloat32(o, true); } }
  };
  var NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

  function parseGLB(buf) {
    var dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x46546c67) throw new Error("不是 GLB 文件");
    var off = 12, json = null, bin = null;
    while (off + 8 <= dv.byteLength) {
      var len = dv.getUint32(off, true);
      var type = dv.getUint32(off + 4, true);
      var start = off + 8;
      if (type === 0x4e4f534a) {
        json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, start, len)));
      } else if (type === 0x004e4942) {
        bin = new Uint8Array(buf, start, len);
      }
      off = start + len + ((4 - (len % 4)) % 4);
    }
    if (!json) throw new Error("GLB 里没有 JSON 块");
    return { json: json, bin: bin || new Uint8Array(0) };
  }

  function readAccessor(ctx, index) {
    var acc = ctx.json.accessors[index];
    if (!acc) throw new Error("访问器不存在: " + index);
    var comp = COMP[acc.componentType];
    if (!comp) throw new Error("不支持的分量类型: " + acc.componentType);
    var n = NUM[acc.type] || 1;
    var out = new comp.C(acc.count * n);
    if (acc.bufferView === undefined || !ctx.bin.length) return out; /* 稀疏/未定义，保持 0 */
    var view = ctx.json.bufferViews[acc.bufferView];
    var base = (view.byteOffset || 0) + (acc.byteOffset || 0);
    var stride = view.byteStride || comp.size * n;
    var dv = new DataView(ctx.bin.buffer, ctx.bin.byteOffset, ctx.bin.byteLength);
    for (var i = 0; i < acc.count; i++) {
      for (var k = 0; k < n; k++) {
        out[i * n + k] = comp.get(dv, base + i * stride + k * comp.size);
      }
    }
    return out;
  }

  function loadImageFromBytes(bytes, mime) {
    return new Promise(function (resolve, reject) {
      var blob = new Blob([bytes], { type: mime || "image/png" });
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("贴图解码失败")); };
      img.src = url;
    });
  }

  function makeTexture(T, image) {
    var tex = new T.Texture(image);
    tex.flipY = false; /* glTF 的 UV 原点在左上，与 three 默认相反 */
    tex.needsUpdate = true;
    if ("colorSpace" in tex) tex.colorSpace = "srgb";
    else if ("encoding" in tex) tex.encoding = 3001; /* sRGBEncoding */
    tex.wrapS = 1001; /* ClampToEdgeWrapping，避免非 2 次幂贴图报错 */
    tex.wrapT = 1001;
    return tex;
  }

  async function loadTexture(ctx, textureIndex) {
    var T = state.T;
    if (!T || !T.Texture) return null;
    var texDef = ctx.json.textures && ctx.json.textures[textureIndex];
    if (!texDef) return null;
    var imgDef = ctx.json.images && ctx.json.images[texDef.source];
    if (!imgDef) return null;
    try {
      var bytes, mime = imgDef.mimeType || "image/png";
      if (imgDef.bufferView !== undefined) {
        var view = ctx.json.bufferViews[imgDef.bufferView];
        bytes = ctx.bin.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
      } else if (imgDef.uri) {
        if (imgDef.uri.indexOf("data:") === 0) {
          /* data URI：把它当图片直接加载 */
          var img = await new Promise(function (res, rej) {
            var el = new Image();
            el.onload = function () { res(el); };
            el.onerror = rej;
            el.src = imgDef.uri;
          });
          return makeTexture(T, img);
        }
        var resp = await fetch(imgDef.uri);
        bytes = new Uint8Array(await resp.arrayBuffer());
        mime = resp.headers.get("content-type") || mime;
      } else {
        return null;
      }
      return makeTexture(T, await loadImageFromBytes(bytes, mime));
    } catch (e) {
      console.warn("[tripo-build] 贴图加载失败，退回纯色:", e.message);
      return null;
    }
  }

  async function buildMaterial(ctx, matIndex) {
    var T = state.T;
    if (!T || !T.Material) return null;
    var def = (ctx.json.materials && ctx.json.materials[matIndex]) || null;
    var pbr = (def && def.pbrMetallicRoughness) || {};
    var color = pbr.baseColorFactor || [1, 1, 1, 1];

    var params = {};
    if (T.Color) params.color = new T.Color(color[0], color[1], color[2]);
    params.metalness = pbr.metallicFactor === undefined ? 0 : pbr.metallicFactor;
    params.roughness = pbr.roughnessFactor === undefined ? 0.9 : pbr.roughnessFactor;
    if (color[3] !== undefined && color[3] < 1) params.transparent = true;
    if (pbr.baseColorTexture) {
      var map = await loadTexture(ctx, pbr.baseColorTexture.index);
      if (map) params.map = map;
    }
    var side = def && def.doubleSided ? 2 : 0; /* 2 = DoubleSide */
    params.side = side;
    return new T.Material(params);
  }

  async function buildPrimitive(ctx, prim) {
    var T = state.T;
    var attr = prim.attributes || {};
    if (attr.POSITION === undefined) return null;

    var geo = new T.BufferGeometry();
    var pos = readAccessor(ctx, attr.POSITION);
    geo.setAttribute("position", new T.BufferAttribute(pos, 3));
    if (attr.NORMAL !== undefined) {
      geo.setAttribute("normal", new T.BufferAttribute(readAccessor(ctx, attr.NORMAL), 3));
    }
    if (attr.TEXCOORD_0 !== undefined) {
      geo.setAttribute("uv", new T.BufferAttribute(readAccessor(ctx, attr.TEXCOORD_0), 2));
    }
    if (prim.indices !== undefined) {
      var idxArr = readAccessor(ctx, prim.indices);
      /* WebGL 索引缓冲只允许 Uint8/Uint16/Uint32。
         某些导出器（含部分 mock/工具链）会给出浮点索引，
         直接上传会被当成整数位模式乱读，导致整个网格一个面都画不出来。
         这里统一强制转成合法整型。 */
      if (!(idxArr instanceof Uint16Array) && !(idxArr instanceof Uint32Array) && !(idxArr instanceof Uint8Array)) {
        var maxIdx = 0;
        for (var q = 0; q < idxArr.length; q++) if (idxArr[q] > maxIdx) maxIdx = idxArr[q];
        var Conv = maxIdx > 65535 ? Uint32Array : Uint16Array;
        var fixed = new Conv(idxArr.length);
        for (var q2 = 0; q2 < idxArr.length; q2++) fixed[q2] = idxArr[q2];
        console.warn("[tripo-build] 索引类型非法(" + idxArr.constructor.name + ")，已转为 " + Conv.name);
        idxArr = fixed;
      }
      geo.setIndex(new T.BufferAttribute(idxArr, 1));
    }
    if (attr.NORMAL === undefined && geo.computeVertexNormals) geo.computeVertexNormals();

    var material = null;
    if (prim.material !== undefined) material = await buildMaterial(ctx, prim.material);
    var mesh = new T.Mesh(geo, material || undefined);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    return mesh;
  }

  async function buildNode(ctx, nodeIndex) {
    var T = state.T;
    var node = ctx.json.nodes[nodeIndex];
    var obj = new T.Object3D();
    if (node.name) obj.name = node.name;

    if (node.matrix && node.matrix.length === 16) {
      var m = new T.Matrix4();
      m.fromArray(node.matrix);
      m.decompose(obj.position, obj.quaternion, obj.scale);
    } else {
      if (node.translation) obj.position.fromArray(node.translation);
      if (node.rotation) obj.quaternion.fromArray(node.rotation);
      if (node.scale) obj.scale.fromArray(node.scale);
    }

    if (node.mesh !== undefined) {
      var meshDef = ctx.json.meshes[node.mesh];
      for (var i = 0; i < meshDef.primitives.length; i++) {
        var p = await buildPrimitive(ctx, meshDef.primitives[i]);
        if (p) obj.add(p);
      }
    }
    var kids = node.children || [];
    for (var k = 0; k < kids.length; k++) {
      obj.add(await buildNode(ctx, kids[k]));
    }
    return obj;
  }

  /** GLB → three 对象（未缩放、未定位的裸模型） */
  async function loadModelFromGLB(arrayBuffer) {
    var T = state.T;
    var ctx = parseGLB(arrayBuffer);
    var sceneIdx = ctx.json.scene || 0;
    var roots = (ctx.json.scenes && ctx.json.scenes[sceneIdx].nodes) || [0];
    var root = new T.Object3D();
    root.name = "TripoModel";
    for (var i = 0; i < roots.length; i++) {
      root.add(await buildNode(ctx, roots[i]));
    }
    return root;
  }

  /* ============================================================
   * 4. 摆到星球表面
   * ============================================================ */

  /** 模型在自身局部空间里的包围盒（沿每个 mesh 的变换走一遍顶点） */
  function localBounds(root) {
    var T = state.T;
    root.updateMatrixWorld(true);
    var min = [Infinity, Infinity, Infinity];
    var max = [-Infinity, -Infinity, -Infinity];
    var v = new T.Vector3();
    root.traverse(function (o) {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
      var arr = o.geometry.attributes.position.array;
      var count = arr.length / 3;
      var step = Math.max(1, Math.floor(count / 6000)); /* 抽样，避免大模型卡顿 */
      for (var i = 0; i < count; i += step) {
        v.set(arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]).applyMatrix4(o.matrixWorld);
        for (var a = 0; a < 3; a++) {
          var c = a === 0 ? v.x : a === 1 ? v.y : v.z;
          if (c < min[a]) min[a] = c;
          if (c > max[a]) max[a] = c;
        }
      }
    });
    if (min[0] === Infinity) return { min: [0, 0, 0], max: [0, 1, 0], height: 1 };
    return { min: min, max: max, height: Math.max(1e-4, max[1] - min[1]) };
  }

  /**
   * 把模型挂到角色脚边的地表上：
   *   - 位置：以角色所在径向为中心，在切平面上随机偏移一段距离后重新投影回球面
   *   - 朝向：模型自身的 +Y 对齐该点的径向（房屋"站"在地面上而不是躺着）
   *   - 缩放：统一到目标高度，底部刚好贴地（再往下埋 SINK 防止起伏处悬空）
   */
  function placeOnSurface(model, world, targetH) {
    var T = state.T;
    var p = world.player && world.player.group ? world.player.group.position : null;
    var dir;
    if (p) dir = new T.Vector3(p.x, p.y, p.z).normalize();
    else dir = new T.Vector3(0, 1, 0);

    /* 切平面基底：任意一条与 dir 垂直的向量 + 叉乘出第二条 */
    var helper = Math.abs(dir.y) > 0.9 ? new T.Vector3(1, 0, 0) : new T.Vector3(0, 1, 0);
    var t1 = new T.Vector3().crossVectors(helper, dir).normalize();
    var t2 = new T.Vector3().crossVectors(dir, t1).normalize();

    /* 场上已有的建筑位置（存档重建的 + 本次会话新放的都算），
       用来避免新建筑叠在旧建筑身上。从场景里取而不是只读存档，
       这样调试入口放的那些也算数。 */
    var occupied = [];
    var refScene = ctxRef && ctxRef.scene;
    if (refScene) {
      refScene.traverse(function (o) {
        if (o.userData && o.userData.tripoBuilding) occupied.push(o.position);
      });
    }

    /* 挑落点，三件事一起判：
         1. 用 world.surface() 查真实地表半径（写死 GROUND_R 会在低处悬空）
         2. 落在水里就换一个方位重试（全星球约六成是水）
         3. 和已有建筑保持 MIN_GAP 的最小间距，避免叠在一起
       不设"必须完美"的死条件：全都试完还不满足时，退而取评分最好的那个，
       保证生成流程永远能出结果，不会卡住。 */
    var spot = null, radius = CFG.GROUND_R, bestScore = -Infinity;
    for (var attempt = 0; attempt < 24; attempt++) {
      var angle = Math.random() * Math.PI * 2;
      /* 角色周围那一圈没多大地方（半径 2.2~3.6 的环形，约 25 平方单位，
         按最小间距只塞得下四五座）。所以让搜索范围随尝试次数往外扩：
         近处有空位就放近处，满了自然往外长，像聚落扩张。 */
      var growth = 1 + attempt * 0.3;
      var dist = (CFG.MIN_DIST + Math.random() * (CFG.MAX_DIST - CFG.MIN_DIST)) * growth;
      var cand = dir.clone().multiplyScalar(CFG.GROUND_R)
        .addScaledVector(t1, Math.cos(angle) * dist)
        .addScaledVector(t2, Math.sin(angle) * dist)
        .normalize();
      var s = null;
      try { s = world && world.surface ? world.surface(cand) : null; } catch (e) { s = null; }
      if (!s || !isFinite(s.radius) || s.radius <= 0) continue;

      /* 与最近一栋建筑的地面直线距离 */
      var surfacePoint = cand.clone().multiplyScalar(s.radius);
      var gap = Infinity;
      for (var k = 0; k < occupied.length; k++) {
        var g = occupied[k].distanceTo(surfacePoint);
        if (g < gap) gap = g;
      }
      var enoughRoom = occupied.length === 0 || gap >= CFG.MIN_GAP;

      if (!s.water && enoughRoom) {       /* 干地 + 不挤 → 直接用 */
        spot = cand; radius = s.radius; break;
      }
      /* 否则记分：干地优先，其次比谁离邻居更远 */
      var score = (s.water ? 0 : 1000) + Math.min(gap, CFG.MIN_GAP);
      if (score > bestScore) {
        bestScore = score; spot = cand; radius = s.radius;
      }
    }
    if (!spot) spot = dir.clone();

    var bounds = localBounds(model);
    var scale = (targetH || CFG.TARGET_H) / bounds.height;

    var root = new T.Object3D();
    root.name = "TripoBuilding";
    root.position.copy(spot).multiplyScalar(radius - CFG.SINK);
    root.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), spot.clone());

    var inner = new T.Object3D();
    inner.scale.setScalar(scale);
    inner.position.y = -bounds.min[1] * scale; /* 底部对齐到 root 的原点 */
    inner.add(model);
    root.add(inner);

    root.userData.tripoBuilding = true;
    return { object: root, scale: scale, spot: spot.toArray() };
  }

  /* ============================================================
   * 5. 生成流程
   * ============================================================ */

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function api(path, opts) {
    var res = await fetch(path, opts);
    var data = await res.json().catch(function () { return { ok: false, error: "响应不是 JSON" }; });
    if (!res.ok || data.ok === false) throw new Error(data.error || ("HTTP " + res.status));
    return data;
  }

  /** 生成 → 轮询 → 落盘 → 加载 → 摆放 */
  async function generateAndPlace(prompt, fileToken, onProgress) {
    var ctx = ctxRef;
    if (!ctx) throw new Error("游戏场景还没准备好");
    if (state.buildings.length >= CFG.MAX_BUILDINGS) throw new Error("建筑数量已达上限，先拆掉一些吧");

    /* 经济规则收敛在这里，不放面板里：
       任何入口（面板 / 快捷键 / 调试 API）生成都必然先扣费，
       失败则原额退还，玩家不会为一次没出来的模型白付积分。 */
    if (!spend()) throw new Error("积分不够，去收集奇迹吧");
    if (typeof paint === "function") paint();

    try {
      return await doGenerate(prompt, fileToken, onProgress);
    } catch (e) {
      addCredits(CFG.COST);
      if (typeof paint === "function") paint();
      throw e;
    }
  }

  async function doGenerate(prompt, fileToken, onProgress) {
    var ctx = ctxRef;

    var created = await api("/api/tripo/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: prompt, fileToken: fileToken || null, face_limit: 8000, texture: true })
    });
    state.mock = !!created.mock;

    var taskId = created.taskId;
    var saved = null;
    for (var i = 0; i < 180; i++) { /* 最多约 6 分钟 */
      var t = await api("/api/tripo/task/" + encodeURIComponent(taskId));
      var d = t.data || {};
      if (onProgress) onProgress(d.status === "success" ? 100 : (d.progress || 0), d.status);
      if (d.status === "success") {
        saved = await api("/api/tripo/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId: taskId, prompt: prompt })
        });
        break;
      }
      if (d.status === "failed" || d.status === "cancelled") {
        throw new Error("生成失败：" + (d.message || d.status));
      }
      await sleep(2000); /* 官方建议每 2 秒一次，勿超过 1 次/秒 */
    }
    if (!saved) throw new Error("生成超时");

    var buf = await (await fetch(saved.url)).arrayBuffer();
    var model = await loadModelFromGLB(buf);
    var placed = placeOnSurface(model, ctx.world);
    ctx.scene.add(placed.object);

    var record = {
      file: saved.file,
      url: saved.url,
      prompt: prompt,
      createdAt: Date.now(),
      p: placed.object.position.toArray(),
      q: placed.object.quaternion.toArray(),
      s: placed.scale
    };
    state.buildings.push(record);
    persist();
    /* 自己负责刷新面板：不要把这个责任留给调用方，
       否则任何不走面板的入口（调试 API / 快捷键）都会让列表慢一拍。 */
    if (typeof paint === "function") paint();
    return record;
  }

  /** 刷新页面后按存档重建 */
  async function restore(record) {
    var ctx = ctxRef;
    if (!ctx) return;
    var buf = await (await fetch(record.url)).arrayBuffer();
    var model = await loadModelFromGLB(buf);
    var T = state.T;
    var root = new T.Object3D();
    root.name = "TripoBuilding";
    root.position.fromArray(record.p);
    root.quaternion.fromArray(record.q);
    var inner = new T.Object3D();
    inner.scale.setScalar(record.s);
    /* 底部偏移已包含在存档的位置里，这里按原始比例还原 */
    var bounds = localBounds(model);
    inner.position.y = -bounds.min[1] * record.s;
    inner.add(model);
    root.add(inner);
    root.userData.tripoBuilding = true;
    ctx.scene.add(root);
  }

  function persist() {
    try {
      localStorage.setItem(LS_LIST, JSON.stringify(state.buildings));
    } catch (e) { /* 容量满了就忽略 */ }
  }
  function loadPersisted() {
    try {
      var list = JSON.parse(localStorage.getItem(LS_LIST) || "[]");
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }

  async function removeBuilding(record) {
    var ctx = ctxRef;
    if (ctx) {
      ctx.scene.traverse(function (o) {
        if (o.userData && o.userData.tripoBuilding) {
          /* 用位置匹配（存档里存的就是位置） */
          if (Math.abs(o.position.x - record.p[0]) < 1e-4 &&
              Math.abs(o.position.y - record.p[1]) < 1e-4 &&
              Math.abs(o.position.z - record.p[2]) < 1e-4) {
            o.parent && o.parent.remove(o);
          }
        }
      });
    }
    state.buildings = state.buildings.filter(function (b) { return b !== record; });
    persist();
    try {
      await fetch("/api/tripo/buildings?file=" + encodeURIComponent(record.file), { method: "DELETE" });
    } catch (e) { /* 文件删不掉不影响前台 */ }
    addCredits(CFG.REFUND);
    paint();
  }

  /* ============================================================
   * 6. 界面
   * ============================================================ */

  var ctxRef = null;
  var el = {};

  function toast(text) {
    var box = document.getElementById("toast");
    if (box) {
      box.textContent = text;
      box.classList.add("is-visible");
      setTimeout(function () { box.classList.remove("is-visible"); }, 2600);
    }
    console.log("[tripo-build] " + text);
  }

  function buildUI() {
    var css = [
      "#tripo-build-btn{position:absolute;top:66px;right:36px;z-index:40;",
      "display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12px;",
      "letter-spacing:.5px;cursor:pointer;color:var(--muted);background:var(--glass);",
      "border:1px solid var(--line);border-radius:9px;padding:7px 12px;",
      "-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);",
      "transition:color .2s,border-color .2s;}",
      "#tripo-build-btn:hover{color:var(--accent);border-color:var(--accent);}",
      "#tripo-panel{position:fixed;top:0;right:0;bottom:0;width:320px;max-width:86vw;z-index:120;",
      "display:none;flex-direction:column;gap:12px;padding:18px 16px;overflow:auto;",
      "background:rgba(10,2,22,.9);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);",
      "border-left:1px solid rgba(255,64,242,.28);color:#f0e6ff;",
      "font:13px/1.6 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;}",
      "#tripo-panel.is-open{display:flex;}",
      "#tripo-panel h3{margin:0;font-size:14px;letter-spacing:.06em;}",
      "#tripo-panel .tp-row{display:flex;align-items:center;justify-content:space-between;gap:8px;}",
      "#tripo-panel .tp-credits{font:600 20px/1 ui-monospace,SFMono-Regular,monospace;color:#ffd166;}",
      "#tripo-panel textarea{min-height:74px;resize:vertical;padding:9px 10px;border-radius:10px;",
      "border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#f0e6ff;",
      "font:inherit;outline:none;}",
      "#tripo-panel textarea:focus{border-color:#ff64ee;}",
      "#tripo-panel button.tp-go{width:100%;padding:10px;border-radius:10px;border:0;cursor:pointer;",
      "font:inherit;font-weight:600;color:#1a0020;background:linear-gradient(90deg,#ff64ee,#ffd166);}",
      "#tripo-panel button.tp-go[disabled]{opacity:.45;cursor:not-allowed;}",
      "#tripo-panel .tp-bar{height:5px;border-radius:99px;background:rgba(255,255,255,.12);overflow:hidden;}",
      "#tripo-panel .tp-bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#ff64ee,#ffd166);",
      "transition:width .35s ease;}",
      "#tripo-panel .tp-status{font-size:12px;color:#b9a8cc;min-height:18px;}",
      "#tripo-panel .tp-list{display:grid;gap:8px;margin:0;padding:0;list-style:none;}",
      "#tripo-panel .tp-list li{display:flex;align-items:center;justify-content:space-between;gap:8px;",
      "padding:8px 10px;border-radius:9px;background:rgba(255,255,255,.05);font-size:12px;}",
      "#tripo-panel .tp-list b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      "#tripo-panel .tp-del{flex:none;border:1px solid rgba(255,255,255,.2);background:transparent;",
      "color:#b9a8cc;border-radius:7px;padding:3px 8px;cursor:pointer;font:inherit;font-size:11px;}",
      "#tripo-panel .tp-del:hover{color:#ff8f8f;border-color:#ff8f8f;}",
      "#tripo-panel .tp-note{font-size:11px;color:#a08fb5;line-height:1.7;}",
      "#tripo-panel .tp-close{align-self:flex-end;border:0;background:transparent;color:#b9a8cc;",
      "font-size:20px;cursor:pointer;line-height:1;}"
    ].join("");
    var style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    var btn = document.createElement("button");
    btn.type = "button";
    btn.id = "tripo-build-btn";
    btn.textContent = "🔨 建造";
    btn.title = "用收集到的积分生成建筑";
    btn.addEventListener("click", function () {
      el.panel.classList.toggle("is-open");
    });

    var panel = document.createElement("aside");
    panel.id = "tripo-panel";
    panel.innerHTML = [
      '<button class="tp-close" aria-label="关闭">×</button>',
      '<div class="tp-row"><h3>🔨 建造工坊</h3><span class="tp-credits">0</span></div>',
      '<div class="tp-note">收集奇迹得积分，花积分让 AI 生成一座建筑，它会落在你脚边的星球表面上。</div>',
      '<textarea placeholder="描述你想建的东西，比如：霓虹小屋 / 灯塔 / 蘑菇屋（中英文都行）"></textarea>',
      '<button class="tp-go">生成（-40 积分）</button>',
      '<div class="tp-bar"><i></i></div>',
      '<div class="tp-status"></div>',
      '<div class="tp-row"><h3>🏘 我的建筑</h3><span class="tp-note" id="tp-count"></span></div>',
      '<ul class="tp-list"></ul>',
      '<div class="tp-note" id="tp-mode"></div>'
    ].join("");
    document.body.appendChild(panel);

    panel.querySelector(".tp-close").addEventListener("click", function () {
      panel.classList.remove("is-open");
    });

    el = {
      btn: btn,
      panel: panel,
      credits: panel.querySelector(".tp-credits"),
      input: panel.querySelector("textarea"),
      go: panel.querySelector(".tp-go"),
      bar: panel.querySelector(".tp-bar i"),
      status: panel.querySelector(".tp-status"),
      list: panel.querySelector(".tp-list"),
      count: panel.querySelector("#tp-count"),
      mode: panel.querySelector("#tp-mode")
    };

    el.go.addEventListener("click", onGenerate);

    var wrap = document.getElementById("duo-entry-wrap");
    if (wrap) wrap.appendChild(btn);
    else (document.getElementById("app") || document.body).appendChild(btn);
  }

  function paint() {
    if (!el.credits) return;
    var c = readCredits();
    el.credits.textContent = String(c);
    el.go.disabled = c < CFG.COST || state.busy || !state.ready;
    el.go.textContent = state.busy ? "生成中…" : "生成（-" + CFG.COST + " 积分）";
    el.count.textContent = state.buildings.length + " / " + CFG.MAX_BUILDINGS;

    el.list.innerHTML = "";
    state.buildings.slice().reverse().forEach(function (b) {
      var li = document.createElement("li");
      var name = document.createElement("b");
      name.textContent = b.prompt || "建筑";
      name.title = b.prompt || "";
      var del = document.createElement("button");
      del.className = "tp-del";
      del.textContent = "拆除 +" + CFG.REFUND;
      del.addEventListener("click", function () { removeBuilding(b); });
      li.appendChild(name);
      li.appendChild(del);
      el.list.appendChild(li);
    });
  }

  function setStatus(text, progress) {
    if (el.status) el.status.textContent = text || "";
    if (el.bar) el.bar.style.width = (progress || 0) + "%";
  }

  async function onGenerate() {
    var prompt = (el.input.value || "").trim();
    if (!prompt) { setStatus("先写一句描述吧", 0); return; }
    if (!state.ready) { setStatus("场景还没准备好", 0); return; }
    if (readCredits() < CFG.COST) { setStatus("积分不够，去收集奇迹吧", 0); return; }
    if (state.busy) return;

    state.busy = true;
    paint();
    try {
      setStatus("已提交生成任务…", 6);
      var rec = await generateAndPlace(prompt, null, function (p, st) {
        setStatus(st === "success" ? "正在下载模型…" : "生成中 " + st + " " + Math.round(p) + "%", Math.max(6, Math.min(95, p)));
      });
      setStatus("✅ 已建成：" + rec.prompt, 100);
      toast("新建筑已落在你脚边");
      el.input.value = "";
    } catch (e) {
      setStatus("❌ " + e.message, 0);
    } finally {
      state.busy = false;
      paint();
    }
  }

  /* ============================================================
   * 7. 启动
   * ============================================================ */

  async function boot() {
    /* 分屏座位里不建面板：两个座位是两个独立世界，都建会互相干扰 */
    if (new URLSearchParams(location.search).get("seat")) return;

    buildUI();

    try {
      var cfg = await api("/api/tripo/config");
      state.mock = !!cfg.mock;
      el.mode.textContent = cfg.mock
        ? "演示模式：服务端没配 TRIPO_API_KEY，生成的是占位小屋。配置后即可生成真实模型。"
        : "已接入 Tripo（" + cfg.model + "）";
    } catch (e) {
      if (el.mode) el.mode.textContent = "取不到服务端配置：" + e.message;
    }

    try {
      ctxRef = await waitForGame();
      state.T = harvestThree(ctxRef.scene);
      state.ready = true;
    } catch (e) {
      setStatus("⚠️ " + e.message, 0);
      if (el.mode) el.mode.innerHTML += "<br>提示：在原版星球上请用 <b>?build=1</b> 打开。";
      return;
    }

    /* 恢复存档 */
    var saved = loadPersisted();
    for (var i = 0; i < saved.length; i++) {
      try {
        await restore(saved[i]);
        state.buildings.push(saved[i]);
      } catch (e2) {
        console.warn("[tripo-build] 恢复失败:", e2.message);
      }
    }
    persist();
    paint();

    /* 收集检测：DOM 变化 + 2 秒兜底轮询 */
    syncCollected();
    var target = document.getElementById("collected-count");
    if (target && window.MutationObserver) {
      new MutationObserver(syncCollected).observe(target, { childList: true, characterData: true, subtree: true });
    }
    setInterval(syncCollected, 2000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
