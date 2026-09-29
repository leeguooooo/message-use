#!/bin/sh
# 从 CHANGELOG.md 取出某个版本那一节作为 GitHub Release 说明，末尾附安装命令。
#   scripts/release-notes.sh v0.6.4 > notes.md
# 找不到这一节时退出码 1：发版说明为空的 release 不许出去（0.6.0 之前全是空的）。
set -eu
version=${1#v}
section=$(awk -v v="$version" '
  /^## / { if (found) exit; h=$2; sub(/^v/, "", h); if (h == v) { found=1; next } }
  found { print }
' CHANGELOG.md)
if [ -z "$(printf '%s' "$section" | tr -d '[:space:]')" ]; then
  echo "CHANGELOG.md has no section for $version" >&2
  exit 1
fi
printf '%s\n' "$section" | sed -e '/./,$!d'
cat <<'NOTES'

---

**Install / upgrade** (macOS)

```sh
curl -fsSL https://raw.githubusercontent.com/leeguooooo/message-use/main/install.sh | sh
message-use upgrade   # already installed
```

Binaries are Developer ID signed and notarized. Part of the [*-use family](https://github.com/leeguooooo/plugins).
NOTES
