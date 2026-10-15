#!/bin/bash
# 双击这个文件启动「短剧工作台」。第一次会自动安装依赖（需要联网，几分钟）。
cd "$(dirname "$0")" || exit 1
echo "=== 短剧工作台 ==="

if ! command -v node >/dev/null 2>&1; then
  echo "!!! 这台电脑还没有装 Node.js。请到 https://nodejs.org 下载安装 LTS 版本，装好后再双击本文件。"
  read -p "按回车关闭..."
  exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "!!! Node.js 版本太低（当前 $(node -v)），需要 20 或更高。请到 https://nodejs.org 下载新版。"
  read -p "按回车关闭..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "=== 第一次运行：安装依赖 ==="
  env -u NODE_OPTIONS npm install --no-audit --no-fund || { echo "!!! 依赖安装失败"; read -p "按回车关闭..."; exit 1; }
fi

# 界面代码比上次构建新，就重新构建一次
if [ ! -f dist/index.html ] || [ -n "$(find src shared index.html -newer dist/index.html -type f 2>/dev/null | head -1)" ]; then
  echo "=== 构建界面 ==="
  env -u NODE_OPTIONS npm run build || { echo "!!! 构建失败"; read -p "按回车关闭..."; exit 1; }
fi

PORT=6688
PIDS=$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null)
if [ -n "$PIDS" ]; then
  echo "端口 $PORT 被旧进程占用（$PIDS），先结束它"
  echo "$PIDS" | xargs kill 2>/dev/null; sleep 1
fi

(sleep 3 && open "http://127.0.0.1:$PORT") &
echo "=== 启动中：http://127.0.0.1:$PORT （关掉这个窗口就停止）==="
env -u NODE_OPTIONS PORT=$PORT npm start
echo ""
echo "!!! 服务已退出（上面如果有报错，就是问题所在）"
read -p "按回车关闭..."
