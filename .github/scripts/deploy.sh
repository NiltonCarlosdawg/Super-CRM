#!/usr/bin/env bash
# Deploy no cPanel (ADR-0016): rsync + npm ci + db:migrate + restart, na ordem.
# Correr da raiz do repo com DEPLOY_* no ambiente (vars do GitHub) e ssh-agent ativo.
# Executável também à mão para recuperação.
# shortcut: sem --delete no rsync do frontend — ficheiros removidos do build ficam
# órfãos no docroot (inócuos); a acrescentar quando G3 confirmar docroot só nosso.
set -euo pipefail

for v in DEPLOY_SSH_HOST DEPLOY_SSH_USER DEPLOY_FRONTEND_DOCROOT DEPLOY_BACKEND_ROOT DEPLOY_RESTART_CMD; do
  if [ -z "${!v:-}" ]; then
    echo "deploy: falta a variável $v" >&2
    exit 1
  fi
done

SSH_TARGET="$DEPLOY_SSH_USER@$DEPLOY_SSH_HOST"

# Frontend: build já feito no runner (packages/frontend/dist).
rsync -az packages/frontend/dist/ "$SSH_TARGET:$DEPLOY_FRONTEND_DOCROOT/" \
  --exclude='.env'

# Backend: código + migrações; node_modules e .env ficam no servidor.
rsync -az packages/backend/ "$SSH_TARGET:$DEPLOY_BACKEND_ROOT/" \
  --exclude='.env' --exclude='node_modules/' --exclude='reports/'

# Um único ssh: se db:migrate falhar, set -e aborta ANTES do restart —
# a app antiga continua a correr e a base não fica com app nova em base velha.
ssh "$SSH_TARGET" "bash -s" <<EOF
set -euo pipefail
cd $DEPLOY_BACKEND_ROOT
npm ci
npm run db:migrate
eval "$DEPLOY_RESTART_CMD"
EOF
