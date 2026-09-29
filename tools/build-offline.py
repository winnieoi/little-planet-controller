#!/usr/bin/env python3
"""生成「离线单文件版」HTML：双击即可用 file:// 打开，不需要启动服务器。

为什么需要这一步
----------------
浏览器对 file:// 有两个硬限制，导致直接双击原来的 index.html 打不开：
  1. <script type="module"> 会被 CORS 拦截（本机 ESM 不允许从 file:// 加载）
  2. fetch / XMLHttpRequest 读本地文件被拦截（模型与贴图取不到）

解决办法
--------
  1. ES Module -> 经典脚本 IIFE：three.js 与游戏各自包进 IIFE，用一个命名空间对象传递符号
  2. 二进制资源 -> data: URI：GLB 与三套白天贴图内嵌成 base64，不再触发任何网络请求
  3. CSS 内联，所有 <script> 内联，整份 HTML 零外部请求

用法
----
    python3 tools/build-offline.py                       # 全保真（约 82 MB）
    python3 tools/build-offline.py <模型.glb> <输出.html>
    node tools/make-test-model.mjs <模型.glb> /tmp/small.glb
    python3 tools/build-offline.py /tmp/small.glb /tmp/light.html   # 轻量调试版

注意
----
  * 离线版不含后端桥接层（lp-controller.js），因为离线没有服务器可连。
    需要联调请用 package 里的服务器版本。
  * 转换时会补 "use strict"，与 ES Module 默认的严格模式保持一致。
"""
import base64, os, re, sys

# 包根目录 = 本文件的上上级（tools/ 的父目录）
PKG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NS = "__LPT"


def read(p):
    with open(p, "r", encoding="utf-8") as f:
        return f.read()


def b64(path, mime):
    with open(path, "rb") as f:
        return "data:%s;base64,%s" % (mime, base64.b64encode(f.read()).decode("ascii"))


def safe_js(s, label):
    n = s.count("</script")
    if n:
        s = s.replace("</script", r"<\/script")
        print("  [转义] %s: %d 处 </script" % (label, n))
    return s


def parse_pairs(inner):
    """'X as y' -> [(first, second)]"""
    out = []
    for part in inner.split(","):
        part = part.strip()
        if not part:
            continue
        if " as " in part:
            a, b = [x.strip() for x in part.split(" as ")]
            out.append((a, b))
        else:
            out.append((part, part))
    return out


def build_three(src):
    """尾部 export{a as X,...} -> IIFE 返回命名空间。

    坑：export{a as X} 的第一个是「内部名」，第二个是「对外名」，方向与 import 相反。
    """
    i = src.rindex("export{")
    body = src[:i]
    m = re.search(r"export\s*\{([^}]*)\}", src[i:])
    pairs = parse_pairs(m.group(1))
    if src.count("export{") != 1:
        raise SystemExit("three 里出现多个 export{，需手工处理")
    obj = "{" + ",".join("%s:%s" % (ext, loc) for loc, ext in pairs) + "}"
    return 'var %s=(function(){\n"use strict";\n%s\nreturn %s;\n})();' % (NS, body, obj), len(pairs)


def build_game(src):
    """头部 import{X as a,...}from"..." -> var a=NS.X,..."""
    m = re.search(r'import\s*\{([^}]*)\}\s*from\s*["\'][^"\']*["\']\s*;?', src)
    if not m:
        return ';(function(){\n"use strict";\n%s\n})();' % src, 0
    pairs = parse_pairs(m.group(1))
    binds = ",".join("%s=%s.%s" % (loc, NS, ext) for ext, loc in pairs)
    body = src[m.end():]
    return ';(function(){\n"use strict";\nvar %s;\n%s\n})();' % (binds, body), len(pairs)


def build(glb_path, out_path, with_textures=True):
    print("构建 ->", out_path)
    print("  模型:", os.path.basename(glb_path), os.path.getsize(glb_path), "bytes")
    three_js, n3 = build_three(read(os.path.join(PKG, "web/assets/three-gtj_l2uB.js")))
    game_js, n1 = build_game(read(os.path.join(PKG, "web/assets/index-CS6g4Xtd.js")))
    print("  转换: three 导出 %d 项, 游戏导入 %d 项" % (n3, n1))
    css = read(os.path.join(PKG, "web/assets/index-CundtmH4.css"))
    if "</style" in css:
        raise SystemExit("CSS 里含 </style，需先转义")

    cyber = read(os.path.join(PKG, "web/integration/cyber-planet.js"))
    # 关键坑（Safari 会卡死）：不要把 78MB 的 data: URI 直接交给 GLTFLoader 去 fetch。
    # WebKit 处理这种量级的 data: 极慢甚至卡住（fetch(data:) 支持也不可靠），
    # 表现为遮罩一直停在「启动中」。改为运行时把 base64 解成 Blob，
    # 给 loader 一个很短的 blob: URL（同源内存资源，各浏览器都稳）。
    lit = '"./models/cyber-planet.glb"'
    if cyber.count(lit) != 1:
        raise SystemExit("模型 URL 字面量出现 %d 次，需人工确认" % cyber.count(lit))
    cyber = cyber.replace(lit, '(window.__LP_GLB_URL__||"./models/cyber-planet.glb")')
    with open(glb_path, "rb") as f:
        glb_b64 = base64.b64encode(f.read()).decode("ascii")
    print("  模型内嵌 base64: %.1f MB（运行时解码为 Blob URL）" % (len(glb_b64) / 1e6))
    decode_js = (
        "(function(){try{"
        + ('var b64="%s";' % glb_b64)
        + "var bin=atob(b64),n=bin.length,bytes=new Uint8Array(n);"
        + "for(var i=0;i<n;i++)bytes[i]=bin.charCodeAt(i);"
        + 'var blob=new Blob([bytes],{type:"model/gltf-binary"});'
        + "window.__LP_GLB_URL__=URL.createObjectURL(blob);"
        + 'console.log("[offline] 模型已解码为 Blob URL "+(n/1048576).toFixed(1)+"MB");'
        + '}catch(e){window.__LP_GLB_URL__=null;console.error("[offline] 模型解码失败",e);}})();'
    )

    day = read(os.path.join(PKG, "web/integration/daylight-mode.js"))
    if with_textures:
        for v in ("A", "B", "C"):
            p = os.path.join(PKG, "web/textures/daylight-%s.jpg" % v)
            if os.path.exists(p):
                day = day.replace('"./textures/daylight-%s.jpg"' % v, '"%s"' % b64(p, "image/jpeg"))
                print("  贴图 %s: %.2f MB" % (v, os.path.getsize(p) / 1e6))

    html = read(os.path.join(PKG, "web/index.html"))
    html = re.sub(r'\s*<script type="module"[^>]*></script>', "", html)
    html = re.sub(r'\s*<link rel="modulepreload"[^>]*>', "", html)
    html = re.sub(r'\s*<link rel="stylesheet"[^>]*>', "<style>\n%s\n</style>" % css, html)
    html = re.sub(r'\s*<script src="\./integration/[^"]*"></script>', "", html)
    html = re.sub(r'\s*<script src="\./bridge/[^"]*"></script>', "", html)

    blocks = [("three.js", three_js), ("game", game_js),
              ("glb-decode", decode_js), ("cyber-planet", cyber), ("daylight-mode", day)]
    html = html.replace("</body>", "\n".join(
        "<script>\n%s\n</script>" % safe_js(c, n) for n, c in blocks) + "\n  </body>")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)
    print("  完成: %.2f MB" % (os.path.getsize(out_path) / 1e6))


if __name__ == "__main__":
    glb = sys.argv[1] if len(sys.argv) > 1 else os.path.join(PKG, "web/models/cyber-planet.glb")
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
        os.path.dirname(PKG), "little-planet-白天切换-离线版.html")
    build(glb, out)
