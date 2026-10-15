#!/bin/bash
# 双击这个文件启动「短剧工作台」（开发模式，改代码自动热更新）。第一次会自动安装依赖（需要联网，几分钟）。
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

# 端口被本项目的旧进程占着就先结束它；被别的程序占着就提示，不乱杀
HERE="$(pwd)"
for PORT in 6688 5188; do
  for PID in $(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null); do
    if ps -p "$PID" -o command= | grep -qF "$HERE"; then
      echo "端口 $PORT 被本项目的旧进程占用（$PID），先结束它"
      kill "$PID" 2>/dev/null
    else
      echo "!!! 端口 $PORT 被别的程序占用：$(ps -p "$PID" -o command= | cut -c1-120)"
      echo "    请先关掉它再双击本文件。"
      read -p "按回车关闭..."
      exit 1
    fi
  done
done
sleep 1

URL="http://127.0.0.1:5188"
(sleep 4 && open "$URL") &
echo "=== 启动中：$URL （改代码自动刷新；关掉这个窗口就停止）==="
env -u NODE_OPTIONS npm run dev
echo ""
echo "!!! 服务已退出（上面如果有报错，就是问题所在）"
read -p "按回车关闭..."
