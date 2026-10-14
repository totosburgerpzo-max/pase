-- =============================================================================
-- Pase · pruebas de la API de la fase 1 (20261014000004_api_fase1.sql)
-- Las sesiones se arman como las de Supabase Auth: sub + session_id + aal en el JWT,
-- y el equipo se conoce solo por la tabla de sesiones (nada de claims inventados).
-- =============================================================================
\set QUIET on
set client_min_messages = notice;

insert into auth.users (id, email) values
  ('f1000000-0000-4000-8000-000000000001', 'gerente.api@pase.test'),
  ('f1000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000002@personal.pase.invalid'),
  ('f1000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000003@personal.pase.invalid'),
  ('f1000000-0000-4000-8000-000000000004', 'b1000000-0000-4000-8000-000000000004@personal.pase.invalid'),
  ('f1000000-0000-4000-8000-000000000009', 'nueva@personal.pase.invalid');
insert into public.usuarios (id, auth_id, sucursal_id, nombre, apellido, cargo, rol, turno) values
  ('b1000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000001','5b1e0000-0000-4000-8000-000000000001','Gina','Gerente','Gerente general','admin','gerencia'),
  ('b1000000-0000-4000-8000-000000000002','f1000000-0000-4000-8000-000000000002','5b1e0000-0000-4000-8000-000000000001','Saúl','Supervisor','Supervisor de turno','supervisor','noche'),
  ('b1000000-0000-4000-8000-000000000003','f1000000-0000-4000-8000-000000000003','5b1e0000-0000-4000-8000-000000000001','Olivia','Operativa','Línea','operativo','noche'),
  ('b1000000-0000-4000-8000-000000000004','f1000000-0000-4000-8000-000000000004','5b1e0000-0000-4000-8000-000000000001','Omar','Operativo','Salón','operativo','noche');
select set_config('t.pin_g', privado.nuevo_pin('b1000000-0000-4000-8000-000000000001', 6), false),
       set_config('t.pin_s', privado.nuevo_pin('b1000000-0000-4000-8000-000000000002', 6), false),
       set_config('t.pin_o', privado.nuevo_pin('b1000000-0000-4000-8000-000000000003', 4), false),
       set_config('t.pin_o2', privado.nuevo_pin('b1000000-0000-4000-8000-000000000004', 4), false) \gset
update privado.credenciales_pin set debe_cambiar = false;

-- Sesión de Supabase Auth: sub, session_id y nivel de autenticación
create function pg_temp.sesion(p_auth text, p_sesion text, p_aal text default 'aal1') returns void
language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_auth, 'role', 'authenticated', 'session_id', p_sesion, 'aal', p_aal)::text, false);
  select set_config('request.headers', '{"x-forwarded-for":"190.202.14.40","user-agent":"Pase/0.1 (pruebas)"}', false);
$$;
create function pg_temp.servicio() returns void language sql as $$
  select set_config('request.jwt.claims', '{"role":"service_role"}', false);
  select set_config('request.headers', '{"x-pase-ip":"190.202.14.77","x-forwarded-for":"10.9.9.9"}', false);
$$;
\set servicio 'reset role; select pg_temp.servicio(); set role service_role;'
\o /dev/null

-- =============================================================================
-- Sesiones y equipos
-- =============================================================================
-- A01: con correo y contraseña (aal1) y sin equipo, la gerente no es nadie
reset role; select pg_temp.sesion('f1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001'); set role authenticated;
do $$ begin
  assert app.usuario_actual() is null, 'una sesión aal1 sin equipo identificó a la persona';
  assert public.pase_contexto() is null, 'pase_contexto respondió sin equipo';
  assert (select count(*) from public.usuarios) = 0, 'una sesión sin equipo lee usuarios';
  assert (public.firmar(current_setting('t.pin_g'), 'crear', 'dispositivos', gen_random_uuid()) ->> 'motivo') = 'sin_sesion';
  raise notice 'OK A01 correo y contraseña sin segundo factor ni equipo registrado: no ve ni firma nada';
end $$;

-- A02: registrar el equipo exige el segundo factor
do $$ declare r jsonb; begin
  r := public.registrar_este_dispositivo('dd000000-0000-4000-8000-000000000001', 'Tablet línea 2', 'tablet_cocina', current_setting('t.pin_g'));
  assert r ->> 'motivo' = 'requiere_2fa', r::text;
  raise notice 'OK A02 registrar un equipo sin segundo factor: %', r ->> 'motivo';
end $$;

-- A03: con aal2 sí; un PIN equivocado no registra; el correcto devuelve el secreto una vez
reset role; select pg_temp.sesion('f1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'aal2'); set role authenticated;
do $$ declare r jsonb; begin
  assert app.usuario_actual() = 'b1000000-0000-4000-8000-000000000001', 'aal2 no identifica a la gerente';
  assert (public.firmar(current_setting('t.pin_g'), 'crear', 'incidencias', gen_random_uuid()) ->> 'motivo') = 'dispositivo_no_registrado';
  r := public.registrar_este_dispositivo('dd000000-0000-4000-8000-000000000001', 'Tablet línea 2', 'tablet_cocina', '000000');
  assert r ->> 'motivo' = 'pin_incorrecto', r::text;
  r := public.registrar_este_dispositivo('dd000000-0000-4000-8000-000000000001', 'Tablet línea 2', 'tablet_cocina', current_setting('t.pin_g'));
  assert (r ->> 'ok')::boolean and length(r ->> 'secreto') = 64, r::text;
  perform set_config('t.secreto', r ->> 'secreto', false);
  assert app.dispositivo_actual() = 'dd000000-0000-4000-8000-000000000001', 'la sesión no quedó atada al equipo';
  assert (public.firmar(current_setting('t.pin_g'), 'crear', 'incidencias', gen_random_uuid()) ->> 'ok')::boolean, 'no firma en su equipo';
  raise notice 'OK A03 la gerente registra la tablet con aal2 y su PIN; la sesión queda atada y ya firma';
end $$;

-- A04: la PC de gerencia: correo + contraseña en un equipo registrado (vincular con su secreto)
reset role; select pg_temp.sesion('f1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002'); set role authenticated;
do $$ declare r jsonb; begin
  assert app.usuario_actual() is null;
  r := public.vincular_dispositivo('dd000000-0000-4000-8000-000000000001', 'secreto-falso');
  assert r ->> 'motivo' = 'dispositivo_no_registrado', r::text;
  assert app.usuario_actual() is null, 'un secreto falso abrió la sesión';
  raise notice 'OK A04 un secreto de equipo falso no vincula la sesión';
end $$;

-- A05: la función de sesiones por PIN es solo del servicio
reset role; select pg_temp.sesion('f1000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000003'); set role authenticated;
do $$ begin
  perform public.pin_abrir_sesion('dd000000-0000-4000-8000-000000000001', 'x', '1234');
  raise exception 'FALLO A05 pin_abrir_sesion abierta a authenticated';
exception when insufficient_privilege then
  raise notice 'OK A05 abrir sesión por PIN no está abierto a la app: %', sqlerrm;
end $$;
do $$ begin
  perform public.sincronizar_firma('dd000000-0000-4000-8000-000000000001', 'x', 'b1000000-0000-4000-8000-000000000003',
                                   'crear', 'incidencias', gen_random_uuid(), now());
  raise exception 'FALLO A05 sincronizar_firma abierta a authenticated';
exception when insufficient_privilege then
  raise notice 'OK A05 registrar firmas sin conexión tampoco: %', sqlerrm;
end $$;
reset role; set role anon;
do $$ begin
  perform public.pase_contexto();
  raise exception 'FALLO A05 la clave anónima ejecuta pase_contexto';
exception when insufficient_privilege then
  raise notice 'OK A05 la clave anónima no ejecuta la API: %', sqlerrm;
end $$;

-- A06: el servicio valida equipo + PIN y ata las sesiones (lo que hace la función pin-sesion)
:servicio
do $$ declare r jsonb; begin
  r := public.pin_abrir_sesion('dd000000-0000-4000-8000-000000000001', 'secreto-falso', current_setting('t.pin_o'));
  assert r ->> 'motivo' = 'dispositivo_no_registrado', r::text;
  r := public.pin_abrir_sesion('dd000000-0000-4000-8000-000000000001', current_setting('t.secreto'), current_setting('t.pin_o'));
  assert (r ->> 'ok')::boolean and r ->> 'correo' like '%@personal.pase.invalid' and r -> 'dispositivo' ->> 'nombre' = 'Tablet línea 2', r::text;
  perform public.pin_vincular_sesion('c1000000-0000-4000-8000-000000000003', 'dd000000-0000-4000-8000-000000000001', (r ->> 'usuario_id')::uuid, 'pin');
  r := public.pin_abrir_sesion('dd000000-0000-4000-8000-000000000001', current_setting('t.secreto'), current_setting('t.pin_s'));
  perform public.pin_vincular_sesion('c1000000-0000-4000-8000-000000000004', 'dd000000-0000-4000-8000-000000000001', (r ->> 'usuario_id')::uuid, 'pin');
  r := public.pin_abrir_sesion('dd000000-0000-4000-8000-000000000001', current_setting('t.secreto'), current_setting('t.pin_o2'));
  perform public.pin_vincular_sesion('c1000000-0000-4000-8000-000000000005', 'dd000000-0000-4000-8000-000000000001', (r ->> 'usuario_id')::uuid, 'pin');
end $$;
reset role;
do $$ begin
  assert (select ip from privado.intentos_pin where exito order by id desc limit 1) = '190.202.14.77'::inet,
    'la IP de la tablet que informa la función no quedó registrada';
  raise notice 'OK A06 PIN + secreto del equipo abren sesión; la IP es la de la tablet (x-pase-ip)';
end $$;

\set op   'reset role; select pg_temp.sesion(''f1000000-0000-4000-8000-000000000003'', ''c1000000-0000-4000-8000-000000000003''); set role authenticated;'
\set sup  'reset role; select pg_temp.sesion(''f1000000-0000-4000-8000-000000000002'', ''c1000000-0000-4000-8000-000000000004''); set role authenticated;'
\set op2  'reset role; select pg_temp.sesion(''f1000000-0000-4000-8000-000000000004'', ''c1000000-0000-4000-8000-000000000005''); set role authenticated;'
\set ger  'reset role; select pg_temp.sesion(''f1000000-0000-4000-8000-000000000001'', ''c1000000-0000-4000-8000-000000000001'', ''aal2''); set role authenticated;'

-- A07: contexto de la persona
:op
do $$ declare c jsonb; begin
  c := public.pase_contexto();
  assert c -> 'usuario' ->> 'nombre' = 'Olivia' and c -> 'usuario' ->> 'rol' = 'operativo', c::text;
  assert c -> 'dispositivo' ->> 'nombre' = 'Tablet línea 2', c::text;
  assert (c -> 'pin' ->> 'longitud')::int = 4 and c -> 'permisos' ? 'checklists.ejecutar'
         and not (c -> 'permisos' ? 'checklists.revisar'), c::text;
  assert (c -> 'parametros' ->> 'sesion.segundos_inactividad')::int = 90, c::text;
  raise notice 'OK A07 contexto del operativo: equipo, PIN de % dígitos, % permisos', c -> 'pin' ->> 'longitud', jsonb_array_length(c -> 'permisos');
end $$;

-- A08: catálogo completo para trabajar sin conexión, según el nivel
do $$ declare c jsonb; n int; begin
  c := public.pase_catalogo();
  assert jsonb_array_length(c) = (select count(*) from public.plantillas where vigente and rol_asignado = 'operativo'), 'catálogo del operativo';
  select count(*) into n from jsonb_array_elements(c) p, jsonb_array_elements(p -> 'secciones') s, jsonb_array_elements(s -> 'items') i;
  assert n > 100, 'el catálogo trae pocos ítems';
  raise notice 'OK A08 catálogo del operativo: % planillas con % ítems', jsonb_array_length(c), n;
end $$;
:sup
do $$ declare c jsonb; begin
  c := public.pase_catalogo();
  assert jsonb_array_length(c) = (select count(*) from public.plantillas where vigente and rol_asignado in ('operativo','supervisor'));
  raise notice 'OK A08 catálogo del supervisor: % planillas', jsonb_array_length(c);
end $$;

-- A09: el riel del día se genera si pg_cron aún no lo hizo, y cada quien ve lo de su nivel
reset role; select set_config('request.jwt.claims', '', false);
delete from public.checklist_programacion where fecha = (now() at time zone 'America/Caracas')::date;
:op
do $$ declare h jsonb; n int; begin
  h := public.pase_hoy();
  n := jsonb_array_length(h -> 'programadas');
  assert n > 0, 'el riel del operativo está vacío';
  assert not exists (select 1 from jsonb_array_elements(h -> 'programadas') x where x ->> 'rol_asignado' <> 'operativo'), 'el operativo ve planillas del supervisor';
  perform set_config('t.riel_op', n::text, false);
end $$;
reset role;
do $$ declare n int := current_setting('t.riel_op')::int; begin
  assert (select count(*) from public.checklist_programacion where fecha = (now() at time zone 'America/Caracas')::date) > n,
    'no se generó el día completo';
  raise notice 'OK A09 riel de hoy generado al vuelo: % planillas para el operativo', n;
end $$;

-- =============================================================================
-- Planillas
-- =============================================================================
create function pg_temp.respuestas(p_codigo text, p_ref text, p_valor numeric, p_evid uuid) returns jsonb
language sql as $$
  select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'item_id', i.id,
    'valor_bool', case when i.tipo = 'pass_fail' then i.ref <> coalesce(p_ref, '') end,
    'valor_num', case when i.tipo = 'number' then case when i.ref = p_ref then p_valor
                      else coalesce((i.valor_min + i.valor_max) / 2, i.valor_max - 1, i.valor_min + 1, 1) end end,
    'valor_texto', case when i.tipo = 'text' then 'Sin novedad' end,
    'valor_opcion', case when i.tipo = 'choice' then i.opciones ->> 0 end,
    'valor_hora', case when i.tipo = 'time' then '12:00' end,
    'evidencia_id', case when i.ref = p_ref or i.tipo = 'photo' then p_evid end,
    'observacion', case when i.ref = p_ref then 'Falla de prueba' end)))
  from public.plantilla_items i join public.plantillas p on p.id = i.plantilla_id
  where p.codigo = p_codigo and p.vigente
$$;

-- A10: planilla con foto: la foto debe estar en Storage, en la carpeta de la sucursal
:op
do $$ declare r jsonb; v_pl uuid; ev jsonb; begin
  select id into v_pl from public.plantillas where codigo = '08A';
  ev := jsonb_build_array(jsonb_build_object('id', 'e1000000-0000-4000-8000-000000000001',
          'ruta', '5b1e0000-0000-4000-8000-000000000001/2026/10/e1000000.webp', 'sha256', 'aa11', 'bytes', 51234,
          'tomada_en', now()));
  r := public.firmar(current_setting('t.pin_o'), 'crear', 'checklist_ejecuciones', 'e2000000-0000-4000-8000-000000000001');
  begin
    perform public.enviar_planilla(jsonb_build_object('id', 'e2000000-0000-4000-8000-000000000001', 'plantilla_id', v_pl),
      pg_temp.respuestas('08A', '08A-1.2', 26, 'e1000000-0000-4000-8000-000000000001'), ev, (r ->> 'firma_id')::uuid);
    raise exception 'FALLO A10 aceptó una foto que no está en Storage';
  exception when no_data_found then
    raise notice 'OK A10 foto que no terminó de subir: %', sqlerrm;
  end;
  begin
    perform public.enviar_planilla(jsonb_build_object('id', 'e2000000-0000-4000-8000-000000000001', 'plantilla_id', v_pl),
      pg_temp.respuestas('08A', '08A-1.2', 26, 'e1000000-0000-4000-8000-000000000001'),
      jsonb_build_array(jsonb_build_object('id', 'e1000000-0000-4000-8000-000000000001', 'ruta', 'otra-sucursal/x.webp', 'sha256', 'aa')),
      (r ->> 'firma_id')::uuid);
    raise exception 'FALLO A10 aceptó una foto fuera de la carpeta de la sucursal';
  exception when insufficient_privilege then
    raise notice 'OK A10 foto fuera de la carpeta de la sucursal: %', sqlerrm;
  end;
end $$;
reset role;
insert into storage.objects (bucket_id, name, owner_id, metadata) values
  ('evidencias', '5b1e0000-0000-4000-8000-000000000001/2026/10/e1000000.webp', 'f1000000-0000-4000-8000-000000000003', '{"mimetype":"image/webp"}');
:op
do $$ declare r jsonb; v_pl uuid; ev jsonb; f uuid; begin
  select id into v_pl from public.plantillas where codigo = '08A';
  ev := jsonb_build_array(jsonb_build_object('id', 'e1000000-0000-4000-8000-000000000001',
          'ruta', '5b1e0000-0000-4000-8000-000000000001/2026/10/e1000000.webp', 'sha256', 'aa11', 'bytes', 51234,
          'tomada_en', now()));
  f := (public.firmar(current_setting('t.pin_o'), 'crear', 'checklist_ejecuciones', 'e2000000-0000-4000-8000-000000000001') ->> 'firma_id')::uuid;
  r := public.enviar_planilla(jsonb_build_object('id', 'e2000000-0000-4000-8000-000000000001', 'plantilla_id', v_pl,
           'programacion_id', (select x ->> 'id' from jsonb_array_elements(public.pase_hoy() -> 'programadas') x where x ->> 'codigo' = '08A')),
         pg_temp.respuestas('08A', '08A-1.2', 26, 'e1000000-0000-4000-8000-000000000001'), ev, f);
  assert (r ->> 'ok')::boolean and (r ->> 'criticos_no_cumple')::int = 1 and (r ->> 'incidencias')::int = 1, r::text;
  assert (select subida_por from public.evidencias where id = 'e1000000-0000-4000-8000-000000000001') = 'b1000000-0000-4000-8000-000000000003';
  assert (select dispositivo_id from public.checklist_ejecuciones where id = 'e2000000-0000-4000-8000-000000000001') = 'dd000000-0000-4000-8000-000000000001';
  -- reintento (se cortó la red después de guardar): no duplica ni pide otra firma
  r := public.enviar_planilla(jsonb_build_object('id', 'e2000000-0000-4000-8000-000000000001', 'plantilla_id', v_pl),
         '[]'::jsonb, ev, f);
  assert (r ->> 'ya_existia')::boolean, r::text;
  raise notice 'OK A10 planilla 08A con foto: puntaje %, incidencia crítica; el reintento no duplica', r ->> 'puntaje';
end $$;

-- A11: el detalle y la lista de lo llenado
do $$ declare d jsonb; l jsonb; begin
  d := public.pase_ejecucion('e2000000-0000-4000-8000-000000000001');
  assert d ->> 'codigo' = '08A' and d -> 'firma' ->> 'metodo' = 'pin_en_linea' and d ->> 'dispositivo' = 'Tablet línea 2', d::text;
  assert jsonb_array_length(d -> 'incidencias') = 1 and jsonb_array_length(d -> 'respuestas') > 4;
  assert exists (select 1 from jsonb_array_elements(d -> 'respuestas') x where x ->> 'ref' = '08A-1.2' and x -> 'evidencia' ->> 'ruta' like '%e1000000.webp');
  l := public.pase_ejecuciones(null, true);
  assert jsonb_array_length(l) = 1 and l -> 0 ->> 'realizada_por_nombre' = 'Olivia Operativa', l::text;
  raise notice 'OK A11 detalle de la planilla con firma, equipo, foto e incidencia';
end $$;
:op2
do $$ begin
  assert public.pase_ejecucion('e2000000-0000-4000-8000-000000000001') is null, 'otro operativo ve la planilla ajena';
  assert jsonb_array_length(public.pase_ejecuciones()) = 0;
  assert jsonb_array_length(public.pase_incidencias()) = 0, 'otro operativo ve incidencias ajenas';
  raise notice 'OK A11 otro operativo no ve planillas ni incidencias ajenas';
end $$;

-- A12: revisión: el supervisor revisa la del operativo; nadie revisa la propia
:sup
do $$ declare r jsonb; f uuid; begin
  assert exists (select 1 from jsonb_array_elements(public.pase_panel() -> 'por_revisar') x
                 where x ->> 'id' = 'e2000000-0000-4000-8000-000000000001'), 'la planilla no aparece por revisar';
  f := (public.firmar(current_setting('t.pin_s'), 'modificar', 'checklist_ejecuciones', 'e2000000-0000-4000-8000-000000000001') ->> 'firma_id')::uuid;
  r := public.revisar_ejecucion('e2000000-0000-4000-8000-000000000001', 'observada', 'Falta la foto del aceite nuevo', f);
  assert r ->> 'estado' = 'observada' and r ->> 'revisada_por' = 'Saúl Supervisor', r::text;
  raise notice 'OK A12 el supervisor observa la planilla con nota y firma';
end $$;

-- =============================================================================
-- Incidencias
-- =============================================================================
:op
do $$ declare r jsonb; f uuid; begin
  f := (public.firmar(current_setting('t.pin_o'), 'crear', 'incidencias', 'e3000000-0000-4000-8000-000000000001') ->> 'firma_id')::uuid;
  begin
    perform public.reportar_incidencia(jsonb_build_object('id', 'e3000000-0000-4000-8000-000000000001', 'titulo', 'La plancha 2 no calienta',
      'severidad', 'critica', 'area', 'Cocina'), null, f);
    raise exception 'FALLO A13 crítica sin foto';
  exception when check_violation then
    raise notice 'OK A13 falla crítica sin foto rechazada: %', sqlerrm;
  end;
  r := public.reportar_incidencia(jsonb_build_object('id', 'e3000000-0000-4000-8000-000000000001', 'titulo', 'La plancha 2 no calienta',
      'severidad', 'alta', 'area', 'Cocina', 'bloquea', true, 'descripcion', 'Marca 150 °C con el dial al máximo'), null, f);
  assert (r ->> 'ok')::boolean and (r ->> 'vence_en')::timestamptz between now() + interval '119 minutes' and now() + interval '121 minutes', r::text;
  assert (select area from public.incidencias where id = 'e3000000-0000-4000-8000-000000000001') = 'Cocina';
  raise notice 'OK A13 falla alta reportada con firma: plazo de 2 horas, área Cocina';
end $$;
do $$ begin
  perform public.actualizar_incidencia('e3000000-0000-4000-8000-000000000001', '{"estado":"en_proceso"}', null);
  raise exception 'FALLO A14 el operativo gestiona incidencias';
exception when insufficient_privilege then
  raise notice 'OK A14 el operativo no gestiona incidencias: %', sqlerrm;
end $$;
:sup
do $$ declare r jsonb; f uuid; l jsonb; begin
  l := public.pase_incidencias();
  assert jsonb_array_length(l) >= 2 and l -> 0 ->> 'severidad' = 'critica', 'el supervisor no ve las incidencias ordenadas';
  f := (public.firmar(current_setting('t.pin_s'), 'modificar', 'incidencias', 'e3000000-0000-4000-8000-000000000001') ->> 'firma_id')::uuid;
  r := public.actualizar_incidencia('e3000000-0000-4000-8000-000000000001',
         '{"estado":"en_proceso","asignada_a":"b1000000-0000-4000-8000-000000000002"}', f);
  assert r ->> 'estado' = 'en_proceso', r::text;
  f := (public.firmar(current_setting('t.pin_s'), 'modificar', 'incidencias', 'e3000000-0000-4000-8000-000000000001') ->> 'firma_id')::uuid;
  r := public.actualizar_incidencia('e3000000-0000-4000-8000-000000000001',
         '{"estado":"resuelta","accion_correctiva":"Se cambió el termostato","causa_raiz":"Termostato dañado"}', f);
  assert r ->> 'estado' = 'resuelta', r::text;
  begin
    f := (public.firmar(current_setting('t.pin_s'), 'modificar', 'incidencias', 'e3000000-0000-4000-8000-000000000001') ->> 'firma_id')::uuid;
    perform public.actualizar_incidencia('e3000000-0000-4000-8000-000000000001', '{"estado":"verificada"}', f);
    raise exception 'FALLO A14 quien resolvió también verificó';
  exception when insufficient_privilege then
    raise notice 'OK A14 quien resolvió no verifica: %', sqlerrm;
  end;
  raise notice 'OK A14 el supervisor atiende y resuelve con firma';
end $$;
:ger
do $$ declare r jsonb; f uuid; begin
  f := (public.firmar(current_setting('t.pin_g'), 'modificar', 'incidencias', 'e3000000-0000-4000-8000-000000000001') ->> 'firma_id')::uuid;
  r := public.actualizar_incidencia('e3000000-0000-4000-8000-000000000001', '{"estado":"verificada"}', f);
  assert r ->> 'estado' = 'verificada', r::text;
  raise notice 'OK A14 la gerente verifica y cierra';
end $$;

-- A15: alertas: el supervisor las ve y las marca como vistas
:sup
do $$ declare a jsonb; begin
  a := public.pase_alertas();
  assert jsonb_array_length(a) >= 1, 'el supervisor no ve alertas';
  perform public.marcar_alerta_vista((a -> 0 ->> 'id')::uuid);
  assert (select estado from public.alertas where id = (a -> 0 ->> 'id')::uuid) = 'vista';
  raise notice 'OK A15 % alertas para el supervisor; marcar vista funciona', jsonb_array_length(a);
end $$;

-- A16: el panel es del supervisor y la gerente
do $$ declare p jsonb; begin
  p := public.pase_panel();
  assert (p -> 'programadas' ->> 'total')::int > 50 and (p -> 'programadas' ->> 'hechas')::int >= 1, p -> 'programadas';
  assert jsonb_array_length(p -> 'por_area') > 3 and jsonb_array_length(p -> 'tendencia') >= 1;
  raise notice 'OK A16 panel: % programadas, % hechas, % vencidas', p -> 'programadas' ->> 'total', p -> 'programadas' ->> 'hechas', p -> 'programadas' ->> 'vencidas';
end $$;
:op
do $$ begin
  perform public.pase_panel();
  raise exception 'FALLO A16 el operativo ve el panel';
exception when insufficient_privilege then
  raise notice 'OK A16 el operativo no ve el panel: %', sqlerrm;
end $$;

-- =============================================================================
-- Personal y equipos
-- =============================================================================
:sup
do $$ begin
  perform public.crear_usuario('{"id":"b1000000-0000-4000-8000-000000000009","nombre":"Nora","apellido":"Nueva"}',
                               'f1000000-0000-4000-8000-000000000009', 4, null);
  raise exception 'FALLO A17 el supervisor crea usuarios';
exception when insufficient_privilege then
  raise notice 'OK A17 el supervisor no da de alta personal: %', sqlerrm;
end $$;
:ger
do $$ declare r jsonb; f uuid; l jsonb; begin
  f := (public.firmar(current_setting('t.pin_g'), 'crear', 'usuarios', 'b1000000-0000-4000-8000-000000000009') ->> 'firma_id')::uuid;
  r := public.crear_usuario('{"id":"b1000000-0000-4000-8000-000000000009","nombre":"Nora","apellido":"Nueva","cargo":"Cajera","turno":"mediodia"}',
                            'f1000000-0000-4000-8000-000000000009', 4, f);
  assert (r ->> 'ok')::boolean and (r ->> 'pin_provisional') ~ '^\d{4}$', r::text;
  l := public.pase_personal();
  assert exists (select 1 from jsonb_array_elements(l) x where x ->> 'nombre' = 'Nora' and (x ->> 'debe_cambiar_pin')::boolean), l::text;
  assert exists (select 1 from jsonb_array_elements(l) x where x ->> 'nombre' = 'Gina' and x ->> 'correo' = 'gerente.api@pase.test');
  assert not exists (select 1 from jsonb_array_elements(l) x where x ->> 'correo' like '%.invalid');
  raise notice 'OK A17 la gerente da de alta a Nora con PIN provisional de 4 dígitos (debe cambiarlo)';
  begin
    f := (public.firmar(current_setting('t.pin_g'), 'modificar', 'usuarios', 'b1000000-0000-4000-8000-000000000001') ->> 'firma_id')::uuid;
    perform public.modificar_usuario('b1000000-0000-4000-8000-000000000001', '{"activo":false}', f);
    raise exception 'FALLO A18 la gerente se desactivó a sí misma';
  exception when insufficient_privilege then
    raise notice 'OK A18 nadie se desactiva a sí mismo: %', sqlerrm;
  end;
  f := (public.firmar(current_setting('t.pin_g'), 'modificar', 'usuarios', 'b1000000-0000-4000-8000-000000000004') ->> 'firma_id')::uuid;
  r := public.modificar_usuario('b1000000-0000-4000-8000-000000000004', '{"activo":false}', f);
  assert not (r ->> 'activo')::boolean, r::text;
  raise notice 'OK A18 la gerente desactiva a Omar con firma';
end $$;
:op2
do $$ begin
  assert app.usuario_actual() is null and public.pase_contexto() is null, 'la sesión de una persona desactivada sigue viva';
  raise notice 'OK A18 la sesión abierta de Omar dejó de valer al desactivarlo';
end $$;

-- A19: dar de baja un equipo corta todas sus sesiones
:ger
do $$ declare r jsonb; f uuid; begin
  begin
    f := (public.firmar(current_setting('t.pin_g'), 'modificar', 'dispositivos', 'dd000000-0000-4000-8000-000000000001') ->> 'firma_id')::uuid;
    perform public.modificar_dispositivo('dd000000-0000-4000-8000-000000000001', '{"activo":false}', f);
    raise exception 'FALLO A19 dio de baja el equipo en uso';
  exception when raise_exception then
    raise notice 'OK A19 no se da de baja el equipo que se está usando: %', sqlerrm;
  end;
  assert exists (select 1 from jsonb_array_elements(public.pase_dispositivos()) x where (x ->> 'este')::boolean);
end $$;

-- =============================================================================
-- Sin conexión
-- =============================================================================
:servicio
do $$ declare r jsonb; begin
  r := public.sincronizar_firma('dd000000-0000-4000-8000-000000000001', 'falso', 'b1000000-0000-4000-8000-000000000003',
                                'crear', 'checklist_ejecuciones', 'e2000000-0000-4000-8000-000000000002', now() - interval '20 minutes');
  assert r ->> 'motivo' = 'dispositivo_no_registrado', r::text;
  r := public.sincronizar_firma('dd000000-0000-4000-8000-000000000001', current_setting('t.secreto'), 'b1000000-0000-4000-8000-000000000001',
                                'crear', 'checklist_ejecuciones', 'e2000000-0000-4000-8000-000000000002', now() - interval '20 minutes');
  assert r ->> 'motivo' = 'sin_ingreso_reciente', r::text;
  r := public.sincronizar_firma('dd000000-0000-4000-8000-000000000001', current_setting('t.secreto'), 'b1000000-0000-4000-8000-000000000003',
                                'crear', 'checklist_ejecuciones', 'e2000000-0000-4000-8000-000000000002', now() - interval '5 days');
  assert r ->> 'motivo' = 'fuera_de_plazo', r::text;
  r := public.sincronizar_firma('dd000000-0000-4000-8000-000000000001', current_setting('t.secreto'), 'b1000000-0000-4000-8000-000000000003',
                                'crear', 'checklist_ejecuciones', 'e2000000-0000-4000-8000-000000000002', now() - interval '20 minutes');
  assert (r ->> 'ok')::boolean and r ->> 'correo' like '%.invalid', r::text;
  perform set_config('t.firma_offline', r ->> 'firma_id', false);
  -- la función abre una sesión de esa persona para reenviar el registro con sus permisos
  perform public.pin_vincular_sesion('c1000000-0000-4000-8000-000000000013', 'dd000000-0000-4000-8000-000000000001',
                                     'b1000000-0000-4000-8000-000000000003', 'sincronizacion');
  raise notice 'OK A20 firma sin conexión: valida el secreto, el ingreso reciente y el plazo de 72 h';
end $$;
reset role; select pg_temp.sesion('f1000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000013'); set role authenticated;
do $$ declare r jsonb; v_pl uuid; begin
  select id into v_pl from public.plantillas where codigo = '17A';
  r := public.enviar_planilla(jsonb_build_object('id', 'e2000000-0000-4000-8000-000000000002', 'plantilla_id', v_pl,
         'completada_en', now() - interval '20 minutes', 'iniciada_en', now() - interval '28 minutes', 'sin_conexion', true),
         pg_temp.respuestas('17A', null, null, null), '[]', current_setting('t.firma_offline')::uuid);
  assert (r ->> 'ok')::boolean, r::text;
  assert (select registrada_sin_conexion from public.checklist_ejecuciones where id = 'e2000000-0000-4000-8000-000000000002');
  assert (select metodo from public.firmas where id = current_setting('t.firma_offline')::uuid) = 'pin_sin_conexion';
  assert (public.pase_ejecucion('e2000000-0000-4000-8000-000000000002') -> 'firma' ->> 'firmada_sin_conexion_en') is not null;
  raise notice 'OK A20 la planilla firmada sin conexión llega con su hora real y queda marcada';
  perform public.cerrar_sesion_equipo();
  assert app.usuario_actual() is null, 'cerrar_sesion_equipo no cortó la sesión';
  raise notice 'OK A21 al bloquear la tablet la sesión deja de valer en el equipo';
end $$;

-- =============================================================================
-- Bitácora
-- =============================================================================
:sup
do $$ begin
  perform public.pase_bitacora();
  raise exception 'FALLO A22 el supervisor ve la bitácora';
exception when insufficient_privilege then
  raise notice 'OK A22 la bitácora es solo de la gerente: %', sqlerrm;
end $$;
:ger
do $$ declare b jsonb; v jsonb; begin
  b := public.pase_bitacora(now() - interval '1 hour');
  assert jsonb_array_length(b) > 10, 'bitácora vacía';
  assert exists (select 1 from jsonb_array_elements(b) x where x ->> 'tabla' = 'checklist_ejecuciones'
                 and x ->> 'usuario' = 'Olivia Operativa' and x ->> 'dispositivo' = 'Tablet línea 2' and x ->> 'ip' = '190.202.14.40'), 'falta la planilla en la bitácora';
  assert exists (select 1 from jsonb_array_elements(b) x where x ->> 'metodo' = 'pin_sin_conexion'), 'falta la firma sin conexión';
  v := public.pase_verificar_bitacora();
  assert (v ->> 'integra')::boolean, v::text;
  raise notice 'OK A22 bitácora con nombres, equipo, IP y método; cadena íntegra en % registros', v ->> 'registros';
end $$;

\o
\echo 'Pruebas de la API de la fase 1: todas pasaron'
