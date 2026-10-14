#!/bin/sh
# Pruebas de la base: copia la base del Supabase local (con auth de GoTrue y las migraciones)
# a una base aparte y corre ahí las pruebas, para no ensuciar los datos de la app local.
set -e
cd "$(dirname "$0")"
P="psql -h 127.0.0.1 -p 54322 -U postgres -v ON_ERROR_STOP=1 -q"
$P -d postgres -c "drop database if exists pruebas" -c "create database pruebas" >/dev/null
pg_dump -h 127.0.0.1 -p 54322 -U postgres --exclude-table-data='auth.*' --exclude-table-data='public.usuarios' \
  --exclude-table-data='privado.*' --exclude-table-data='public.dispositivos' --exclude-table-data='auditoria.*' postgres \
  | $P -d pruebas >/dev/null 2>&1
for f in ${*:-sql_*.sql}; do
  echo "== $f"
  PGOPTIONS='-c client_min_messages=warning' $P -d pruebas -f "$f" 2>&1 || { echo "ERROR en $f"; exit 1; }
done
