#!/bin/sh
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BUS_DIR=$(CDPATH= cd -- "$DIR/../../antlegion-bus" && pwd)
ENV_FILE="$DIR/.env"

command -v node >/dev/null 2>&1 || { echo '需要安装 Node.js 20 或更高版本。' >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo '需要安装 npm。' >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)' || {
  echo '需要 Node.js 20 或更高版本。' >&2; exit 1;
}

if [ ! -f "$ENV_FILE" ]; then
  umask 077
  SECRET=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  (set -C; printf 'ANTLEGION_BUS_SECRET=%s\nANTLEGION_BIND=127.0.0.1\nANTLEGION_PORT=28090\nANTLEGION_FSYNC=everysec\n' "$SECRET" > "$ENV_FILE") || {
    echo '配置已存在或无法创建，请检查后重新运行。' >&2; exit 1;
  }
  echo "已创建 ${ENV_FILE}，请妥善备份。"
fi

set -a
. "$ENV_FILE"
set +a
unset ANTLEGION_API_TOKEN
: "${ANTLEGION_BUS_SECRET:?配置中缺少 ANTLEGION_BUS_SECRET}"
export HOST="${ANTLEGION_BIND:-127.0.0.1}"
export PORT="${ANTLEGION_PORT:-28090}"
export ANTLEGION_DATA_DIR="$DIR/.data"
export ANTLEGION_FSYNC="${ANTLEGION_FSYNC:-everysec}"

if ! (cd "$BUS_DIR" && npm ls --depth=0 >/dev/null 2>&1); then
  echo '安装总线依赖...'
  (cd "$BUS_DIR" && npm ci)
fi
echo '构建总线...'
(cd "$BUS_DIR" && npm run build)
echo "控制台: http://127.0.0.1:${PORT}/console"
echo "数据目录: ${ANTLEGION_DATA_DIR}；按 Ctrl-C 停止。"
exec node "$BUS_DIR/dist/index.js"
