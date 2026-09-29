# 星球模型替换说明

本文说明《赛博星球》模型是怎么接进来的，以及换成别的模型时该怎么做。

---

## 背景：为什么不能"直接摆上去"

游戏的碰撞与移动是一个**半径固定的球面**：

- 角色群组原点始终位于半径 26 的球面上
- 实测角色脚底顶点位于半径 **26.17** —— 这就是原程序化地表的基准高度
- 角色身高约 **1.56** 个世界单位

而 Tripo 生成的高精度模型地表起伏很大，原始半径分布换算后是 **18.5 ~ 34.0**。
直接摆放的结果是：角色在洼地上空悬空近 10 个单位（6 倍身高），在山体上又被完全埋住。

所以模型必须**径向重映射**到角色行走球面，这是唯一能保证角色真正踩在地上的办法。

---

## 处理流程

三道工序，都在打包前离线完成，网页端不做任何计算。

```
原始 GLB
   │
   │  ①  fit-planet.mjs      径向贴合：把地表压到角色行走球面附近
   ▼
贴合后 GLB
   │
   │  ②  shrink_textures.py  压缩贴图：4096 → 2048
   ▼
cyber-planet.glb  ──►  web/models/
   │
   │  ③  verify-planet.mjs   校验：确认地表半径落在设计范围内
   ▼
   数值报告
```

### ① 径向贴合（`tools/fit-planet.mjs`）

核心是**径向软约束重映射**：

```
d        = (该顶点半径 - 中位半径) × 缩放   # 换算到世界单位的偏离量
clamped  = sign(d) × M × (1 - e^(-|d|/M))  # 软压缩
新半径   = 26.17 + clamped
```

其中 `M = 1.0` 是允许的最大起伏。这个映射是**单调**的，因此：

- 网格不会自交，拓扑完全不变
- 小起伏（`|d| << M`）几乎原样保留，细节不丢
- 大起伏平滑收敛进 ±M，不会出现在极端值处"削平"的硬边

顶点中位半径被对齐到 26.17，因此**一半地表略高于脚底、一半略低于脚底**，
悬空与陷入都不超过 1.00（约 64% 身高）。

结束后会重算法线（`computeVertexNormals` 的等价实现），保证光照正确。

### ② 贴图压缩（`tools/shrink_textures.py`）

三张 4096 贴图在 GPU 上约占 190 MB，是加载崩溃的主因。
用 macOS 自带的 `sips` 降到 2048：

| 贴图 | 处理前 | 处理后 |
| --- | --- | --- |
| basecolor.jpg | 9.8 MB | 0.9 MB |
| rm.jpg | 1.8 MB | 0.4 MB |
| normal.png | 5.0 MB | 2.4 MB |

法线贴图保持 PNG 避免精度损失，其余转 JPEG。

### ③ 校验（`tools/verify-planet.mjs`）

只测量不修改，输出地表半径分布：

```
地表半径分布（世界单位）:
  min  25.17   偏差 -1.00
  p25  25.27   偏差 -0.90
  p50  26.17   偏差 -0.00
  p75  26.88   偏差 +0.71
  max  27.17   偏差 +1.00

最大偏差 1.00
结论: 贴合合格
```

---

## 换一个模型

把新模型放到 `tools/` 旁边，按顺序跑：

```bash
cd little-planet-controller-cyber

# ① 贴合到角色行走球面
node --max-old-space-size=4096 tools/fit-planet.mjs 你的模型.glb /tmp/fitted.glb

# ② 压缩贴图
python3 tools/shrink_textures.py /tmp/fitted.glb web/models/cyber-planet.glb 2048

# ③ 校验
node tools/verify-planet.mjs web/models/cyber-planet.glb 26.17
```

然后清一下浏览器缓存重新打开页面即可，不用改前端代码。

### 可调参数

`tools/fit-planet.mjs` 顶部两个常量：

| 常量 | 默认 | 含义 |
| --- | --- | --- |
| `WALK_RADIUS` | 26.17 | 角色脚底所在球面半径，决定星球整体大小 |
| `RELIEF_MARGIN` | 1.0 | 允许的最大起伏，越小地形越贴合球面、也越平 |

`RELIEF_MARGIN` 是唯一需要权衡的参数：

- 调小（如 0.6）：角色几乎不会悬空或陷入，但地形起伏被压平
- 调大（如 2.0）：保留更多原始造型，但角色可能陷入山体

角色身高 1.56，建议不要超过 1.5。

---

## 网页端做了什么

`web/integration/cyber-planet-source.js`：

1. 轮询等待 `window.__LP_SCENE__` / `window.__LP_WORLD__` 出现（游戏初始化完成）
2. 隐藏原地表：遍历 `world.world.children`，只保留角色、NPC、光环、目标点、交互标记
3. `GLTFLoader` 加载 `./models/cyber-planet.glb`，原样加入场景

因为模型已经是最终世界坐标，放置时 **scale = 1、position = 0**，只做了一次朝向旋转。

想换回原程序化星球，删掉 `web/index.html` 里的
`<script src="./integration/cyber-planet.js"></script>` 即可。

---

## 已知限制

- **文件 56 MB**：转发和首次加载都偏重。如需进一步瘦身，
  可对几何做减面或 Draco 压缩，但那需要额外的第三方库，当前环境未安装。
- **地形起伏被压缩**：模型原本剧烈的尖峰与拱形结构被压到 1 个单位以内，
  这是让角色能正常行走所必须付出的代价。
