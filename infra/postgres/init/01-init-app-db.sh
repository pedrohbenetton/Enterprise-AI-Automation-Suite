#!/bin/sh
# Executado pela imagem oficial do Postgres apenas no PRIMEIRO boot (volume vazio).
# Cria o banco de negócio com um usuário de menor privilégio e aplica o schema.
# Para reaplicar: docker compose down -v  (apaga dados!)  ou rode o SQL manualmente.
set -eu

: "${APP_DB_NAME:?APP_DB_NAME ausente}"
: "${APP_DB_USER:?APP_DB_USER ausente}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD ausente}"

echo ">> Criando role '${APP_DB_USER}' e banco '${APP_DB_NAME}'"

# Variáveis psql (:'x' / :"x") fazem o quoting seguro de literal e identificador.
psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
     -v app_user="$APP_DB_USER" -v app_password="$APP_DB_PASSWORD" -v app_db="$APP_DB_NAME" \
     -v n8n_db="$POSTGRES_DB" <<'SQL'
CREATE ROLE :"app_user" LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE :"app_db" OWNER :"app_user" ENCODING 'UTF8';
-- O usuário de negócio não enxerga o banco interno do n8n
REVOKE CONNECT ON DATABASE :"n8n_db" FROM PUBLIC;
SQL

echo ">> Aplicando schema em '${APP_DB_NAME}'"
# Rodar como o próprio app user garante que ele seja dono das tabelas.
psql -v ON_ERROR_STOP=1 \
     --username "$APP_DB_USER" --dbname "$APP_DB_NAME" \
     -f /docker-entrypoint-initdb.d/schema/app_schema.sql

echo ">> Banco de negócio pronto."
