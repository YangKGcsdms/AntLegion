#!/bin/sh
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ENV_FILE="$DIR/.env"
init() {
  if [ ! -f "$ENV_FILE" ]; then
    umask 077
    TOKEN=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
    SECRET=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
    (set -C; printf 'ANTLEGION_API_TOKEN=%s\nANTLEGION_BUS_SECRET=%s\nANTLEGION_BIND=127.0.0.1\nANTLEGION_PORT=28090\nANTLEGION_FSYNC=everysec\n' "$TOKEN" "$SECRET" > "$ENV_FILE") || { echo '配置已存在，请重新运行'; exit 1; }
    echo "已创建 $ENV_FILE，请妥善备份。"
  fi
}
compose() { docker compose --env-file "$ENV_FILE" -f "$DIR/compose.yml" -p antlegion-home "$@"; }
demo_compose() { ANTLEGION_PORT=28091 docker compose --env-file "$ENV_FILE" -f "$DIR/compose.yml" -p antlegion-demo "$@"; }
case "${1:-up}" in
  up) init; compose up -d --build bus; echo '控制台: http://127.0.0.1:28090/console（端口以 .env 配置为准）'; echo "访问令牌: 查看 $ENV_FILE 中的 ANTLEGION_API_TOKEN" ;;
  stop) init; compose stop ;;
  status) init; compose ps ;;
  password) if [ ! -f "$ENV_FILE" ]; then echo '配置尚未创建，请先运行 up。' >&2; exit 1; fi; sed -n 's/^ANTLEGION_API_TOKEN=//p' "$ENV_FILE" ;;
  logs) init; compose logs -f --tail=100 bus ;;
  demo) init; demo_compose up -d --build bus; echo '演示控制台: http://127.0.0.1:28091/console'; demo_compose --profile demo run --rm demo ;;
  demo-stop) init; demo_compose down ;;
  *) echo "用法: $0 {up|stop|status|password|logs|demo|demo-stop}"; exit 2 ;;
esac
