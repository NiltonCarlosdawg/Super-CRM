#!/usr/bin/env bash
# Guardiões do deploy: invariantes da spec §6/§9 que um refactor pode partir.
set -euo pipefail
cd "$(dirname "$0")/../.."

s=.github/scripts/deploy.sh

grep -q 'set -euo pipefail' $s
grep -qF -- "--exclude='.env'" $s                 # risco: .env do servidor apagado
grep -qF -- "--exclude='node_modules/'" $s
# ordem: migrate ANTES do restart, no mesmo ssh
m=$(grep -n 'db:migrate' $s | head -1 | cut -d: -f1)
r=$(grep -nF 'eval "$DEPLOY_RESTART_CMD"' $s | head -1 | cut -d: -f1)
test -n "$m" && test -n "$r" && test "$m" -lt "$r"

echo "deploy-guard: OK"
