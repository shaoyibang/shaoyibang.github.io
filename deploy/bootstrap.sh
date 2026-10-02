#!/usr/bin/env bash
# =========================================================================
# bootstrap.sh — 一次性服务器准备（幂等，可以重复跑）
#
# 做六件事：
#   1. 装 git 和 Docker
#   2. 加 2G swap（2G 内存的机器别省这个，构建和证书签发时的峰值够呛）
#   3. 建仓库目录并把属主调对
#   4. 装 systemd 定时单元（同步 GitHub、每日备份）
#   5. 检查 GitHub 走 SSH over 443 能不能通
#   6. 打印接下来要做什么
#
# 用法（在仓库根目录，用 root）：
#   sudo bash deploy/bootstrap.sh
# =========================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
UNIT_SRC="$HERE/systemd"
UNIT_DST="/etc/systemd/system"

# say / ok / warn / die 和 envval 都从这里来，构造函数和测试共用同一份
# shellcheck source=lib.sh
. "$HERE/lib.sh"

[ "$(id -u)" -eq 0 ] || die "要用 root 跑：sudo bash deploy/bootstrap.sh"

# --------------------------------------------------------------- 读 .env
# 取值细节（尤其是为什么不 source）见 lib.sh 里 envval 上方的注释。
[ -f "$ENV_FILE" ] || die "缺少 $ENV_FILE
先执行：cp deploy/.env.example deploy/.env，然后填好域名和 uid/gid。"

SITE_ROOT="$(envval SITE_ROOT)"
SITE_UID="$(envval SITE_UID)"
SITE_GID="$(envval SITE_GID)"
SITE_DOMAIN="$(envval SITE_DOMAIN)"
BACKUP_DIR="$(envval BACKUP_DIR)";        BACKUP_DIR="${BACKUP_DIR:-/var/backups/site}"
BACKUP_KEEP_DAYS="$(envval BACKUP_KEEP_DAYS)"; BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

[ -n "$SITE_ROOT" ] || die "deploy/.env 里要设置 SITE_ROOT"
[ -n "$SITE_UID" ]  || die "deploy/.env 里要设置 SITE_UID（用 id -u 查）"
[ -n "$SITE_GID" ]  || die "deploy/.env 里要设置 SITE_GID（用 id -g 查）"
[ -n "$SITE_DOMAIN" ] || die "deploy/.env 里要设置 SITE_DOMAIN"

if [ -z "$(envval ADMIN_PASSWORD_HASH)" ] || [ -z "$(envval SESSION_SECRET)" ]; then
  die "deploy/.env 里 ADMIN_PASSWORD_HASH 或 SESSION_SECRET 是空的
先生成：node tools/passwd.mjs --out deploy/.env"
fi

say "部署参数"
ok "仓库根目录：$SITE_ROOT"
ok "属主：${SITE_UID}:${SITE_GID}"
ok "域名：$SITE_DOMAIN"
ok "备份目录：$BACKUP_DIR（保留 ${BACKUP_KEEP_DAYS} 天）"

# ------------------------------------------------------------ 1. 装依赖
say "安装 git 与 Docker"

PKG=""
if command -v apt-get >/dev/null 2>&1; then PKG=apt
elif command -v dnf >/dev/null 2>&1; then PKG=dnf
elif command -v yum >/dev/null 2>&1; then PKG=yum
else die "认不出包管理器（不是 apt/dnf/yum）。请手工安装 git 和 docker，再重跑本脚本。"
fi

pkg_install() {
  case "$PKG" in
    apt) DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" ;;
    dnf) dnf install -y -q "$@" ;;
    yum) yum install -y -q "$@" ;;
  esac
}

if ! command -v git >/dev/null 2>&1; then
  [ "$PKG" = apt ] && apt-get update -qq
  pkg_install git ca-certificates
fi
ok "git：$(git --version)"

# ssh-keygen 也要在：服务器得有**自己的**密钥才能推回 GitHub（见第 5 步）。
# 干净服务器上通常有 openssh-client，但别赌。
if ! command -v ssh-keygen >/dev/null 2>&1; then
  case "$PKG" in
    apt) pkg_install openssh-client || warn "openssh-client 装失败" ;;
    *)   pkg_install openssh-clients || pkg_install openssh || warn "openssh 客户端装失败" ;;
  esac
fi
command -v ssh-keygen >/dev/null 2>&1 && ok "ssh-keygen 可用"

if ! command -v docker >/dev/null 2>&1; then
  warn "没装 Docker，正在装发行版自带的包（比官方脚本在国内更稳）"
  case "$PKG" in
    apt)
      apt-get update -qq
      pkg_install docker.io || warn "docker.io 装失败"
      pkg_install docker-compose-v2 || pkg_install docker-compose || warn "compose 插件装失败"
      ;;
    *)
      pkg_install docker || warn "docker 装失败"
      pkg_install docker-compose-plugin || pkg_install docker-compose || warn "compose 插件装失败"
      ;;
  esac
fi

if ! command -v docker >/dev/null 2>&1; then
  die "Docker 还是没装上。可以试官方脚本：curl -fsSL https://get.docker.com | sh
（国内网络下它偶尔会卡在拉包那一步，多试一次或换镜像源）"
fi
systemctl enable --now docker >/dev/null 2>&1 || true

if docker compose version >/dev/null 2>&1; then
  ok "docker compose：$(docker compose version --short 2>/dev/null || echo 可用)"
else
  die "Docker 装上了，但取不到 compose 插件。检查：docker compose version
（旧版是 docker-compose，本仓库的脚本统一用 docker compose 这个子命令）"
fi

# deploy.sh 要以仓库属主的身份跑（git 不接受属主不一致的目录），
# 所以那个人得能直接用 docker，否则每次都得 sudo。
DOCKER_USER="$(getent passwd "$SITE_UID" 2>/dev/null | cut -d: -f1 || true)"
if [ -n "$DOCKER_USER" ]; then
  if id -nG "$DOCKER_USER" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
    ok "$DOCKER_USER 已经在 docker 组里"
  else
    usermod -aG docker "$DOCKER_USER"
    warn "已把 $DOCKER_USER 加进 docker 组 —— 需要**重新登录**才生效"
  fi
fi

# ----------------------------------------------------------- 2. 加 swap
say "检查 swap"
if swapon --show 2>/dev/null | grep -q .; then
  ok "已有 swap：$(swapon --show=NAME,SIZE --noheadings 2>/dev/null | tr '\n' ' ')"
else
  warn "没有 swap，正在建 2G 的"
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ok "swap 已启用并写进 /etc/fstab（重启后仍在）"
fi
# 2G 内存的机器上，默认 swappiness=60 会让内核过早把常驻进程换出去
echo 'vm.swappiness=10' > /etc/sysctl.d/99-sean-site.conf
sysctl -q -w vm.swappiness=10 || true
ok "vm.swappiness=10"

# ------------------------------------------------- 3. 仓库目录与属主
say "检查仓库目录"
if [ ! -d "$SITE_ROOT/.git" ]; then
  warn "$SITE_ROOT 还不是一个 git 仓库。请先 clone 好再跑本脚本："
  warn "  git clone git@github.com:shaoyibang/shaoyibang.github.io.git $SITE_ROOT"
  warn "（继续执行剩下的步骤，目录属主先调好）"
fi
mkdir -p "$SITE_ROOT"
chown -R "${SITE_UID}:${SITE_GID}" "$SITE_ROOT" 2>/dev/null || warn "chown 失败，检查 $SITE_UID/$SITE_GID 是否存在"
chmod 750 "$SITE_ROOT"
ok "属主已设为 ${SITE_UID}:${SITE_GID}"

if [ -f "$SITE_ROOT/deploy/.env" ]; then
  chmod 600 "$SITE_ROOT/deploy/.env"
  ok "deploy/.env 权限已收紧到 600"
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
ok "备份目录已建好：$BACKUP_DIR"

# ------------------------------------------------------- 4. systemd 单元
say "安装 systemd 定时单元"
for f in "$UNIT_SRC"/*.in; do
  name="$(basename "$f" .in)"
  sed -e "s|@SITE_ROOT@|$SITE_ROOT|g" \
      -e "s|@SITE_UID@|$SITE_UID|g" \
      -e "s|@SITE_GID@|$SITE_GID|g" \
      -e "s|@BACKUP_DIR@|$BACKUP_DIR|g" \
      -e "s|@BACKUP_KEEP_DAYS@|$BACKUP_KEEP_DAYS|g" \
      "$f" > "$UNIT_DST/$name"
  chmod 644 "$UNIT_DST/$name"
  ok "$name"
done
systemctl daemon-reload
systemctl enable --now site-sync.timer site-backup.timer >/dev/null 2>&1 || \
  warn "定时器启用失败，检查：systemctl status site-sync.timer"
ok "已启用：site-sync.timer（每 10 分钟）、site-backup.timer（每天 04:00）"

# --------------------------------- 5. GitHub 部署密钥与连通性
say "GitHub 部署密钥与连通性"

GIT_HOME="$(getent passwd "$SITE_UID" 2>/dev/null | cut -d: -f6 || true)"
if [ -z "$GIT_HOME" ] || [ ! -d "$GIT_HOME" ]; then
  warn "拿不到 uid $SITE_UID 的家目录，跳过密钥检查（GitHub 同步会失败）"
else
  SSH_DIR="$GIT_HOME/.ssh"
  mkdir -p "$SSH_DIR"
  chmod 700 "$SSH_DIR"

  # 服务器需要**它自己的**密钥。不要把你本机的个人私钥拷上来 —— 那等于把整个
  # GitHub 账号放到服务器上。这里生成的这一对专门给这台机器，加到仓库的
  # Deploy keys 里，权限只限这一个仓库。
  #
  # 无口令是必须的：systemd 定时器在无人值守的情况下推送，没有地方输口令。
  KEY="$SSH_DIR/id_ed25519"
  HAVE_KEY=""
  for k in "$KEY" "$SSH_DIR/id_rsa" "$SSH_DIR/id_ecdsa"; do
    [ -f "$k" ] && { HAVE_KEY="$k"; break; }
  done
  if [ -n "$HAVE_KEY" ]; then
    ok "这台机器上已经有 SSH 密钥：$HAVE_KEY"
  elif command -v ssh-keygen >/dev/null 2>&1; then
    if ssh-keygen -t ed25519 -N "" -C "site-sync@$(hostname 2>/dev/null || echo server)" -f "$KEY" >/dev/null 2>&1; then
      chown -R "${SITE_UID}:${SITE_GID}" "$SSH_DIR"
      chmod 600 "$KEY"; chmod 644 "$KEY.pub"
      ok "已生成 $KEY（ed25519，无口令）"
    else
      warn "ssh-keygen 失败，请手工：sudo -u \"#${SITE_UID}\" ssh-keygen -t ed25519"
    fi
  else
    warn "没有 ssh-keygen，无法自动生成密钥"
  fi

  # 国内多数网络到 github.com:443 不通，但 ssh.github.com:443 通。
  # 这一段就是把 git 对 github 的访问改道到那个端口。
  SSH_CFG="$SSH_DIR/config"
  if [ -f "$SSH_CFG" ] && grep -q 'ssh\.github\.com' "$SSH_CFG"; then
    ok "~/.ssh/config 里已经有 ssh.github.com 的配置"
  elif timeout 6 bash -c 'exec 3<>/dev/tcp/ssh.github.com/443' 2>/dev/null; then
    [ -f "$SSH_CFG" ] && cp "$SSH_CFG" "$SSH_CFG.bak.$(date +%s)"
    cat >> "$SSH_CFG" <<'EOF'

# 由 deploy/bootstrap.sh 添加：github.com 的 443 常被阻断，改走 SSH over 443
Host github.com
  HostName ssh.github.com
  Port 443
  User git
EOF
    chmod 600 "$SSH_CFG"
    chown -R "${SITE_UID}:${SITE_GID}" "$SSH_DIR"
    ok "已写入 $SSH_CFG（原文件如有则备份为 .bak.*）"
  else
    warn "ssh.github.com:443 不可达，没有写 ssh config"
  fi

  # 把公钥打出来 —— 这一步不做完，服务器永远推不回 GitHub
  PUB=""
  for k in "$KEY.pub" "$SSH_DIR/id_rsa.pub" "$SSH_DIR/id_ecdsa.pub"; do
    [ -f "$k" ] && { PUB="$k"; break; }
  done
  if [ -n "$PUB" ]; then
    cat <<EOF

$(printf '\033[1m还需要你手动做一件事\033[0m')：把这台机器的公钥加到 GitHub ——
  仓库 → Settings → Deploy keys → Add deploy key
  **勾上 Allow write access**（不勾就只能拉、不能推）

$(sed 's/^/    /' "$PUB")

  加完之后验证（应该看到 Hi / successfully authenticated）：
    sudo -u "#${SITE_UID}" ssh -T git@github.com
EOF
  else
    warn "没有可用的公钥 —— GitHub 同步会一直失败"
  fi
fi

if timeout 6 bash -c 'exec 3<>/dev/tcp/github.com/443' 2>/dev/null; then
  ok "github.com:443 可达"
else
  ok "github.com:443 不可达（预期之内，走上面的 SSH over 443）"
fi
if timeout 6 bash -c 'exec 3<>/dev/tcp/ssh.github.com/443' 2>/dev/null; then
  ok "ssh.github.com:443 可达"
else
  warn "ssh.github.com:443 也不可达。"
  warn "服务器推不回 GitHub 时，内容仍然会本地提交，但仓库和 CI 拿不到更新。"
  warn "退路见 deploy/README.md 的「GitHub 不通怎么办」一节（换 Gitee/Codeup 镜像）。"
fi

# --------------------------------------------------------------- 收尾
cat <<EOF

$(printf '\033[1m接下来\033[0m')

  1) 填好凭据（如果还没）：
       node tools/passwd.mjs --out deploy/.env

  2) 确认域名已备案并解析到本机公网 IP，安全组放行 80 与 443：
       dig +short $SITE_DOMAIN

  3) 首次上线：
       bash deploy/deploy.sh

  4) 验收（照着 deploy/README.md 的「上线验收清单」逐条过）：
       curl -I https://$SITE_DOMAIN/
       curl -I https://$SITE_DOMAIN/blog/posts/   # 必须是 404

EOF
