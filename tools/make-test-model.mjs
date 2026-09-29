/*
 * 从贴合后的完整模型中抽取一小块，生成一个极小测试用 GLB。
 * 仅用于在本机内存受限的环境下验证「加载 → 隐藏原星球 → 入场景」链路，
 * 交付时使用的仍是完整模型。
 *
 * 用法：node tools/make-test-model.mjs <完整.glb> <输出.glb> [最大顶点数] [最多三角面]
 */

import { readFileSync, writeFileSync } from "node:fs";

const SRC = process.argv[2];
const OUT = process.argv[3];
const MAX_VERT = Number(process.argv[4] || 20000);
const MAX_TRIS = Number(process.argv[5] || 20000);

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
const posAcc = json.accessors[prim.attributes.POSITION];
const nrmAcc = json.accessors[prim.attributes.NORMAL];
const uvAcc = json.accessors[prim.attributes.TEXCOORD_0];
const idxAcc = json.accessors[prim.indices];

const vOff = (a) => (json.bufferViews[a.bufferView].byteOffset || 0) + (a.byteOffset || 0);
const positions = new Float32Array(bin.buffer, bin.byteOffset + vOff(posAcc), posAcc.count * 3);
const normals = new Float32Array(bin.buffer, bin.byteOffset + vOff(nrmAcc), nrmAcc.count * 3);
const uvs = new Float32Array(bin.buffer, bin.byteOffset + vOff(uvAcc), uvAcc.count * 2);
const indices = new Uint32Array(bin.buffer, bin.byteOffset + vOff(idxAcc), idxAcc.count);

/* 抽取索引较小的三角形，构成星球表面的一小块 */
const tris = [];
for (let t = 0; t < indices.length && tris.length < MAX_TRIS * 3; t += 3) {
  const a = indices[t], b = indices[t + 1], c = indices[t + 2];
  if (a < MAX_VERT && b < MAX_VERT && c < MAX_VERT) tris.push(a, b, c);
}
console.log(`抽取三角面 ${tris.length / 3}`);

/* 压缩到实际使用到的顶点 */
const used = new Map();
const remap = new Map();
for (const i of tris) {
  if (!used.has(i)) {
    const n = used.size;
    used.set(i, n);
    remap.set(i, n);
  }
}
const vCount = used.size;
console.log(`实际顶点 ${vCount}`);

const out = {
  asset: { version: "2.0", generator: "little-planet test subset" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, name: "CyberPlanetTest" }],
  meshes: [{ name: "test", primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
  materials: [{ name: "test", pbrMetallicRoughness: { baseColorFactor: [0.6, 0.45, 0.9, 1], metallicFactor: 0.1, roughnessFactor: 0.8 } }],
  accessors: [],
  bufferViews: [],
  buffers: [{ byteLength: 0 }]
};

const chunks = [];
let cursor = 0;
function push(typed) {
  const pad = (4 - (cursor % 4)) % 4;
  if (pad) { chunks.push(Buffer.alloc(pad)); cursor += pad; }
  const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
  chunks.push(buf);
  const view = { buffer: 0, byteOffset: cursor, byteLength: buf.length };
  cursor += buf.length;
  return view;
}

const posOut = new Float32Array(vCount * 3);
const nrmOut = new Float32Array(vCount * 3);
const uvOut = new Float32Array(vCount * 2);
const idxOut = new Uint32Array(tris.length);
for (const [oldIdx, newIdx] of used) {
  posOut[newIdx * 3] = positions[oldIdx * 3];
  posOut[newIdx * 3 + 1] = positions[oldIdx * 3 + 1];
  posOut[newIdx * 3 + 2] = positions[oldIdx * 3 + 2];
  nrmOut[newIdx * 3] = normals[oldIdx * 3];
  nrmOut[newIdx * 3 + 1] = normals[oldIdx * 3 + 1];
  nrmOut[newIdx * 3 + 2] = normals[oldIdx * 3 + 2];
  uvOut[newIdx * 2] = uvs[oldIdx * 2];
  uvOut[newIdx * 2 + 1] = uvs[oldIdx * 2 + 1];
}
for (let i = 0; i < tris.length; i++) idxOut[i] = used.get(tris[i]);

function minMax(arr, stride) {
  const mn = new Array(stride).fill(Infinity);
  const mx = new Array(stride).fill(-Infinity);
  for (let i = 0; i < arr.length; i += stride) {
    for (let k = 0; k < stride; k++) {
      if (arr[i + k] < mn[k]) mn[k] = arr[i + k];
      if (arr[i + k] > mx[k]) mx[k] = arr[i + k];
    }
  }
  return [mn, mx];
}

const posView = push(posOut);
const [pmin, pmax] = minMax(posOut, 3);
out.accessors.push({ bufferView: 0, componentType: 5126, count: vCount, type: "VEC3", min: pmin, max: pmax });
const nrmView = push(nrmOut);
const [nmin, nmax] = minMax(nrmOut, 3);
out.accessors.push({ bufferView: 1, componentType: 5126, count: vCount, type: "VEC3", min: nmin, max: nmax });
const uvView = push(uvOut);
const [umin, umax] = minMax(uvOut, 2);
out.accessors.push({ bufferView: 2, componentType: 5126, count: vCount, type: "VEC2", min: umin, max: umax });
const idxView = push(idxOut);
out.accessors.push({ bufferView: 3, componentType: 5125, count: idxOut.length, type: "SCALAR", min: [0], max: [vCount - 1] });

out.bufferViews = [posView, nrmView, uvView, idxView];
out.bufferViews[0].target = 34962;
const binBuf = Buffer.concat(chunks);
const binPad = (4 - (binBuf.length % 4)) % 4;
const binChunk = Buffer.concat([binBuf, Buffer.alloc(binPad)]);
out.buffers[0].byteLength = binChunk.length;

const jsonBuf = Buffer.from(JSON.stringify(out), "utf8");
const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);

const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonChunk.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
const bh = Buffer.alloc(8); bh.writeUInt32LE(binChunk.length, 0); bh.writeUInt32LE(0x004e4942, 4);

writeFileSync(OUT, Buffer.concat([header, jh, jsonChunk, bh, binChunk]));
console.log(`已写出 ${OUT}  ${(binChunk.length / 1024).toFixed(0)} KB`);
