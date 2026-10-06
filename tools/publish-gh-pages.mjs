#!/usr/bin/env node
/**
 * 把 web/ 发布到 GitHub Pages（gh-pages 分支）。
 *
 * 为什么是 gh-pages 分支而不是 GitHub Actions：
 * Actions 的工作流文件要推到 .github/workflows/，而本机的 GitHub token 没有
 * workflow 权限（只有 repo），推上去会被拒。走产物分支绕开了这个限制 ——
 * 分支本身用 repo 权限就能推。代价是每次更新要手动跑一次这个脚本。
 *
 * 用法：
 *   node tools/publish-gh-pages.mjs
 *   node tools/publish-gh-pages.mjs --domain play.example.com   # 同时写入 CNAME
 *   node tools/publish-gh-pages.mjs --dry-run                   # 只组织不推送
 *
 * 推送用的凭据从当前环境继承（GIT_ASKPASS / ssh / credential.helper 都行），
 * 脚本不碰任何密钥。若本机 token 是钥匙串里的，可以这样跑：
 *   security find-internet-password -s github.com -a winnieoi -w > /tmp/gh-tok.txt
 *   printf '#!/bin/sh\ncat /tmp/gh-tok.txt\n' > /tmp/gh-askpass.sh && chmod +x /tmp/gh-askpass.sh
 *   GIT_ASKPASS=/tmp/gh-askpass.sh node tools/publish-gh-pages.mjs
 *
 * 静态托管的边界（重要）：
 * Pages 只能给静态文件，跑不了 Node。所以建造工坊的在线生成、WebSocket 输入注入
 * 这些依赖 server/server.js 的能力在这里全部没有 —— 前端会明确提示而不是静默失败。
 * 需要后端就别用这个脚本，改用带 Node 运行时的平台。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const WEB = path.join(ROOT, "web");
const BRANCH = "gh-pages";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const domainArg = argv.indexOf("--domain");
const domain = domainArg >= 0 ? argv[domainArg + 1] : null;

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function step(msg) {
  console.log("  " + msg);
}

if (!fs.existsSync(WEB)) throw new Error("找不到 web/ 目录，脚本要在仓库根目录跑");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lp-pages-"));
console.log("[准备产物] " + tmp);

/* 站点根就是 web/：index.html 必须落在 Pages 的根，不能是 web/index.html */
fs.cpSync(WEB, tmp, { recursive: true });

/* Pages 默认走 Jekyll，会把下划线开头的文件当模板私有资源直接丢掉；
   .nojekyll 让它原样发布所有文件，省得哪天加个 _xxx.js 就莫名 404。 */
fs.writeFileSync(path.join(tmp, ".nojekyll"), "");

/* 静态托管标记：告诉页面「这里没有 Node 后端」，别去连 WebSocket、别发 API 探测。
   页面读不到后端时本来可以自己探测，但那次探测本身会在控制台留下一条 404；
   既然发布时就知道是静态站，直接把结论写进去更干净。 */
const MARK = "\n<!-- 静态托管标记，由 publish-gh-pages.mjs 注入 -->\n"
  + "<script>window.LP_STATIC_HOST = true;</script>";
for (const page of ["index.html", "duo.html"]) {
  const f = path.join(tmp, page);
  if (!fs.existsSync(f)) continue;
  const html = fs.readFileSync(f, "utf8");
  if (html.includes("LP_STATIC_HOST")) continue;
  fs.writeFileSync(f, html.replace("</head>", MARK + "\n</head>"));
  step("注入静态托管标记 → " + page);
}

/* 自定义域名：写进 CNAME 文件，GitHub 会自动签证书。
   DNS 那边要自己加一条 CNAME 记录指向 <user>.github.io（脚本管不了 DNS）。 */
if (domain) {
  fs.writeFileSync(path.join(tmp, "CNAME"), domain + "\n");
  console.log("[CNAME] " + domain);
}

/* 离线单文件版是给设计师双击看的，不跟着 Pages 一起发（它本身也没法在浏览器里生成） */
const offline = fs.readdirSync(tmp).filter((f) => f.endsWith("离线版.html"));
console.log("[产物] " + fs.readdirSync(tmp).length + " 个顶层条目"
  + (offline.length ? "，排除离线版 " + offline.length + " 个" : ""));

const git = (args) => run("git", args, tmp);
git(["init", "-q"]);
git(["checkout", "-q", "-b", BRANCH]);
git(["add", "-A"]);

/* 没有改动就别造空提交 */
let status = "";
try {
  status = git(["status", "--porcelain"]).trim();
} catch (e) {
  status = "unknown";
}
git(["commit", "-q", "-m", "发布静态站：" + new Date().toISOString().slice(0, 16).replace("T", " ")]);
const sha = git(["rev-parse", "--short", "HEAD"]).trim();
console.log("[提交] " + sha);

if (dryRun) {
  console.log("\n[dry-run] 未推送。产物在 " + tmp);
  process.exit(0);
}

const remote = run("git", ["remote", "get-url", "origin"], ROOT).trim();
console.log("[推送] → " + remote + " " + BRANCH);
try {
  /* 产物分支每次都是重新生成的整套内容，前后没有需要保留的历史，
     所以 force。别对这个分支做手工改动，会被下一次发布覆盖。 */
  git(["push", "-q", "--force", remote, BRANCH + ":" + BRANCH]);
} catch (e) {
  console.error("\n推送失败：");
  console.error((e.stderr || e.message || "").trim());
  console.error("\n多半是没有推送凭据。见脚本顶部注释里的 GIT_ASKPASS 用法。");
  process.exit(1);
}

console.log("\n已推送 " + sha + " 到 " + BRANCH + " 分支。");
console.log("首次启用 Pages 要在仓库 Settings → Pages 里把 source 选成 " + BRANCH + " 分支；");
console.log("绑自定义域名也是在那个页面填（或带 --domain 跑本脚本写 CNAME 文件）。");
fs.rmSync(tmp, { recursive: true, force: true });
