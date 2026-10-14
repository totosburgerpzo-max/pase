-- Imita lo que un proyecto nuevo de Supabase ya trae antes de la primera migración:
-- roles de la API, esquemas auth / extensions / storage / vault y privilegios por defecto.
-- Solo para el entorno local de pruebas. En Supabase NO se ejecuta.

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit password 'authenticator-local';
grant anon, authenticated, service_role to authenticator;
create role supabase_auth_admin login noinherit createrole password 'auth-local';
create role supabase_storage_admin login noinherit createrole bypassrls password 'storage-local';
grant authenticated, anon, service_role to supabase_storage_admin;

create schema extensions;
create extension pgcrypto with schema extensions;
create extension "uuid-ossp" with schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;
alter database postgres set search_path = "$user", public, extensions;

create schema auth authorization supabase_auth_admin;
grant usage on schema auth to anon, authenticated, service_role, postgres;
alter role supabase_auth_admin set search_path = auth;
grant create on database postgres to supabase_auth_admin;

grant usage on schema public to anon, authenticated, service_role;
grant create on schema public to postgres;

-- Supabase deja abiertos por defecto los objetos que crea postgres en public;
-- el esquema de Pase los cierra explícitamente, así que conviene probar contra lo mismo.
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;

-- Vault (supabase_vault): el pepper del PIN vive aquí
create schema vault;
create table vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  description text not null default '',
  secret text not null,
  created_at timestamptz not null default now()
);
create view vault.decrypted_secrets as select id, name, description, secret, secret as decrypted_secret, created_at from vault.secrets;
create function vault.create_secret(new_secret text, new_name text default null, new_description text default '')
returns uuid language sql as $$
  insert into vault.secrets (secret, name, description) values (new_secret, new_name, new_description) returning id
$$;
revoke all on schema vault from public;

-- Storage: lo mínimo para que las políticas de RLS de la migración se apliquen igual
create schema storage authorization supabase_storage_admin;
grant usage on schema storage to anon, authenticated, service_role, postgres;
create table storage.buckets (
  id text primary key, name text not null unique, owner uuid, owner_id text,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  public boolean default false, file_size_limit bigint, allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text, owner uuid, owner_id text,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  last_accessed_at timestamptz default now(), metadata jsonb,
  path_tokens text[] generated always as (string_to_array(name, '/')) stored,
  version text, user_metadata jsonb,
  unique (bucket_id, name)
);
alter table storage.objects enable row level security;
alter table storage.buckets enable row level security;
create function storage.foldername(name text) returns text[] language plpgsql immutable as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end $$;
grant all on storage.objects, storage.buckets to anon, authenticated, service_role, postgres;
grant execute on function storage.foldername(text) to anon, authenticated, service_role;
alter table storage.objects owner to supabase_storage_admin;
alter table storage.buckets owner to supabase_storage_admin;
grant supabase_storage_admin to postgres;
