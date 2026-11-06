#!/usr/bin/env bash
# sync.sh —— 提交 skills 改动 → 推 GitHub → 同步到服务器
# 用法: ./sync.sh [提交说明]
set -e
cd "$(dirname "$0")"

MSG="${1:-sync: $(date '+%Y-%m-%d %H:%M')}"

echo "== 1/3 提交并推送 =="
git add -A
if git diff --cached --quiet; then
  echo "   无改动，跳过提交"
else
  git commit -m "$MSG"
  git push
fi

echo "== 2/3 安全检查：确认没把凭据带进去 =="
# data/keys.json 存 API key（web-search 等技能），和 cookie.json 一样不能进仓库
SENSITIVE='data/cookie\.json|data/keys\.json|certs/|\.key$|\.pem$'
if git ls-files | grep -qE "$SENSITIVE"; then
  echo "   ✗ 发现敏感文件已被跟踪，中止！"
  git ls-files | grep -E "$SENSITIVE"
  exit 1
fi
echo "   ✓ 无敏感文件"

echo "== 3/3 同步到服务器 =="
for host in yan yan2; do
  echo "   → $host"
  rsync -az --delete \
    --exclude 'sensevoice/' --exclude 'node_modules/' --exclude '__pycache__/' \
    --exclude 'synced/' --exclude 'data/cookie.json' --exclude 'data/keys.json' --exclude 'certs/' \
    --exclude 'logs/' --exclude '.git/' \
    ./ "$host:~/.claude/skills/"
  echo "     ✓ 完成"
done

echo "全部完成"
