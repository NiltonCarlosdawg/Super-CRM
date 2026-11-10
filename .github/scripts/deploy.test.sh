#!/usr/bin/env bash
# Guardiões do deploy: invariantes da spec §6/§9 que um refactor pode partir.
set -euo pipefail
cd "$(dirname "$0")/../.."

s=.github/scripts/deploy.sh
w=.github/workflows/ci.yml

grep -q 'set -euo pipefail' $s
# transfers: .env nunca sai daqui (frontend e backend), node_modules não é copiado
test "$(grep -cF -- "--exclude='.env'" $s)" -ge 2
grep -qF -- "--exclude='node_modules'" $s
# Gate 0 (2026-11-07): o servidor não tem rsync — deploy é tar sobre ssh
! grep -q 'rsync -az' $s
# Migrations ADIADAS pelo dono (2026-11-07, sem pgvector) — não reacrescentar sem decisão nova
! grep -q 'db:migrate' $s
# onnxruntime-node: skip do download GPU (SIGKILL no host; ADR-0014 é CPU-only)
grep -q 'ONNXRUNTIME_NODE_INSTALL=skip' $s
# ordem: npm ci ANTES do restart, no mesmo ssh
n=$(grep -n 'npm ci' $s | head -1 | cut -d: -f1)
r=$(grep -nF 'eval "$DEPLOY_RESTART_CMD"' $s | head -1 | cut -d: -f1)
test -n "$n" && test -n "$r" && test "$n" -lt "$r"

# workflow: deploy só em push para main, e nunca em cron/PR/dispatch
grep -qF "if: github.event_name == 'push' && github.ref == 'refs/heads/main'" $w
! grep -q 'Deploy não configurado' $w            # placeholder removido

echo "deploy-guard: OK"
