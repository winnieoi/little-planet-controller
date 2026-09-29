#!/bin/bash
# 口袋星球 · 一键启动
# 双击本文件即可启动联调服务器并自动打开游戏页面。

cd "$(dirname "$0")" || exit 1

# 找一个可用的 Node
NODE_BIN=""
for candidate in "$(command -v node 2>/dev/null)" /usr/local/bin/node /opt/homebrew/bin/node "$HOME/.nvm/versions/node"/*/bin/node; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    NODE_BIN="$candidate"
    break
  fi
done

if [ -z "$NODE_BIN" ]; then
  echo ""
  echo "  没有找到 Node.js，请先安装：https://nodejs.org"
  echo ""
  read -r -p "  按回车键关闭…" _
  exit 1
fi

PORT="${PORT:-8765}"

echo ""
echo "  使用 Node: $NODE_BIN"
echo "  正在启动联调服务器…"
echo ""

# 稍等服务器起来再打开浏览器
( sleep 1.5; open "http://localhost:$PORT/" ) &

exec "$NODE_BIN" server/server.js
