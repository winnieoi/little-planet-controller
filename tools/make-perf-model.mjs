/* 生成一个"像 Tripo 输出"的高面数建筑 GLB，用于性能压测。
   结构：塔身（圆柱）+ 锥顶，uint32 索引 + 法线 + UV + PBR 材质，
   面数尽量贴近 face_limit=8000。 */
import fs from "node:fs";

const TARGET_TRIS = Number(process.argv[3] || 8000);
const OUT = process.argv[2] || "/tmp/perf.glb";

const verts = [];
const norms = [];
const uvs = [];
const idx = [];

function pushTri(a, b, c, na, nb, nc, uva, uvb, uvc) {
  const base = verts.length / 3;
  for (const v of [a, b, c]) verts.push(v[0], v[1], v[2]);
  for (const n of [na, nb, nc]) norms.push(n[0], n[1], n[2]);
  for (const u of [uva, uvb, uvc]) uvs.push(u[0], u[1]);
  idx.push(base, base + 1, base + 2);
}

/* 塔身：圆柱，按面数反推分段数 */
const towerTris = Math.floor(TARGET_TRIS * 0.7);
const radial = Math.max(6, Math.floor(towerTris / 2 / 2)); // 每段 2 个三角 × 上下
const heightSteps = 2;
for (let i = 0; i < radial; i++) {
  const a0 = (i / radial) * Math.PI * 2;
  const a1 = ((i + 1) / radial) * Math.PI * 2;
  for (let h = 0; h < heightSteps; h++) {
    const y0 = (h / heightSteps) * 1.0;
    const y1 = ((h + 1) / heightSteps) * 1.0;
    const r0 = 0.5 * (1 - 0.15 * (h / heightSteps));
    const r1 = 0.5 * (1 - 0.15 * ((h + 1) / heightSteps));
    const p = (a, y, r) => [Math.cos(a) * r, y, Math.sin(a) * r];
    const n = (a) => [Math.cos(a), 0, Math.sin(a)];
    const u = (i, h) => [i / radial, h / heightSteps];
    pushTri(p(a0, y0, r0), p(a1, y0, r0), p(a1, y1, r1), n(a0), n(a1), n(a1),
      u(i, h), u(i + 1, h), u(i + 1, h + 1));
    pushTri(p(a0, y0, r0), p(a1, y1, r1), p(a0, y1, r1), n(a0), n(a1), n(a0),
      u(i, h), u(i + 1, h + 1), u(i, h + 1));
  }
}

/* 锥顶 */
const apex = [0, 1.45, 0];
for (let i = 0; i < radial; i++) {
  const a0 = (i / radial) * Math.PI * 2;
  const a1 = ((i + 1) / radial) * Math.PI * 2;
  const r = 0.425;
  const p = (a) => [Math.cos(a) * r, 1.0, Math.sin(a) * r];
  const nb = [0, 1, 0];
  pushTri(p(a0), p(a1), apex, nb, nb, [Math.cos((a0 + a1) / 2), 0.6, Math.sin((a0 + a1) / 2)],
    [i / radial, 0], [(i + 1) / radial, 0], [(i + 0.5) / radial, 1]);
}

const min = [Infinity, Infinity, Infinity];
const max = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < verts.length; i += 3) {
  for (let k = 0; k < 3; k++) {
    const v = verts[i + k];
    if (v < min[k]) min[k] = v;
    if (v > max[k]) max[k] = v;
  }
}

const posArr = new Float32Array(verts);
const nrmArr = new Float32Array(norms);
const uvArr = new Float32Array(uvs);
const idxArr = new Uint32Array(idx);

const chunks = [
  { name: "pos", buf: Buffer.from(posArr.buffer, posArr.byteOffset, posArr.byteLength) },
  { name: "nrm", buf: Buffer.from(nrmArr.buffer, nrmArr.byteOffset, nrmArr.byteLength) },
  { name: "uv", buf: Buffer.from(uvArr.buffer, uvArr.byteOffset, uvArr.byteLength) },
  { name: "idx", buf: Buffer.from(idxArr.buffer, idxArr.byteOffset, idxArr.byteLength) }
];
const bufferViews = [];
let off = 0;
for (const c of chunks) {
  bufferViews.push({ buffer: 0, byteOffset: off, byteLength: c.buf.length });
  off += c.buf.length;
}
const bin = Buffer.alloc(off);
let cur = 0;
for (const c of chunks) {
  c.buf.copy(bin, cur);
  cur += c.buf.length;
}

const gltf = {
  asset: { version: "2.0", generator: "little-planet-perf" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, name: "PerfTower" }],
  meshes: [{
    name: "PerfTower",
    primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }]
  }],
  materials: [{
    name: "Tower",
    pbrMetallicRoughness: { baseColorFactor: [0.72, 0.66, 0.55, 1], metallicFactor: 0, roughnessFactor: 0.85 }
  }],
  accessors: [
    { bufferView: 0, componentType: 5126, count: posArr.length / 3, type: "VEC3", min, max },
    { bufferView: 1, componentType: 5126, count: nrmArr.length / 3, type: "VEC3" },
    { bufferView: 2, componentType: 5126, count: uvArr.length / 2, type: "VEC2" },
    { bufferView: 3, componentType: 5125, count: idxArr.length, type: "SCALAR" }
  ],
  bufferViews,
  buffers: [{ byteLength: bin.length }]
};

let jsonStr = JSON.stringify(gltf);
let jsonBuf = Buffer.from(jsonStr, "utf8");
const pad = (4 - (jsonBuf.length % 4)) % 4;
if (pad) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(pad, 0x20)]);
const binPad = (4 - (bin.length % 4)) % 4;
const binFinal = binPad ? Buffer.concat([bin, Buffer.alloc(binPad)]) : bin;

const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
const total = 12 + 8 + jsonBuf.length + 8 + binFinal.length;
header.writeUInt32LE(total, 8);

const jsonHeader = Buffer.alloc(8);
jsonHeader.writeUInt32LE(jsonBuf.length, 0);
jsonHeader.writeUInt32LE(0x4e4f534a, 4);

const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(binFinal.length, 0);
binHeader.writeUInt32LE(0x004e4942, 4);

fs.writeFileSync(OUT, Buffer.concat([header, jsonHeader, jsonBuf, binHeader, binFinal]));
console.log("写出", OUT, "三角面", idxArr.length / 3, "顶点", posArr.length / 3, "大小", (total / 1024).toFixed(1), "KB");
