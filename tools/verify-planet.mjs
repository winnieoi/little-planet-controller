/*
 * 校验交付用的 GLB 是否已经贴合到角色行走球面。
 * 只做测量，不修改文件。
 *
 * 用法：node tools/verify-planet.mjs <模型.glb> [角色行走半径]
 */

import { readFileSync } from "node:fs";

const SRC = process.argv[2];
const WALK = Number(process.argv[3] || 26);

const file = readFileSync(SRC);
let offset = 12;
let json = null;
let bin = null;
while (offset < file.length) {
  const len = file.readUInt32LE(offset);
  const type = file.readUInt32LE(offset + 4);
  const start = offset + 8;
  if (type === 0x4e4f534a) json = JSON.parse(file.toString("utf8", start, start + len));
  else if (type === 0x004e4942) bin = Buffer.from(file.subarray(start, start + len));
  offset = start + len + ((4 - (len % 4)) % 4);
}

const prim = json.meshes[0].primitives[0];
const acc = json.accessors[prim.attributes.POSITION];
const off = (json.bufferViews[acc.bufferView].byteOffset || 0) + (acc.byteOffset || 0);
const positions = new Float32Array(bin.buffer, bin.byteOffset + off, acc.count * 3);
const count = acc.count;

const radii = new Float64Array(count);
for (let i = 0; i < count; i++) {
  radii[i] = Math.hypot(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
}
const sorted = Float64Array.from(radii).sort();
const pick = (p) => sorted[Math.min(count - 1, Math.max(0, Math.floor(p * (count - 1))))];

const stats = {
  min: pick(0), p5: pick(0.05), p25: pick(0.25),
  p50: pick(0.5), p75: pick(0.75), p95: pick(0.95), max: pick(1)
};
const bound = Math.max(Math.abs(stats.max - WALK), Math.abs(stats.min - WALK));

console.log(`模型: ${SRC}`);
console.log(`顶点 ${count}`);
console.log(`角色行走半径: ${WALK}`);
console.log("地表半径分布（世界单位）:");
for (const [k, v] of Object.entries(stats)) {
  console.log(`  ${k.padEnd(4)} ${v.toFixed(2)}   偏差 ${(v - WALK >= 0 ? "+" : "") + (v - WALK).toFixed(2)}`);
}
console.log(`\n最大偏差 ${bound.toFixed(2)}  —— 角色身高约 1.56，因此悬空/陷入不超过 ${(bound / 1.56 * 100).toFixed(0)}% 身高`);
console.log(bound <= 1.35 ? "结论: 贴合合格" : "结论: 偏差偏大，需要重新贴合");
