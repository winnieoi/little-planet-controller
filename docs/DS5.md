# DualSense（DS5）适配说明

《口袋星球》网页版的 PS5 DualSense 适配层。**游戏本体与 `lp-controller.js` 一行未改**，
所有手柄逻辑集中在一个文件里：`web/bridge/ds5-adapter.js`。

> 文档只管单手玩法。**双人分屏（一块屏幕两位玩家、一只或两只手柄）见 [`DUO.md`](DUO.md)。**

---

## 快速开始（Windows）

```bash
cd pocket-planet-roam
node server/server.js
```

浏览器打开 `http://localhost:8765/`，然后**按一下手柄上的任意按键**唤醒
（浏览器要求先有一次用户交互才会把手柄暴露给页面）。

> `start.command` 是 macOS 一键启动脚本，Windows 上直接执行上面的命令即可。

左下角会出现状态条，显示手柄型号、后端连接与震动可用性；首次接入时右下角会弹出
9 秒的按键提示卡。

---

## 按键表

| 手柄按键 | 动作 | 对应键盘 |
| --- | --- | --- |
| 左摇杆 / 十字键 | 移动 | `W A S D` / `↑ ↓ ← →` |
| 右摇杆 | 环视星球 | 拖动画面 |
| × | 跳跃 | `Space` |
| □ | 互动 | `E` |
| △ | 切换视角（跟随 / 星球） | `V` |
| ○ | 取消路线 / 关闭弹窗 | `Esc` |
| L2（模拟量） | 奔跑 | `Shift` |
| R2（模拟量）/ R1 | 拉近 | 滚轮上 |
| L1 | 拉远 | 滚轮下 |
| 触摸板 | 镜头回正到角色 | 点击镜头按钮 |
| L3 | 回到草原 | `Home` |
| R3 | 取消 / 关闭弹窗 | `Esc` |
| Options | 探索手记 | `J` |
| Create | 操作说明 | `H` |

扳机是**模拟量**：L2 超过 `0.35` 才算奔跑，R2 的推入深度直接决定缩放速度，
所以能像原生主机游戏那样"轻推慢移、推到底最快"。

---

## 震动反馈

震动分两类：**按键即时反馈**与**游戏事件反馈**。后者通过观察游戏自己已经渲染的 DOM
（`#toast`、`#collected-count`、`#region-name`、`#view-toggle span`、`#interaction`）触发，
不需要游戏本体暴露任何钩子。

| 模式 | 触发时机 | 手感 |
| --- | --- | --- |
| `connect` | 手柄接入 | 两段轻振，确认已识别 |
| `jump` | 按 × | 极短轻振 |
| `pick` | 收集到奇迹（计数变化） | 最强的一下，奖励感 |
| `interact` | 按 □ | 中等短振 |
| `view` | 切换视角 / 触摸板回正 | 中短振 |
| `region` | 进入新区域 | 长而轻的绵振 |
| `notify` | 弹出提示（toast） | 中等振，700ms 内去重 |
| `ready` | 附近出现可互动地标 | 极轻提示振，900ms 内去重 |
| `menu` | Options / Create | 轻振 |
| `cancel` | ○ / R3 | 干脆的短振 |
| `land` | 落地（预留给物理钩子） | 重而短的闷振 |
| `blocked` | 受限操作（预留） | 最重的振 |
| `test` | 手动测试用 | 对等双振 |

去重机制：`notify` 与 `ready` 带 `gap` 最小间隔，避免连续提示把震动打成蜂鸣。

---

## 为什么不会出 bug

适配层围绕**"手柄不抢输入"**这一条约定设计，共有四道保险：

1. **手柄所有权唯一。** `index.html` 里用 `LPControllerConfig = { enableGamepad: false }`
   关掉 `lp-controller.js` 内置的手柄轮询，由适配层独占。
   两套逻辑不再互相覆盖，也就不会出现按键卡住或重复触发。
2. **空闲即让位。** 只有摇杆、十字键、扳机**真的产生输入**时才写入 `io.move` / `io.look` /
   `io.zoomRate`，手柄不动时立即归零清零。键盘操作与后端 `POST /input` 注入完全不受影响。
3. **拔出即释放。** 手柄断开时 `releaseEverything()` 清空移动、视角、奔跑、缩放，
   并重置所有上升沿状态，不会留下"一直在走"的幽灵输入。
4. **异常不扩散。** 轮询整帧包在 `try/catch` 里，单帧异常只记一条 warn，下一帧照常运行；
   震动能力逐级探测（`vibrationActuator` → `hapticActuators`），浏览器不支持时静默跳过。
5. **取消动作真的能取消。** `Escape` 关闭 `<dialog>` 属于**浏览器默认动作**，合成的键盘事件
   触发不了它 —— 如果照搬键盘映射，手柄用户按下 ○ 会被永久关在探索手记里（而且弹窗打开时
   游戏不接受移动输入，等于卡死）。适配层因此在 `cancel` 动作里显式收掉所有打开的弹窗：
   先点游戏自己的关闭按钮（保留游戏的收尾逻辑），按钮没生效再兜底 `close()`。
   按 ○ 或 R3 都能用。

另外，`lp-controller.js` 缺失时适配层会启用内置兜底后端（移动与按键可用，视角与缩放不可用）
并打印警告，页面不会白屏。

---

## 自检页

```
http://localhost:8765/bridge/ds5-selftest.html
```

它用一个**假 DualSense** 驱动真实的适配层，覆盖 39 项断言：手柄识别、震动探测、
摇杆死区与回中、每一个按键的映射、扳机阈值、十字键优先级、触摸板 / L3 / R3、
取消动作关闭弹窗、游戏事件震动、拔出与重插、关闭震动开关。没有手柄也能跑，用来回归测试。

双人分屏另有 `bridge/duo-selftest.html`（37 项断言），覆盖手柄归属、跨 frame 分发与存档隔离。
它会把座位侧的自读入口也换成受控列表，所以**机器上插着真手柄时结果同样可信**。

---

## 可调参数

在 `ds5-adapter.js` **之前**写入 `window.DS5Config` 即可覆盖。默认值：

```js
window.DS5Config = {
  enable: true,          // 总开关
  deadzone: 0.18,        // 摇杆死区
  triggerPress: 0.35,    // 扳机判定阈值
  zoomSpeed: 1.2,        // 扳机缩放倍率
  rumble: true,          // 震动
  rumbleScale: 1.0,      // 震动强度整体倍率
  hud: true,             // 左下角状态条
  keycard: true,         // 首次接入的按键提示卡
  keycardMs: 9000,       // 提示卡停留时长
  eventFeedback: true,   // 游戏事件震动
  padProvider: null,     // 调试钩子：返回手柄数组的函数
  debug: false
};
```

---

## 调试 API

游戏页面控制台可直接使用 `window.DS5`：

```js
DS5.version            // "1.0.0"
DS5.status()           // 手柄、震动、移动/视角/缩放、后端连接与输入源
DS5.rumble("pick")     // 播放某个震动模式
DS5.rumble(0.8, 0.4, 300)   // 自定义：主马达、副马达、时长(ms)
DS5.setRumble(false)   // 临时关掉震动
DS5.keycard()          // 重新弹出按键提示卡
DS5.mapping            // 完整按键映射表
```

`DS5.status()` 返回示例：

```js
{
  pad: { id: "DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)", kind: "DualSense" },
  rumbleSupported: true, rumbleEnabled: true, lastRumble: "jump",
  move: false, look: false, run: false, zoom: 0,
  backend: true, source: "gamepad"
}
```

`lp-controller.js` 自身仍可用 `LPController.status()` 查看后端通道状态。

---

## 浏览器能力限制

Gamepad API 只能拿到**输入**和基础双马达震动。以下 DS5 独有硬件能力在浏览器里**不可用**，
需要 WebHID 才能部分访问，属于后续可选项，当前版本未启用：

- **自适应扳机**（L2/R2 的段落阻尼反馈）—— 浏览器不暴露
- **灯条颜色** —— 需 WebHID，且需要用户额外授权
- **陀螺仪 / 加速度计** —— Gamepad API 不含
- **触摸板精确坐标** —— 只能读到"按下"与"点击"，读不到 X/Y
  （因此触摸板被设计为"一键镜头回正"，而不是指针设备）

震动强度在不同平台上的实际表现会有差异：Windows 上的 Chromium 支持 `dual-rumble`，
Safari 目前只支持旧版 `pulse` 接口（适配层已自动回退，力度会取主副马达中的较大值）。
