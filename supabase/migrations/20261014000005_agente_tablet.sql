-- Supabase rechaza las claves secretas (sb_secret_…) cuando la petición trae el user-agent de
-- un navegador. Las Edge Functions ya no reenvían el de la tablet como user-agent: lo mandan en
-- x-pase-agente, y la bitácora lo toma de ahí (o del user-agent, si no viene).
create or replace function app.agente_cliente() returns text
language sql stable as $$
  select left(coalesce(app.encabezado('x-pase-agente'), app.encabezado('user-agent')), 300)
$$;

create or replace function auditoria.anotar(
  p_accion text, p_tabla text, p_registro text, p_antes jsonb, p_despues jsonb,
  p_firma uuid default null, p_campos text[] default null, p_usuario uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  r auditoria.registros;
begin
  -- serializa las escrituras para que la cadena de hash no se bifurque
  perform pg_advisory_xact_lock(hashtext('auditoria.registros'));
  r.ocurrido_en        := clock_timestamp();
  r.usuario_sesion_id  := app.usuario_actual();
  r.usuario_id         := coalesce(p_usuario, r.usuario_sesion_id);
  r.accion             := p_accion;
  r.tabla              := p_tabla;
  r.registro_id        := p_registro;
  r.valores_anteriores := p_antes;
  r.valores_nuevos     := p_despues;
  r.campos_modificados := p_campos;
  r.firma_id           := p_firma;
  r.ip                 := app.ip_cliente();
  r.dispositivo_id     := app.dispositivo_actual();
  r.user_agent         := app.agente_cliente();
  select u.rol into r.rol from public.usuarios u where u.id = r.usuario_id;
  select a.hash into r.hash_anterior from auditoria.registros a order by a.id desc limit 1;
  r.hash := extensions.digest(coalesce(r.hash_anterior, '\x'::bytea) || auditoria.texto_hash(r), 'sha256');

  insert into auditoria.registros (ocurrido_en, usuario_id, usuario_sesion_id, rol, accion, tabla,
    registro_id, valores_anteriores, valores_nuevos, campos_modificados, firma_id, ip,
    dispositivo_id, user_agent, hash_anterior, hash)
  values (r.ocurrido_en, r.usuario_id, r.usuario_sesion_id, r.rol, r.accion, r.tabla,
    r.registro_id, r.valores_anteriores, r.valores_nuevos, r.campos_modificados, r.firma_id, r.ip,
    r.dispositivo_id, r.user_agent, r.hash_anterior, r.hash);
end $$;
