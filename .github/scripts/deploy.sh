#!/usr/bin/env bash
# Deploy no cPanel (ADR-0016): tar sobre ssh + npm ci + restart, na ordem.
# Gate 0 (2026-11-07): o servidor não tem o utilitário de sincronização da
# família rsync; tem tar+gzip — por isso o transporte é tar sobre ssh.
# Migrations ADIADAS pelo dono (2026-11-07): sem pgvector a migration 0000
# falha; o schema é tratado manualmente até o alojamento instalar a extensão.
# Correr da raiz do repo com DEPLOY_* no ambiente e ssh-agent ativo.
# Executável também à mão para recuperação.
# shortcut: sem limpeza no destino — ficheiros removidos do build ficam órfãos
# no docroot (inócuos); a acrescentar quando G3 confirmar docroot só nosso.
set -euo pipefail

for v in DEPLOY_SSH_HOST DEPLOY_SSH_USER DEPLOY_FRONTEND_DOCROOT DEPLOY_BACKEND_ROOT DEPLOY_RESTART_CMD; do
  if [ -z "${!v:-}" ]; then
    echo "deploy: falta a variável $v" >&2
    exit 1
  fi
done

SSH_TARGET="$DEPLOY_SSH_USER@$DEPLOY_SSH_HOST"

# Frontend: build já feito no runner (packages/frontend/dist).
tar czf - --exclude='.env' -C packages/frontend/dist . | \
  ssh "$SSH_TARGET" "tar xzf - -C '$DEPLOY_FRONTEND_DOCROOT'"

# Backend: código + migrações no servidor; .env e node_modules ficam lá.
tar czf - --exclude='.env' --exclude='node_modules' --exclude='reports' -C packages/backend . | \
  ssh "$SSH_TARGET" "tar xzf - -C '$DEPLOY_BACKEND_ROOT'"

# Um único ssh: npm ci antes do restart — se algo falhar, set -e aborta
# antes de reiniciar, e a app antiga continua a correr.
# Medido no host (2026-11-11): a cage LVE mata processos a ~950MB RSS e o
# `npm ci` completo chega lá em 5s (buffers de extração) — por isso:
#   - --omit=dev: só deps de runtime (tsx/ioredis movidos para dependencies);
#     pico medido 872MB, `added 190 packages` com exit 0;
#   - sync periódico: descarrega as páginas sujas de node_modules, senão o
#     uso total da cage (RSS + sujas) ultrapassa o limite a meio da extração;
#   - NODE_OPTIONS capa o heap; ONNXRUNTIME skip: sem GPU no host (ADR-0014
#     é CPU-only) o postinstall do onnxruntime-node leva SIGKILL.
ssh "$SSH_TARGET" "bash -s" <<EOF
set -euo pipefail
# SSH não-interativo não tem node/npm no PATH (Gate 0); alt-nodejs22 é o Node 22 do host
export PATH=/opt/alt/alt-nodejs22/root/usr/bin:\$PATH
cd $DEPLOY_BACKEND_ROOT
export ONNXRUNTIME_NODE_INSTALL=skip
export NODE_OPTIONS=--max-old-space-size=400
( while :; do sync; sleep 1; done ) & SYNC=\$!
trap 'kill \$SYNC 2>/dev/null || true' EXIT
npm ci --omit=dev --no-audit --no-fund --prefer-offline
eval "$DEPLOY_RESTART_CMD"
EOF
