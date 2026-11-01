#!/usr/bin/env sh
# Cria o .env a partir do .env.example, trocando cada "change-me" por um segredo aleatório distinto.
# Uso: ./scripts/generate-secrets.sh        (não sobrescreve um .env existente)
#      ./scripts/generate-secrets.sh --force
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXAMPLE="$ROOT/.env.example"
TARGET="$ROOT/.env"

if [ -f "$TARGET" ] && [ "${1:-}" != "--force" ]; then
  echo ".env já existe — nada feito. Use --force para regenerar (invalida Credentials salvas no n8n!)." >&2
  exit 1
fi

rand_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

: > "$TARGET"
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    *=change-me) printf '%s=%s\n' "${line%%=*}" "$(rand_hex)" >> "$TARGET" ;;
    *) printf '%s\n' "$line" >> "$TARGET" ;;
  esac
done < "$EXAMPLE"

chmod 600 "$TARGET" 2>/dev/null || true
echo ".env criado com segredos aleatórios em: $TARGET"
echo "Guarde o N8N_ENCRYPTION_KEY: sem ele as Credentials do n8n não podem ser decifradas."
