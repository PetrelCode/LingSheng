#!/bin/sh
# 协议抓包工具启动脚本（自带 Node 运行时，无需目标机安装 Node）
# 用法：sh capture.sh --host 127.0.0.1 --port 21883
set -eu

DIR=$(cd "$(dirname "$0")" && pwd)

if [ -f "$DIR/node/bin/node" ]; then
  chmod +x "$DIR/node/bin/node" 2>/dev/null || true
  NODE_BIN="$DIR/node/bin/node"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN=$(command -v node)
else
  echo "未找到 Node 运行时：请确认包内 node/bin/node 存在，或安装 Node 18+" >&2
  exit 1
fi

exec "$NODE_BIN" "$DIR/tools/capture.mjs" "$@"
