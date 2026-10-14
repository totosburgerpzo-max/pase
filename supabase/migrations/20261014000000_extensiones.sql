-- Pase · extensiones que Supabase ofrece y que el esquema aprovecha si están.
-- pg_cron programa las planillas del día, las alertas de planillas vencidas y la escalada
-- de incidencias. En un PostgreSQL sin pg_cron (pruebas locales) simplemente se omite.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
  end if;
end $$;
