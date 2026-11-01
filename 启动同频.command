#!/bin/sh
cd "$(dirname "$0")" || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  printf '请先安装 Node.js 22.18+ 或 24：https://nodejs.org/\n'
  read -r _tongpin_wait
  exit 1
fi
if [ ! -d node_modules/zod ]; then npm install --no-audit --no-fund || exit 1; fi
node scripts/start-local.mjs
