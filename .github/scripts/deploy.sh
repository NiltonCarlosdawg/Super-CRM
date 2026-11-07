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
ssh "$SSH_TARGET" "bash -s" <<EOF
set -euo pipefail
cd $DEPLOY_BACKEND_ROOT
npm ci
eval "$DEPLOY_RESTART_CMD"
EOF
