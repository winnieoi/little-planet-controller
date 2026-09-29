#!/usr/bin/env python3
"""
把赛博星球的夜景 basecolor 贴图改造成「白天版」候选。

关键在于不能只提亮 —— 原贴图是高饱和的紫/品红夜景，单纯提亮只会得到
一团粉色噪点。这里走的是「去噪 → HSV 域重新配光 → 回写」的路线：

  1. 轻度去噪：压缩 JPEG 暗部噪点，否则一提亮全是颗粒；
  2. 降饱和 + 封顶：把霓虹紫的饱和度压到日光级别，并设上限，
     这是让画面从「夜店霓虹」变成「白天建筑」的关键一步；
  3. 色相偏移：紫色往青蓝方向挪，离开品红区；
  4. 提亮：只抬明度，且用幂律抬暗部，避免高光过曝。

用法：python3 tools/daylight_texture.py <basecolor 路径> <输出目录> <对比图路径>
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageStat

src = Path(sys.argv[1])
outdir = Path(sys.argv[2])
out_png = Path(sys.argv[3])
outdir.mkdir(parents=True, exist_ok=True)

base = Image.open(src).convert("RGB")
print(f"贴图尺寸 {base.size[0]}x{base.size[1]}")
st = ImageStat.Stat(base)
print(f"原始: 均值 R{st.mean[0]:.0f} G{st.mean[1]:.0f} B{st.mean[2]:.0f}  亮度 {(sum(st.mean) / 3):.0f}")


def rgb_to_hsv(a):
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mx = np.max(a, axis=-1)
    mn = np.min(a, axis=-1)
    d = mx - mn
    h = np.zeros_like(mx)
    nz = d > 1e-6
    idx = nz & (mx == r)
    h[idx] = ((g - b)[idx] / d[idx]) % 6
    idx = nz & (mx == g)
    h[idx] = ((b - r)[idx] / d[idx]) + 2
    idx = nz & (mx == b)
    h[idx] = ((r - g)[idx] / d[idx]) + 4
    h = h * 60.0
    s = np.where(mx > 1e-6, d / np.maximum(mx, 1e-6), 0.0)
    return h, s, mx


def hsv_to_rgb(h, s, v):
    h = (h % 360.0) / 60.0
    c = v * s
    x = c * (1 - np.abs(h % 2 - 1))
    m = v - c
    z = np.zeros_like(c)
    cond = [h < 1, h < 2, h < 3, h < 4, h < 5]
    rr = np.select(cond, [c, x, z, z, x], default=c)
    gg = np.select(cond, [x, c, c, x, z], default=z)
    bb = np.select(cond, [z, z, x, c, c], default=x)
    return np.stack([rr + m, gg + m, bb + m], axis=-1)


def daylight(img, v_gain, s_scale, s_cap, hue_shift, denoise, warmth=0.0):
    arr = np.asarray(img).astype(np.float32) / 255.0
    if denoise > 0:
        blurred = np.asarray(img.filter(ImageFilter.GaussianBlur(denoise))).astype(np.float32) / 255.0
        arr = arr * (1 - denoise * 0.55) + blurred * (denoise * 0.55)
    h, s, v = rgb_to_hsv(arr)
    h = h + hue_shift
    s = np.clip(s * s_scale, 0, s_cap)
    v = np.clip(v * v_gain, 0, 1) ** 0.92
    out = np.clip(hsv_to_rgb(h, s, v), 0, 1)
    if warmth:
        out[..., 0] = np.clip(out[..., 0] * (1 + warmth), 0, 1)
        out[..., 2] = np.clip(out[..., 2] * (1 - warmth * 0.7), 0, 1)
    return Image.fromarray((out * 255).round().astype(np.uint8))


# 三套候选：v_gain 明度增益 / s_scale 饱和度系数 / s_cap 饱和度上限 / hue_shift 色相偏移 / denoise 去噪强度
presets = [
    ("A 清晨微冷", 1.60, 0.52, 0.34, -26, 0.7, 0.00),
    ("B 正午晴日", 1.95, 0.46, 0.30, -34, 0.9, 0.01),
    ("C 午后暖阳", 1.75, 0.58, 0.36, -20, 0.8, 0.06),
]

results = []
for name, vg, ss, sc, hs, dn, wm in presets:
    img = daylight(base, vg, ss, sc, hs, dn, wm)
    lm = sum(ImageStat.Stat(img).mean) / 3
    slug = name.split()[0]
    path = outdir / f"daylight_{slug}.jpg"
    img.save(path, quality=92)
    print(f"  {name}: 结果亮度 {lm:.0f}  -> {path.name}")
    results.append((name, img, lm))

# ---- 对比预览 ----
CELL, PAD, LABEL, cols = 520, 24, 48, 2
rows = 2
pw = CELL * cols + PAD * (cols + 1)
ph = (CELL + LABEL) * rows + PAD * (rows + 1)
canvas = Image.new("RGB", (pw, ph), (18, 20, 26))
d = ImageDraw.Draw(canvas)
try:
    f1 = ImageFont.truetype("/System/Library/Fonts/PingFang.ttc", 22)
    f2 = ImageFont.truetype("/System/Library/Fonts/PingFang.ttc", 15)
except Exception:
    f1 = f2 = ImageFont.load_default()

panels = [("原版 · 赛博夜景", base, sum(st.mean) / 3)] + results
for i, (title, img, lm) in enumerate(panels):
    cx = PAD + (i % cols) * (CELL + PAD)
    cy = PAD + (i // cols) * (CELL + LABEL + PAD)
    thumb = img.copy()
    thumb.thumbnail((CELL, CELL), Image.LANCZOS)
    canvas.paste(thumb, (cx + (CELL - thumb.width) // 2, cy + (CELL - thumb.height) // 2))
    d.text((cx, cy + CELL + 6), title, font=f1, fill=(238, 240, 248))
    d.text((cx + 320, cy + CELL + 12), f"亮度 {lm:.0f}", font=f2, fill=(140, 148, 168))

canvas.save(out_png)
print(f"\n对比图: {out_png}")
