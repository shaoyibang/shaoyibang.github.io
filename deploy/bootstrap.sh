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
#   sudo bash deploy/bootstrap.sh               基础准备
#   sudo bash deploy/bootstrap.sh --with-node   顺便装一个够新的 Node（见下）
# =========================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
UNIT_SRC="$HERE/systemd"
UNIT_DST="/etc/systemd/system"

WITH_NODE=0
for a in "$@"; do
  case "$a" in
    --with-node) WITH_NODE=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数：$a"; exit 2 ;;
  esac
done

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
  # 刻意只警告、不中止：这台机器上的准备工作（Docker、swap、定时器、密钥）
  # 跟凭据无关，可以照常做完。后台自己会在启动时拒绝空凭据（那是权威检查点），
  # preflight.sh 也会把这一条报成阻塞项。
  warn "deploy/.env 里还没有口令哈希 / 会话密钥 —— 后台起不来。下一步：node tools/passwd.mjs --out deploy/.env"
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

# ------------------------------------------------- 1.5 Node（可选，--with-node）
#
# 宿主机其实不需要 Node：后台的 Node 跑在容器里。装它只为一件事 ——
# 在服务器上就能跑 `node tools/passwd.mjs` 生成口令哈希，不用切回自己的电脑
# 再粘贴过来。要不要装，取决于你觉得哪个更省事。
#
# 为什么不用 apt：Ubuntu 22.04 的 nodejs 是 12.22.9，而 tools/*.mjs 用了
# 可选链 / 空值合并 / 顶层 await（Node 14.8+）。Node 12 跑起来会在**解析阶段**
# 抛 "SyntaxError: Unexpected token '.'"，指向 auth.mjs 某一行 —— 报错里
# 一个字都不会提到"你的 Node 太旧"。所以这里从官方 tarball 装到 /usr/local。
node_major() {
  if command -v node >/dev/null 2>&1; then
    node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
  else
    echo 0
  fi
}

say "Node"
CUR_NODE="$(node_major)"
if [ "$WITH_NODE" -eq 1 ]; then
  if [ "${CUR_NODE:-0}" -ge 18 ]; then
    ok "已经有 Node v$(node -v | sed 's/^v//')，跳过"
  else
    [ "${CUR_NODE:-0}" -ne 0 ] && warn "现有 Node 是 v$(node -v | sed 's/^v//')，太旧（需要 18+）；装一个够新的到 /usr/local"

    command -v curl >/dev/null 2>&1 || pkg_install curl || die "需要 curl 才能下载 Node"

    # 版本号不硬编码：它随时会变。从 SHASUMS256.txt 里解出当前 v22 的文件名。
    NODE_BASE=""; NODE_FILE=""
    for b in "https://npmmirror.com/mirrors/node" "https://nodejs.org/dist"; do
      f="$(curl -fsSL --max-time 25 "$b/latest-v22.x/SHASUMS256.txt" 2>/dev/null \
            | awk '/linux-x64\.tar\.xz$/ {print $2; exit}')"
      [ -n "$f" ] && { NODE_BASE="$b"; NODE_FILE="$f"; break; }
    done
    [ -n "$NODE_FILE" ] || die "从镜像解析不出 Node 版本（网络问题）。手工装法见 deploy/README.md"

    ok "选中的版本：$NODE_FILE（来自 $NODE_BASE）"
    curl -fsSL --max-time 300 -o /tmp/node.tar.xz "$NODE_BASE/latest-v22.x/$NODE_FILE" \
      || die "下载 Node 失败"

    if ! tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 2>/dev/null; then
      warn "解压失败，可能是没有 xz-utils，正在补装"
      pkg_install xz-utils || true
      tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 || die "解压 Node 失败"
    fi
    rm -f /tmp/node.tar.xz

    NEW_NODE="$(node_major)"
    if [ "${NEW_NODE:-0}" -ge 18 ]; then
      ok "Node 装好了：$(node -v)（$(command -v node)）"
      case "$(command -v node)" in
        /usr/local/bin/node) ok "PATH 里优先用的就是新装的那个" ;;
        *) warn "PATH 里用的是 $(command -v node)，不是新装的 /usr/local/bin/node —— 旧的会盖住它" ;;
      esac
    else
      warn "装完了仍然拿不到 18+ 的 node，检查 PATH（which -a node）"
    fi
  fi
elif [ "${CUR_NODE:-0}" -ne 0 ] && [ "${CUR_NODE:-0}" -lt 18 ]; then
  warn "现有 Node 是 v$(node -v | sed 's/^v//')，太旧：tools/*.mjs 会抛一个看不懂的 SyntaxError"
  warn "  想装新的：sudo bash deploy/bootstrap.sh --with-node"
  warn "  不想装：改在别的机器上跑 node tools/passwd.mjs，把打印出来的三行粘进 deploy/.env"
else
  ok "没装 Node（不是必须的）"
fi

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

# 同步那个定时器只在"这是个 git 仓库"时才有意义。文件是直接上传上去的
# （没有 .git）情况下如果照装，sync.sh 会每 10 分钟失败一次 —— 而站点本身
# 一切正常，所以这种失败很容易被忽略很久。宁可不装，并且说清楚。
if [ -d "$SITE_ROOT/.git" ]; then
  systemctl enable --now site-sync.timer site-backup.timer >/dev/null 2>&1 || \
    warn "定时器启用失败，检查：systemctl status site-sync.timer"
  ok "已启用：site-sync.timer（每 10 分钟）、site-backup.timer（每天 04:00）"
else
  systemctl enable --now site-backup.timer >/dev/null 2>&1 || \
    warn "备份定时器启用失败，检查：systemctl status site-backup.timer"
  systemctl disable --now site-sync.timer >/dev/null 2>&1 || true
  ok "已启用：site-backup.timer（每天 04:00）"
  warn "没有启用 site-sync.timer：$SITE_ROOT 不是 git 仓库，同步脚本每 10 分钟只会失败一次"
  warn "  想要和 GitHub 同步，就把 .git 目录也传上来（或在服务器上 clone 一份）再重跑本脚本"
fi

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

# origin 如果是 HTTPS，推送走的是 github.com:443 —— 那条路在国内基本不通，
# 而上面刚把 SSH 改道到了 443。不改的话表现是"定时同步每 10 分钟失败一次"，
# 报错只说连不上，完全不会指向这里。从本机 scp 过去的仓库 origin 一定是
# HTTPS（本机就是这么克隆的），所以这一步几乎是必须的。
#
# 刻意放在上面那个 GIT_HOME 分支之外：改 origin 只跟仓库有关，跟家目录无关。
if [ -d "$SITE_ROOT/.git" ] && command -v git >/dev/null 2>&1; then
  ORIGIN="$(git -C "$SITE_ROOT" remote get-url origin 2>/dev/null || true)"
  case "$ORIGIN" in
    https://github.com/*)
      SLUG="${ORIGIN#https://github.com/}"
      SLUG="${SLUG%.git}"
      git -C "$SITE_ROOT" remote set-url origin "git@github.com:${SLUG}.git"
      ok "origin 从 HTTPS 改成了 SSH：git@github.com:${SLUG}.git（否则推送会走被阻断的 443）"
      ;;
    git@github.com:*)
      ok "origin 已经是 SSH：$ORIGIN"
      ;;
    "")
      warn "读不到 origin，检查 $SITE_ROOT 的 remote"
      ;;
    *)
      ok "origin 是 $ORIGIN（不是 GitHub 的 HTTPS 地址，没动它）"
      ;;
  esac
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
