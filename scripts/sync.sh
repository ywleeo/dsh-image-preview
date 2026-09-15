#!/usr/bin/env bash
# 把插件文件同步到本机所有已安装该插件的 dsh profile node_modules 拷贝。
# 本机用 file: 依赖安装，编辑工具原子写入会断开硬链接，改完源码需要同步。
set -euo pipefail
cd "$(dirname "$0")/.."

SYNCED=0
for d in "$HOME/.dsh/profiles"/*/node_modules/dsh-image-preview; do
  [ -d "$d" ] || continue
  # host.js 是启动壳动态加载的真实插件，必须一起同步，否则壳会报导入失败。
  # 先 rm 再 cp：目标可能是源的硬链接，就地覆盖会连带改掉另一头。
  for f in index.js host.js client.js package.json; do
    rm -f "$d/$f"
    cp "$f" "$d/$f"
  done
  echo "已同步: $d"
  SYNCED=1
done

if [ "$SYNCED" = 0 ]; then
  echo "警告: 未找到已安装的 profile 拷贝（~/.dsh/profiles/*/node_modules/dsh-image-preview）"
  echo "      仅完成了源码准备；若其它机器从 git 安装则无需本机同步。"
  exit 1
fi
