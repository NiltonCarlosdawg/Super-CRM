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

# npm ci antes do restart — se algo falhar, o restart não acontece e a app
# antiga continua a correr.
# Medido no host (2026-11-11/12): cage LVE mata a ~950MB RSS. Cache quente do
# npm + install scripts nativos causam rajada que ultrapassa o limite — por isso:
#   - npm cache clean --force: força extração/download ritmado (cache quente mata);
#   - --omit=dev: só deps de runtime (tsx/ioredis movidos para dependencies);
#   - --ignore-scripts: deps nativas têm prebuild/optional-deps no tarball;
#   - sync periódico: descarrega páginas sujas de node_modules (trap EXIT limpa);
#   - ONNXRUNTIME skip: sem GPU no host (ADR-0014 é CPU-only).
# Provado: exit 0, ~815MB pico, ~17m (cache limpa). Sem estes, rc=137/1.
# O passo remoto corre DESTACADO (setsid nohup) e o runner faz poll com ssh's
# curtos: em 2026-11-12 o servidor fechou a ligação aos 13m e matava o npm a
# meio, deixando node_modules incompleto (sem restart = app antiga no ar, mas
# próxima reinício rebentava).
ssh "$SSH_TARGET" "bash -s" <<EOF
set -euo pipefail
rm -f \$HOME/.deploy-npmci.exit
cat > \$HOME/.deploy-npmci.sh <<'INNER'
set -euo pipefail
# SSH não-interativo não tem node/npm no PATH (Gate 0); alt-nodejs22 é o Node 22 do host
export PATH=/opt/alt/alt-nodejs22/root/usr/bin:\$PATH
export ONNXRUNTIME_NODE_INSTALL=skip
cd $DEPLOY_BACKEND_ROOT
npm cache clean --force >/dev/null 2>&1 || true
( while :; do sync; sleep 1; done ) & SYNC=\$!
trap 'kill \$SYNC 2>/dev/null || true' EXIT
npm ci --omit=dev --no-audit --no-fund --ignore-scripts
eval "$DEPLOY_RESTART_CMD"
# Espera o arranque (compile frio do tsx: ~30-60s) — sem isto o Verify do
# runner apanha o proxy ainda em 503 e falha (medido 2026-11-12).
# \$(: o heredoc de envio é não-quoted — sem a barra o seq expandsia AQUI.
for _ in \$(seq 1 36); do
  if curl -fsS -m 3 http://127.0.0.1:3002/health/live >/dev/null 2>&1; then exit 0; fi
  sleep 5
done
echo "backend não respondeu em 180s após restart" >&2
exit 1
INNER
setsid nohup bash -c 'bash "\$HOME/.deploy-npmci.sh"; echo \$? > "\$HOME/.deploy-npmci.exit"' \
  > "\$HOME/.deploy-npmci.log" 2>&1 < /dev/null &
echo "deploy: npm ci destacado no servidor (log: ~/.deploy-npmci.log)"
EOF

# Poll: ligação nova a cada ronda — uma queda não desmarca o npm ci remoto.
rc=""
for _ in $(seq 1 60); do # 60 x 30s = 30min (npm ci medido a ~17m)
  sleep 30
  rc=$(ssh "$SSH_TARGET" "cat \$HOME/.deploy-npmci.exit 2>/dev/null" || true)
  if [ -n "$rc" ]; then break; fi
done
if [ -z "$rc" ]; then
  echo "deploy: timeout à espera do npm ci remoto" >&2
  exit 1
fi
if [ "$rc" != "0" ]; then
  echo "deploy: npm ci/remoto falhou (exit $rc) — log:" >&2
  ssh "$SSH_TARGET" "tail -40 \$HOME/.deploy-npmci.log" >&2 || true
  exit 1
fi
echo "deploy: npm ci e restart concluídos"
