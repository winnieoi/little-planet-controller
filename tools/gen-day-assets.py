# -*- coding: utf-8 -*-
"""从 Desktop/preview 的昼夜两份单文件预览版提取主题映射，
生成主项目的白天版 bundle 与 CSS。

白天版与夜晚版的差异本质是同一构建换了一批主题常量（已通过 token 级
diff 确认：JS 一共 10 组替换、CSS 若干颜色 + 3 处带颜色锚点的数字）。
这里用「对齐替换」保证每处替换都精确命中、不误伤。
"""
import re
import difflib
import sys

BASE = r"C:\Users\张朵朵\Desktop"
PROJ = BASE + r"\little-planet-controller"
PREV = BASE + r"\preview"

# ---------- 读入 ----------
js_night = open(PREV + r"\little-planet-preview.html", encoding="utf-8", errors="replace").read()
js_day = open(PREV + r"\little-planet-preview-day.html", encoding="utf-8", errors="replace").read()
night_lines = js_night.split("\n")
day_lines = js_day.split("\n")

# CSS：<style> 标签跨行，要在整个文件上匹配
css_n = re.search(r"<style[^>]*>(.*?)</style>", js_night, re.S).group(1)
css_d = re.search(r"<style[^>]*>(.*?)</style>", js_day, re.S).group(1)

main_css = open(PROJ + r"\web\assets\index-CundtmH4.css", encoding="utf-8").read()
main_js = open(PROJ + r"\web\assets\index-CS6g4Xtd.js", encoding="utf-8").read()

# ============================================================
# 一、JS bundle：上下文锚定替换（每处必须恰好命中 1 次）
# ============================================================
JS_RULES = [
    # 建筑色板 A：紫红系 → 草木绿系
    ('["#8a2a5c","#8a2a5c","#8a2a5c","#8a2a5c","#9a3a6c","#85b64a"]',
     '["#4a8a3a","#5a9a4a","#6aaa5a","#3a7a2a","#8aba6a","#e8d840"]'),
    # 屋顶色板 te：深紫 → 暖棕系
    ('["#4a1040","#4a1040","#4a1040","#4a1040","#4a1040"]',
     '["#6a5a3a","#7a6a4a","#5a4a2a","#8a7a5a","#6a5a3a"]'),
    # 地面网格
    ('set("#2a1040")', 'set("#8a9a7a")'),
    # 建筑底色
    ('"#6a1a5c"', '"#8a6a4a"'),
    # 水面
    ('"#247e88"', '"#4ac0e0"'),
    # 建筑自发光强度（夜晚霓虹 → 白天微光）
    ("emissiveIntensity:.8", "emissiveIntensity:.03"),
    # 天空背景
    ('"#0d0020"', '"#87ceeb"'),
    # 雾（颜色 + 密度；极光/粒子的 #ff5ef2 不动）
    ('"#ff5ef2","#0a0030",1.5', '"#87ceeb","#4a8a3a",1.2'),
    # 主光源（紫光 → 暖阳）
    ('"#c44dff",2.2', '"#fff8e8",2.2'),
    # 补光（颜色 + 强度）
    ('"#5a7a9a",.6', '"#ffe0b0",.4'),
]

day_js = main_js
for old, new in JS_RULES:
    n = day_js.count(old)
    if n != 1:
        print("JS 规则命中 %d 次（应为 1）：%r" % (n, old[:60]))
        sys.exit(1)
    day_js = day_js.replace(old, new)

open(PROJ + r"\web\assets\index-day-CS6g4Xtd.js", "w", encoding="utf-8", newline="").write(day_js)
print("JS: %d 组替换全部精确命中 → index-day-CS6g4Xtd.js (%d 字节)" % (len(JS_RULES), len(day_js)))

# ============================================================
# 二、CSS：按「值的出现序号」逐个映射
#    （主 CSS 与预览版存在属性顺序差异，全局 token 对齐会漏；
#      但两侧规则集合与顺序一致，同一值的第 n 次出现互相对应）
# ============================================================
TOK = re.compile(r"#[0-9a-fA-F]{3,8}\b|[A-Za-z-]+|[\d.]+|\S")

def toks(s):
    return [m.group(0) for m in TOK.finditer(s)]

tn = toks(css_n)
td = toks(css_d)
tm_raw = [(m.start(), m.end(), m.group(0)) for m in TOK.finditer(main_css)]

# 1) 夜→昼：每个夜 token 索引的替换目标（仅 1:1 块）
nd = difflib.SequenceMatcher(None, tn, td, autojunk=False)
night_edit = {}  # night_idx -> day_text
for tag, i1, i2, j1, j2 in nd.get_opcodes():
    if tag == "equal":
        continue
    if tag == "replace" and i2 - i1 == j2 - j1:
        for k in range(i2 - i1):
            if tn[i1 + k] != td[j1 + k]:
                night_edit[i1 + k] = td[j1 + k]
    elif tag == "delete":
        pass  # 夜里多出的 token，主 CSS 里多半也没有，忽略
    else:
        print("警告：非 1:1 差异块 %s %r -> %r" % (
            tag, "".join(tn[i1:i2])[:50], "".join(td[j1:j2])[:50]))

# 2) 夜 CSS 中每个值的出现序号
night_ord = {}  # (value, ordinal) -> night_idx
counters = {}
for i, v in enumerate(tn):
    counters[v] = counters.get(v, 0) + 1
    night_ord[(v, counters[v])] = i

# 3) 夜侧每个值被改动的序号集合，及目标文本
#    value -> {ordinal: day_text}
by_value = {}
for ni, dtxt in night_edit.items():
    v = tn[ni]
    # 该 token 是值 v 的第几次出现
    ordn = sum(1 for j in range(ni + 1) if tn[j] == v)
    by_value.setdefault(v, {})[ordn] = dtxt

# 4) 主 CSS 中按序号替换（要求两侧该值出现次数一致，否则跳过并报告）
main_count = {}
for _, _, v in tm_raw:
    main_count[v] = main_count.get(v, 0) + 1

edits = []  # (start, end, new_text)
skipped = []
for v, ordmap in by_value.items():
    n_night = counters[v]
    n_main = main_count.get(v, 0)
    if n_night != n_main:
        skipped.append((v, n_night, n_main, sorted(ordmap)))
        continue
    for ordn, dtxt in ordmap.items():
        if ordn > n_main:
            continue
        # 找主 CSS 中该值的第 ordn 次出现
        c = 0
        for s, e, val in tm_raw:
            if val == v:
                c += 1
                if c == ordn:
                    edits.append((s, e, dtxt))
                    break

if skipped:
    print("以下值两侧出现次数不同，已跳过（夜/主）：")
    for v, a, b, ords in skipped:
        print("   %r 夜=%d 主=%d 想改序号=%s" % (v, a, b, ords))

edits.sort(key=lambda e: e[0])
out = []
pos = 0
for s, e, txt in edits:
    out.append(main_css[pos:s])
    out.append(txt)
    pos = e
out.append(main_css[pos:])
day_css = "".join(out)

open(PROJ + r"\web\assets\index-day-CundtmH4.css", "w", encoding="utf-8", newline="").write(day_css)
print("CSS: %d 处替换 → index-day-CundtmH4.css (%d 字节)" % (len(edits), len(day_css)))

# ---- 手工锚定补充：两侧出现次数不同、按序号映射不了的值 ----
# #ff20ff：预览版把 button/a 的 focus-visible 拆成两条规则（3 处），
# 主 CSS 合并成一条（2 处）。按语义锚定：
CSS_EXTRA_RULES = [
    # focus-visible 外框：紫 → 绿
    ("outline:2px solid #ff20ff", "outline:2px solid #2a8a5a"),
    # 「开始霓虹之旅」按钮 hover：亮紫 → 暖橙红
    ("background:#ff20ff", "background:#e06040"),
]
for old, new in CSS_EXTRA_RULES:
    n = day_css.count(old)
    if n != 1:
        print("CSS 补充规则命中 %d 次（应为 1）：%r" % (n, old))
        sys.exit(1)
    day_css = day_css.replace(old, new)

# 重新落盘（补充规则之后）
open(PROJ + r"\web\assets\index-day-CundtmH4.css", "w", encoding="utf-8", newline="").write(day_css)
print("CSS 补充规则 %d 条全部命中" % len(CSS_EXTRA_RULES))

# 汇总替换清单
uniq = []
seen = set()
for s, e, txt in edits:
    old = main_css[s:e]
    if (old, txt) not in seen:
        seen.add((old, txt))
        uniq.append((old, txt))
print("\nCSS 替换清单（去重 %d 条）:" % len(uniq))
for a, b in uniq:
    print("   %s → %s" % (a, b))

# ---------- 抽查 ----------
checks = [
    ("background:#d4e8d0", True),   # body 背景变浅绿
    ("--accent:#2a8a5a", True),     # 主题色变绿
    ("#ff40ff", "COUNT2"),          # 恰好保留 2 处（location-rule + 描边）
    ("#0d0015", False),             # 夜晚底色清零
    ("#ff20ff", False),             # 全部替换
    ("#e040d033", True),            # 弹窗描边：白天版保留
    ("#e040d02c", True),            # 摇杆描边：白天版保留
    ("#e040d055", False),           # 其余 e040d0 变体清零
]
for probe, want in checks:
    if want == "COUNT2":
        got = day_css.count("#ff40ff")
        ok = got == 2
    else:
        got = probe in day_css
        ok = got == want
    print("抽查 %-24s 期望=%s 实际=%s %s" % (probe, want, got, "OK" if ok else "!! FAIL"))
    if not ok:
        sys.exit(1)
plain = re.sub(r"#e040d0[0-9a-fA-F]{2}", "", day_css)
if "#e040d0" in plain:
    print("!! 残留纯 6 位 #e040d0")
    sys.exit(1)
print("抽查 纯6位#e040d0 清零 OK")
for probe in ["#87ceeb", "#fff8e8", "#ffe0b0", "#4a8a3a"]:
    if probe not in day_js:
        print("JS 抽查缺失: %s" % probe)
        sys.exit(1)
print("\n全部抽查通过")
