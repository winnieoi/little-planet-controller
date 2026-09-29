import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/*
 * 新赛博星球接入模块
 *
 * 把《赛博星球.glb》作为「主星球」接入《口袋星球》网页版。
 * 角色、碰撞、寻路、交互点、后端手柄控制全部沿用原游戏逻辑，一行不改。
 *
 * 模型已在打包前用 tools/fit-planet.mjs 做过离线贴合：
 *   - 顶点坐标即最终世界坐标，无需再缩放/平移；
 *   - 地表半径严格落在 25.4 ± 1.3 的窄带内（角色行走球面为 26，脚底约 25.4）；
 *   - 法线已重算，光照正确。
 * 因此这里只负责：隐藏原程序化地表 → 加载模型 → 原样摆放。
 */

const MODEL_URL = "./models/cyber-planet.glb";

const state = {
  status: "waiting",
  progress: 0,
  error: null,
  model: null,
  info: null
};

window.LPCyberPlanet = state;

function createOverlay() {
  const overlay = document.createElement("div");
  overlay.id = "cyber-model-loading";
  overlay.innerHTML = '<div class="cyber-model-loading__panel"><strong>正在载入新赛博星球</strong><span>0%</span><small>CYBER PLANET · HIGH DETAIL MODEL</small></div>';
  overlay.style.cssText = "position:fixed;inset:0;z-index:98;display:grid;place-items:center;background:radial-gradient(circle at 50% 45%,rgba(64,0,92,.52),rgba(8,0,24,.92));color:#f4d8ff;font:14px/1.5 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;letter-spacing:.08em;transition:opacity .65s ease;pointer-events:none";
  const panel = overlay.firstElementChild;
  panel.style.cssText = "display:grid;gap:8px;text-align:center;padding:20px 28px;border:1px solid rgba(255,64,242,.42);border-radius:18px;background:rgba(12,0,30,.74);box-shadow:0 0 60px rgba(212,40,255,.16)";
  panel.querySelector("strong").style.cssText = "font-size:16px;font-weight:600";
  panel.querySelector("span").style.cssText = "font:600 28px/1 ui-monospace,SFMono-Regular,monospace;color:#ff64ee";
  panel.querySelector("small").style.cssText = "font-size:9px;color:#a98aba";
  document.body.appendChild(overlay);
  return overlay;
}

function waitForGame() {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const check = () => {
      if (window.__LP_SCENE__ && window.__LP_WORLD__) {
        resolve({ scene: window.__LP_SCENE__, world: window.__LP_WORLD__ });
        return;
      }
      if (performance.now() - started > 20000) {
        reject(new Error("等待游戏场景初始化超时"));
        return;
      }
      requestAnimationFrame(check);
    };
    check();
  });
}

/**
 * 隐藏原程序化地表，只保留操作层对象（角色、NPC、光环、目标点、收集标记）。
 *
 * 这些对象在场景树里的层级并不固定，因此采用「按路径保护」：
 *   1. 先把整个世界递归隐藏
 *   2. 再沿「世界 → 目标」这条链逐层恢复可见
 *      - 路径上的节点恢复可见，但把不在路径上的兄弟子树继续隐藏
 *      - 到达目标本身时，恢复它的整棵子树
 * 这样无论目标嵌套多深都能保住，同时不会误把地形放出来。
 */
function hideOriginalPlanet(world) {
  const keepRoots = [
    world.player && world.player.group,
    world.npc && world.npc.group,
    world.halo,
    world.destination,
    ...(world.stamps || []).map((item) => item.group)
  ].filter(Boolean);

  const hideTree = (node) => node.traverse((o) => { o.visible = false; });
  for (const child of [...world.world.children]) hideTree(child);

  for (const root of keepRoots) {
    const chain = [];
    let node = root;
    while (node && node !== world.world) {
      chain.push(node);
      node = node.parent;
    }
    chain.reverse();
    if (!chain.length || chain[0].parent !== world.world) continue;

    for (let i = 0; i < chain.length; i++) {
      const current = chain[i];
      current.visible = true;
      if (i + 1 < chain.length) {
        const next = chain[i + 1];
        for (const child of current.children) {
          if (child !== next) hideTree(child);
        }
      } else {
        /* 目标本身：恢复整棵子树 */
        current.traverse((o) => { o.visible = true; });
      }
    }
  }

  if (world.sea) world.sea.visible = false;
}

async function boot() {
  const overlay = createOverlay();
  const percent = overlay.querySelector("span");
  const note = overlay.querySelector("small");
  try {
    state.status = "loading";
    const { scene, world } = await waitForGame();
    hideOriginalPlanet(world);

    note.textContent = "正在下载模型…";
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(MODEL_URL, (event) => {
      if (!event.total) return;
      state.progress = Math.min(1, event.loaded / event.total);
      percent.textContent = Math.round(state.progress * 100) + "%";
    });

    const root = gltf.scene;
    /* 模型已是最终世界坐标，只做朝向微调 */
    root.rotation.y = Math.PI;
    root.name = "CyberPlanetGLB";
    root.userData.cyberPlanet = true;
    root.traverse((object) => {
      if (!object.isMesh) return;
      object.castShadow = false;
      object.receiveShadow = true;
      const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
      for (const material of materials) material.needsUpdate = true;
    });

    scene.add(root);
    state.model = root;
    state.info = {
      scale: root.scale.toArray(),
      position: root.position.toArray(),
      meshes: (() => { let n = 0; root.traverse((o) => { if (o.isMesh) n++; }); return n; })()
    };
    state.progress = 1;
    state.status = "ready";
    percent.textContent = "100%";

    const canvas = document.getElementById("world");
    if (canvas) canvas.dataset.model = "cyber-planet-glb";
    window.dispatchEvent(new CustomEvent("lp-cyber-planet-ready", { detail: state }));

    setTimeout(() => {
      overlay.style.opacity = "0";
      setTimeout(() => overlay.remove(), 700);
    }, 250);
  } catch (error) {
    state.status = "error";
    state.error = String(error && error.message ? error.message : error);
    overlay.querySelector("strong").textContent = "新星球模型加载失败";
    percent.textContent = "!";
    note.textContent = state.error;
    overlay.style.pointerEvents = "auto";
    console.error("[cyber-planet]", error);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
