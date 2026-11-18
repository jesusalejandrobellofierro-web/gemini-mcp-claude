#!/usr/bin/env bash
# Prueba el conector ya desplegado. Uso:
#   ./probar.sh https://conector-gemini.YOUR-ACCOUNT.workers.dev/mcp/YOUR-TOKEN
set -euo pipefail
URL="${1:?Pasa la URL completa del endpoint /mcp/<token>}"

echo "== 1. initialize =="
curl -sS -X POST "$URL" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"prueba","version":"1"}}}'
echo; echo

echo "== 2. tools/list =="
curl -sS -X POST "$URL" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
echo; echo

echo "== 3. modelos disponibles con tu API key =="
curl -sS -X POST "$URL" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"gemini_listar_modelos","arguments":{"filtro":"image"}}}'
echo; echo

echo "== 4. texto de prueba =="
curl -sS -X POST "$URL" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"gemini_generar_texto","arguments":{"prompt":"Responde solo: conector funcionando"}}}'
echo
