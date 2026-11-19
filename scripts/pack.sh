#!/usr/bin/env bash
# Build a clean delivery archive: source only, no node_modules, no .env, no databases, no session logs.
# Usage: bash scripts/pack.sh [version]
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="${1:-$(node -p "require('${root}/package.json').version")}"
out_dir="${root}/dist"
archive="${out_dir}/erstantwort-intl-${version}.zip"

mkdir -p "${out_dir}"
rm -f "${archive}"
cd "${root}"

zip -r -q "${archive}" . \
  -x 'node_modules/*' 'var/*' '.git/*' 'dist/*' 'reports/*' 'coverage/*' '.n8n/*' 'uploads/*' 'agent-tools/*' '__pycache__/*' \
     '.env' '.env.local' '.DS_Store' 'dsh-session-*.zip' 'dsh-session-*.jsonl' '*.sqlite' '*.sqlite-shm' '*.sqlite-wal' \
     '*.log' '*.tap' '*.pyc'

echo "packed ${archive} ($(( $(wc -c < "${archive}") / 1024 / 1024 )) MB)"
