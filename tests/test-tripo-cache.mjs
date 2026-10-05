/*
 * Tripo 提示词缓存测试。
 *
 * 目的：验证「同样的描述 + 模型 + 面数 + 贴图配置」第二次生成时直接复用已有 GLB，
 * 不再向 Tripo 提交任务（真实调用一次扣一次费，缓存命中应当省掉这一笔）。
 *
 * 跑法： node tests/test-tripo-cache.mjs
 *
 * 它是仓库里唯一会真起服务器的测试，所以做了三件事保证不污染：
 *   - TRIPO_OUT_DIR 指向 /tmp 下的空目录，产物不进 web/models/buildings
 *   - 用 8799 端口，避让默认的 8765
 *   - 显式删掉 TRIPO_API_KEY，强制走 mock，绝不会真的扣费
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSuite } from "./harness.mjs";
import { ROOT } from "./harness.mjs";

const NODE = process.execPath;
const PORT = Number(process.env.TRIPO_TEST_PORT || 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK_MS = Number(process.env.TRIPO_TEST_MOCK_MS || 300);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, init) {
  const res = await fetch(BASE + p, init);
  return await res.json();
}

const post = (p, body) =>
  api(p, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });

/** 轮询到任务结束。缓存命中的任务一问就 success，mock 任务要等 MOCK_MS */
async function waitFor(taskId, budgetMs = 8000) {
  const t0 = Date.now();
  for (;;) {
    const t = await api("/api/tripo/task/" + encodeURIComponent(taskId));
    const d = t.data || {};
    if (d.status === "success") return t;
    if (d.status === "failed" || d.status === "cancelled") throw new Error("任务失败: " + d.status);
    if (Date.now() - t0 > budgetMs) throw new Error("等任务超时，最后状态 " + d.status);
    await sleep(120);
  }
}

/** 完整走一遍「生成 → 轮询 → 落盘」，返回落盘结果 */
async function build(prompt, extra) {
  const g = await post("/api/tripo/generate", Object.assign({ prompt }, extra || {}));
  if (!g.ok) throw new Error("生成失败: " + g.error);
  await waitFor(g.taskId);
  const saved = await post("/api/tripo/save", { taskId: g.taskId, prompt });
  if (!saved.ok) throw new Error("落盘失败: " + saved.error);
  return { generate: g, saved };
}

function startServer(outDir) {
  const env = Object.assign({}, process.env);
  delete env.TRIPO_API_KEY;          // 强制 mock，测试绝不能真扣费
  env.PORT = String(PORT);
  env.TRIPO_OUT_DIR = outDir;
  env.TRIPO_MOCK_MS = String(MOCK_MS);

  const proc = spawn(NODE, [path.join(ROOT, "server", "server.js")], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  proc.stderr.on("data", () => {});
  proc.stdout.on("data", () => {});
  return proc;
}

async function waitReady(proc, budgetMs = 10000) {
  const t0 = Date.now();
  for (;;) {
    if (proc.exitCode !== null) throw new Error("服务器提前退出，code=" + proc.exitCode);
    try {
      const c = await api("/api/tripo/config");
      if (c && c.ok) return c;
    } catch (e) { /* 还没起来 */ }
    if (Date.now() - t0 > budgetMs) throw new Error("服务器启动超时");
    await sleep(150);
  }
}

export default async function run() {
  const s = createSuite("test-tripo-cache");
  const outDir = mkdtempSync(path.join(tmpdir(), "lp-cache-"));
  let proc = startServer(outDir);

  try {
    const cfg = await waitReady(proc);
    s.group("环境");
    s.eq(cfg.mock, true, "走 mock 模式（没有 API Key，不会真的扣费）");
    s.eq(cfg.hasKey, false, "hasKey 为 false");

    /* ---------- 首次生成：应当真的走一遍流程 ---------- */
    s.group("首次生成");
    const first = await build("测试小屋");
    s.eq(first.generate.cached, false, "首次生成不走缓存");
    s.ok(String(first.generate.taskId).startsWith("mock_"), "返回真实任务号", first.generate.taskId);
    s.ok(!!first.saved.file, "落盘拿到文件名", String(first.saved.file));
    s.ok(first.saved.size > 0, "文件非空");

    const idxPath = path.join(outDir, "index.json");
    const idx1 = JSON.parse(readFileSync(idxPath, "utf8"));
    /* 按 taskId 精确找。按 file 找会撞上历史遗留的桩记录（见下方重复断言） */
    const entry1 = idx1.find((b) => b.taskId === first.generate.taskId);
    s.ok(!!entry1, "索引里能找到这条记录");
    const sameFile = idx1.filter((b) => b.file === first.saved.file);
    s.eq(sameFile.length, 1, "同一个文件在索引里只出现一次（防重复落盘登记）");
    s.ok(!!(entry1 && entry1.cacheKey), "记录被打上缓存键", entry1 && entry1.cacheKey);
    s.ok(
      !!entry1 && entry1.cacheKey.indexOf("测试小屋") === 0,
      "缓存键以归一化后的描述开头",
      entry1 && entry1.cacheKey
    );

    /* ---------- 第二次同描述：应当命中缓存 ---------- */
    s.group("同描述再生成（核心）");
    const second = await build("测试小屋");
    s.eq(second.generate.cached, true, "第二次命中缓存，不再提交任务");
    s.ok(
      String(second.generate.taskId).startsWith("cached:"),
      "返回 cached: 开头的伪任务号",
      second.generate.taskId
    );
    s.eq(second.saved.file, first.saved.file, "复用的就是第一次那个文件");
    s.eq(second.saved.cached, true, "落盘也标记为缓存复用");

    /* mock_ 开头是 mock 任务自己的中间产物，不算玩家造出来的建筑，要排除掉 */
    const realFiles = () => readdirSync(outDir).filter((f) => f.endsWith(".glb") && !f.startsWith("mock_"));
    s.eq(realFiles().length, 1, "磁盘上仍然只有一个建筑 GLB，没有重复落盘");

    /* ---------- 描述归一化 ---------- */
    s.group("描述归一化");
    const spaced = await build("  测试小屋  ");
    s.eq(spaced.generate.cached, true, "首尾空格不影响命中");
    /* 归一化是「压连续空白成一个空格」，不是删掉空白，
       所以 "测试 小屋" 和 "测试小屋" 是两个不同需求，而多个空格会折成一个 */
    const oneSpace = await build("测试 小屋");
    s.eq(oneSpace.generate.cached, false, "「测试 小屋」与「测试小屋」算两个需求");
    const manySpace = await build("测试   小屋");
    s.eq(manySpace.generate.cached, true, "连续空白折成一个空格后命中上一条");
    s.eq(manySpace.saved.file, oneSpace.saved.file, "复用的是同一个文件");
    s.eq(realFiles().length, 2, "归一化后只多出一个建筑文件");

    /* ---------- 参数不同则不命中 ---------- */
    s.group("参数变了就不该命中");
    const otherModel = await build("测试小屋", { model: "v2.5-20250123" });
    s.eq(otherModel.generate.cached, false, "换模型 → 重新生成");
    const otherFaces = await build("测试小屋", { face_limit: 3000 });
    s.eq(otherFaces.generate.cached, false, "换面数 → 重新生成");
    const otherTex = await build("测试小屋", { texture: false });
    s.eq(otherTex.generate.cached, false, "关贴图 → 重新生成");
    const otherPrompt = await build("测试灯塔");
    s.eq(otherPrompt.generate.cached, false, "换描述 → 重新生成");

    /* 换过参数之后，原参数依然应该命中 —— 缓存键不能互相覆盖 */
    s.group("参数变更后原组合仍命中");
    const back = await build("测试小屋");
    s.eq(back.generate.cached, true, "回到默认参数仍然命中最初那个模型");
    s.eq(back.saved.file, first.saved.file, "复用的还是同一个文件");

    /* ---------- 文件被删：缓存失效 ---------- */
    s.group("模型文件没了要能降级");
    const victim = first.saved.file;
    unlinkSync(path.join(outDir, victim));
    const afterDelete = await build("测试小屋");
    s.eq(afterDelete.generate.cached, false, "原文件被删后不再命中，重新生成");
    s.ok(!!afterDelete.saved.file && afterDelete.saved.file !== victim, "落盘了一个新文件");

    /* ---------- 重启服务器：索引里的缓存键是持久的 ---------- */
    s.group("重启后仍命中（缓存键持久化）");
    const before = await build("持久化小屋");
    s.eq(before.generate.cached, false, "重启前先生成一个");

    proc.kill("SIGTERM");
    await sleep(400);
    proc = startServer(outDir);
    const cfg2 = await waitReady(proc);
    s.eq(cfg2.mock, true, "服务器重启成功");

    const afterRestart = await build("持久化小屋");
    s.eq(afterRestart.generate.cached, true, "重启后同描述仍命中（索引里的缓存键是持久的）");
    s.eq(afterRestart.saved.file, before.saved.file, "复用的还是重启前那个文件");

    s.group("索引内容");
    const idxEnd = JSON.parse(readFileSync(path.join(outDir, "index.json"), "utf8"));
    s.ok(Array.isArray(idxEnd), "索引是数组");
    s.ok(idxEnd.every((b) => typeof b.file === "string"), "每条记录都有 file 字段");
    const withKey = idxEnd.filter((b) => b.cacheKey);
    s.ok(withKey.length > 0, "至少有一条记录带缓存键");
  } catch (e) {
    s.ok(false, "测试过程没有抛异常", e && e.stack ? e.stack.split("\n")[0] : String(e));
  } finally {
    try { proc.kill("SIGKILL"); } catch (e) { /* 已退出 */ }
    rmSync(outDir, { recursive: true, force: true });
  }

  /* 入口 run.mjs 会统一打印 results.lines，这里只回传 suite 对象 */
  return s;
}

/* 允许单独跑： node tests/test-tripo-cache.mjs */
if (process.argv[1] && process.argv[1].endsWith("test-tripo-cache.mjs")) {
  const s = await run();
  console.log(`\n[${s.results.name}]`);
  s.results.lines.forEach((l) => console.log(l));
  console.log(`\n通过 ${s.results.pass} · 失败 ${s.results.fail}`);
  process.exit(s.results.fail ? 1 : 0);
}
