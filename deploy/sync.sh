#!/usr/bin/env bash
# =========================================================================
# sync.sh — 与 GitHub 双向同步
#
# 由 systemd 定时器每 10 分钟跑一次（见 deploy/systemd/site-sync.timer）。
#
# 服务器和别处都可能改东西，所以是两个方向：
#   上行：后台在服务器上写文章时会自动 commit，这里把它推回 GitHub
#   下行：在别处（本机 / GitHub 网页版）改的代码，拉回服务器
#
# 用 rebase 而不是 merge：这个仓库只有一个人在写，线性历史更好读，
# 也不会堆出一串"Merge branch 'main'"。
# --autostash 保证服务器上有未提交改动时也不会卡住。
#
# 失败会以非零码退出，systemd 会把它记成 failed —— 这是故意的：
# 推不上去必须让人知道，否则"我明明在服务器上写了文章，GitHub 上却没有"
# 这种问题会一直藏着。查看：systemctl status site-sync.service
# =========================================================================
set -euo pipefail

SITE_ROOT="${SITE_ROOT:-/srv/site}"
cd "$SITE_ROOT"

command -v git >/dev/null 2>&1 || { echo "没有 git" >&2; exit 1; }
[ -d .git ] || { echo "$SITE_ROOT 不是一个 git 仓库" >&2; exit 1; }

# ── 上行 ────────────────────────────────────────────────────────────────
# 自动提交只在后台保存时触发。如果因为磁盘满、git 报错之类的原因漏掉了，
# 或者有人手工改了文件，这里兜住 —— 工作区里躺着的改动不该被无声忘掉。
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git -c user.name="${GIT_AUTHOR_NAME:-site-sync}" \
      -c user.email="${GIT_AUTHOR_EMAIL:-site-sync@localhost}" \
      commit -q -m "content: 服务器上的改动 $(date '+%F %H:%M')" \
    && echo "已补提交工作区里的改动"
fi

# ── 下行 ────────────────────────────────────────────────────────────────
git pull --rebase --autostash --quiet

# ── 推送 ────────────────────────────────────────────────────────────────
if git rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1; then
  git push --quiet
  echo "已同步：$(git log --oneline -1)"
else
  echo "当前分支没有设置上游，跳过推送（git push -u origin main 设置一次即可）" >&2
  exit 1
fi
