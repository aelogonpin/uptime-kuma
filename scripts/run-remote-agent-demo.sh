#!/usr/bin/env bash
#
# Levanta dos instancias de Uptime Kuma en local para probar la feature de
# Remote Forwarding (satélite -> central):
#
#   - "central": en la raíz del dominio (/), puerto 3001
#   - "agent":   bajo un subpath (/agent), puerto 3002
#
# Ambas usan builds de producción (node server/server.js) para que el
# comportamiento sea el real, no el del dev server de Vite.
#
# Uso:
#   ./scripts/run-remote-agent-demo.sh
#
# Para parar ambas instancias: Ctrl+C (el script mata los dos procesos).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

RUN_DIR="${REPO_ROOT}/.remote-agent-demo"
CENTRAL_DATA_DIR="${RUN_DIR}/central-data/"
AGENT_DATA_DIR="${RUN_DIR}/agent-data/"
AGENT_DIST_DIR="${RUN_DIR}/agent-dist"
AGENT_RUN_DIR="${RUN_DIR}/agent-run"

CENTRAL_PORT=3001
AGENT_PORT=3002
AGENT_BASE_PATH="/agent"

mkdir -p "$CENTRAL_DATA_DIR" "$AGENT_DATA_DIR" "$AGENT_RUN_DIR"

echo "==> [1/4] Compilando frontend para la instancia CENTRAL (raíz /)..."
UPTIME_KUMA_BASE_PATH="/" npx vite build --config ./config/vite.config.js --outDir "${REPO_ROOT}/dist"

echo "==> [2/4] Compilando frontend para la instancia AGENT (subpath ${AGENT_BASE_PATH})..."
UPTIME_KUMA_BASE_PATH="$AGENT_BASE_PATH" npx vite build --config ./config/vite.config.js --outDir "$AGENT_DIST_DIR"

# server/server.js resuelve bastantes rutas relativas al cwd del proceso,
# no a __dirname: el estático ("dist"), la plantilla/migraciones de sqlite
# (./db/...), Y también R.autoloadModels("./server/model") -- si esto
# último no resuelve, redbean-node no registra las clases de modelo
# (Monitor, User, etc.) y R.dispense(...) devuelve un Bean genérico sin
# .validate()/.start()/etc, dando errores como "bean.validate is not a
# function". Para evitar ir descubriendo estas rutas una a una, la
# instancia agent (que necesita un "dist" propio, compilado con el
# subpath) se lanza desde un directorio "falso" que symlinkea TODO el
# contenido del repo salvo "dist", que se sustituye por el build con
# subpath.
for entry in "$REPO_ROOT"/*; do
    name="$(basename "$entry")"
    [[ "$name" == "dist" ]] && continue
    ln -sfn "$entry" "${AGENT_RUN_DIR}/${name}"
done
ln -sfn "$AGENT_DIST_DIR" "${AGENT_RUN_DIR}/dist"

cleanup() {
    echo ""
    echo "==> Parando instancias..."
    [[ -n "${CENTRAL_PID:-}" ]] && kill "$CENTRAL_PID" 2>/dev/null || true
    [[ -n "${AGENT_PID:-}" ]] && kill "$AGENT_PID" 2>/dev/null || true
    wait 2>/dev/null || true
    echo "==> Listo."
}
trap cleanup EXIT INT TERM

echo "==> [3/4] Arrancando CENTRAL en http://localhost:${CENTRAL_PORT}/ ..."
(
    cd "$REPO_ROOT"
    DATA_DIR="$CENTRAL_DATA_DIR" \
    NODE_ENV=production \
    PORT="$CENTRAL_PORT" \
    UPTIME_KUMA_PORT="$CENTRAL_PORT" \
    node server/server.js
) > "${RUN_DIR}/central.log" 2>&1 &
CENTRAL_PID=$!

echo "==> [4/4] Arrancando AGENT en http://localhost:${AGENT_PORT}${AGENT_BASE_PATH}/ ..."
(
    cd "$AGENT_RUN_DIR"
    DATA_DIR="$AGENT_DATA_DIR" \
    NODE_ENV=production \
    PORT="$AGENT_PORT" \
    UPTIME_KUMA_PORT="$AGENT_PORT" \
    UPTIME_KUMA_BASE_PATH="$AGENT_BASE_PATH" \
    node "${REPO_ROOT}/server/server.js"
) > "${RUN_DIR}/agent.log" 2>&1 &
AGENT_PID=$!

cat <<EOF

============================================================
 CENTRAL : http://localhost:${CENTRAL_PORT}/           (PID $CENTRAL_PID, log: ${RUN_DIR}/central.log)
 AGENT   : http://localhost:${AGENT_PORT}${AGENT_BASE_PATH}/   (PID $AGENT_PID, log: ${RUN_DIR}/agent.log)
============================================================

Ctrl+C para parar ambas instancias.
EOF

wait
