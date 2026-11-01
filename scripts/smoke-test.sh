#!/usr/bin/env sh
# Dispara os payloads de exemplo contra os webhooks locais e mostra status + resposta.
# Pré-requisito: workflows importados, credenciais configuradas e workflows ATIVOS.
# Uso: ./scripts/smoke-test.sh                 (Fluxo A com samples/inbound/*.json)
#      ./scripts/smoke-test.sh caminho/nota.pdf (também envia uma fatura ao Fluxo B)
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$ROOT/.env" ] || { echo "Crie o .env antes (scripts/generate-secrets.sh)." >&2; exit 1; }

# Lê só as variáveis necessárias, sem executar o .env
env_get() { grep -E "^$1=" "$ROOT/.env" | tail -n1 | cut -d= -f2-; }
BASE_URL="$(env_get WEBHOOK_URL)"
BASE_URL="${BASE_URL:-http://localhost:5678/}"
TOKEN="$(env_get WEBHOOK_AUTH_TOKEN)"
HEADER="$(env_get WEBHOOK_AUTH_HEADER)"
HEADER="${HEADER:-X-Webhook-Token}"
[ -n "$TOKEN" ] || { echo "WEBHOOK_AUTH_TOKEN vazio no .env." >&2; exit 1; }

post_json() {
  printf '\n== %s\n' "$(basename "$1")"
  curl -sS -o /dev/stdout -w '\nHTTP %{http_code} · %{time_total}s\n' \
    -X POST "${BASE_URL}webhook/inbound-lead" \
    -H "Content-Type: application/json" -H "$HEADER: $TOKEN" \
    --data-binary "@$1"
}

for f in "$ROOT"/samples/inbound/*.json; do post_json "$f"; done

printf '\n== reenvio (deve responder "duplicate")\n'
post_json "$ROOT/samples/inbound/ticket-critico.json"

if [ "${1:-}" != "" ]; then
  printf '\n== fatura: %s\n' "$1"
  curl -sS -w '\nHTTP %{http_code} · %{time_total}s\n' \
    -X POST "${BASE_URL}webhook/invoice-upload" \
    -H "$HEADER: $TOKEN" -F "file=@$1"
fi

printf '\nConfira: Executions no n8n, canais do Slack e as tabelas leads_triage / invoices / invoice_quarantine.\n'
