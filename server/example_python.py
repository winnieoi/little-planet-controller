"""
Little Planet · Python 后端接入示例
================================================================
用途：给用 Python 写后端的同事作为对接参考。
      它做的事情和 Node 版完全一样——向 /input 接口 POST JSON。

零第三方依赖，只用 Python 标准库，直接运行即可：

    python3 server/example_python.py demo      自动演示
    python3 server/example_python.py           手动输入指令
    python3 server/example_python.py status    查看连接状态

手动模式支持的指令（每行一条）：
    move 0 -1          向前走          move 1 0    向右走
    look 1 0           视角右转        look 0 0    视角回中
    zoom 1.2           持续拉近        zoom 0      停止缩放
    run on             开始奔跑        run off     停止奔跑
    tap jump           跳跃            tap interact 互动
    reset              重置所有输入
    quit               退出
================================================================
"""

import json
import sys
import time
import urllib.error
import urllib.request

HOST = "127.0.0.1"
PORT = 8765
BASE = f"http://{HOST}:{PORT}"

# 语义动作名 -> 游戏内动作含义
ACTIONS = {
    "jump": "跳跃",
    "interact": "互动",
    "view": "切换视角",
    "journal": "探索手记",
    "help": "操作说明",
    "home": "回到草原",
    "cancel": "取消当前路线",
}


def post(payload):
    """向后端注入口发送一条指令，返回服务器的响应字典。"""
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE}/input",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=3) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        raise SystemExit(f"\n无法连接联调服务器 {BASE}\n请先运行：node server/server.js\n原因：{exc}\n")


def get(path):
    with urllib.request.urlopen(f"{BASE}{path}", timeout=3) as res:
        return json.loads(res.read().decode("utf-8"))


def state(move=(0, 0), look=(0, 0), zoom=0.0, hold=None, taps=None):
    """组合状态指令：这是推荐给后端使用的格式。"""
    return {
        "type": "state",
        "move": list(move),
        "look": list(look),
        "zoom": zoom,
        "hold": hold or [],
        "taps": taps or [],
    }


def demo():
    """脚本模式：自动走一遍完整动作，用来验证链路。"""
    steps = [
        ("向前奔跑", state(move=(0, -1), hold=["run"]), 2.0),
        ("视角右转", state(move=(0, -1), look=(1, 0)), 0.9),
        ("跳跃", state(taps=["jump"]), 0.7),
        ("向右移动", state(move=(1, 0)), 1.2),
        ("拉近镜头", {"type": "zoom", "rate": 1.2}, 0.7),
        ("恢复镜头", {"type": "zoom", "rate": -1.2}, 0.7),
        ("切换星球视角", {"type": "tap", "name": "view"}, 1.5),
        ("切回跟随视角", {"type": "tap", "name": "view"}, 0.8),
        ("互动", {"type": "tap", "name": "interact"}, 0.6),
        ("停止全部输入", state(), 0.2),
    ]

    for label, payload, wait in steps:
        res = post(payload)
        delivered = res.get("delivered", 0)
        note = "" if delivered else "  (暂无页面监听，请先打开游戏页面)"
        print(f"  {label:<14} -> 送达 {delivered} 个页面{note}")
        time.sleep(wait)

    post({"type": "reset"})
    print("\n  演示结束。")


HELP = """\
可用指令：
  move <x> <y>      移动，x 右为正，y 前为负。例：move 0 -1
  look <x> <y>      视角，x 右为正
  zoom <rate>       持续缩放，正数拉近，0 停止
  run on|off        奔跑开关
  tap <动作>        触发一次动作，动作名见下方
  key <code> <动作> 直接发送键盘事件，例：key KeyE tap
  reset             清空所有输入
  status            查看连接情况
  quit              退出

可用动作名：""" + "、".join(f"{k}({v})" for k, v in ACTIONS.items())


def repl():
    status = get("/status")
    clients = status.get("clients", 0)
    print(f"\n  当前连接到联调服务器的页面数：{clients}")
    if not clients:
        print(f"  提示：请先打开 http://{HOST}:{PORT}/")
    print()
    print(HELP)

    hold = []
    while True:
        try:
            line = input("\n> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break

        if not line:
            continue

        parts = line.split()
        cmd = parts[0].lower()

        if cmd == "quit":
            break
        if cmd == "status":
            print(json.dumps(get("/status"), ensure_ascii=False, indent=2))
            continue
        if cmd == "reset":
            hold = []
            print(post({"type": "reset"}))
            continue
        if cmd == "move" and len(parts) == 3:
            print(post(state(move=(float(parts[1]), float(parts[2])), hold=hold)))
            continue
        if cmd == "look" and len(parts) == 3:
            print(post(state(look=(float(parts[1]), float(parts[2])), hold=hold)))
            continue
        if cmd == "zoom" and len(parts) == 2:
            print(post({"type": "zoom", "rate": float(parts[1])}))
            continue
        if cmd == "run" and len(parts) == 2:
            if parts[1].lower() == "on" and "run" not in hold:
                hold.append("run")
            elif parts[1].lower() == "off" and "run" in hold:
                hold.remove("run")
            print(post(state(hold=hold)))
            continue
        if cmd == "tap" and len(parts) == 2:
            print(post({"type": "tap", "name": parts[1]}))
            continue
        if cmd == "key" and len(parts) == 3:
            print(post({"type": "key", "code": parts[1], "action": parts[2]}))
            continue

        print("  无法识别的指令，输入 quit 退出。")

    post({"type": "reset"})
    print("\n  已退出。")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "repl"

    if mode == "demo":
        demo()
    elif mode == "status":
        print(json.dumps(get("/status"), ensure_ascii=False, indent=2))
    else:
        repl()
