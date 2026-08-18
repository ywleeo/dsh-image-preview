#!/usr/bin/env bash
# 把插件文件同步到本机所有已安装该插件的 dsh profile node_modules 拷贝。
# 本机用 file: 依赖安装，编辑工具原子写入会断开硬链接，改完源码需要同步。
set -euo pipefail
cd "$(dirname "$0")/.."

SYNCED=0
for d in "$HOME/.dsh/profiles"/*/node_modules/dsh-image-preview; do
  [ -d "$d" ] || continue
  cp index.js client.js package.json "$d/"
  echo "已同步: $d"
  SYNCED=1
done

if [ "$SYNCED" = 0 ]; then
  echo "警告: 未找到已安装的 profile 拷贝（~/.dsh/profiles/*/node_modules/dsh-image-preview）"
  echo "      仅完成了源码准备；若其它机器从 git 安装则无需本机同步。"
  exit 1
fi
