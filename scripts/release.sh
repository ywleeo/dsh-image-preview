#!/usr/bin/env bash
# dsh-image-preview 一键发布：
#   1) 递增版本号（默认 patch，可传 minor/major）
#   2) 同步文件到本机已安装的 profile node_modules 拷贝
#   3) git commit + 打 tag + push（代码与 tag 一起发布）
#
# 用法: ./scripts/release.sh [patch|minor|major]
set -euo pipefail
cd "$(dirname "$0")/.."

PART="${1:-patch}"
case "$PART" in
  patch|minor|major) ;;
  *) echo "用法: ./scripts/release.sh [patch|minor|major]" >&2; exit 2 ;;
esac

# 1) 递增版本号
VER=$(node -e "
const p = require('./package.json');
const [a, b, c] = p.version.split('.').map(Number);
const m = { patch: [a, b, c + 1], minor: [a, b + 1, 0], major: [a + 1, 0, 0] };
console.log(m['$PART'].join('.'));
")
node -e "
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.version = '$VER';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
"
echo "版本: $VER"

# 2) 同步本机已安装的拷贝（file: 依赖的 node_modules 是拷贝/硬链接，需手动同步）
bash scripts/sync.sh || true

# 3) git 提交 + tag + 推送
git add -A
if ! git diff --cached --quiet; then
  git commit -m "release v$VER"
else
  echo "无代码改动，仅打标签"
fi
if git rev-parse "v$VER" >/dev/null 2>&1; then
  echo "tag v$VER 已存在，跳过"
else
  git tag "v$VER"
fi
git push origin main
git push origin "v$VER" || true
echo "✅ 已发布 v$VER → https://github.com/ywleeo/dsh-image-preview"
