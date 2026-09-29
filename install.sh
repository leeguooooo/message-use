#!/bin/sh
# message-use installer — GitHub Release binary, no token.
#   curl -fsSL https://raw.githubusercontent.com/leeguooooo/message-use/main/install.sh | sh
set -eu

REPO="leeguooooo/message-use"
INSTALL_DIR="${MESSAGE_USE_INSTALL_DIR:-$HOME/.local/bin}"

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$os-$arch" in
  darwin-arm64) asset="message-use-darwin-arm64" ;;
  darwin-x86_64) asset="message-use-darwin-x64" ;;
  *) echo "message-use reads macOS Messages; unsupported platform: $os-$arch" >&2; exit 1 ;;
esac

url="https://github.com/$REPO/releases/latest/download/$asset.tar.gz"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "downloading $url"
curl -fsSL "$url" -o "$tmp/$asset.tar.gz"
# Fail closed: every release ships a .sha256.
curl -fsSL "$url.sha256" -o "$tmp/$asset.tar.gz.sha256"
expected=$(awk '{print $1}' "$tmp/$asset.tar.gz.sha256")
actual=$(shasum -a 256 "$tmp/$asset.tar.gz" | awk '{print $1}')
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "sha256 mismatch: expected $expected got $actual" >&2
  exit 1
fi

tar -xzf "$tmp/$asset.tar.gz" -C "$tmp"
chmod +x "$tmp/message-use"
"$tmp/message-use" version >/dev/null || { echo "downloaded binary failed smoke test" >&2; exit 1; }
mkdir -p "$INSTALL_DIR"
staged="$INSTALL_DIR/.message-use.staged.$$"
mv "$tmp/message-use" "$staged"
mv -f "$staged" "$INSTALL_DIR/message-use"
echo "installed: $INSTALL_DIR/message-use"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "note: add $INSTALL_DIR to your PATH" ;;
esac

if [ "${MESSAGE_USE_INSTALL_SKILLS:-1}" != "0" ]; then
  "$INSTALL_DIR/message-use" skill install </dev/null || echo "warning: skill install failed; rerun: message-use skill install" >&2
fi
echo "ok: run \`message-use doctor\` (reading needs Full Disk Access for your terminal)"
