/*
 * 给游戏本体副本加「场景钩子」，供外部集成层取用场景与角色。
 *
 * 背景：
 *   赛博星球副本（assets/index-cyber-*.js）里有一行官方原文件没有的钩子：
 *       window.__LP_SCENE__ = <Scene>; window.__LP_WORLD__ = <World>;
 *   集成层靠它拿到 THREE.Scene 与包含 player 的世界对象。
 *   原版星球（夜晚 / 白天）用的是官方原文件，没有这个钩子，
 *   所以「用 Tripo 生成建筑并摆到星球上」这类需要场景的功能在原版星球上拿不到句柄。
 *
 *   本脚本不改官方原文件，只生成一个带钩子的副本（与白天版、赛博版同样的做法：
 *   副本资源，本体零改动）。
 *
 * 用法：node tools/add-lp-hook.mjs <输入.js> <输出.js>
 */

import { readFileSync, writeFileSync } from "node:fs";

const SRC = process.argv[2];
const OUT = process.argv[3];

if (!SRC || !OUT) {
  console.error("用法: node tools/add-lp-hook.mjs <输入.js> <输出.js>");
  process.exit(1);
}

/* 锚点：世界对象构造完成后、玩家句柄赋值前。
   官方原文件：  ...R=on(Ce,tn(Ce)),Ne=R.player...
   赛博版副本：  ...R=on(Ce,tn(Ce));window.__LP_SCENE__=Ce;window.__LP_WORLD__=R;const Ne=R.player...
   本脚本产出的就是后者，字符数与赛博版完全一致（+51 字节）。 */
const FROM = "R=on(Ce,tn(Ce)),Ne=R.player";
const TO = "R=on(Ce,tn(Ce));window.__LP_SCENE__=Ce;window.__LP_WORLD__=R;const Ne=R.player";

const code = readFileSync(SRC, "utf8");

if (code.includes("__LP_SCENE__")) {
  console.log("已含钩子，原样复制:", SRC);
  writeFileSync(OUT, code);
  process.exit(0);
}

const count = code.split(FROM).length - 1;
if (count !== 1) {
  console.error(`锚点匹配 ${count} 次（应为 1），游戏本体可能已更新，请核对 tools/add-lp-hook.mjs`);
  process.exit(1);
}

const out = code.replace(FROM, TO);
writeFileSync(OUT, out);
console.log(`已生成: ${OUT}  (${code.length} → ${out.length} 字节, +${out.length - code.length})`);
