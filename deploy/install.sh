#!/bin/sh
# 菱声播报服务 - 离线安装脚本（麒麟 V10 / 银河麒麟 / CentOS 系通用）
# 说明：只做安装与配置，不启动服务。安装完成后按提示手动启动。
set -eu

PREFIX=/opt/lingshen
HTTP_PORT=18080
MQTT_PORT=21883
SRC_DIR=$(cd "$(dirname "$0")/.." && pwd)

echo "==> 安装目录: $PREFIX"
mkdir -p "$PREFIX/app" "$PREFIX/media"

echo "==> 复制程序文件"
cp -rf "$SRC_DIR/dist" "$PREFIX/app/"
cp -rf "$SRC_DIR/node_modules" "$PREFIX/app/"
cp -f "$SRC_DIR/package.json" "$PREFIX/app/"
[ -d "$SRC_DIR/tools" ] && mkdir -p "$PREFIX/tools" && cp -rf "$SRC_DIR/tools/." "$PREFIX/tools/"

# 讯飞离线 TTS（可选，来自 npm run tts:setup + tts:build）
HAS_TTS=0
if [ -d "$SRC_DIR/tts/bin" ] || [ -d "$SRC_DIR/tts/msc" ]; then
  echo "==> 复制 TTS 引擎与讯飞 SDK 资源（约 10MB）"
  mkdir -p "$PREFIX/tts"
  cp -rf "$SRC_DIR/tts/." "$PREFIX/tts/"
  # 从 Windows 打包时不会有执行位，必须显式补上
  [ -d "$PREFIX/tts/bin" ] && chmod +x "$PREFIX/tts/bin/"* 2>/dev/null || true
  [ -d "$PREFIX/tts/lib" ] && chmod 755 "$PREFIX/tts/lib/"*.so* 2>/dev/null || true
  mkdir -p "$PREFIX/tts/cache"
  HAS_TTS=1
  if [ -x "$PREFIX/tts/bin/xf-tts" ] && [ -f "$PREFIX/tts/lib/libmsc.so" ] && [ -f "$PREFIX/tts/msc/res/tts/common.jet" ]; then
    echo "    引擎: $PREFIX/tts/bin/xf-tts"
  else
    echo "    !! TTS 不完整（缺 xf-tts / libmsc.so / jet 资源），TTS 接口将返回 503" >&2
  fi
fi

echo "==> 检查 Node 运行时"
NODE_BIN=""
if [ -f "$SRC_DIR/node/bin/node" ]; then
  mkdir -p "$PREFIX/node/bin"
  cp -f "$SRC_DIR/node/bin/node" "$PREFIX/node/bin/node"
  # 从 Windows 打包时不会有执行位，必须显式补上
  chmod +x "$PREFIX/node/bin/node"
  NODE_BIN="$PREFIX/node/bin/node"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN=$(command -v node)
else
  echo "!! 未找到 node。请把 linux-x64 的 Node 18+ 解压到包内 node/ 目录，或先安装 nodejs。" >&2
  exit 1
fi
NODE_VER=$("$NODE_BIN" -v 2>/dev/null || echo unknown)
echo "    使用 $NODE_BIN ($NODE_VER)"

cat > "$PREFIX/run.sh" <<EOF
#!/bin/sh
exec "$NODE_BIN" "$PREFIX/app/dist/main.js"
EOF
chmod +x "$PREFIX/run.sh"

if [ ! -f "$PREFIX/config.json" ]; then
  echo "==> 生成配置文件"
  cp -f "$SRC_DIR/config.example.json" "$PREFIX/config.json"
  if [ "$HAS_TTS" = "1" ]; then
    sed -i "s#\"root\": \"./tts\"#\"root\": \"$PREFIX/tts\"#" "$PREFIX/config.json"
  fi
  LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  if [ -n "${LAN_IP:-}" ]; then
    sed -i "s#\"publicBaseUrl\": \"\"#\"publicBaseUrl\": \"http://$LAN_IP:$HTTP_PORT\"#" "$PREFIX/config.json"
    echo "    已自动填入 publicBaseUrl=http://$LAN_IP:$HTTP_PORT"
  else
    echo "    请手动编辑 $PREFIX/config.json 中的 server.publicBaseUrl（设备访问本机的地址）"
  fi
else
  echo "==> 保留已有配置 $PREFIX/config.json"
  # 升级场景：老配置里 tts.root 还是相对路径，指到新装的引擎目录
  if [ "$HAS_TTS" = "1" ] && grep -q '"root": "./tts"' "$PREFIX/config.json"; then
    sed -i "s#\"root\": \"./tts\"#\"root\": \"$PREFIX/tts\"#" "$PREFIX/config.json"
    echo "    已将 tts.root 更新为 $PREFIX/tts"
  fi
fi

echo "==> 检查端口占用"
for p in "$HTTP_PORT" "$MQTT_PORT"; do
  if ss -lnt 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$p\$"; then
    echo "!! 警告: 端口 $p 已被占用，服务将启动失败。请改 $PREFIX/config.json 里的 server.httpPort / mqtt.port" >&2
    ss -lntp 2>/dev/null | grep -E "[:.]$p\$" >&2 || true
  fi
done

echo "==> 安装 systemd 服务"
cp -f "$SRC_DIR/deploy/lingshen-core.service" /etc/systemd/system/lingshen-core.service
systemctl daemon-reload

echo "==> 放行端口"
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port=$HTTP_PORT/tcp >/dev/null
  firewall-cmd --permanent --add-port=$MQTT_PORT/tcp >/dev/null
  firewall-cmd --reload >/dev/null
  echo "    已放行 $HTTP_PORT/tcp $MQTT_PORT/tcp"
else
  echo "    未检测到运行中的 firewalld，请自行放行 $HTTP_PORT/tcp $MQTT_PORT/tcp"
fi

cat <<EOF

安装完成。

  配置：$PREFIX/config.json
  媒体：$PREFIX/media
  TTS：$([ "$HAS_TTS" = "1" ] && echo "$PREFIX/tts" || echo "未安装（离线包不含 tts/ 目录，接口将返回 503）")
  启动：systemctl start lingshen-core
  开机自启：systemctl enable lingshen-core
  查看日志：journalctl -u lingshen-core -f

  设备端 MQTT 服务器请指向本机 $MQTT_PORT 端口；
  自检：curl http://127.0.0.1:$HTTP_PORT/api/health
EOF
