# 接口协议说明

本文档面向后端开发者。后端只需向一个 HTTP 接口 POST JSON，即可完整驱动网页里的游戏。

---

## 1. 链路总览

```
手柄 / 传感器 / 算法
        ↓
   后端程序
        ↓  POST http://localhost:8765/input
   联调服务器
        ↓  WebSocket 广播
   游戏页面 (浏览器)
        ↓  合成输入事件
   游戏逻辑
```

后端有两条可选通道：

| 通道 | 地址 | 适用场景 |
| --- | --- | --- |
| HTTP 注入（推荐） | `POST /input` | 无需任何库，调试方便，延迟约 1–5ms |
| WebSocket | `ws://localhost:8765/ws` | 需要双向、高频、低延迟时 |

两条通道消息格式完全相同。

---

## 2. 后端到游戏：指令格式

### 2.1 组合状态（推荐）

连续控制时使用，建议 20–60Hz 持续发送。**幂等**，重复发送同样的内容不会产生副作用。

```json
{
  "type": "state",
  "move": [0, -1],
  "look": [0.5, 0],
  "zoom": 1.2,
  "hold": ["run"],
  "taps": ["jump"]
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `move` | `[x, y]` | 移动向量，取值 `-1 ~ 1`。`x` 右为正，`y` 前为负 |
| `look` | `[x, y]` | 视角向量。`x` 右为正，`y` 下为正。`0` 表示停止转动 |
| `zoom` | `number` | 缩放速率，正数拉近，负数拉远，`0` 停止 |
| `hold` | `string[]` | 需要**持续按住**的动作名，见下表 |
| `taps` | `string[]` | 需要**触发一次**的动作名，见下表 |

`move` 只取方向，不取力度；游戏本身是 8 方向键盘控制，超过死区即视为按下对应方向。

### 2.2 单条指令

不便于发送组合状态时，可以一条一条发。

```json
{ "type": "move",   "x": 0, "y": -1 }
{ "type": "look",   "x": 1, "y": 0 }
{ "type": "zoom",   "rate": 1.2 }
{ "type": "zoom",   "delta": -1 }
{ "type": "button", "name": "run", "pressed": true }
{ "type": "tap",    "name": "jump" }
{ "type": "key",    "code": "KeyE", "action": "tap" }
{ "type": "reset" }
```

| 指令 | 说明 |
| --- | --- |
| `zoom.rate` | 持续缩放速率 |
| `zoom.delta` | 离散缩放，`1` 表示拉近一档 |
| `button` | 按键按下 / 抬起，用于长按型动作 |
| `key` | 直接发送键盘事件，`action` 取 `press` / `release` / `tap`，用于协议未覆盖的键 |

### 2.3 动作名对照表

| 动作名 | 类型 | 对应按键 | 游戏内效果 |
| --- | --- | --- | --- |
| `jump` | 触发 | Space | 跳跃 |
| `interact` | 触发 | E | 与附近地标互动 |
| `run` | 长按 | Shift | 奔跑 |
| `view` | 触发 | V | 切换视角（近景 / 第三人称 / 第一视角 / 星球） |
| `journal` | 触发 | J | 打开探索手记 |
| `help` | 触发 | H | 打开操作说明 |
| `home` | 触发 | Home | 回到三叶草原 |
| `cancel` | 触发 | Esc | 取消当前自动寻路 |

`taps` 中的触发型动作会在上升沿执行一次，持续发送不会重复触发。

---

## 3. 游戏到后端：遥测

页面每 500ms 主动上报一次状态，便于后端观测，无需请求。

```json
{
  "type": "telemetry",
  "version": "1.0.0",
  "ready": true,
  "view": "follow",
  "zoom": "0.900",
  "source": "websocket",
  "move": [0, -1],
  "look": [0, 0],
  "held": ["KeyW", "ShiftLeft"]
}
```

| 字段 | 说明 |
| --- | --- |
| `ready` | 场景是否加载完成 |
| `view` | 当前视角模式，`follow` 或 `globe` |
| `zoom` | 当前镜头缩放系数 |
| `source` | 最近一次输入的来源 |
| `held` | 当前被按住的所有按键 |

可通过 WebSocket 收到；HTTP 模式不支持回推。

---

## 4. 连接与查询

### 握手

WebSocket 连接建立后，页面会先发送：

```json
{ "type": "hello", "client": "browser", "version": "1.0.0" }
```

后端若使用 WebSocket，建议同样发送 `hello`，`client` 填写 `backend`，便于服务器区分角色。

### 状态查询

```
GET http://localhost:8765/status
```

```json
{
  "ok": true,
  "uptimeSec": 128,
  "clients": 2,
  "detail": [
    { "role": "browser", "remote": "::1", "connectedSec": 120 },
    { "role": "backend", "remote": "::1", "connectedSec": 96 }
  ]
}
```

### 注入响应

`POST /input` 会返回本次投递结果，便于后端判断页面是否在线：

```json
{ "ok": true, "delivered": 1, "clients": 1 }
```

`delivered` 为 `0` 表示当前没有页面在监听。

---

## 5. 手柄直连（无需后端）

如果手柄直接插在演示电脑上，可以完全不写后端。

- 标准手柄（Xbox / PS / Switch Pro）走浏览器 Gamepad API
- 映射关系：左摇杆移动，右摇杆视角，A 跳跃，X 互动，B 取消，Y 切换视角，LT 奔跑，RT 拉近，肩键缩放，Start 手记，Select 帮助

在页面中调用 `window.LPController.status()` 可查看当前接入情况。

---

## 6. 调试接口（浏览器控制台）

```js
LPController.status()                 // 查看桥接层状态
LPController.move(0, -1)              // 向前走
LPController.look(1, 0)               // 视角右转
LPController.tap("jump")              // 跳跃
LPController.hold("run", true)        // 开始奔跑
LPController.reset()                  // 清空输入
LPController.pressKey("KeyE")         // 直接按某个键
LPController.actionNames              // 所有可用动作名
```

需要关闭页面顶部的状态浮条时，在页面加载前设置：

```js
window.LPControllerConfig = { hud: false, telemetry: false };
```
