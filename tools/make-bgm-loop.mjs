/*
 * 从视频/音频里扒出背景音乐，做成一个「能无限循环且听不出接缝」的音频文件。
 *
 *   node tools/make-bgm-loop.mjs ~/Desktop/spider_bgm_scifi_1min.mp4
 *   -> web/bgm/bgm-loop.ogg   （主用，Vorbis 本身无编码器延迟，循环真无缝）
 *   -> web/bgm/bgm-loop.mp3   （兜底，Safari 等不放 ogg 的浏览器）
 *
 * 为什么不能直接 loop 原文件：
 *   1. 结尾有淡出（最后 2 秒电平掉到 -51dB），直接循环会每轮"喘一口气"；
 *   2. 就算切掉淡出，结尾一个采样接到开头一个采样，波形不连续 = 每轮"咔哒"一声。
 *
 * 做法：找一个频谱上"接得上"的循环点 T，再把 T 之后的 F 秒交叉淡化回开头。
 *   成品 O 长度 = T，其中
 *     O[i] = A[T+i]·cos(πi/2F) + A[i]·sin(πi/2F)   （i < F，尾段混进头部）
 *     O[i] = A[i]                                   （i ≥ F）
 *   于是接缝处 O[T-1] = A[T-1] → O[0] = A[T]，本来就是连续的下一段，天然无断点；
 *   开头 F 秒是"尾+头"的等功率混合，听着是平滑过渡。
 *
 * 循环点怎么选：氛围电子乐的典型情况是"包络循环但音符不完全重复"——
 * 波形级互相关普遍只有 0.2 左右，根本不存在采样级完美接点。所以改用
 * 32 个对数频带的能量指纹算余弦相似度：只要和声/音色对得上（>0.99），
 * 交叉淡化就听不出来。这一点踩过坑，别再用波形相关去挑。
 *
 * 可选参数：
 *   --start <秒>   跳过开头的起拍（默认自动：跳过开头的安静段）
 *   --at <秒>      直接指定循环点，跳过搜索
 *   --fade <秒>    交叉淡化长度（默认 3）
 *   --out <路径>   输出前缀（默认 web/bgm/bgm-loop）
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const opt = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 ? argv[i + 1] : dflt;
};
if (!positional.length) {
  console.error("用法: node tools/make-bgm-loop.mjs <视频或音频文件> [--at 53] [--fade 3]");
  process.exit(1);
}
const INPUT = path.resolve(positional[0]);
const FADE = Number(opt("fade", 3));
const OUT = path.resolve(opt("out", path.join(ROOT, "web/bgm/bgm-loop")));
const FORCED_AT = opt("at", null) ? Number(opt("at", null)) : null;
const FORCED_START = opt("start", null) ? Number(opt("start", null)) : null;

const TMP = fs.mkdtempSync("/tmp/bgm-loop-");
const WAV = path.join(TMP, "src.wav");

/* ---------- 1. 抽音轨 ---------- */
console.log("抽音轨: " + path.basename(INPUT));
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", INPUT, "-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", WAV], { stdio: "inherit" });

/* ---------- 2. 读 WAV（只认 16bit PCM，ffmpeg 出来的就是这个） ---------- */
const buf = fs.readFileSync(WAV);
if (buf.toString("ascii", 0, 4) !== "RIFF") throw new Error("不是 RIFF WAV");
let fmt = null, data = null, off = 12;
while (off + 8 <= buf.length) {
  const id = buf.toString("ascii", off, off + 4);
  const sz = buf.readUInt32LE(off + 4);
  const body = off + 8;
  if (id === "fmt ") fmt = { ch: buf.readUInt16LE(body + 2), sr: buf.readUInt32LE(body + 4) };
  if (id === "data") data = { start: body, len: sz };
  off = body + sz + (sz % 2);
}
const SR = fmt.sr, CH = fmt.ch, FRAMES = data.len / 2 / CH;
const L = new Float32Array(FRAMES);
const R = new Float32Array(FRAMES);
for (let i = 0; i < FRAMES; i++) {
  L[i] = buf.readInt16LE(data.start + i * CH * 2) / 32768;
  R[i] = buf.readInt16LE(data.start + (i * CH + 1) * 2) / 32768;
}
const mono = new Float32Array(FRAMES);
for (let i = 0; i < FRAMES; i++) mono[i] = (L[i] + R[i]) / 2;
console.log("  " + (FRAMES / SR).toFixed(2) + " 秒 / " + SR + " Hz / " + CH + " 声道");

/* ---------- 3. 频谱指纹（找循环点用） ---------- */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}
const N = 2048, BANDS = 32;
const EDGES = [];
for (let b = 0; b <= BANDS; b++) EDGES.push(Math.floor((N / 2) ** (b / BANDS)));

function fingerprint(from, len) {
  const bands = new Float64Array(BANDS);
  let count = 0;
  for (let p = 0; p + N <= len; p += N) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = mono[from + p + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
    fft(re, im);
    for (let b = 0; b < BANDS; b++) {
      let acc = 0;
      const a = Math.max(1, EDGES[b]), z = Math.min(N / 2, Math.max(a + 1, EDGES[b + 1]));
      for (let i = a; i < z; i++) acc += Math.hypot(re[i], im[i]);
      bands[b] += acc;
    }
    count++;
  }
  for (let b = 0; b < BANDS; b++) bands[b] = Math.log10(bands[b] / Math.max(1, count) + 1e-9);
  return bands;
}
function cosSim(a, b) {
  let ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; }
  ma /= a.length; mb /= b.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return num / (Math.sqrt(da * db) + 1e-12);
}
function rmsAt(from, len) {
  let acc = 0;
  for (let i = 0; i < len; i++) acc += mono[from + i] ** 2;
  return Math.sqrt(acc / len);
}
const db = (v) => 20 * Math.log10(v + 1e-9);

/* ---------- 4. 定起点：跳过开头那段明显更安静的起拍 ---------- */
const START = FORCED_START !== null
  ? Math.floor(FORCED_START * SR)
  : (() => {
      const win = Math.floor(0.5 * SR);
      const overall = rmsAt(0, Math.min(FRAMES, Math.floor(10 * SR)));
      let s = 0;
      for (; s + win < FRAMES; s += Math.floor(0.05 * SR)) {
        if (db(rmsAt(s, win)) >= db(overall) - 3) break;
      }
      return s;
    })();
console.log("  起点 " + (START / SR).toFixed(2) + "s（跳过起拍）");

/* ---------- 5. 定循环点 ---------- */
const F = Math.floor(FADE * SR);
/* 结尾淡出区不参与：找最后 2.5 秒里电平掉得最狠的位置，从那儿往前切 */
const END = (() => {
  let e = FRAMES;
  const win = Math.floor(0.4 * SR);
  const ref = rmsAt(Math.floor(FRAMES * 0.5), win);
  for (let t = FRAMES - win; t > FRAMES * 0.5; t -= win) {
    if (db(rmsAt(t, win)) > db(ref) - 8) { e = t + win; break; }
  }
  return e;
})();
console.log("  可用到 " + (END / SR).toFixed(2) + "s（之后是淡出）");

const head = fingerprint(START, F);
const headDb = db(rmsAt(START, F));

let at;
if (FORCED_AT !== null) {
  at = Math.floor(FORCED_AT * SR);
} else {
  const minLoop = Math.floor(15 * SR);
  const rows = [];
  for (let t = minLoop; t + F < END; t += Math.floor(0.25 * SR)) {
    const spec = cosSim(head, fingerprint(t, F));
    const level = Math.abs(db(rmsAt(t, F)) - headDb);
    /* 频谱像（主） + 电平差小 + 循环尽量长（避免几秒就重复一遍） */
    const score = spec * 0.6 + (1 - Math.min(level, 8) / 8) * 0.25 + (t / FRAMES) * 0.15;
    rows.push({ t, spec, level, score });
  }
  rows.sort((a, b) => b.score - a.score);
  console.log("  候选循环点前 5:");
  for (const r of rows.slice(0, 5)) {
    console.log("    " + (r.t / SR).toFixed(2) + "s  频谱相似 " + r.spec.toFixed(3) + "  电平差 " + r.level.toFixed(1) + "dB");
  }
  at = rows[0].t;
}
const T = at;
console.log("  循环点 " + (T / SR).toFixed(2) + "s  频谱相似 " + cosSim(head, fingerprint(T, F)).toFixed(3));
if (START + T + F >= FRAMES) throw new Error("循环点 + 交叉淡化长度超出音轨，减小 --fade 或换 --at");

/* ---------- 6. 交叉淡化：把尾段混回开头 ---------- */
function buildChannel(A) {
  const O = new Float32Array(T);
  for (let i = 0; i < T; i++) {
    if (i < F) {
      const w = (Math.PI / 2) * (i / F);       // 等功率，避免中间凹陷
      O[i] = A[START + T + i] * Math.cos(w) + A[START + i] * Math.sin(w);
    } else {
      O[i] = A[START + i];
    }
  }
  return O;
}
const OL = buildChannel(L), OR = buildChannel(R);

/* 接缝体检：跳变幅度要和普通相邻采样差不多，否则就是还有"咔哒" */
function seamReport(O) {
  const jump = Math.abs(O[0] - O[T - 1]);
  let acc = 0;
  for (let i = 1; i < Math.min(T, SR); i++) acc += Math.abs(O[i] - O[i - 1]);
  const avg = acc / Math.min(T - 1, SR - 1);
  return { jump, avg, ratio: jump / (avg + 1e-12) };
}
const seam = seamReport(OL);
console.log("  接缝跳变 " + seam.jump.toFixed(5) + " / 相邻采样均值 " + seam.avg.toFixed(5) + " → 比值 " + seam.ratio.toFixed(2));
if (seam.ratio > 6) console.warn("  ⚠️ 接缝跳变明显大于常规采样间跳变，可能需要换循环点或加长 --fade");

/* ---------- 7. 写 WAV ---------- */
const loopWav = path.join(TMP, "loop.wav");
const bytes = T * CH * 2;
const out = Buffer.alloc(44 + bytes);
out.write("RIFF", 0); out.writeUInt32LE(36 + bytes, 4); out.write("WAVE", 8);
out.write("fmt ", 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20);
out.writeUInt16LE(CH, 22); out.writeUInt32LE(SR, 24); out.writeUInt32LE(SR * CH * 2, 28);
out.writeUInt16LE(CH * 2, 32); out.writeUInt16LE(16, 34);
out.write("data", 36); out.writeUInt32LE(bytes, 40);
const clip = (v) => Math.max(-1, Math.min(1, v));
for (let i = 0; i < T; i++) {
  out.writeInt16LE(Math.round(clip(OL[i]) * 32767), 44 + i * CH * 2);
  out.writeInt16LE(Math.round(clip(OR[i]) * 32767), 44 + i * CH * 2 + 2);
}
fs.writeFileSync(loopWav, out);

/* ---------- 8. 编码 ---------- */
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const ogg = OUT + ".ogg";
const mp3 = OUT + ".mp3";
/* 目标 -20 LUFS：背景音乐不宜太吵，也不至于被环境盖住 */
const norm = "loudnorm=I=-20:TP=-1.5:LRA=11";
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", loopWav, "-af", norm, "-c:a", "libvorbis", "-q:a", "5", ogg], { stdio: "inherit" });
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", loopWav, "-af", norm, "-c:a", "libmp3lame", "-b:a", "128k", mp3], { stdio: "inherit" });

const kb = (p) => (fs.statSync(p).size / 1024).toFixed(0) + " KB";
console.log("\n已生成");
console.log("  " + path.relative(ROOT, ogg) + "  " + kb(ogg));
console.log("  " + path.relative(ROOT, mp3) + "  " + kb(mp3));
console.log("  循环长度 " + (T / SR).toFixed(2) + " 秒 · 交叉淡化 " + FADE + " 秒");
fs.rmSync(TMP, { recursive: true, force: true });
