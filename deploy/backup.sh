#!/usr/bin/env bash
# =========================================================================
# backup.sh — 每日备份
#
# 备份的是仓库里除 .git 之外的全部内容：Markdown 源、图片、生成出来的
# 页面，以及 deploy/.env。
#
# 为什么连 .env 一起备：里面有后台口令哈希和会话密钥。少了它，从备份
# 恢复出来的后台是登不进去的 —— 而"备份能用"这件事只有真的恢复过才算数。
#
# 代价是这个归档等于凭据：所以它必须 600，备份目录必须 700，也正因如此
# **不要**把它丢进任何网盘或公开的存储桶。
#
# 用法：
#   bash deploy/backup.sh
#   SITE_ROOT=/srv/site BACKUP_DIR=/var/backups/site bash deploy/backup.sh
#
# git 历史不在这里面（那部分由 GitHub 兜着）。想把历史也备走：
#   git bundle create /var/backups/site/repo-$(date +%F).bundle --all
# =========================================================================
set -euo pipefail

SITE_ROOT="${SITE_ROOT:-/srv/site}"
DEST="${BACKUP_DIR:-/var/backups/site}"
KEEP="${BACKUP_KEEP_DAYS:-14}"

[ -d "$SITE_ROOT" ] || { echo "找不到仓库目录：$SITE_ROOT" >&2; exit 1; }

mkdir -p "$DEST"
chmod 700 "$DEST"

STAMP="$(date +%F)"
OUT="$DEST/site-$STAMP.tar.gz"

# 先写到临时文件再改名：备份到一半被中断时，不会留下一个"看着像备份、
# 其实是半截"的归档，那种文件比没有备份更危险。
TMP="$OUT.part"
trap 'rm -f "$TMP"' EXIT

tar -czf "$TMP" -C "$SITE_ROOT" \
  --exclude=./.git \
  --exclude=./node_modules \
  --exclude=./deploy/logs \
  .

chmod 600 "$TMP"
mv -f "$TMP" "$OUT"

# 轮转。用 mtime 而不是文件名日期，这样删掉旧的不会影响今天的新档。
DELETED="$(find "$DEST" -maxdepth 1 -name 'site-*.tar.gz' -type f -mtime "+$KEEP" -print -delete | wc -l)"

SIZE="$(du -h "$OUT" | cut -f1)"
echo "备份完成：$OUT（$SIZE），清掉了 $DELETED 个超过 ${KEEP} 天的旧档"
echo "当前存档："
ls -1t "$DEST" | head -5 | sed 's/^/  /'
