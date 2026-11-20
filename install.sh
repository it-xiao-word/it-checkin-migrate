#!/usr/bin/env bash
# ============================================================================
# IT 机房打卡服务 · 通用迁移部署脚本
# ----------------------------------------------------------------------------
# 适用于任意 Linux 机器 / 任意安装目录，全新部署或覆盖升级均可。
#
# 用法：
#   sudo bash install.sh                       # 交互引导（推荐）
#   sudo APP_DIR=/opt/it-checkin bash install.sh          # 指定目录，非交互
#   sudo APP_DIR=/opt/it-checkin AUTO=1 bash install.sh    # 全自动（含自签证书+systemd）
#
# 行为：
#   1) 校验 Node.js >= 18
#   2) 把当前包内容复制到 APP_DIR（保留 data/ 与 uploads/ 不覆盖）
#   3) npm ci 安装生产依赖
#   4) 可选：生成自签 HTTPS 证书（手机端 GPS/摄像头需要）
#   5) 可选：注册 systemd 服务并设为开机自启
#   6) 启动服务并健康检查
# ============================================================================
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-}"
AUTO="${AUTO:-0}"

say()  { echo -e "\033[1;36m[install]\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn]\033[0m $*"; }
err()  { echo -e "\033[1;31m[error]\033[0m $*" >&2; }

ask_yes() {
  # $1=提示 $2=默认(y/n)
  local prompt="$1" def="${2:-y}" ans
  if [ "$AUTO" = "1" ]; then ans="$def"; else
    read -r -p "$prompt [$( [ "$def" = y ] && echo Y/n || echo y/N )]: " ans || true
  fi
  case "${ans:-$def}" in [Yy]*) return 0;; *) return 1;; esac
}

# ---------- 1. 确定安装目录 ----------
if [ -z "$APP_DIR" ]; then
  if [ -t 0 ] && [ "$AUTO" != "1" ]; then
    read -r -p "安装目录（默认 /opt/it-checkin）: " APP_DIR || true
  fi
  APP_DIR="${APP_DIR:-/opt/it-checkin}"
fi
say "源目录   : $SRC"
say "安装目录 : $APP_DIR"
mkdir -p "$APP_DIR"

# ---------- 2. 校验 Node ----------
if ! command -v node >/dev/null 2>&1; then
  err "未找到 node。请先安装 Node.js 18+（https://nodejs.org）"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  err "Node.js 版本过低（当前 $(node -v)，需要 >= 18）"
  exit 1
fi
say "Node 版本: $(node -v)"

# ---------- 3. 复制文件（保护 data/ 与 uploads/）----------
say "正在复制程序文件（保留已有 data/ 与 uploads/）..."
STAMP="$(date +%Y%m%d_%H%M%S)"
# 备份旧数据
if [ -d "$APP_DIR/data" ] || [ -d "$APP_DIR/uploads" ]; then
  BAK="/tmp/it-checkin-data-backup_${STAMP}.tar.gz"
  tar czf "$BAK" -C "$APP_DIR" data uploads 2>/dev/null || true
  say "已备份旧数据到: $BAK"
fi
TMP_COPY="$(mktemp -d)"
cp -a "$SRC/." "$TMP_COPY/" 2>/dev/null || cp -R "$SRC/." "$TMP_COPY/"
# 用 rsync 若可用，否则 cp 逐项，排除 install.sh 自身之外都覆盖，但保留 data/uploads
if command -v rsync >/dev/null 2>&1; then
  rsync -a --exclude='data/' --exclude='uploads/' --exclude='node_modules/' "$TMP_COPY/" "$APP_DIR/"
else
  for item in "$TMP_COPY"/* "$TMP_COPY"/.[!.]*; do
    [ -e "$item" ] || continue
    name="$(basename "$item")"
    case "$name" in data|uploads|node_modules) continue;; esac
    cp -a "$item" "$APP_DIR/" 2>/dev/null || true
  done
fi
rm -rf "$TMP_COPY"
mkdir -p "$APP_DIR/data" "$APP_DIR/uploads"

# ---------- 4. 安装依赖 ----------
cd "$APP_DIR"
if [ -f package-lock.json ]; then
  say "安装依赖 (npm ci --omit=dev)..."
  npm ci --omit=dev --no-audit --no-fund
else
  say "安装依赖 (npm install --omit=dev)..."
  npm install --omit=dev --no-audit --no-fund
fi

# ---------- 5. 可选：自签 HTTPS 证书 ----------
ENABLE_SSL=0
mkdir -p "$APP_DIR/certs"
if [ -f "$APP_DIR/certs/key.pem" ] && [ -f "$APP_DIR/certs/cert.pem" ]; then
  say "检测到已有证书，将启用 HTTPS"
  ENABLE_SSL=1
elif ask_yes "是否生成自签 HTTPS 证书（手机 GPS/摄像头需要）?" y; then
  if command -v openssl >/dev/null 2>&1; then
    say "生成自签证书（有效期 365 天）..."
    openssl req -x509 -newkey rsa:2048 -nodes \
      -keyout "$APP_DIR/certs/key.pem" \
      -out "$APP_DIR/certs/cert.pem" \
      -days 365 -subj "/CN=it-checkin" >/dev/null 2>&1
    chmod 600 "$APP_DIR/certs/key.pem"
    ENABLE_SSL=1
    warn "自签证书需在手机/浏览器手动信任；正式对外请用受信任的证书。"
  else
    warn "未找到 openssl，跳过证书生成（仅 HTTP 可用）"
  fi
fi

# ---------- 6. 写环境文件 & systemd 服务 ----------
ENV_FILE="$APP_DIR/.env"
PORT="${PORT:-3000}"
SSL_PORT="${SSL_PORT:-3443}"
INIT_PW="${INIT_ADMIN_PASSWORD:-}"
{
  echo "PORT=$PORT"
  echo "SSL_PORT=$SSL_PORT"
  if [ "$ENABLE_SSL" = "1" ]; then
    echo "SSL_KEY=$APP_DIR/certs/key.pem"
    echo "SSL_CERT=$APP_DIR/certs/cert.pem"
  fi
  [ -n "$INIT_PW" ] && echo "INIT_ADMIN_PASSWORD=$INIT_PW"
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"
say "已写入环境文件: $ENV_FILE"

SERVICE_NAME="it-checkin"
if command -v systemctl >/dev/null 2>&1 && [ -d /etc/systemd/system ]; then
  if ask_yes "是否注册 systemd 服务并开机自启?" y; then
    NODE_BIN="$(command -v node)"
    cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=IT Check-in Service
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $APP_DIR/server.js
Restart=on-failure
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
    systemctl restart "$SERVICE_NAME"
    say "systemd 服务已注册并启动: systemctl status $SERVICE_NAME"
  else
    say "跳过 systemd。手动启动: cd $APP_DIR && set -a && . ./.env && set +a && node server.js"
  fi
else
  warn "未检测到 systemd，跳过服务注册。后台启动示例："
  say "  cd $APP_DIR && set -a && . ./.env && set +a && nohup node server.js >app.log 2>&1 &"
fi

# ---------- 7. 健康检查 ----------
say "等待服务启动..."
sleep 3
if curl -fsS "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
  say "✅ HTTP 健康检查通过: http://服务器IP:${PORT}/"
else
  warn "HTTP 未就绪，请检查日志: systemctl status $SERVICE_NAME 或查看 app.log"
fi
if [ "$ENABLE_SSL" = "1" ]; then
  if curl -kfsS "https://127.0.0.1:${SSL_PORT}/" >/dev/null 2>&1; then
    say "✅ HTTPS 健康检查通过: https://服务器IP:${SSL_PORT}/"
  else
    warn "HTTPS 未就绪，请检查证书与服务日志"
  fi
fi

echo
say "========== 部署完成 =========="
say "安装目录 : $APP_DIR"
say "管理端   : http://服务器IP:${PORT}/admin.html"
say "初始密码 : 见启动日志，或读取 $APP_DIR/data/first_password.txt（权限 600）"
say "           （如设置了 INIT_ADMIN_PASSWORD 则为该值；首次登录后请改密并删除该文件）"
say "数据目录 : $APP_DIR/data（含数据库与 JWT 密钥，请纳入备份）"
