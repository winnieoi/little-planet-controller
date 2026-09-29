#!/usr/bin/env python3
"""
从 GLB 中导出内嵌贴图（不依赖第三方库）。

用法：python3 tools/extract_images.py <输入.glb> <输出目录>
输出文件名形如  00_<name>.<ext>  ，并打印每张图的名称与体积。
"""

import json
import struct
import sys
from pathlib import Path

src = Path(sys.argv[1])
outdir = Path(sys.argv[2])
outdir.mkdir(parents=True, exist_ok=True)

data = src.read_bytes()
assert data[:4] == b"glTF", "不是 GLB 文件"

offset = 12
json_text = None
bin_data = None
while offset < len(data):
    (length,) = struct.unpack_from("<I", data, offset)
    (ctype,) = struct.unpack_from("<I", data, offset + 4)
    start = offset + 8
    if ctype == 0x4E4F534A:
        json_text = data[start:start + length].decode("utf-8")
    elif ctype == 0x004E4942:
        bin_data = bytearray(data[start:start + length])
    offset = start + length + ((4 - (length % 4)) % 4)

doc = json.loads(json_text.rstrip("\0 \t\r\n"))
views = doc["bufferViews"]
images = doc.get("images", [])

if not images:
    print("模型内没有内嵌贴图")
    sys.exit(0)

MAGIC_EXT = {b"\xff\xd8\xff": "jpg", b"\x89PNG": "png", b"RIFF": "webp"}

print(f"共 {len(images)} 张贴图：")
for idx, img in enumerate(images):
    bv = img.get("bufferView")
    if bv is None:
        continue
    start = views[bv].get("byteOffset", 0)
    length = views[bv]["byteLength"]
    raw = bytes(bin_data[start:start + length])
    ext = "jpg"
    for magic, e in MAGIC_EXT.items():
        if raw[:4].startswith(magic):
            ext = e
            break
    name = (img.get("name") or f"image{idx}").replace("/", "_")
    path = outdir / f"{idx:02d}_{name}.{ext}"
    path.write_bytes(raw)
    print(f"  [{idx}] {name:<28} {len(raw) / 1048576:6.2f} MB  -> {path}")
