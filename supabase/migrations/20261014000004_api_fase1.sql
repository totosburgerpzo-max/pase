-- =============================================================================
-- Pase · fase 1 · API de la app web
-- Sesión por PIN atada al equipo, registro de equipos por la gerente, planillas con
-- fotos, incidencias, panel del supervisor, personal, equipos, bitácora y la cola de
-- registros hechos sin conexión.
--
-- Regla nueva de seguridad: una sesión solo vale si está atada a un equipo registrado
-- y activo (la abre la función pin-sesion o la gerente con vincular_dispositivo), o si
-- es una sesión de correo con segundo factor (aal2). Con el link y una contraseña no
-- basta: sin equipo registrado nadie ve ni firma nada.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. AJUSTES AL ESQUEMA Y PARÁMETROS
-- -----------------------------------------------------------------------------
alter table public.incidencias add column if not exists area text;

insert into public.parametros (clave, valor, descripcion) values
  ('dispositivo.registro_exige_2fa', 'true', 'Registrar un equipo exige correo, contraseña y segundo factor de la gerente'),
  ('sin_conexion.dias_verificador',  '7',    'Días que un equipo puede verificar sin internet el PIN de quien entró en él'),
  ('sin_conexion.horas_max_firma',   '72',   'Horas máximas entre una firma sin conexión y su sincronización'),
  ('planilla.minutos_anticipacion',  '60',   'Minutos antes de su hora en que una planilla aparece en el riel')
on conflict (clave) do nothing;

-- Sesiones de Supabase Auth atadas a un equipo (session_id del JWT → equipo)
create table if not exists privado.sesiones_dispositivo (
  session_id      uuid primary key,
  dispositivo_id  uuid not null references public.dispositivos(id) on delete cascade,
  usuario_id      uuid not null references public.usuarios(id) on delete cascade,
  metodo          text not null check (metodo in ('pin','correo','sincronizacion')),
  creada_en       timestamptz not null default now()
);
create index if not exists sesiones_dispositivo_equipo on privado.sesiones_dispositivo (dispositivo_id, usuario_id, creada_en desc);
revoke all on privado.sesiones_dispositivo from public;

-- -----------------------------------------------------------------------------
-- 2. CONTEXTO DE LA SESIÓN
-- -----------------------------------------------------------------------------
-- Equipo de esta sesión: el de la tabla de sesiones (o el claim de las pruebas locales),
-- siempre que el equipo siga activo.
create or replace function app.dispositivo_actual() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  c jsonb := app.claims();
  v uuid;
begin
  begin
    v := nullif(c ->> 'dispositivo_id', '')::uuid;
  exception when others then v := null;
  end;
  if v is null and nullif(c ->> 'session_id', '') is not null then
    select s.dispositivo_id into v
    from privado.sesiones_dispositivo s
    join public.usuarios u on u.id = s.usuario_id
    where s.session_id = (c ->> 'session_id')::uuid and u.auth_id = auth.uid();
  end if;
  if v is null then return null; end if;
  return (select d.id from public.dispositivos d where d.id = v and d.activo);
exception when others then
  return null;
end $$;

create or replace function app.sesion_valida() returns boolean
language sql stable security definer set search_path = '' as $$
  select app.dispositivo_actual() is not null or coalesce(app.claims() ->> 'aal', '') = 'aal2'
$$;

create or replace function app.usuario_actual() returns uuid
language sql stable security definer set search_path = '' as $$
  select u.id from public.usuarios u where u.auth_id = auth.uid() and u.activo and app.sesion_valida()
$$;

create or replace function app.rol_actual() returns text
language sql stable security definer set search_path = '' as $$
  select u.rol from public.usuarios u where u.auth_id = auth.uid() and u.activo and app.sesion_valida()
$$;

create or replace function app.nivel_actual() returns smallint
language sql stable security definer set search_path = '' as $$
  select r.nivel from public.usuarios u join public.roles r on r.codigo = u.rol
  where u.auth_id = auth.uid() and u.activo and app.sesion_valida()
$$;

create or replace function app.sucursal_actual() returns uuid
language sql stable security definer set search_path = '' as $$
  select u.sucursal_id from public.usuarios u where u.auth_id = auth.uid() and u.activo and app.sesion_valida()
$$;

create or replace function app.tiene_permiso(p_permiso text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.usuarios u
    join public.rol_permisos rp on rp.rol = u.rol
    where u.auth_id = auth.uid() and u.activo and rp.permiso = p_permiso)
  and app.sesion_valida()
$$;

-- Una sesión sin tablet registrada (ni 2FA) no ve ni su propia ficha: un enlace mágico
-- suelto no sirve para leer nada.
drop policy if exists ver on public.usuarios;
create policy ver on public.usuarios for select to authenticated
  using (((auth_id = (select auth.uid())) and (select app.sesion_valida()))
         or ((select app.tiene_permiso('usuarios.ver')) and (select app.en_mi_sucursal(sucursal_id))));

-- IP del cliente. Cuando llama una Edge Function (clave de servicio), ella informa la IP
-- de la tablet en x-pase-ip; a nadie más se le cree ese encabezado.
create or replace function app.ip_cliente() returns inet
language plpgsql stable as $$
begin
  return nullif(trim(split_part(coalesce(
    case when app.es_proceso_interno() then app.encabezado('x-pase-ip') end,
    app.encabezado('cf-connecting-ip'), app.encabezado('x-forwarded-for'), ''), ',', 1)), '')::inet;
exception when others then return null;
end $$;

create or replace function app.nombre_de(p_usuario uuid) returns text
language sql stable security definer set search_path = '' as $$
  select u.nombre || ' ' || u.apellido from public.usuarios u where u.id = p_usuario
$$;

create or replace function app.fecha_local(p_sucursal uuid default null) returns date
language sql stable security definer set search_path = '' as $$
  select (now() at time zone coalesce(
    (select s.zona_horaria from public.sucursales s where s.id = coalesce(p_sucursal, app.sucursal_actual())),
    'America/Caracas'))::date
$$;

-- Verifica el PIN de una persona con los mismos bloqueos que firmar(). Nunca lanza error
-- por un PIN malo: devuelve ok=false para que el intento fallido quede guardado.
create or replace function privado.comprobar_pin(
  p_usuario uuid, p_pin text, p_contexto text, p_entidad text, p_entidad_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  c         privado.credenciales_pin;
  v_max     int := coalesce((app.parametro('pin.max_intentos'))::int, 5);
  v_bloqueo int := coalesce((app.parametro('pin.minutos_bloqueo'))::int, 15);
  v_disp    uuid := app.dispositivo_actual();
  v_suc     uuid;
begin
  select * into c from privado.credenciales_pin where usuario_id = p_usuario for update;
  if c.usuario_id is null then
    return jsonb_build_object('ok', false, 'motivo', 'sin_pin');
  end if;
  if c.bloqueado_hasta > now() then
    return jsonb_build_object('ok', false, 'motivo', 'bloqueado', 'bloqueado_hasta', c.bloqueado_hasta);
  end if;
  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' or extensions.crypt(p_pin, c.pin_hash) <> c.pin_hash then
    insert into privado.intentos_pin (dispositivo_id, usuario_id, contexto, exito, ip)
    values (v_disp, p_usuario, p_contexto, false, app.ip_cliente());
    if c.intentos_fallidos + 1 >= v_max then
      update privado.credenciales_pin
        set intentos_fallidos = 0, bloqueado_hasta = now() + make_interval(mins => v_bloqueo)
      where usuario_id = p_usuario;
      select sucursal_id into v_suc from public.usuarios where id = p_usuario;
      insert into public.alertas (sucursal_id, tipo, severidad, titulo, detalle, rol_destino, clave_unica)
      values (v_suc, 'pin_bloqueado', 'alta', 'PIN bloqueado por intentos fallidos',
              format('%s intentos seguidos (%s)', v_max, p_entidad), 'supervisor',
              'pin:' || p_usuario || ':' || to_char(now(), 'YYYYMMDDHH24MI'))
      on conflict (clave_unica) do nothing;
      perform auditoria.anotar('PIN_BLOQUEADO', p_entidad, p_entidad_id::text, null, null, null, null, p_usuario);
      return jsonb_build_object('ok', false, 'motivo', 'bloqueado',
                                'bloqueado_hasta', now() + make_interval(mins => v_bloqueo));
    end if;
    update privado.credenciales_pin set intentos_fallidos = intentos_fallidos + 1 where usuario_id = p_usuario;
    perform auditoria.anotar('PIN_FALLIDO', p_entidad, p_entidad_id::text, null, null, null, null, p_usuario);
    return jsonb_build_object('ok', false, 'motivo', 'pin_incorrecto',
                              'intentos_restantes', v_max - c.intentos_fallidos - 1);
  end if;
  update privado.credenciales_pin set intentos_fallidos = 0 where usuario_id = p_usuario;
  insert into privado.intentos_pin (dispositivo_id, usuario_id, contexto, exito, ip)
  values (v_disp, p_usuario, p_contexto, true, app.ip_cliente());
  return jsonb_build_object('ok', true);
end $$;

-- -----------------------------------------------------------------------------
-- 3. EQUIPOS Y SESIONES
-- -----------------------------------------------------------------------------
-- La gerente registra el equipo en el propio equipo: entra con correo, contraseña y
-- segundo factor, y confirma con su PIN. El secreto se devuelve una sola vez y queda
-- guardado en ese navegador; la sesión de la gerente queda atada al equipo.
create or replace function public.registrar_este_dispositivo(
  p_id uuid, p_nombre text, p_tipo text, p_pin text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_auth     uuid := auth.uid();
  u          public.usuarios;
  v_secreto  text := encode(extensions.gen_random_bytes(32), 'hex');
  v_firma    uuid;
  v_sesion   uuid;
  v_pin      jsonb;
begin
  select * into u from public.usuarios where auth_id = v_auth and activo;
  if u.id is null then return jsonb_build_object('ok', false, 'motivo', 'sin_sesion'); end if;
  if not exists (select 1 from public.rol_permisos where rol = u.rol and permiso = 'dispositivos.gestionar') then
    return jsonb_build_object('ok', false, 'motivo', 'sin_permiso');
  end if;
  if coalesce(app.parametro('dispositivo.registro_exige_2fa'), 'true'::jsonb) <> 'false'::jsonb
     and coalesce(app.claims() ->> 'aal', 'aal1') <> 'aal2' then
    return jsonb_build_object('ok', false, 'motivo', 'requiere_2fa');
  end if;
  if p_id is null or length(trim(coalesce(p_nombre, ''))) < 3
     or p_tipo not in ('tablet_cocina','tablet_caja','telefono','pc_gerencia') then
    return jsonb_build_object('ok', false, 'motivo', 'datos_incompletos');
  end if;
  if exists (select 1 from public.dispositivos where id = p_id) then
    return jsonb_build_object('ok', false, 'motivo', 'ya_registrado');
  end if;
  v_sesion := nullif(app.claims() ->> 'session_id', '')::uuid;
  if v_sesion is null then return jsonb_build_object('ok', false, 'motivo', 'sin_sesion'); end if;

  v_pin := privado.comprobar_pin(u.id, p_pin, 'firma', 'dispositivos', p_id);
  if not (v_pin ->> 'ok')::boolean then return v_pin; end if;

  insert into public.firmas (usuario_id, accion, entidad, entidad_id, metodo, ip, expira_en, usada_en, usada_txid)
  values (u.id, 'crear', 'dispositivos', p_id, 'pin_en_linea', app.ip_cliente(),
          now() + interval '120 seconds', clock_timestamp(), txid_current())
  returning id into v_firma;
  perform set_config('app.contexto', 'registrar_este_dispositivo', true);
  insert into public.dispositivos (id, sucursal_id, nombre, tipo, registrado_por, firma_id)
  values (p_id, u.sucursal_id, trim(p_nombre), p_tipo, u.id, v_firma);
  update public.firmas set dispositivo_id = p_id where id = v_firma;
  insert into privado.dispositivo_secretos values (p_id, extensions.digest(v_secreto, 'sha256'));
  insert into privado.sesiones_dispositivo (session_id, dispositivo_id, usuario_id, metodo)
  values (v_sesion, p_id, u.id, 'correo')
  on conflict (session_id) do update set dispositivo_id = excluded.dispositivo_id, creada_en = now();
  perform set_config('app.contexto', '', true);
  return jsonb_build_object('ok', true, 'dispositivo', jsonb_build_object(
    'id', p_id, 'nombre', trim(p_nombre), 'tipo', p_tipo, 'sucursal_id', u.sucursal_id), 'secreto', v_secreto);
end $$;

-- La gerente entra con correo en un equipo ya registrado (la PC de gerencia): el equipo
-- prueba con su secreto que es él, y la sesión queda atada al equipo.
create or replace function public.vincular_dispositivo(p_dispositivo uuid, p_secreto text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  u        public.usuarios;
  d        public.dispositivos;
  v_sesion uuid := nullif(app.claims() ->> 'session_id', '')::uuid;
begin
  select * into u from public.usuarios where auth_id = auth.uid() and activo;
  if u.id is null or v_sesion is null then return jsonb_build_object('ok', false, 'motivo', 'sin_sesion'); end if;
  select * into d from public.dispositivos where id = p_dispositivo;
  if d.id is null or not d.activo or not exists (
       select 1 from privado.dispositivo_secretos s
       where s.dispositivo_id = d.id and s.secreto_hash = extensions.digest(coalesce(p_secreto, ''), 'sha256')) then
    if d.id is not null then perform privado.fallo_en_dispositivo(d.id, 'sesion'); end if;
    return jsonb_build_object('ok', false, 'motivo', 'dispositivo_no_registrado');
  end if;
  if d.bloqueado_hasta > now() then
    return jsonb_build_object('ok', false, 'motivo', 'dispositivo_bloqueado', 'hasta', d.bloqueado_hasta);
  end if;
  if u.sucursal_id <> d.sucursal_id and u.rol <> 'admin' then
    return jsonb_build_object('ok', false, 'motivo', 'otra_sucursal');
  end if;
  insert into privado.sesiones_dispositivo (session_id, dispositivo_id, usuario_id, metodo)
  values (v_sesion, d.id, u.id, 'correo')
  on conflict (session_id) do update set dispositivo_id = excluded.dispositivo_id, creada_en = now();
  update public.dispositivos set ultimo_uso = now() where id = d.id;
  perform auditoria.anotar('SESION_CORREO', 'dispositivos', d.id::text, null,
                           jsonb_build_object('dispositivo', d.nombre), null, null, u.id);
  return jsonb_build_object('ok', true, 'dispositivo', jsonb_build_object('id', d.id, 'nombre', d.nombre, 'tipo', d.tipo));
end $$;

-- Solo la Edge Function pin-sesion (clave de servicio): valida equipo + PIN.
create or replace function public.pin_abrir_sesion(p_dispositivo uuid, p_secreto text, p_pin text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare r jsonb;
begin
  if not app.es_proceso_interno() then
    raise exception 'Solo el servicio de sesiones abre sesiones por PIN' using errcode = '42501';
  end if;
  r := privado.abrir_sesion_por_pin(p_dispositivo, p_secreto, p_pin);
  if (r ->> 'ok')::boolean then
    r := r || jsonb_build_object(
      'correo', (select a.email from auth.users a where a.id = (r ->> 'auth_id')::uuid),
      'dispositivo', (select jsonb_build_object('id', d.id, 'nombre', d.nombre, 'tipo', d.tipo)
                      from public.dispositivos d where d.id = p_dispositivo));
  end if;
  return r;
end $$;

create or replace function public.pin_vincular_sesion(
  p_session uuid, p_dispositivo uuid, p_usuario uuid, p_metodo text default 'pin')
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  if not app.es_proceso_interno() then
    raise exception 'Solo el servicio de sesiones' using errcode = '42501';
  end if;
  insert into privado.sesiones_dispositivo (session_id, dispositivo_id, usuario_id, metodo)
  values (p_session, p_dispositivo, p_usuario, p_metodo)
  on conflict (session_id) do update set dispositivo_id = excluded.dispositivo_id,
    usuario_id = excluded.usuario_id, metodo = excluded.metodo, creada_en = now();
end $$;

-- Solo la Edge Function sincronizar: registra la firma de algo que se firmó sin conexión,
-- si el equipo es quien dice ser y la persona entró en él hace poco con su PIN.
create or replace function public.sincronizar_firma(
  p_dispositivo uuid, p_secreto text, p_usuario uuid, p_accion public.accion_firma,
  p_entidad text, p_entidad_id uuid, p_firmada_en timestamptz)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  d       public.dispositivos;
  u       public.usuarios;
  v_dias  int := coalesce((app.parametro('sin_conexion.dias_verificador'))::int, 7);
  v_horas int := coalesce((app.parametro('sin_conexion.horas_max_firma'))::int, 72);
  v_firma uuid;
begin
  if not app.es_proceso_interno() then
    raise exception 'Solo el servicio de sincronización' using errcode = '42501';
  end if;
  select * into d from public.dispositivos where id = p_dispositivo;
  if d.id is null or not d.activo or not exists (
       select 1 from privado.dispositivo_secretos s
       where s.dispositivo_id = d.id and s.secreto_hash = extensions.digest(coalesce(p_secreto, ''), 'sha256')) then
    return jsonb_build_object('ok', false, 'motivo', 'dispositivo_no_registrado');
  end if;
  select * into u from public.usuarios where id = p_usuario;
  if u.id is null or not u.activo or (u.sucursal_id <> d.sucursal_id and u.rol <> 'admin') then
    return jsonb_build_object('ok', false, 'motivo', 'usuario_no_valido');
  end if;
  if p_firmada_en > now() + interval '10 minutes' or p_firmada_en < now() - make_interval(hours => v_horas) then
    return jsonb_build_object('ok', false, 'motivo', 'fuera_de_plazo');
  end if;
  if not exists (select 1 from privado.sesiones_dispositivo s
                 where s.dispositivo_id = d.id and s.usuario_id = u.id and s.metodo = 'pin'
                   and s.creada_en > p_firmada_en - make_interval(days => v_dias)) then
    return jsonb_build_object('ok', false, 'motivo', 'sin_ingreso_reciente');
  end if;
  v_firma := public.registrar_firma_sin_conexion(u.id, d.id, p_accion, p_entidad, p_entidad_id, p_firmada_en);
  return jsonb_build_object('ok', true, 'firma_id', v_firma, 'auth_id', u.auth_id,
    'correo', (select a.email from auth.users a where a.id = u.auth_id));
end $$;

-- -----------------------------------------------------------------------------
-- 4. LECTURAS DE LA APP
-- -----------------------------------------------------------------------------
create or replace function public.pase_contexto() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'usuario', jsonb_build_object('id', u.id, 'nombre', u.nombre, 'apellido', u.apellido, 'rol', u.rol,
      'nivel', r.nivel, 'cargo', u.cargo, 'turno', u.turno, 'sucursal_id', u.sucursal_id),
    'permisos', (select coalesce(jsonb_agg(rp.permiso order by rp.permiso), '[]'::jsonb)
                 from public.rol_permisos rp where rp.rol = u.rol),
    'pin', (select jsonb_build_object('longitud', c.longitud, 'debe_cambiar', c.debe_cambiar)
            from privado.credenciales_pin c where c.usuario_id = u.id),
    'sucursal', (select jsonb_build_object('id', s.id, 'nombre', s.nombre, 'zona_horaria', s.zona_horaria)
                 from public.sucursales s where s.id = u.sucursal_id),
    'dispositivo', (select jsonb_build_object('id', d.id, 'nombre', d.nombre, 'tipo', d.tipo)
                    from public.dispositivos d where d.id = app.dispositivo_actual()),
    'parametros', (select jsonb_object_agg(p.clave, p.valor) from public.parametros p
                   where p.clave in ('sesion.segundos_inactividad', 'incidencia.sla_minutos', 'horarios.alias',
                                     'sin_conexion.dias_verificador', 'planilla.minutos_anticipacion')),
    'aal', coalesce(app.claims() ->> 'aal', 'aal1'),
    'hora_servidor', now())
  from public.usuarios u join public.roles r on r.codigo = u.rol
  where u.id = app.usuario_actual()
$$;

-- Plantillas vigentes que la persona puede llenar (su nivel o inferior), completas,
-- para guardarlas en el equipo y trabajar sin conexión.
create or replace function public.pase_catalogo() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'codigo', p.codigo, 'version', p.version, 'nombre', p.nombre, 'tipo', p.tipo, 'area', p.area,
      'frecuencia', p.frecuencia, 'horarios', p.horarios, 'rol_asignado', p.rol_asignado, 'rol_revisor', p.rol_revisor,
      'minutos', p.minutos_estimados, 'objetivo', p.objetivo, 'bloquea', p.bloquea_operacion,
      'documento', p.documento_origen,
      'secciones', (
        select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'orden', s.orden, 'titulo', s.titulo, 'hora', s.hora,
          'items', (select coalesce(jsonb_agg(jsonb_build_object(
              'id', i.id, 'ref', i.ref, 'texto', i.texto, 'tipo', i.tipo, 'critico', i.critico, 'unidad', i.unidad,
              'min', i.valor_min, 'max', i.valor_max, 'opciones', i.opciones, 'foto_si_falla', i.foto_si_falla,
              'admite_na', i.admite_no_aplica, 'ayuda', i.ayuda) order by i.orden), '[]'::jsonb)
            from public.plantilla_items i where i.seccion_id = s.id)) order by s.orden), '[]'::jsonb)
        from public.plantilla_secciones s where s.plantilla_id = p.id)
    ) order by p.codigo), '[]'::jsonb)
  from public.plantillas p
  join public.roles r on r.codigo = p.rol_asignado
  where p.vigente and not p.anulado and app.usuario_actual() is not null and r.nivel <= app.nivel_actual()
$$;

-- El riel del día: lo programado para la sucursal, visible según el nivel de la persona.
-- Si pg_cron no generó el día (o aún no corrió), lo genera aquí.
create or replace function public.pase_hoy(p_fecha date default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_suc   uuid := app.sucursal_actual();
  v_nivel smallint := app.nivel_actual();
  v_fecha date;
  v_tz    text;
begin
  if v_suc is null then raise exception 'Sesión no válida' using errcode = '42501'; end if;
  select zona_horaria into v_tz from public.sucursales where id = v_suc;
  v_fecha := coalesce(p_fecha, (now() at time zone v_tz)::date);
  if not exists (select 1 from public.checklist_programacion where sucursal_id = v_suc and fecha = v_fecha) then
    perform app.generar_programacion(v_fecha);
  end if;
  return jsonb_build_object('fecha', v_fecha, 'ahora', now(), 'programadas', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', cp.id, 'plantilla_id', p.id, 'codigo', p.codigo, 'nombre', p.nombre, 'area', p.area,
      'rol_asignado', p.rol_asignado, 'minutos', p.minutos_estimados, 'bloquea', p.bloquea_operacion,
      'horario', cp.horario,
      'desde', case when cp.horario = '' then (cp.fecha::timestamp at time zone v_tz)
                    else ((cp.fecha + app.hora_de(cp.horario))::timestamp at time zone v_tz) end,
      'vence_en', cp.vence_en, 'ejecucion_id', cp.ejecucion_id,
      'hecha_en', e.completada_en, 'hecha_por', app.nombre_de(e.realizada_por), 'hecha_por_id', e.realizada_por,
      'puntaje', e.puntaje, 'no_cumple', e.items_no_cumple, 'criticos', e.criticos_no_cumple)
      order by cp.vence_en, p.codigo)
    from public.checklist_programacion cp
    join public.plantillas p on p.id = cp.plantilla_id
    join public.roles r on r.codigo = p.rol_asignado
    left join public.checklist_ejecuciones e on e.id = cp.ejecucion_id
    where cp.sucursal_id = v_suc and cp.fecha = v_fecha and r.nivel <= v_nivel), '[]'::jsonb));
end $$;

-- Planillas llenadas: las propias, o todas para quien tiene checklists.ver_todos
create or replace function public.pase_ejecuciones(
  p_desde timestamptz default null, p_solo_mias boolean default false, p_limite int default 100)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x order by x ->> 'completada_en' desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', e.id, 'plantilla_id', p.id, 'codigo', p.codigo, 'nombre', p.nombre, 'area', p.area, 'horario', e.horario,
      'completada_en', e.completada_en, 'realizada_por', e.realizada_por, 'realizada_por_nombre', app.nombre_de(e.realizada_por),
      'estado', e.estado, 'puntaje', e.puntaje, 'total', e.total_items, 'cumple', e.items_cumple,
      'no_cumple', e.items_no_cumple, 'criticos', e.criticos_no_cumple, 'sin_conexion', e.registrada_sin_conexion,
      'revisada_por_nombre', app.nombre_de(e.revisada_por), 'revisada_en', e.revisada_en, 'nota_revision', e.nota_revision,
      'rol_revisor', p.rol_revisor) as x
    from public.checklist_ejecuciones e
    join public.plantillas p on p.id = e.plantilla_id
    where e.sucursal_id = app.sucursal_actual()
      and e.completada_en >= coalesce(p_desde, now() - interval '24 hours')
      and (e.realizada_por = app.usuario_actual()
           or (not p_solo_mias and app.tiene_permiso('checklists.ver_todos')))
    order by e.completada_en desc
    limit least(coalesce(p_limite, 100), 500)) t
$$;

create or replace function public.pase_ejecucion(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', e.id, 'plantilla_id', p.id, 'codigo', p.codigo, 'nombre', p.nombre, 'area', p.area, 'version', p.version,
    'horario', e.horario, 'iniciada_en', e.iniciada_en, 'completada_en', e.completada_en,
    'realizada_por', e.realizada_por, 'realizada_por_nombre', app.nombre_de(e.realizada_por),
    'estado', e.estado, 'puntaje', e.puntaje, 'total', e.total_items, 'cumple', e.items_cumple,
    'no_cumple', e.items_no_cumple, 'criticos', e.criticos_no_cumple, 'sin_conexion', e.registrada_sin_conexion,
    'revisada_por_nombre', app.nombre_de(e.revisada_por), 'revisada_en', e.revisada_en, 'nota_revision', e.nota_revision,
    'rol_revisor', p.rol_revisor,
    'dispositivo', (select d.nombre from public.dispositivos d where d.id = e.dispositivo_id),
    'firma', (select jsonb_build_object('id', f.id, 'metodo', f.metodo, 'creada_en', f.creada_en,
                                        'firmada_sin_conexion_en', f.firmada_sin_conexion_en,
                                        'firmante', app.nombre_de(f.usuario_id))
              from public.firmas f where f.id = e.firma_id),
    'respuestas', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'item_id', i.id, 'ref', i.ref, 'texto', i.texto, 'tipo', i.tipo, 'critico', i.critico, 'unidad', i.unidad,
        'min', i.valor_min, 'max', i.valor_max, 'seccion', s.titulo,
        'valor_bool', r.valor_bool, 'valor_num', r.valor_num, 'valor_texto', r.valor_texto,
        'valor_opcion', r.valor_opcion, 'valor_hora', r.valor_hora, 'no_aplica', r.no_aplica,
        'cumple', r.cumple, 'observacion', r.observacion,
        'evidencia', (select jsonb_build_object('id', v.id, 'ruta', v.ruta_storage, 'mime', v.mime)
                      from public.evidencias v where v.id = r.evidencia_id))
        order by s.orden, i.orden), '[]'::jsonb)
      from public.checklist_respuestas r
      join public.plantilla_items i on i.id = r.item_id
      join public.plantilla_secciones s on s.id = i.seccion_id
      where r.ejecucion_id = e.id),
    'incidencias', (
      select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'titulo', n.titulo, 'severidad', n.severidad,
                                                   'estado', n.estado) order by n.reportada_en), '[]'::jsonb)
      from public.incidencias n where n.ejecucion_id = e.id))
  from public.checklist_ejecuciones e
  join public.plantillas p on p.id = e.plantilla_id
  where e.id = p_id and e.sucursal_id = app.sucursal_actual()
    and (e.realizada_por = app.usuario_actual() or app.tiene_permiso('checklists.ver_todos'))
$$;

create or replace function public.pase_incidencias(p_activas boolean default true, p_limite int default 100)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x order by (x ->> 'orden')::int, x ->> 'reportada_en' desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', n.id, 'titulo', n.titulo, 'descripcion', n.descripcion, 'area', coalesce(n.area, p.area::text),
      'origen', n.origen, 'severidad', n.severidad, 'estado', n.estado, 'bloquea', n.bloquea_operacion,
      'codigo_plantilla', p.codigo, 'nombre_plantilla', p.nombre, 'ref_item', i.ref, 'ejecucion_id', n.ejecucion_id,
      'reportada_por', n.reportada_por, 'reportada_por_nombre', app.nombre_de(n.reportada_por), 'reportada_en', n.reportada_en,
      'asignada_a', n.asignada_a, 'asignada_a_nombre', app.nombre_de(n.asignada_a),
      'vence_en', n.vence_en, 'escalada', n.escalada, 'accion_correctiva', n.accion_correctiva, 'causa_raiz', n.causa_raiz,
      'resuelta_por', n.resuelta_por, 'resuelta_por_nombre', app.nombre_de(n.resuelta_por), 'resuelta_en', n.resuelta_en,
      'verificada_por_nombre', app.nombre_de(n.verificada_por), 'verificada_en', n.verificada_en,
      'evidencia', (select jsonb_build_object('id', v.id, 'ruta', v.ruta_storage, 'mime', v.mime)
                    from public.evidencias v where v.id = n.evidencia_id),
      'orden', case n.severidad when 'critica' then 0 when 'alta' then 1 when 'media' then 2 else 3 end) as x
    from public.incidencias n
    left join public.plantillas p on p.id = n.plantilla_id
    left join public.plantilla_items i on i.id = n.item_id
    where n.sucursal_id = app.sucursal_actual() and not n.anulado
      and (n.reportada_por = app.usuario_actual() or n.asignada_a = app.usuario_actual()
           or app.tiene_permiso('incidencias.gestionar'))
      and (case when p_activas then n.estado in ('abierta','en_proceso')
                                   or (n.estado = 'resuelta' and n.severidad = 'critica')
                                   or (n.estado = 'resuelta' and n.resuelta_en > now() - interval '24 hours')
                else n.reportada_en > now() - interval '30 days' end)
    order by n.reportada_en desc
    limit least(coalesce(p_limite, 100), 500)) t
$$;

create or replace function public.pase_alertas(p_limite int default 50)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x order by x ->> 'creada_en' desc), '[]'::jsonb) from (
    select jsonb_build_object('id', a.id, 'tipo', a.tipo, 'severidad', a.severidad, 'titulo', a.titulo,
      'detalle', a.detalle, 'estado', a.estado, 'creada_en', a.creada_en, 'incidencia_id', a.incidencia_id,
      'vista_por_nombre', app.nombre_de(a.vista_por)) as x
    from public.alertas a
    left join public.roles r on r.codigo = a.rol_destino
    where a.sucursal_id = app.sucursal_actual() and a.estado <> 'resuelta'
      and (a.usuario_destino = app.usuario_actual()
           or (a.usuario_destino is null and r.nivel <= app.nivel_actual()))
    order by a.creada_en desc
    limit least(coalesce(p_limite, 50), 200)) t
$$;

-- Panel del supervisor y la gerente: cumplimiento del día, vencidas, por revisar,
-- incidencias y la tendencia de las últimas dos semanas.
create or replace function public.pase_panel(p_fecha date default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_suc   uuid := app.sucursal_actual();
  v_yo    uuid := app.usuario_actual();
  v_fecha date;
  v_tz    text;
begin
  if not app.tiene_permiso('checklists.ver_todos') then
    raise exception 'Sin acceso al panel' using errcode = '42501';
  end if;
  select zona_horaria into v_tz from public.sucursales where id = v_suc;
  v_fecha := coalesce(p_fecha, (now() at time zone v_tz)::date);
  if not exists (select 1 from public.checklist_programacion where sucursal_id = v_suc and fecha = v_fecha) then
    perform app.generar_programacion(v_fecha);
  end if;
  return jsonb_build_object(
    'fecha', v_fecha, 'ahora', now(),
    'programadas', (
      select jsonb_build_object('total', count(*),
        'hechas', count(*) filter (where cp.ejecucion_id is not null),
        'vencidas', count(*) filter (where cp.ejecucion_id is null and cp.vence_en < now()),
        'pendientes', count(*) filter (where cp.ejecucion_id is null and cp.vence_en >= now()))
      from public.checklist_programacion cp where cp.sucursal_id = v_suc and cp.fecha = v_fecha),
    'vencidas', coalesce((
      select jsonb_agg(jsonb_build_object('id', cp.id, 'codigo', p.codigo, 'nombre', p.nombre, 'area', p.area,
        'horario', cp.horario, 'vence_en', cp.vence_en, 'rol_asignado', p.rol_asignado, 'bloquea', p.bloquea_operacion)
        order by cp.vence_en desc)
      from public.checklist_programacion cp join public.plantillas p on p.id = cp.plantilla_id
      where cp.sucursal_id = v_suc and cp.fecha = v_fecha and cp.ejecucion_id is null and cp.vence_en < now()), '[]'::jsonb),
    'por_area', coalesce((
      select jsonb_agg(jsonb_build_object('area', a.area, 'total', a.total, 'hechas', a.hechas,
        'pct', round(100.0 * a.hechas / nullif(a.vencibles, 0), 1)) order by a.area)
      from (select p.area::text as area, count(*) as total,
                   count(*) filter (where cp.ejecucion_id is not null) as hechas,
                   count(*) filter (where cp.ejecucion_id is not null or cp.vence_en < now()) as vencibles
            from public.checklist_programacion cp join public.plantillas p on p.id = cp.plantilla_id
            where cp.sucursal_id = v_suc and cp.fecha = v_fecha group by p.area) a), '[]'::jsonb),
    'por_revisar', coalesce((
      select jsonb_agg(jsonb_build_object('id', e.id, 'codigo', p.codigo, 'nombre', p.nombre,
        'realizada_por_nombre', app.nombre_de(e.realizada_por), 'completada_en', e.completada_en,
        'puntaje', e.puntaje, 'no_cumple', e.items_no_cumple, 'criticos', e.criticos_no_cumple,
        'sin_conexion', e.registrada_sin_conexion, 'propia', e.realizada_por = v_yo)
        order by e.criticos_no_cumple desc, e.items_no_cumple desc, e.completada_en desc)
      from public.checklist_ejecuciones e join public.plantillas p on p.id = e.plantilla_id
      join public.roles r on r.codigo = p.rol_revisor
      where e.sucursal_id = v_suc and e.estado = 'completada' and not e.anulado
        and e.completada_en > now() - interval '48 hours' and r.nivel <= app.nivel_actual()), '[]'::jsonb),
    'incidencias', (
      select jsonb_build_object(
        'activas', count(*) filter (where n.estado in ('abierta','en_proceso')),
        'criticas', count(*) filter (where n.estado in ('abierta','en_proceso') and n.severidad = 'critica'),
        'fuera_de_plazo', count(*) filter (where n.estado in ('abierta','en_proceso') and n.vence_en < now()),
        'por_verificar', count(*) filter (where n.estado = 'resuelta' and n.severidad = 'critica'),
        'bloquean', count(*) filter (where n.bloquea_operacion and n.estado not in ('verificada','anulada')))
      from public.incidencias n where n.sucursal_id = v_suc and not n.anulado),
    'alertas_abiertas', (select count(*) from public.alertas a left join public.roles r on r.codigo = a.rol_destino
                         where a.sucursal_id = v_suc and a.estado = 'abierta'
                           and (a.usuario_destino = v_yo or (a.usuario_destino is null and r.nivel <= app.nivel_actual()))),
    'tendencia', coalesce((
      select jsonb_agg(jsonb_build_object('fecha', t.fecha, 'pct', t.pct, 'puntaje', t.puntaje) order by t.fecha)
      from (select cp.fecha,
                   round(100.0 * count(*) filter (where cp.ejecucion_id is not null)
                         / nullif(count(*) filter (where cp.ejecucion_id is not null or cp.vence_en < now()), 0), 1) as pct,
                   (select round(avg(e.puntaje), 1) from public.checklist_ejecuciones e
                    where e.sucursal_id = v_suc and not e.anulado
                      and (e.completada_en at time zone v_tz)::date = cp.fecha) as puntaje
            from public.checklist_programacion cp
            where cp.sucursal_id = v_suc and cp.fecha between v_fecha - 13 and v_fecha
            group by cp.fecha) t), '[]'::jsonb));
end $$;

create or replace function public.pase_personal() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', u.id, 'nombre', u.nombre, 'apellido', u.apellido, 'cedula', u.cedula, 'cargo', u.cargo,
      'rol', u.rol, 'turno', u.turno, 'activo', u.activo, 'creado_en', u.creado_en,
      'tiene_pin', c.usuario_id is not null, 'pin_longitud', c.longitud, 'debe_cambiar_pin', c.debe_cambiar,
      'pin_bloqueado_hasta', case when c.bloqueado_hasta > now() then c.bloqueado_hasta end,
      'correo', (select a.email from auth.users a where a.id = u.auth_id and a.email not like '%.invalid'),
      'ultimo_ingreso', (select max(i.ocurrido_en) from privado.intentos_pin i where i.usuario_id = u.id and i.exito))
      order by u.activo desc, case u.rol when 'admin' then 0 when 'supervisor' then 1 else 2 end, u.nombre), '[]'::jsonb)
  from public.usuarios u
  left join privado.credenciales_pin c on c.usuario_id = u.id
  where app.tiene_permiso('usuarios.ver') and (u.sucursal_id = app.sucursal_actual() or app.es_admin())
$$;

create or replace function public.pase_dispositivos() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', d.id, 'nombre', d.nombre, 'tipo', d.tipo, 'activo', d.activo,
      'registrado_por_nombre', app.nombre_de(d.registrado_por), 'registrado_en', d.registrado_en,
      'ultimo_uso', d.ultimo_uso, 'bloqueado_hasta', case when d.bloqueado_hasta > now() then d.bloqueado_hasta end,
      'este', d.id = app.dispositivo_actual()) order by d.activo desc, d.nombre), '[]'::jsonb)
  from public.dispositivos d
  where app.tiene_permiso('usuarios.ver') and app.en_mi_sucursal(d.sucursal_id)
$$;

-- Bitácora legible: nombres de personas y equipos, método de la firma
create or replace function public.pase_bitacora(
  p_desde timestamptz default null, p_hasta timestamptz default null, p_tabla text default null,
  p_antes_de bigint default null, p_limite int default 200)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.tiene_permiso('auditoria.ver') then
    raise exception 'Solo la gerente consulta la bitácora' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(x order by (x ->> 'id')::bigint desc) from (
      select jsonb_build_object('id', a.id, 'ocurrido_en', a.ocurrido_en, 'accion', a.accion, 'tabla', a.tabla,
        'registro_id', a.registro_id, 'usuario', app.nombre_de(a.usuario_id), 'sesion', app.nombre_de(a.usuario_sesion_id),
        'rol', a.rol, 'dispositivo', (select d.nombre from public.dispositivos d where d.id = a.dispositivo_id),
        'ip', host(a.ip), 'metodo', (select f.metodo from public.firmas f where f.id = a.firma_id),
        'campos', a.campos_modificados, 'antes', a.valores_anteriores, 'despues', a.valores_nuevos,
        'hash', encode(a.hash, 'hex')) as x
      from auditoria.registros a
      where a.ocurrido_en >= coalesce(p_desde, now() - interval '7 days')
        and a.ocurrido_en <= coalesce(p_hasta, now())
        and (p_tabla is null or a.tabla = p_tabla)
        and (p_antes_de is null or a.id < p_antes_de)
        and app.en_mi_sucursal(coalesce(
              (select u.sucursal_id from public.usuarios u where u.id = coalesce(a.usuario_id, a.usuario_sesion_id)),
              (select d.sucursal_id from public.dispositivos d where d.id = a.dispositivo_id),
              app.sucursal_actual()))
      order by a.id desc
      limit least(coalesce(p_limite, 200), 1000)) t), '[]'::jsonb);
end $$;

create or replace function public.pase_verificar_bitacora() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_roto bigint;
begin
  if not app.tiene_permiso('auditoria.ver') then
    raise exception 'Solo la gerente consulta la bitácora' using errcode = '42501';
  end if;
  v_roto := auditoria.verificar_cadena();
  return jsonb_build_object('integra', v_roto is null, 'primer_registro_alterado', v_roto,
    'registros', (select count(*) from auditoria.registros));
end $$;

-- -----------------------------------------------------------------------------
-- 5. ESCRITURAS DE LA APP (todas con firma, salvo marcar una alerta como vista)
-- -----------------------------------------------------------------------------
create or replace function app.guardar_evidencias(p_evidencias jsonb)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare
  v   jsonb;
  v_suc uuid := app.sucursal_actual();
  v_hay boolean;
begin
  for v in select * from jsonb_array_elements(coalesce(p_evidencias, '[]'::jsonb)) loop
    if exists (select 1 from public.evidencias where id = (v ->> 'id')::uuid) then continue; end if;
    if (v ->> 'ruta') not like v_suc::text || '/%' then
      raise exception 'Ruta de foto no válida' using errcode = '42501';
    end if;
    if to_regclass('storage.objects') is not null then
      execute 'select exists (select 1 from storage.objects where bucket_id = $1 and name = $2)'
        into v_hay using 'evidencias', v ->> 'ruta';
      if not v_hay then raise exception 'La foto no terminó de subir; inténtalo de nuevo' using errcode = 'P0002'; end if;
    end if;
    insert into public.evidencias (id, sucursal_id, ruta_storage, sha256, mime, bytes, tomada_en)
    values ((v ->> 'id')::uuid, v_suc, v ->> 'ruta', v ->> 'sha256', coalesce(v ->> 'mime', 'image/webp'),
            (v ->> 'bytes')::int, coalesce((v ->> 'tomada_en')::timestamptz, now()));
  end loop;
end $$;

-- Enviar una planilla con sus fotos. Si ya llegó (reintento), responde lo mismo sin duplicar.
create or replace function public.enviar_planilla(
  p_ejecucion jsonb, p_respuestas jsonb, p_evidencias jsonb, p_firma uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid := (p_ejecucion ->> 'id')::uuid;
  e    public.checklist_ejecuciones;
  cp   public.checklist_programacion;
  r    jsonb;
begin
  if app.usuario_actual() is null then raise exception 'Sesión no válida' using errcode = '42501'; end if;
  select * into e from public.checklist_ejecuciones where id = v_id;
  if e.id is not null then
    if e.realizada_por <> app.usuario_actual() then
      raise exception 'Ese registro ya existe' using errcode = '23505';
    end if;
    return jsonb_build_object('ok', true, 'ya_existia', true, 'ejecucion_id', e.id, 'puntaje', e.puntaje,
      'no_cumple', e.items_no_cumple, 'criticos_no_cumple', e.criticos_no_cumple,
      'incidencias', (select count(*) from public.incidencias where ejecucion_id = e.id));
  end if;
  -- La app manda la línea del riel que se está llenando: así queda marcada aunque se
  -- entregue pasada la medianoche o con otro horario escrito.
  if p_ejecucion ? 'programacion_id' then
    select * into cp from public.checklist_programacion
     where id = (p_ejecucion ->> 'programacion_id')::uuid and sucursal_id = app.sucursal_actual();
    if cp.id is not null then
      p_ejecucion := p_ejecucion || jsonb_build_object('horario', cp.horario);
    end if;
  end if;
  perform app.guardar_evidencias(p_evidencias);
  r := public.enviar_checklist(p_ejecucion, p_respuestas, p_firma);
  if cp.id is not null then
    update public.checklist_programacion set ejecucion_id = v_id where id = cp.id and ejecucion_id is null;
  end if;
  return r;
end $$;

create or replace function public.reportar_incidencia(p_incidencia jsonb, p_evidencia jsonb, p_firma uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id  uuid := (p_incidencia ->> 'id')::uuid;
  v_sev public.severidad := coalesce(p_incidencia ->> 'severidad', 'media')::public.severidad;
  n     public.incidencias;
begin
  if not app.tiene_permiso('incidencias.reportar') then
    raise exception 'Sin permiso para reportar incidencias' using errcode = '42501';
  end if;
  select * into n from public.incidencias where id = v_id;
  if n.id is not null then
    return jsonb_build_object('ok', true, 'ya_existia', true, 'incidencia_id', n.id, 'vence_en', n.vence_en);
  end if;
  if length(trim(coalesce(p_incidencia ->> 'titulo', ''))) < 5 then
    raise exception 'Describe la falla en al menos 5 letras';
  end if;
  if v_sev = 'critica' and p_evidencia is null then
    raise exception 'Una falla crítica lleva foto' using errcode = '23514';
  end if;
  if p_evidencia is not null then perform app.guardar_evidencias(jsonb_build_array(p_evidencia)); end if;
  insert into public.incidencias (id, sucursal_id, area, titulo, descripcion, severidad, bloquea_operacion,
                                  evidencia_id, firma_id)
  values (v_id, app.sucursal_actual(), nullif(trim(p_incidencia ->> 'area'), ''), left(trim(p_incidencia ->> 'titulo'), 180),
          nullif(trim(p_incidencia ->> 'descripcion'), ''), v_sev,
          coalesce((p_incidencia ->> 'bloquea')::boolean, false),
          (p_evidencia ->> 'id')::uuid, p_firma)
  returning * into n;
  return jsonb_build_object('ok', true, 'incidencia_id', n.id, 'vence_en', n.vence_en, 'severidad', n.severidad);
end $$;

-- Atender, resolver, verificar o anular. Las reglas del flujo las aplica el trigger.
create or replace function public.actualizar_incidencia(p_id uuid, p_cambios jsonb, p_firma uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  n        public.incidencias;
  v_estado public.estado_incidencia;
  v_asig   uuid;
begin
  if not app.tiene_permiso('incidencias.gestionar') then
    raise exception 'Sin permiso para gestionar incidencias' using errcode = '42501';
  end if;
  select * into n from public.incidencias where id = p_id and sucursal_id = app.sucursal_actual();
  if n.id is null then raise exception 'Incidencia no encontrada'; end if;
  v_estado := coalesce(p_cambios ->> 'estado', n.estado::text)::public.estado_incidencia;
  v_asig := case when p_cambios ? 'asignada_a' then nullif(p_cambios ->> 'asignada_a', '')::uuid else n.asignada_a end;
  if v_asig is not null and not exists (select 1 from public.usuarios u where u.id = v_asig and u.activo
                                         and u.sucursal_id = n.sucursal_id) then
    raise exception 'Responsable no válido';
  end if;
  update public.incidencias set
    estado = v_estado,
    asignada_a = v_asig,
    accion_correctiva = coalesce(nullif(trim(p_cambios ->> 'accion_correctiva'), ''), accion_correctiva),
    causa_raiz = coalesce(nullif(trim(p_cambios ->> 'causa_raiz'), ''), causa_raiz),
    anulado = v_estado = 'anulada',
    firma_id = p_firma
  where id = p_id
  returning * into n;
  return jsonb_build_object('ok', true, 'incidencia_id', n.id, 'estado', n.estado);
end $$;

create or replace function public.revisar_ejecucion(p_id uuid, p_estado public.estado_ejecucion, p_nota text, p_firma uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare e public.checklist_ejecuciones;
begin
  if not app.tiene_permiso('checklists.revisar') then
    raise exception 'Sin permiso para revisar planillas' using errcode = '42501';
  end if;
  select * into e from public.checklist_ejecuciones where id = p_id and sucursal_id = app.sucursal_actual();
  if e.id is null then raise exception 'Planilla no encontrada'; end if;
  update public.checklist_ejecuciones
     set estado = p_estado, nota_revision = nullif(trim(p_nota), ''), anulado = p_estado = 'anulada', firma_id = p_firma
   where id = p_id
  returning * into e;
  return jsonb_build_object('ok', true, 'ejecucion_id', e.id, 'estado', e.estado,
                            'revisada_por', app.nombre_de(e.revisada_por));
end $$;

create or replace function public.marcar_alerta_vista(p_id uuid)
returns void language plpgsql volatile security invoker set search_path = '' as $$
begin
  update public.alertas set estado = 'vista' where id = p_id and estado = 'abierta';
end $$;

-- Alta de una persona. La Edge Function "personal" crea antes su usuario de Supabase Auth
-- (sin contraseña) y llama aquí con el token de la gerente. Devuelve el PIN provisional,
-- que se muestra una sola vez; en su primer ingreso la persona lo cambia.
create or replace function public.crear_usuario(p_usuario jsonb, p_auth_id uuid, p_longitud int, p_firma uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id   uuid := (p_usuario ->> 'id')::uuid;
  v_rol  text := coalesce(p_usuario ->> 'rol', 'operativo');
  v_long int := case when v_rol in ('admin','supervisor') then 6 else coalesce(p_longitud, 4) end;
  v_pin  text;
begin
  if not app.tiene_permiso('usuarios.gestionar') then
    raise exception 'Sin permiso para gestionar el personal' using errcode = '42501';
  end if;
  if v_rol not in ('operativo','supervisor','admin') then raise exception 'Rol no válido'; end if;
  if v_long not between 4 and 6 then raise exception 'El PIN tiene de 4 a 6 dígitos'; end if;
  if length(trim(coalesce(p_usuario ->> 'nombre', ''))) < 2 or length(trim(coalesce(p_usuario ->> 'apellido', ''))) < 2 then
    raise exception 'Faltan el nombre y el apellido';
  end if;
  if not exists (select 1 from auth.users a where a.id = p_auth_id)
     or exists (select 1 from public.usuarios u where u.auth_id = p_auth_id) then
    raise exception 'Cuenta de acceso no válida';
  end if;
  perform app.consumir_firma(p_firma, 'usuarios', v_id, array['crear']::public.accion_firma[]);
  perform set_config('app.contexto', 'crear_usuario', true);
  insert into public.usuarios (id, auth_id, sucursal_id, nombre, apellido, cedula, cargo, rol, turno, firma_id)
  values (v_id, p_auth_id, app.sucursal_actual(), trim(p_usuario ->> 'nombre'), trim(p_usuario ->> 'apellido'),
          nullif(trim(p_usuario ->> 'cedula'), ''), nullif(trim(p_usuario ->> 'cargo'), ''), v_rol,
          nullif(p_usuario ->> 'turno', ''), p_firma);
  v_pin := privado.nuevo_pin(v_id, v_long);
  update privado.credenciales_pin set debe_cambiar = true where usuario_id = v_id;
  perform auditoria.anotar('PIN_ASIGNADO', 'usuarios', v_id::text, null, null, p_firma);
  perform set_config('app.contexto', '', true);
  return jsonb_build_object('ok', true, 'usuario_id', v_id, 'pin_provisional', v_pin);
end $$;

create or replace function public.modificar_usuario(p_id uuid, p_cambios jsonb, p_firma uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare u public.usuarios;
begin
  if not app.tiene_permiso('usuarios.gestionar') then
    raise exception 'Sin permiso para gestionar el personal' using errcode = '42501';
  end if;
  select * into u from public.usuarios where id = p_id and app.en_mi_sucursal(sucursal_id);
  if u.id is null then raise exception 'Persona no encontrada'; end if;
  if p_id = app.usuario_actual() and (p_cambios ? 'rol' or p_cambios ? 'activo') then
    raise exception 'No puedes cambiar tu propio rol ni desactivarte' using errcode = '42501';
  end if;
  if p_cambios ? 'rol' and (p_cambios ->> 'rol') not in ('operativo','supervisor','admin') then
    raise exception 'Rol no válido';
  end if;
  if p_cambios ? 'rol' and (p_cambios ->> 'rol') in ('admin','supervisor')
     and exists (select 1 from privado.credenciales_pin c where c.usuario_id = p_id and c.longitud < 6) then
    raise exception 'Para ser supervisor o gerente necesita un PIN de 6 dígitos: asígnale uno nuevo primero';
  end if;
  update public.usuarios set
    nombre   = coalesce(nullif(trim(p_cambios ->> 'nombre'), ''), nombre),
    apellido = coalesce(nullif(trim(p_cambios ->> 'apellido'), ''), apellido),
    cedula   = case when p_cambios ? 'cedula' then nullif(trim(p_cambios ->> 'cedula'), '') else cedula end,
    cargo    = case when p_cambios ? 'cargo' then nullif(trim(p_cambios ->> 'cargo'), '') else cargo end,
    turno    = case when p_cambios ? 'turno' then nullif(p_cambios ->> 'turno', '') else turno end,
    rol      = coalesce(p_cambios ->> 'rol', rol),
    activo   = coalesce((p_cambios ->> 'activo')::boolean, activo),
    actualizado_en = now(),
    firma_id = p_firma
  where id = p_id
  returning * into u;
  if not u.activo then
    delete from privado.sesiones_dispositivo where usuario_id = u.id;
  end if;
  return jsonb_build_object('ok', true, 'usuario_id', u.id, 'activo', u.activo, 'rol', u.rol);
end $$;

create or replace function public.modificar_dispositivo(p_id uuid, p_cambios jsonb, p_firma uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare d public.dispositivos;
begin
  if not app.tiene_permiso('dispositivos.gestionar') then
    raise exception 'Sin permiso para gestionar equipos' using errcode = '42501';
  end if;
  select * into d from public.dispositivos where id = p_id and app.en_mi_sucursal(sucursal_id);
  if d.id is null then raise exception 'Equipo no encontrado'; end if;
  if p_id = app.dispositivo_actual() and (p_cambios ->> 'activo')::boolean is false then
    raise exception 'No puedes dar de baja el equipo que estás usando';
  end if;
  update public.dispositivos set
    nombre = coalesce(nullif(trim(p_cambios ->> 'nombre'), ''), nombre),
    activo = coalesce((p_cambios ->> 'activo')::boolean, activo),
    bloqueado_hasta = case when (p_cambios ->> 'desbloquear')::boolean then null else bloqueado_hasta end,
    firma_id = p_firma
  where id = p_id
  returning * into d;
  if not d.activo then
    delete from privado.sesiones_dispositivo where dispositivo_id = d.id;
  end if;
  return jsonb_build_object('ok', true, 'dispositivo_id', d.id, 'activo', d.activo);
end $$;

-- Al bloquear la tablet, la sesión de esa persona deja de valer en el equipo
create or replace function public.cerrar_sesion_equipo() returns void
language sql volatile security definer set search_path = '' as $$
  delete from privado.sesiones_dispositivo
  where session_id = nullif(app.claims() ->> 'session_id', '')::uuid and metodo <> 'correo'
$$;

-- -----------------------------------------------------------------------------
-- 6. STORAGE Y TAREAS PROGRAMADAS
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    update storage.buckets
       set file_size_limit = 3145728, allowed_mime_types = array['image/webp','image/jpeg']
     where id = 'evidencias';
    -- owner_id es la columna vigente de Storage (owner quedó por compatibilidad)
    drop policy if exists evidencias_ver on storage.objects;
    create policy evidencias_ver on storage.objects for select to authenticated
      using (bucket_id = 'evidencias'
             and ((owner_id = (select auth.uid())::text and (select app.sesion_valida()))
                  or ((select app.tiene_permiso('checklists.ver_todos'))
                      and (storage.foldername(name))[1] = (select app.sucursal_actual())::text)));
  end if;

  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('programar-planillas', '5 4 * * *',    $c$select app.generar_programacion((now() at time zone 'America/Caracas')::date)$c$);
    perform cron.schedule('planillas-vencidas',  '*/15 * * * *', $c$select app.alertar_checklists_vencidos()$c$);
    perform cron.schedule('escalar-incidencias', '*/5 * * * *',  $c$select app.escalar_incidencias()$c$);
    perform cron.schedule('vencimientos',        '0 10,19 * * *', $c$select app.revisar_vencimientos()$c$);
    perform cron.schedule('limpiar-sesiones',    '30 8 * * *',
      $c$delete from privado.sesiones_dispositivo where creada_en < now() - interval '30 days'$c$);
  end if;
end $$;

-- El pepper del índice de PIN se crea dentro de la base y nunca sale de Vault
do $$
begin
  if to_regclass('vault.decrypted_secrets') is not null
     and not exists (select 1 from vault.decrypted_secrets where name = 'pin_pepper') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'pin_pepper',
                                'Pepper del índice HMAC de los PIN de Pase');
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 7. PRIVILEGIOS
-- -----------------------------------------------------------------------------
revoke all on all functions in schema public    from public, anon;
revoke all on all functions in schema app       from public, anon;
revoke all on all functions in schema privado   from public, anon, authenticated;
revoke all on all functions in schema auditoria from public, anon, authenticated;
revoke all on all tables    in schema privado   from public, anon, authenticated;

grant execute on function app.sesion_valida(), app.nombre_de(uuid), app.fecha_local(uuid) to authenticated;

grant execute on function
  public.registrar_este_dispositivo(uuid, text, text, text),
  public.vincular_dispositivo(uuid, text),
  public.pase_contexto(), public.pase_catalogo(), public.pase_hoy(date),
  public.pase_ejecuciones(timestamptz, boolean, int), public.pase_ejecucion(uuid),
  public.pase_incidencias(boolean, int), public.pase_alertas(int), public.pase_panel(date),
  public.pase_personal(), public.pase_dispositivos(),
  public.pase_bitacora(timestamptz, timestamptz, text, bigint, int), public.pase_verificar_bitacora(),
  public.enviar_planilla(jsonb, jsonb, jsonb, uuid),
  public.reportar_incidencia(jsonb, jsonb, uuid),
  public.actualizar_incidencia(uuid, jsonb, uuid),
  public.revisar_ejecucion(uuid, public.estado_ejecucion, text, uuid),
  public.marcar_alerta_vista(uuid),
  public.crear_usuario(jsonb, uuid, int, uuid),
  public.modificar_usuario(uuid, jsonb, uuid),
  public.modificar_dispositivo(uuid, jsonb, uuid),
  public.cerrar_sesion_equipo()
  to authenticated;

-- Un equipo solo se registra desde él mismo, con 2FA (registrar_este_dispositivo): la versión
-- anterior devolvía el secreto a cualquier sesión con permiso, aunque fuera de otra tablet.
revoke execute on function public.registrar_dispositivo(uuid, text, text, uuid) from authenticated;

revoke execute on function
  public.pin_abrir_sesion(uuid, text, text),
  public.pin_vincular_sesion(uuid, uuid, uuid, text),
  public.sincronizar_firma(uuid, text, uuid, public.accion_firma, text, uuid, timestamptz),
  public.registrar_firma_sin_conexion(uuid, uuid, public.accion_firma, text, uuid, timestamptz)
  from authenticated;
grant execute on function
  public.pin_abrir_sesion(uuid, text, text),
  public.pin_vincular_sesion(uuid, uuid, uuid, text),
  public.sincronizar_firma(uuid, text, uuid, public.accion_firma, text, uuid, timestamptz),
  public.registrar_firma_sin_conexion(uuid, uuid, public.accion_firma, text, uuid, timestamptz)
  to service_role;

-- PostgREST vuelve a leer las funciones expuestas
notify pgrst, 'reload schema';
