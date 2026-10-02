#!/usr/bin/env bash
# =========================================================================
# preflight.sh — 上线前体检（在服务器上跑）
#
# 只读检查，不改系统。唯一的例外是镜像拉取那一步（会真的下载约 200 MB 的
# 镜像）—— 那正是最需要提前撞一次的墙，不想下载就加 --skip-pull。
#
# 用法（在仓库根目录，不需要 root）：
#   bash deploy/preflight.sh
#   bash deploy/preflight.sh --skip-pull
#
# 它查的是"部署会不会失败"，不是"部署完了对不对"。跑完照着提示修掉 ✗，
# 再执行 bash deploy/deploy.sh；部署完的验收清单在 deploy/README.md。
#
# 为什么值得先跑一遍：下面这些失败原因里，有大半的报错信息都不会指向真正
# 的原因 —— 证书签不下来可能只是 DNS 没生效，容器起不来可能只是 80 被占了，
# 后台能存文章但宿主 git 一片红可能只是 uid 填错了一位。
# =========================================================================
set -uo pipefail   # 刻意不用 -e：一项检查失败不该中断整个体检

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh" 2>/dev/null || { echo "找不到 deploy/lib.sh，请在仓库里运行"; exit 1; }

SKIP_PULL=0
for a in "$@"; do
  case "$a" in
    --skip-pull) SKIP_PULL=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$a"; exit 2 ;;
  esac
done

N_PASS=0; N_WARN=0; N_BAD=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; N_PASS=$((N_PASS+1)); }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; N_WARN=$((N_WARN+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; N_BAD=$((N_BAD+1)); }
sec()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

echo "上线前体检 —— 只读检查，不改系统"
[ -f "$ENV_FILE" ] || warn "还没有 $ENV_FILE（很多项会因为缺少配置而跳过；先 cp deploy/.env.example deploy/.env）"

# ------------------------------------------------------------------ 系统
sec "系统与架构"
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  pass "${PRETTY_NAME:-未知发行版}"
else
  warn "读不到 /etc/os-release"
fi
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|aarch64|arm64) pass "架构 $ARCH" ;;
  *) warn "架构 $ARCH 不常见，镜像 tag 要自己确认" ;;
esac
pass "内核 $(uname -r)"

# ------------------------------------------------------------------ 资源
sec "资源"
MEM_MB="$(awk '/^MemTotal:/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
if [ "$MEM_MB" -ge 1800 ]; then pass "内存 ${MEM_MB} MB"
elif [ "$MEM_MB" -gt 0 ]; then warn "内存只有 ${MEM_MB} MB（低于 2G；证书签发和构建时的峰值可能不够）"
else warn "读不到内存信息"; fi

SWAP_MB="$(awk '/^SwapTotal:/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
if [ "$SWAP_MB" -ge 512 ]; then pass "swap ${SWAP_MB} MB"
else warn "没有 swap —— bootstrap.sh 会加 2G；2G 内存的机器别省这个"; fi

if have df; then
  DISK_MB="$(df -Pm / 2>/dev/null | awk 'NR==2{print $4}')"
  if [ -n "${DISK_MB:-}" ] && [ "$DISK_MB" -ge 8000 ]; then pass "根分区可用 ${DISK_MB} MB"
  else warn "根分区只剩 ${DISK_MB:-?} MB —— 镜像加证书缓存建议留 8 GB 以上"; fi
fi

# ------------------------------------------------------- 时间（TLS 依赖它）
sec "系统时间"
if have timedatectl && timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -q '^yes$'; then
  pass "时间已同步（$(date '+%F %T %Z')）"
else
  warn "时间可能没同步，证书校验会因此失败：sudo timedatectl set-ntp true"
fi

# ------------------------------------------------------------ 80 / 443
sec "端口 80 / 443"
if have ss; then
  for p in 80 443; do
    LINE="$(ss -lntp 2>/dev/null | awk -v p=":$p" '$4 ~ p"$" {print; exit}')"
    if [ -n "$LINE" ]; then
      if printf '%s' "$LINE" | grep -q docker; then
        pass "$p 已被 Docker 占用（如果本站已经在跑，这是正常的）"
      else
        bad "$p 已被别的进程占用：$LINE"
      fi
    else
      pass "$p 空闲"
    fi
  done
else
  warn "没有 ss 命令，跳过端口检查"
fi

# ------------------------------------------------------------ 本机防火墙
sec "本机防火墙"
FW_DONE=0
if have ufw && ufw status 2>/dev/null | grep -q '^Status: active'; then
  FW_DONE=1
  for p in 80 443; do
    if ufw status 2>/dev/null | grep -qE "^$p(/tcp)?\b"; then pass "ufw 放行 $p"
    else bad "ufw 没放行 $p：sudo ufw allow $p/tcp"; fi
  done
elif have firewall-cmd && firewall-cmd --state 2>/dev/null | grep -q running; then
  FW_DONE=1
  for p in 80 443; do
    if firewall-cmd --list-ports 2>/dev/null | grep -q "$p/tcp"; then pass "firewalld 放行 $p"
    else bad "firewalld 没放行 $p：sudo firewall-cmd --permanent --add-port=$p/tcp && sudo firewall-cmd --reload"; fi
  done
fi
if [ "$FW_DONE" -eq 0 ]; then
  pass "ufw / firewalld 都没启用（那就要靠云厂商的安全组放行 80 和 443）"
fi

# --------------------------------------------------------------- SELinux
sec "SELinux"
if have getenforce; then
  MODE="$(getenforce 2>/dev/null || echo Unknown)"
  if [ "$MODE" = "Enforcing" ]; then
    warn "SELinux 是 Enforcing：bind mount 进容器可能被拒，卷后面要加 :z（docker-compose.yml）"
  else
    pass "SELinux $MODE"
  fi
else
  pass "没有 SELinux（Debian / Ubuntu 常见）"
fi

# ---------------------------------------------------------------- Docker
sec "Docker"
DOCKER_OK=0
if have docker; then
  # 注意：光有 CLI 不算数。Docker Desktop 会往 WSL 里塞一个壳，
  # `command -v docker` 能找到，但真正执行时它只是打印一句"没有集成"。
  # 所以版本号拿不到就当成"CLI 在但不可用"，别报绿灯。
  DVER="$(docker --version 2>/dev/null | sed -e 's/^Docker version //' -e 's/,.*$//')"
  if [ -n "$DVER" ]; then pass "docker CLI $DVER"
  else warn "docker 命令在，但拿不到版本 —— 可能只是个壳（Docker Desktop 的 WSL 集成未开启），不能当成可用"; fi

  if docker info >/dev/null 2>&1; then
    DOCKER_OK=1
    pass "守护进程可访问"
    if docker compose version >/dev/null 2>&1; then
      pass "compose $(docker compose version --short 2>/dev/null || echo 可用)"
    else
      bad "取不到 compose 插件（需要 docker-compose-v2 或 docker-compose-plugin）"
    fi
  else
    bad "连不上守护进程：服务没起，或当前用户不在 docker 组（sudo usermod -aG docker \$USER 后重新登录）"
  fi
else
  bad "没装 docker —— 跑 sudo bash deploy/bootstrap.sh"
fi

# ------------------------------------------------------------- 镜像拉取
sec "镜像拉取（国内网络最容易卡在这一步）"
if [ "$DOCKER_OK" -ne 1 ]; then
  warn "守护进程不可用，跳过"
elif [ "$SKIP_PULL" -eq 1 ]; then
  warn "按 --skip-pull 跳过了（这一步会下载约 200 MB）"
else
  echo "  （会真的下载镜像，约 200 MB；不想下载就加 --skip-pull）"
  PULL_FAIL=0
  for img in node:22-alpine caddy:2.11-alpine; do
    if timeout 120 docker pull -q "$img" >/dev/null 2>&1; then
      pass "拉到了 $img"
    else
      bad "拉不动 $img"
      PULL_FAIL=1
    fi
  done
  if [ "$PULL_FAIL" -eq 1 ]; then
    cat <<'EOF'

  镜像拉不动基本都是 Docker Hub 从国内不可达。配一个加速器再重试：

    sudo mkdir -p /etc/docker
    sudo tee /etc/docker/daemon.json >/dev/null <<'JSON'
    { "registry-mirrors": ["https://<你的加速器地址>"] }
    JSON
    sudo systemctl restart docker

  加速器地址从云厂商的控制台拿（阿里云「容器镜像服务」、腾讯云「容器镜像服务」
  都有各自专属的地址，不要用网上抄来的公共地址，大多已经失效）。
  配好之后重新跑本脚本确认能拉到，再去 deploy.sh。

EOF
  fi
fi

# ---------------------------------------------------------------- GitHub
sec "GitHub 连通性"
if timeout 6 bash -c 'exec 3<>/dev/tcp/github.com/443' 2>/dev/null; then
  pass "github.com:443 可达"
else
  warn "github.com:443 不可达（HTTPS 推送会失败，改用 SSH over 443）"
fi
if timeout 6 bash -c 'exec 3<>/dev/tcp/ssh.github.com/443' 2>/dev/null; then
  pass "ssh.github.com:443 可达"
else
  bad "ssh.github.com:443 也不可达 —— 服务器推不回 GitHub，退路见 deploy/README.md 的「GitHub 不通怎么办」"
fi

# 服务器要推回 GitHub，必须有它自己的密钥并被加进仓库的 Deploy keys。
# 这一步最容易漏：bootstrap.sh 会生成密钥并把公钥打出来，但"加到 GitHub"要人做。
if [ -n "$(envval SITE_UID)" ] && [ "$(id -u)" = "$(envval SITE_UID)" ]; then
  KEY_FOUND=""
  for k in "$HOME/.ssh/id_ed25519" "$HOME/.ssh/id_rsa" "$HOME/.ssh/id_ecdsa"; do
    [ -f "$k" ] && { KEY_FOUND="$k"; break; }
  done
  if [ -n "$KEY_FOUND" ]; then
    pass "当前用户有 SSH 密钥：$KEY_FOUND"
    if [ -f "$HOME/.ssh/config" ] && grep -q 'ssh\.github\.com' "$HOME/.ssh/config"; then
      pass "~/.ssh/config 已把 github.com 改道到 ssh.github.com:443"
    else
      warn "~/.ssh/config 里没有改道配置（bootstrap.sh 会加）"
    fi
    echo "  （要确认密钥是否已被 GitHub 接受，跑：ssh -T git@github.com）"
  else
    bad "当前用户没有 SSH 密钥 —— 服务器推不回 GitHub（跑 sudo bash deploy/bootstrap.sh 生成）"
  fi
else
  warn "当前不是 SITE_UID 用户，跳过密钥检查（用那个用户跑一遍才准）"
fi

# ------------------------------------------------------- 域名与解析
sec "域名解析"
DOMAIN="$(envval SITE_DOMAIN)"
if [ -z "$DOMAIN" ]; then
  warn "deploy/.env 里还没填 SITE_DOMAIN，跳过"
else
  RESOLVED=""
  for r in 223.5.5.5 119.29.29.29 8.8.8.8; do
    if have dig; then RESOLVED="$(dig +short +time=3 +tries=1 "@$r" "$DOMAIN" A 2>/dev/null | grep -E '^[0-9.]+$' | head -1)"
    elif have nslookup; then RESOLVED="$(nslookup "$DOMAIN" "$r" 2>/dev/null | awk '/^Address: /{print $2; exit}')"; fi
    [ -n "$RESOLVED" ] && break
  done
  [ -z "$RESOLVED" ] && RESOLVED="$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1; exit}')"

  if [ -z "$RESOLVED" ]; then
    bad "$DOMAIN 解析不出 A 记录 —— 没备案、解析没配、或还没生效。证书一定签不下来"
  else
    pass "$DOMAIN -> $RESOLVED"
    PUB=""
    if have curl; then
      for u in https://api.ipify.org https://ifconfig.me/ip https://myip.ipip.net; do
        PUB="$(curl -s --max-time 6 "$u" 2>/dev/null | tr -d '\r\n' | grep -oE '^[0-9]+(\.[0-9]+){3}')"
        [ -n "$PUB" ] && break
      done
    fi
    if [ -z "$PUB" ]; then
      warn "探测不到本机公网 IP（拿不到外部回显服务），没法比对解析是否正确"
    elif [ "$PUB" = "$RESOLVED" ]; then
      pass "解析指向本机公网 IP（$PUB）"
    else
      bad "$DOMAIN 解析到 $RESOLVED，但本机公网 IP 是 $PUB —— 不一致，证书签不下来。也可能是这台机器在 NAT 后面，那就要在云控制台做端口映射"
    fi
  fi
fi

# ------------------------------------------------------- 仓库与凭据
sec "仓库与凭据"
SITE_ROOT="$(envval SITE_ROOT)"
SITE_UID="$(envval SITE_UID)"
SITE_GID="$(envval SITE_GID)"

if [ -z "$SITE_ROOT" ]; then
  warn "deploy/.env 里还没填 SITE_ROOT，跳过仓库检查"
else
  if [ -d "$SITE_ROOT/.git" ]; then
    pass "$SITE_ROOT 是一个 git 仓库"
    ( cd "$SITE_ROOT" && git status --porcelain >/dev/null 2>&1 && pass "git 能正常工作（没有 dubious ownership）" ) \
      || warn "git 在这个目录上工作不正常，检查属主"
  else
    warn "$SITE_ROOT 还不是 git 仓库（先 clone）"
  fi
  if [ -d "$SITE_ROOT" ] && have stat; then
    OWNER="$(stat -c '%u' "$SITE_ROOT" 2>/dev/null)"
    if [ -n "$SITE_UID" ] && [ "$OWNER" = "$SITE_UID" ]; then
      pass "目录属主 uid=$OWNER 与 SITE_UID 一致"
    elif [ -n "$SITE_UID" ]; then
      bad "目录属主 uid=$OWNER，但 SITE_UID=$SITE_UID —— 容器写出的文件宿主 git 会认不出（sudo chown -R $SITE_UID:$SITE_GID $SITE_ROOT）"
    fi
  fi
  if [ -f "$SITE_ROOT/deploy/.env" ] && have stat; then
    PERM="$(stat -c '%a' "$SITE_ROOT/deploy/.env" 2>/dev/null)"
    if [ "$PERM" = "600" ]; then pass "deploy/.env 权限 600"
    else warn "deploy/.env 权限是 $PERM，建议 chmod 600（里面有会话密钥）"; fi
  fi
fi

# 只报"填没填"和长度，绝不打印值 —— 这个脚本的输出可能被贴进聊天窗口
#
# .env 整个不存在时不要逐项报 ✗：那时候"六项都空"是必然的，把真正的
# 原因（还没建 .env）淹掉了。顶部已经警告过一次，这里就跳过。
if [ ! -f "$ENV_FILE" ]; then
  warn "deploy/.env 不存在，跳过凭据检查"
else
  for k in ADMIN_USER ADMIN_PASSWORD_HASH SESSION_SECRET ACME_EMAIL SITE_UID SITE_GID; do
    v="$(envval "$k")"
    if [ -n "$v" ]; then pass "$k 已填（长度 ${#v}）"
    else bad "$k 是空的"; fi
  done

  HASH="$(envval ADMIN_PASSWORD_HASH)"
  case "$HASH" in
    "") ;;
    scrypt\$*) pass "口令哈希是 scrypt 格式" ;;
    *) bad "口令哈希不是 scrypt 开头 —— 很可能被 shell 展开弄坏过（别 source deploy/.env），重跑 node tools/passwd.mjs --out deploy/.env" ;;
  esac

  SECRET="$(envval SESSION_SECRET)"
  if [ -n "$SECRET" ] && [ "${#SECRET}" -lt 32 ]; then
    bad "SESSION_SECRET 只有 ${#SECRET} 字符，至少要 32（后台会拒绝启动）"
  fi
fi

# ---------------------------------------------------------------- systemd
sec "systemd 定时任务"
if have systemctl && systemctl is-system-running >/dev/null 2>&1; then
  pass "systemd 可用"
  for u in site-sync.timer site-backup.timer; do
    if systemctl list-unit-files "$u" >/dev/null 2>&1 && systemctl is-enabled "$u" >/dev/null 2>&1; then
      pass "$u 已启用"
    else
      warn "$u 还没装（跑 sudo bash deploy/bootstrap.sh）"
    fi
  done
elif have systemctl; then
  warn "systemd 在，但不在正常状态；容器仍可用，只是定时同步与备份装不上（可以改用 cron）"
else
  warn "没有 systemd：定时同步与备份需要自己写 cron"
fi

# ------------------------------------------------------------------ 汇总
printf '\n\033[1m== 汇总\033[0m\n'
printf '  \033[32m✓ %d\033[0m    \033[33m! %d\033[0m    \033[31m✗ %d\033[0m\n' "$N_PASS" "$N_WARN" "$N_BAD"
if [ "$N_BAD" -gt 0 ]; then
  echo
  echo "先把上面的 ✗ 解决掉，再执行：bash deploy/deploy.sh"
  echo "（! 是警告：多数可以带着走，但 swap 和镜像加速器那两条建议处理）"
  exit 1
fi
echo
echo "没有阻塞项。可以执行：bash deploy/deploy.sh"
echo "部署完照 deploy/README.md 的「上线验收清单」再走一遍。"
