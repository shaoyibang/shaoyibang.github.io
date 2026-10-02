#!/usr/bin/env bash
# =========================================================================
# deploy.sh — 部署与更新（幂等，可以反复跑）
#
# 流程：拉代码 → 校验 compose 与 Caddyfile → 构建启动 → 等健康检查
#
# 用法（在仓库根目录，用**仓库属主**的身份，不是 root）：
#   bash deploy/deploy.sh
#
# 为什么要以仓库属主身份跑：docker 侧的 git 操作会拒绝属主不一致的目录
# （"dubious ownership"）。root 跑 git 也是一样的毛病。
# =========================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
cd "$ROOT"

# shellcheck source=lib.sh
. "$HERE/lib.sh"

[ -f "$ENV_FILE" ] || die "缺少 deploy/.env
先执行：cp deploy/.env.example deploy/.env，填好后 node tools/passwd.mjs --out deploy/.env"

if [ "$(id -u)" -eq 0 ]; then
  OWNER="$(stat -c '%u' . 2>/dev/null || echo 0)"
  if [ "$OWNER" -ne 0 ]; then
    die "别用 root 跑这个脚本（仓库属主是 uid $OWNER）
  sudo -u \"#$OWNER\" -H bash deploy/deploy.sh
或者用那个用户直接登录执行。"
  fi
fi

docker info >/dev/null 2>&1 || die "拿不到 Docker 权限
  sudo usermod -aG docker \$USER   # 然后退出重新登录
  # 或者：sudo -g docker bash deploy/deploy.sh"

say "拉取最新代码"
if [ -d .git ]; then
  git pull --rebase --autostash
  ok "$(git log --oneline -1)"
else
  # 文件是直接上传上去的（没有 .git）也照样能部署 —— 静态站和写作后台都不依赖它。
  # 但同步、自动提交、按提交回滚会没有，所以要说清楚，而不是静默跳过。
  warn "这里不是 git 仓库（没有 .git）—— 跳过拉取"
  warn "  站点和写作后台照常工作，但：自动提交、与 GitHub 同步、按提交回滚都用不了"
  warn "  想要它们：把 .git 目录也传上来，或者在服务器上 clone 一份再重跑"
fi

say "校验配置"
( cd deploy && docker compose config -q ) || die "compose 配置不合法"
ok "docker-compose.yml 合法"

# 用真实挂载进去的那份 Caddyfile 校验，而不是本地副本
( cd deploy && docker compose run --rm --no-deps --entrypoint caddy caddy \
    validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 ) || {
  ( cd deploy && docker compose run --rm --no-deps --entrypoint caddy caddy \
      validate --config /etc/caddy/Caddyfile )
  die "Caddyfile 不合法"
}
ok "Caddyfile 合法"

say "构建并启动"
( cd deploy && docker compose up -d --build )

say "等待服务就绪"
for _ in $(seq 1 30); do
  STATUS="$( cd deploy && docker compose ps --format '{{.Service}} {{.State}} {{.Health}}' | tr '\n' ';' )"
  case "$STATUS" in
    *"admin running healthy"*) ok "admin 已就绪"; break ;;
  esac
  sleep 2
done

( cd deploy && docker compose ps )

cat <<'EOF'

接下来自己确认三件事（详见 deploy/README.md 的验收清单）：

  1. 证书签下来了：      curl -sI https://<域名>/ | head -1
  2. 源码确实拿不到：    curl -s -o /dev/null -w '%{http_code}\n' https://<域名>/blog/posts/
                         # 必须是 404
  3. 后台能打开、能登录：https://<域名>/admin/

看日志：
  cd deploy && docker compose logs -f admin caddy
EOF
