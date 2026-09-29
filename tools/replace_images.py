#!/usr/bin/env python3
"""
替换 GLB 中的指定内嵌贴图，并重建缓冲区。

用法：python3 tools/replace_images.py <输入.glb> <输出.glb> <索引=图片路径> [...]
示例：python3 tools/replace_images.py in.glb out.glb 0=daylight.jpg

几何数据（顶点、索引、法线等）原样搬运，只换贴图字节。
"""

import json
import struct
import sys
from pathlib import Path

src = Path(sys.argv[1])
out = Path(sys.argv[2])
pairs = {}
for arg in sys.argv[3:]:
    idx, _, path = arg.partition("=")
    pairs[int(idx)] = Path(path)

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

replaced = {}
for idx, path in pairs.items():
    if idx >= len(images):
        raise SystemExit(f"索引 {idx} 超出范围（共 {len(images)} 张）")
    bv = images[idx]["bufferView"]
    payload = path.read_bytes()
    ext = path.suffix.lower().lstrip(".")
    mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp"}[ext]
    images[idx]["mimeType"] = mime
    replaced[bv] = payload
    old_len = views[bv]["byteLength"]
    print(f"  [{idx}] {old_len / 1048576:.2f} MB -> {len(payload) / 1048576:.2f} MB ({mime})")

# 重建缓冲区：贴图在前（保持 bufferView 索引不变），其余原样
buf = bytearray()


def align4(n):
    return (4 - (n % 4)) % 4


geom_payloads = {}
for i, v in enumerate(views):
    if i in replaced:
        continue
    off = v.get("byteOffset", 0)
    geom_payloads[i] = bytes(bin_data[off:off + v["byteLength"]])

for bv, payload in replaced.items():
    buf.extend(b"\x00" * align4(len(buf)))
    views[bv]["byteOffset"] = len(buf)
    views[bv]["byteLength"] = len(payload)
    buf.extend(payload)

for i, payload in geom_payloads.items():
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
out.write_bytes(header + struct.pack("<II", len(json_chunk), 0x4E4F534A) + json_chunk
                + struct.pack("<II", len(bin_chunk), 0x004E4942) + bin_chunk)

print(f"\n输入 {src.stat().st_size / 1048576:.1f} MB -> 输出 {out.stat().st_size / 1048576:.1f} MB")
print(f"已写出: {out}")
