#!/usr/bin/env bash
set -euo pipefail

USER_HOME="$(getent passwd "$(id -un)" | cut -d: -f6)"
NODE_BIN=""

if node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  while IFS= read -r candidate; do
    if [ -x "$candidate" ]; then
      NODE_BIN="$candidate"
    fi
  done < <(find "$USER_HOME/.nvm/versions/node" -maxdepth 3 -type f -path "*/bin/node" -print 2>/dev/null | sort -V)
fi

if [ -z "$NODE_BIN" ]; then
  echo "HyperFrames precisa de Node.js >= 22. Instale/ative Node 22 e tente novamente." >&2
  exit 2
fi

NODE_DIR="$(dirname "$NODE_BIN")"
export PATH="$NODE_DIR:$PATH"
exec npx --yes hyperframes@0.8.17 "$@"
