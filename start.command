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

# Tripo API Key：优先用环境变量，其次读项目根目录的 .tripo-key
# （把 Key 存成文件，就不用每次敲在命令行里、也不会留在 shell 历史记录中）
if [[ -z "$TRIPO_API_KEY" && -f .tripo-key ]]; then
  TRIPO_API_KEY="$(tr -d '[:space:]' < .tripo-key)"
  export TRIPO_API_KEY
fi

echo ""
echo "  使用 Node: $NODE_BIN"
if [[ -n "$TRIPO_API_KEY" ]]; then
  echo "  Tripo:      真实模式（已读到 API Key）"
else
  echo "  Tripo:      mock 模式（未配置 Key，生成的是占位小屋）"
fi
echo "  正在启动联调服务器…"
echo ""

# 稍等服务器起来再打开浏览器
( sleep 1.5; open "http://localhost:$PORT/" ) &

exec "$NODE_BIN" server/server.js
