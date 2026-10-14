#!/bin/sh
# Baja a local/bin los programas del Supabase local (sin Docker): PostgREST, Supabase Auth
# (GoTrue, con sus migraciones) y Deno para las Edge Functions. Postgres 16 va aparte
# (apt install postgresql-16). Son las mismas versiones con las que pasaron las pruebas.
set -e
cd "$(dirname "$0")"
mkdir -p bin
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

curl -fsSL https://github.com/PostgREST/postgrest/releases/download/v13.0.7/postgrest-v13.0.7-linux-static-x86-64.tar.xz | tar -xJ -C "$T"
mv "$T/postgrest" bin/postgrest

curl -fsSL https://github.com/supabase/auth/releases/download/v2.197.0/auth-v2.197.0-x86.tar.gz | tar -xz -C "$T"
mv "$T/auth" bin/gotrue
rm -rf bin/gotrue-migraciones && mv "$T/migrations" bin/gotrue-migraciones

(cd "$T" && npm pack --silent @deno/linux-x64-glibc@2.9.6 >/dev/null && tar -xzf deno-linux-x64-glibc-2.9.6.tgz)
mv "$T/package/deno" bin/deno

chmod +x bin/postgrest bin/gotrue bin/deno
bin/postgrest --version | head -1
bin/deno --version | head -1
echo "Listo: local/bin"
