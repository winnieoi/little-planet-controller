/*
 * 离线把《赛博星球.glb》贴合到《口袋星球》的角色行走球面。
 *
 * 背景：原游戏的碰撞与移动是一个半径恒为 26 的完美球面（WALK_RADIUS）。
 *      而 Tripo 生成的模型地表半径起伏过大（约 16~30），
 *      直接摆放会让角色大面积悬空或陷入地表。
 *
 * 做法：径向「软约束」重映射（radial soft-clamp）
 *   - 以顶点半径中位数为基准，把中位地表对齐到 WALK_RADIUS；
 *   - 对偏离量做单调压缩：小起伏几乎原样保留，大起伏平滑收敛进 RELIEF_MARGIN；
 *   - 单调映射保证网格不自交、拓扑不变；
 *   - 结束后重算法线，并直接把结果写成「最终世界坐标」，
 *     网页端加载后无需任何再计算，直接 scale=1 摆放即可。
 *
 * 用法：node tools/fit-planet.mjs <输入.glb> <输出.glb>
 */

import { readFileSync, writeFileSync } from "node:fs";

/*
 * WALK_RADIUS：原游戏把角色群组原点放在半径 26 的球面上，
 *   实测角色脚底顶点位于半径 26.17 —— 也就是原程序化地表的基准高度。
 *   新模型的中位地表应对齐到这个值，角色才是真正「站在」地面上。
 * RELIEF_MARGIN：允许地表相对基准的最大起伏（角色身高约 1.56）。
 */
const WALK_RADIUS = 26.17;
const RELIEF_MARGIN = 1.0;
const SRC = process.argv[2];
const OUT = process.argv[3];

if (!SRC || !OUT) {
  console.error("用法: node tools/fit-planet.mjs <输入.glb> <输出.glb>");
  process.exit(1);
}

const file = readFileSync(SRC);
if (file.readUInt32LE(0) !== 0x46546c67) throw new Error("不是 GLB 文件");

/* ---- 解析 chunk ---- */
let offset = 12;
let json = null;
let bin = null;
while (offset < file.length) {
  const len = file.readUInt32LE(offset);
  const type = file.readUInt32LE(offset + 4);
  const start = offset + 8;
  if (type === 0x4e4f534a) {
    json = JSON.parse(file.toString("utf8", start, start + len));
  } else if (type === 0x004e4942) {
    bin = Buffer.from(file.subarray(start, start + len));
  }
  offset = start + len + ((4 - (len % 4)) % 4);
}
if (!json || !bin) throw new Error("GLB 缺少 JSON 或 BIN 数据块");

function viewOffset(viewIndex) {
  const view = json.bufferViews[viewIndex];
  return (view.byteOffset || 0);
}

/* ---- 定位访问器 ---- */
const mesh = json.meshes[0];
const prim = mesh.primitives[0];
const posAcc = json.accessors[prim.attributes.POSITION];
const nrmAcc = json.accessors[prim.attributes.NORMAL];
const idxAcc = json.accessors[prim.indices];
if (posAcc.componentType !== 5126) throw new Error("POSITION 不是 float32");
if (nrmAcc.componentType !== 5126) throw new Error("NORMAL 不是 float32");
if (idxAcc.componentType !== 5125) throw new Error("indices 不是 uint32");

const count = posAcc.count;
const posOff = viewOffset(posAcc.bufferView) + (posAcc.byteOffset || 0);
const nrmOff = viewOffset(nrmAcc.bufferView) + (nrmAcc.byteOffset || 0);
const idxOff = viewOffset(idxAcc.bufferView) + (idxAcc.byteOffset || 0);

const positions = new Float32Array(bin.buffer, bin.byteOffset + posOff, count * 3);
const normals = new Float32Array(bin.buffer, bin.byteOffset + nrmOff, count * 3);
const indices = new Uint32Array(bin.buffer, bin.byteOffset + idxOff, idxAcc.count);

console.log(`顶点 ${count}  ·  三角形 ${indices.length / 3}`);

/* ---- 1. 包围盒中心 ---- */
let minX = Infinity, minY = Infinity, minZ = Infinity;
let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
for (let i = 0; i < count; i++) {
  const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
  if (x < minX) minX = x;
  if (y < minY) minY = y;
  if (z < minZ) minZ = z;
  if (x > maxX) maxX = x;
  if (y > maxY) maxY = y;
  if (z > maxZ) maxZ = z;
}
const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
console.log(`原包围盒尺寸 ${(maxX - minX).toFixed(4)} × ${(maxY - minY).toFixed(4)} × ${(maxZ - minZ).toFixed(4)}`);
console.log(`中心 (${cx.toFixed(4)}, ${cy.toFixed(4)}, ${cz.toFixed(4)})`);

/* ---- 2. 半径分布与中位半径 ---- */
const radii = new Float64Array(count);
for (let i = 0; i < count; i++) {
  const x = positions[i * 3] - cx, y = positions[i * 3 + 1] - cy, z = positions[i * 3 + 2] - cz;
  radii[i] = Math.hypot(x, y, z);
}
const sorted = Float64Array.from(radii).sort();
const pick = (p) => sorted[Math.min(count - 1, Math.max(0, Math.floor(p * (count - 1))))];
const base = pick(0.5);
const scale = WALK_RADIUS / base;
const before = { min: pick(0), p25: pick(0.25), p50: base, p75: pick(0.75), max: pick(1) };
console.log("贴合前（换算到 26 世界单位后）:");
console.log(`  min ${(before.min * scale).toFixed(2)}  p25 ${(before.p25 * scale).toFixed(2)}  中位 ${(before.p50 * scale).toFixed(2)}  p75 ${(before.p75 * scale).toFixed(2)}  max ${(before.max * scale).toFixed(2)}`);

/* ---- 3. 径向软约束重映射 ---- */
const margin = RELIEF_MARGIN;
for (let i = 0; i < count; i++) {
  const px = positions[i * 3] - cx, py = positions[i * 3 + 1] - cy, pz = positions[i * 3 + 2] - cz;
  const r = radii[i];
  if (!(r > 1e-9)) continue;
  const d = (r - base) * scale;
  const clamped = Math.sign(d) * margin * (1 - Math.exp(-Math.abs(d) / margin));
  const worldR = WALK_RADIUS + clamped;
  const k = worldR / r;
  positions[i * 3] = px * k;
  positions[i * 3 + 1] = py * k;
  positions[i * 3 + 2] = pz * k;
}

/* ---- 4. 重算法线 ---- */
normals.fill(0);
const ax = new Float64Array(count), ay = new Float64Array(count), az = new Float64Array(count);
for (let t = 0; t < indices.length; t += 3) {
  const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
  const ux = positions[b] - positions[a];
  const uy = positions[b + 1] - positions[a + 1];
  const uz = positions[b + 2] - positions[a + 2];
  const vx = positions[c] - positions[a];
  const vy = positions[c + 1] - positions[a + 1];
  const vz = positions[c + 2] - positions[a + 2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const ia = indices[t], ib = indices[t + 1], ic = indices[t + 2];
  ax[ia] += nx; ay[ia] += ny; az[ia] += nz;
  ax[ib] += nx; ay[ib] += ny; az[ib] += nz;
  ax[ic] += nx; ay[ic] += ny; az[ic] += nz;
}
let nMinX = Infinity, nMinY = Infinity, nMinZ = Infinity;
let nMaxX = -Infinity, nMaxY = -Infinity, nMaxZ = -Infinity;
let pMinX = Infinity, pMinY = Infinity, pMinZ = Infinity;
let pMaxX = -Infinity, pMaxY = -Infinity, pMaxZ = -Infinity;
for (let i = 0; i < count; i++) {
  let nx = ax[i], ny = ay[i], nz = az[i];
  const len = Math.hypot(nx, ny, nz);
  if (len > 1e-9) { nx /= len; ny /= len; nz /= len; } else { nx = 0; ny = 1; nz = 0; }
  normals[i * 3] = nx; normals[i * 3 + 1] = ny; normals[i * 3 + 2] = nz;
  if (nx < nMinX) nMinX = nx;
  if (ny < nMinY) nMinY = ny;
  if (nz < nMinZ) nMinZ = nz;
  if (nx > nMaxX) nMaxX = nx;
  if (ny > nMaxY) nMaxY = ny;
  if (nz > nMaxZ) nMaxZ = nz;
  const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
  if (x < pMinX) pMinX = x;
  if (y < pMinY) pMinY = y;
  if (z < pMinZ) pMinZ = z;
  if (x > pMaxX) pMaxX = x;
  if (y > pMaxY) pMaxY = y;
  if (z > pMaxZ) pMaxZ = z;
}

/* ---- 5. 校验 ---- */
const after = new Float64Array(count);
for (let i = 0; i < count; i++) {
  after[i] = Math.hypot(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
}
const sortedAfter = Float64Array.from(after).sort();
const pickAfter = (p) => sortedAfter[Math.min(count - 1, Math.max(0, Math.floor(p * (count - 1))))];
const res = {
  min: pickAfter(0), p5: pickAfter(0.05), p25: pickAfter(0.25),
  p50: pickAfter(0.5), p75: pickAfter(0.75), p95: pickAfter(0.95), max: pickAfter(1)
};
console.log("贴合后（世界单位，角色行走半径 26）:");
console.log(`  min ${res.min.toFixed(2)}  p5 ${res.p5.toFixed(2)}  p25 ${res.p25.toFixed(2)}  中位 ${res.p50.toFixed(2)}  p75 ${res.p75.toFixed(2)}  p95 ${res.p95.toFixed(2)}  max ${res.max.toFixed(2)}`);
console.log(`  最大偏差 ${Math.max(Math.abs(res.max - WALK_RADIUS), Math.abs(res.min - WALK_RADIUS)).toFixed(2)}（限制 ${margin}）`);

/* ---- 6. 更新 min/max 并写出 ---- */
posAcc.min = [pMinX, pMinY, pMinZ];
posAcc.max = [pMaxX, pMaxY, pMaxZ];
nrmAcc.min = [nMinX, nMinY, nMinZ];
nrmAcc.max = [nMaxX, nMaxY, nMaxZ];

const jsonText = JSON.stringify(json);
const jsonBuf = Buffer.from(jsonText, "utf8");
const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);
const binPad = (4 - (bin.length % 4)) % 4;
const binChunk = Buffer.concat([bin, Buffer.alloc(binPad, 0)]);

const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
const jsonHeader = Buffer.alloc(8);
jsonHeader.writeUInt32LE(jsonChunk.length, 0);
jsonHeader.writeUInt32LE(0x4e4f534a, 4);
const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(binChunk.length, 0);
binHeader.writeUInt32LE(0x004e4942, 4);

writeFileSync(OUT, Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]));
console.log(`\n已输出: ${OUT}`);
console.log(`最终包围盒 ${(pMaxX - pMinX).toFixed(2)} × ${(pMaxY - pMinY).toFixed(2)} × ${(pMaxZ - pMinZ).toFixed(2)}`);
