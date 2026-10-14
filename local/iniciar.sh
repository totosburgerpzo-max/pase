#!/bin/sh
# Levanta un Supabase local sin Docker para desarrollar y probar Pase:
#   Postgres 16 (:54322) · GoTrue (:54324) · PostgREST (:54325) · Edge Functions en Deno (:54326)
#   y una puerta tipo Kong con Storage simulado (:54321), que es la URL que usa la app.
# Uso: sh local/iniciar.sh [--limpio]    (--limpio borra la base y la crea de nuevo)
set -e
cd "$(dirname "$0")"
AQUI=$(pwd)
RAIZ=$(cd .. && pwd)
BIN=$AQUI/bin
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
PGDATA=${PGDATA:-/tmp/pase-pg}
DATOS=${DATOS:-/tmp/pase-local}
PGPORT=54322
JWT_SECRET=${JWT_SECRET:-pase-local-jwt-secret-de-al-menos-32-caracteres}
mkdir -p "$DATOS"

for b in postgrest gotrue deno; do
  [ -x "$BIN/$b" ] || { echo "Falta $BIN/$b (ver local/LEEME.md)"; exit 1; }
done

como_postgres() {
  if [ "$(id -u)" = 0 ]; then su postgres -c "$1"; else sh -c "$1"; fi
}

# 1. Postgres
if [ "$1" = "--limpio" ] && [ -d "$PGDATA" ]; then
  como_postgres "$PGBIN/pg_ctl -D $PGDATA -m fast stop" >/dev/null 2>&1 || true
  rm -rf "$PGDATA"
fi
if [ ! -d "$PGDATA" ]; then
  mkdir -p "$PGDATA"
  [ "$(id -u)" = 0 ] && chown postgres "$PGDATA"
  como_postgres "$PGBIN/initdb -D $PGDATA -A trust -U postgres -E UTF8 --locale=C.UTF-8" >/dev/null
  NUEVA=1
fi
if ! "$PGBIN/pg_isready" -h 127.0.0.1 -p $PGPORT >/dev/null 2>&1; then
  como_postgres "$PGBIN/pg_ctl -D $PGDATA -o '-p $PGPORT -k /tmp -c listen_addresses=127.0.0.1 -c timezone=UTC' -l $PGDATA/log.txt -w start" >/dev/null
fi
P="psql -h 127.0.0.1 -p $PGPORT -U postgres -d postgres -v ON_ERROR_STOP=1 -q"

# 2. Llaves de la API (JWT HS256 como las de un proyecto de Supabase)
node "$AQUI/llaves.mjs" "$JWT_SECRET" > "$DATOS/llaves.env"
. "$DATOS/llaves.env"

# 3. Esquema: lo que Supabase trae de fábrica, luego GoTrue migra auth, luego las migraciones de Pase
if [ -n "$NUEVA" ]; then
  $P -f "$AQUI/supabase_local.sql" >/dev/null
fi
export GOTRUE_DB_DRIVER=postgres
export GOTRUE_DB_DATABASE_URL="postgres://supabase_auth_admin:auth-local@127.0.0.1:$PGPORT/postgres?sslmode=disable&search_path=auth"
export GOTRUE_DB_NAMESPACE=auth
export GOTRUE_DB_MIGRATIONS_PATH="$BIN/gotrue-migraciones"
export GOTRUE_API_HOST=127.0.0.1
export PORT=54324
export API_EXTERNAL_URL=http://127.0.0.1:54321/auth/v1
export GOTRUE_SITE_URL=http://127.0.0.1:5173
export GOTRUE_URI_ALLOW_LIST='http://127.0.0.1:5173/**'
export GOTRUE_DISABLE_SIGNUP=true
export GOTRUE_JWT_SECRET="$JWT_SECRET"
export GOTRUE_JWT_EXP=3600
export GOTRUE_JWT_AUD=authenticated
export GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated
export GOTRUE_JWT_ADMIN_ROLES=service_role
export GOTRUE_EXTERNAL_EMAIL_ENABLED=true
export GOTRUE_MAILER_AUTOCONFIRM=true
export GOTRUE_SMTP_ADMIN_EMAIL=pase@localhost
export GOTRUE_MFA_TOTP_ENROLL_ENABLED=true
export GOTRUE_MFA_TOTP_VERIFY_ENABLED=true
export GOTRUE_MFA_MAX_ENROLLED_FACTORS=10
export GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED=true
export GOTRUE_RATE_LIMIT_VERIFY=100000
export GOTRUE_RATE_LIMIT_TOKEN_REFRESH=100000
export GOTRUE_RATE_LIMIT_EMAIL_SENT=100000
export GOTRUE_RATE_LIMIT_OTP=100000
export GOTRUE_LOG_LEVEL=warn
if [ -n "$NUEVA" ]; then
  (cd "$BIN" && ./gotrue migrate >"$DATOS/gotrue-migrar.log" 2>&1) || { cat "$DATOS/gotrue-migrar.log"; exit 1; }
  for f in "$RAIZ"/supabase/migrations/*.sql; do
    $P -f "$f" >/dev/null || { echo "Error en $f"; exit 1; }
  done
fi

parar() { [ -f "$DATOS/$1.pid" ] && kill "$(cat "$DATOS/$1.pid")" 2>/dev/null || true; rm -f "$DATOS/$1.pid"; }

# 4. GoTrue
parar gotrue
(cd "$BIN" && nohup ./gotrue serve >"$DATOS/gotrue.log" 2>&1 & echo $! >"$DATOS/gotrue.pid")

# 5. PostgREST
parar postgrest
cat >"$DATOS/postgrest.conf" <<EOF
db-uri = "postgres://authenticator:authenticator-local@127.0.0.1:$PGPORT/postgres"
db-schemas = "public"
db-anon-role = "anon"
db-extra-search-path = "public, extensions"
jwt-secret = "$JWT_SECRET"
server-host = "127.0.0.1"
server-port = 54325
log-level = "warn"
EOF
nohup "$BIN/postgrest" "$DATOS/postgrest.conf" >"$DATOS/postgrest.log" 2>&1 &
echo $! >"$DATOS/postgrest.pid"

# 6. Edge Functions (las variables son las mismas que Supabase da a cada función)
parar funciones
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY="$ANON_KEY" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
  PASE_CORREO_DOMINIO=personal.pase.invalid \
  nohup "$BIN/deno" run --allow-net --allow-env --allow-read "$AQUI/funciones.ts" >"$DATOS/funciones.log" 2>&1 &
echo $! >"$DATOS/funciones.pid"

# 7. Puerta (Kong + Storage)
parar puerta
JWT_SECRET="$JWT_SECRET" ANON_KEY="$ANON_KEY" SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" ALMACEN="$DATOS/storage" \
  nohup node "$AQUI/puerta.mjs" >"$DATOS/puerta.log" 2>&1 &
echo $! >"$DATOS/puerta.pid"

# Espera a que todo responda
for i in $(seq 1 60); do
  if curl -sf -o /dev/null http://127.0.0.1:54324/health && curl -sf -o /dev/null http://127.0.0.1:54325/ -H "Authorization: Bearer $ANON_KEY" \
     && curl -s -o /dev/null http://127.0.0.1:54326/ && curl -sf -o /dev/null http://127.0.0.1:54321/salud; then
    if [ -n "$NUEVA" ]; then
      SUPABASE_URL=http://127.0.0.1:54321 SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" node "$AQUI/sembrar.mjs" || exit 1
    fi
    echo "Supabase local listo en http://127.0.0.1:54321 (llaves en $DATOS/llaves.env)"
    exit 0
  fi
  sleep 0.5
done
echo "Algo no arrancó; revisa los registros en $DATOS/*.log"
tail -5 "$DATOS"/*.log
exit 1
