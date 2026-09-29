#!/usr/bin/env python3
"""
压缩 GLB 内嵌贴图（不依赖第三方库，使用 macOS 自带 sips）。

4096×4096 的三张贴图在 GPU 上约占 190MB，是浏览器渲染进程崩溃的主因。
这里把它们降到指定边长，并重写 GLB 的缓冲区分块。

用法：python3 tools/shrink_textures.py <输入.glb> <输出.glb> [边长]
"""

import json
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

src = Path(sys.argv[1])
out = Path(sys.argv[2])
size = int(sys.argv[3]) if len(sys.argv) > 3 else 2048

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

tmp = Path(tempfile.mkdtemp())
new_images = []
for img in images:
    bv = img.get("bufferView")
    if bv is None:
        continue
    start = views[bv].get("byteOffset", 0)
    length = views[bv]["byteLength"]
    raw = bytes(bin_data[start:start + length])
    magic = raw[:4]
    ext = "jpg"
    for m, e in MAGIC_EXT.items():
        if magic.startswith(m):
            ext = e
            break
    src_path = tmp / f"src_{bv}.{ext}"
    src_path.write_bytes(raw)
    # 法线贴图保持 PNG 以免丢失精度，其余转 JPEG
    keep_png = "normal" in (img.get("name") or "").lower()
    dst_ext = "png" if keep_png else "jpg"
    dst_path = tmp / f"dst_{bv}.{dst_ext}"
    subprocess.run(["sips", "-Z", str(size), str(src_path), "--out", str(dst_path)],
                   check=True, capture_output=True)
    new_bytes = dst_path.read_bytes()
    new_images.append((bv, new_bytes, "image/png" if keep_png else "image/jpeg"))
    old_mb = len(raw) / 1048576
    new_mb = len(new_bytes) / 1048576
    print(f"  {img.get('name')}: {old_mb:.1f} MB -> {new_mb:.1f} MB")

# 重建缓冲区：贴图在前，几何数据保持原样
geom_views = {}
image_views = {bv for bv, _, _ in new_images}
for i, v in enumerate(views):
    if i not in image_views:
        geom_views[i] = bytes(bin_data[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]])

buf = bytearray()


def align4(n):
    return (4 - (n % 4)) % 4


for bv, payload, mime in new_images:
    buf.extend(b"\x00" * align4(len(buf)))
    views[bv]["byteOffset"] = len(buf)
    views[bv]["byteLength"] = len(payload)
    img = next(i for i in images if i.get("bufferView") == bv)
    img["mimeType"] = mime
    buf.extend(payload)

for i, payload in geom_views.items():
    buf.extend(b"\x00" * align4(len(buf)))
    views[i]["byteOffset"] = len(buf)
    buf.extend(payload)

doc["buffers"][0]["byteLength"] = len(buf)

json_bytes = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
json_pad = b" " * ((4 - (len(json_bytes) % 4)) % 4)
json_chunk = json_bytes + json_pad
bin_pad = b"\x00" * ((4 - (len(buf) % 4)) % 4)
bin_chunk = bytes(buf) + bin_pad

header = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(json_chunk) + 8 + len(bin_chunk))
json_header = struct.pack("<II", len(json_chunk), 0x4E4F534A)
bin_header = struct.pack("<II", len(bin_chunk), 0x004E4942)

out.write_bytes(header + json_header + json_chunk + bin_header + bin_chunk)

print(f"\n输入 {src.stat().st_size / 1048576:.1f} MB -> 输出 {out.stat().st_size / 1048576:.1f} MB")
print(f"已写出: {out}")
