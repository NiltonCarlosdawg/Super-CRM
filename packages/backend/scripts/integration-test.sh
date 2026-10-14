#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose -f docker-compose.test.yml up -d --wait
if [[ "${KEEP_CONTAINERS:-0}" != "1" ]]; then
  trap 'docker compose -f docker-compose.test.yml down -v' EXIT
fi
tsx --test "tests/integration/**/*.test.ts"
