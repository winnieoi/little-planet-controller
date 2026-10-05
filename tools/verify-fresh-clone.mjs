/*
 * 全新克隆冒烟测试：从 GitHub 拉一份干净副本，按 README 的步骤跑起来，
 * 确认「clone 下来就能玩」这件事没坏。
 *
 *   node tools/verify-fresh-clone.mjs
 *
 * 为什么单开一个脚本：本地工作区里躺着 24 个已生成的建筑和一堆未入库的产物，
 * 很容易掩盖「某个必需文件其实被 gitignore 掉了」这类问题。
 * CI 上就是这个场景，所以这里显式地模拟一遍。
 *
 * 它做两件事：
 *   1. 全套测试（会先构建离线单文件版，因为那个产物不入库）
 *   2. 起服务器，走一遍接口 + 真的生成一个模型，再把它取回来
 *
 * 注意：需要能访问 GitHub。私有仓库要带凭证，公开仓库直接拉就行。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = process.env.CLONE_REPO || "https://github.com/winnieoi/little-planet-controller.git";
const NODE = process.execPath;
const PORT = Number(process.env.CLONE_PORT || 8807);
const DIR = process.env.CLONE_DIR || path.join(mkdtempSync(path.join(tmpdir(), "lp-clone-")), "repo");
const KEEP = process.env.CLONE_KEEP === "1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(cond, label, detail) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? "  → " + detail : ""}`); }
  return !!cond;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, Object.assign({ cwd: DIR, stdio: ["ignore", "pipe", "pipe"] }, opts));
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    p.on("close", (code) => resolve({ code, out }));
  });
}

try {
  console.log(`\n[克隆] ${REPO}\n       → ${DIR}`);
  const clone = await run("git", ["clone", "-q", "--depth", "1", REPO, DIR], { cwd: tmpdir() });
  if (clone.code !== 0) {
    check(false, "克隆成功", clone.out.trim().split("\n").slice(-2).join(" "));
    throw new Error("克隆失败，后面没法继续");
  }
  check(true, "克隆成功");

  const log = await run("git", ["log", "--oneline"]);
  check(log.out.trim().length > 0, "拉到了提交记录", log.out.trim().split("\n").length + " 个");

  console.log("\n[按 README 步骤：先构建离线单文件版]");
  const build = await run(NODE, ["tools/build-ds5-standalone-html.mjs"]);
  check(build.code === 0, "构建脚本退出码为 0", build.out.trim().split("\n").slice(-1)[0]);

  console.log("\n[按 README 步骤：跑全套测试]");
  const tests = await run(NODE, ["tests/run.mjs"]);
  const last = tests.out.trim().split("\n").slice(-1)[0];
  check(/全部通过/.test(tests.out), "全套测试全部通过", last);
  const m = tests.out.match(/通过 (\d+) · 失败 (\d+)/);
  if (m) console.log(`     通过 ${m[1]} · 失败 ${m[2]}`);

  console.log("\n[按 README 步骤：启动服务器（不配 Key，走 mock）]");
  const server = spawn(NODE, ["server/server.js"], {
    cwd: DIR,
    env: Object.assign({}, process.env, { PORT: String(PORT), TRIPO_MOCK_MS: "600" }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let bootLog = "";
  server.stdout.on("data", (d) => { bootLog += d; });
  server.stderr.on("data", (d) => { bootLog += d; });
  const B = `http://127.0.0.1:${PORT}`;

  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      try { const c = await (await fetch(B + "/api/tripo/config")).json(); if (c.ok) { up = true; break; } } catch (e) {}
      await sleep(150);
    }
    check(up, "服务器启动成功");
    if (!up) throw new Error("服务器没起来");

    const home = await fetch(B + "/");
    check(home.ok, "游戏首页可取", "status " + home.status);

    /* 建造模式的三个关键文件都要在，缺一个就玩不了 */
    for (const f of ["/bridge/tripo-build.js", "/bridge/lp-controller.js"]) {
      const r = await fetch(B + f);
      check(r.ok, `建造模式资源可取 ${f}`, "status " + r.status);
    }

    const cfg = await (await fetch(B + "/api/tripo/config")).json();
    check(cfg.mock === true, "没配 Key 自动进 mock 模式");
    check(cfg.balance !== undefined, "返回余额字段");

    const list = await (await fetch(B + "/api/tripo/buildings")).json();
    check(Array.isArray(list.buildings), "建筑清单接口正常");
    check(list.buildings.length === 0, "全新克隆下建筑列表为空（运行时产物没入库）", "实得 " + list.buildings.length);

    console.log("\n[全新环境真的生成一个]");
    const g = await (await fetch(B + "/api/tripo/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "克隆冒烟测试小屋" })
    })).json();
    check(g.ok === true, "生成请求被接受", g.error);
    if (g.ok) {
      let done = false;
      for (let i = 0; i < 40; i++) {
        const t = await (await fetch(B + "/api/tripo/task/" + g.taskId)).json();
        if (t.data && t.data.status === "success") { done = true; break; }
        await sleep(150);
      }
      check(done, "任务跑完");
      const sv = await (await fetch(B + "/api/tripo/save", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: g.taskId, prompt: "克隆冒烟测试小屋" })
      })).json();
      check(sv.ok === true, "落盘成功", sv.error);
      if (sv.ok) {
        const r = await fetch(B + "/models/buildings/" + sv.file);
        check(r.ok, "刚生成的模型能取回来", "status " + r.status);
      }
    }
  } finally {
    try { server.kill("SIGKILL"); } catch (e) {}
  }
} catch (e) {
  failures++;
  console.log("\n✗ 过程抛异常: " + (e && e.message ? e.message : e));
} finally {
  if (!KEEP) {
    try { rmSync(path.dirname(DIR), { recursive: true, force: true }); } catch (e) {}
  } else {
    console.log("\n保留克隆目录: " + DIR);
  }
}

console.log("\n" + "=".repeat(56));
console.log(failures === 0 ? "全新克隆可跑通" : `${failures} 项失败`);
process.exit(failures ? 1 : 0);
