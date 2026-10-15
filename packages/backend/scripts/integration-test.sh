#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose -f docker-compose.test.yml up -d --wait
if [[ "${KEEP_CONTAINERS:-0}" != "1" ]]; then
  trap 'docker compose -f docker-compose.test.yml down -v' EXIT
fi
# --test-concurrency=1: os ficheiros partilham uma BD única (migrate + TRUNCATE
# CASCADE em tests/helpers/db.ts) — correr em série para não se apagarem uns aos
# outros (docs/plans/...fase1, Task 1, passo 1; estender, nunca enfraquecer).
tsx --test --test-concurrency=1 "tests/integration/**/*.test.ts"
