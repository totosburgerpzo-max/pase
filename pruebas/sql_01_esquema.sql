-- =============================================================================
-- Totos Control · pruebas de seguridad y reglas de negocio (PostgreSQL 16 local)
-- psql -v ON_ERROR_STOP=1 -f 04_pruebas.sql  → cada prueba imprime "OK Txx"
-- Las pruebas se ejecutan con el rol de la API (authenticated) y el JWT de cada
-- persona, igual que una llamada real a Supabase.
-- =============================================================================
\set QUIET on
set client_min_messages = notice;

-- ---------- Datos de prueba (como proceso interno: sin JWT) ----------
insert into auth.users (id, email) values
  ('f0000000-0000-4000-8000-000000000001', 'gerente@totos.local'),
  ('f0000000-0000-4000-8000-000000000002', 'sup1@totos.local'),
  ('f0000000-0000-4000-8000-000000000003', 'sup2@totos.local'),
  ('f0000000-0000-4000-8000-000000000004', 'op1@totos.local'),
  ('f0000000-0000-4000-8000-000000000005', 'op2@totos.local');

insert into public.usuarios (id, auth_id, sucursal_id, nombre, apellido, cargo, rol, turno) values
  ('a0000000-0000-4000-8000-000000000001','f0000000-0000-4000-8000-000000000001','5b1e0000-0000-4000-8000-000000000001','Gerente','Prueba','Gerente de tienda','admin','gerencia'),
  ('a0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000002','5b1e0000-0000-4000-8000-000000000001','Sofía','Supervisora','Supervisor de turno','supervisor','mediodia'),
  ('a0000000-0000-4000-8000-000000000003','f0000000-0000-4000-8000-000000000003','5b1e0000-0000-4000-8000-000000000001','Simón','Supervisor','Supervisor de turno','supervisor','noche'),
  ('a0000000-0000-4000-8000-000000000004','f0000000-0000-4000-8000-000000000004','5b1e0000-0000-4000-8000-000000000001','Óscar','Parrillero','Parrillero','operativo','mediodia'),
  ('a0000000-0000-4000-8000-000000000005','f0000000-0000-4000-8000-000000000005','5b1e0000-0000-4000-8000-000000000001','Olga','Cajera','Cajera','operativo','noche');

insert into public.dispositivos (id, sucursal_id, nombre, tipo) values
  ('d0000000-0000-4000-8000-000000000001','5b1e0000-0000-4000-8000-000000000001','Tablet línea 1','tablet_cocina'),
  ('d0000000-0000-4000-8000-000000000002','5b1e0000-0000-4000-8000-000000000001','PC gerencia','pc_gerencia');
insert into privado.dispositivo_secretos values
  ('d0000000-0000-4000-8000-000000000001', extensions.digest('secreto-tablet-1', 'sha256')),
  ('d0000000-0000-4000-8000-000000000002', extensions.digest('secreto-pc', 'sha256'));

select set_config('t.pin_admin', privado.nuevo_pin('a0000000-0000-4000-8000-000000000001', 6), false),
       set_config('t.pin_s1',    privado.nuevo_pin('a0000000-0000-4000-8000-000000000002', 6), false),
       set_config('t.pin_s2',    privado.nuevo_pin('a0000000-0000-4000-8000-000000000003', 6), false),
       set_config('t.pin_o1',    privado.nuevo_pin('a0000000-0000-4000-8000-000000000004', 4), false),
       set_config('t.pin_o2',    privado.nuevo_pin('a0000000-0000-4000-8000-000000000005', 4), false) \gset

select set_config('t.pl01', (select id::text from public.plantillas where codigo = '01'), false) \gset
insert into public.proveedores (id, rif, razon_social, dias_entrega) values
  ('b0000000-0000-4000-8000-000000000001', 'J-12345678-9', 'Carnes del Ávila C.A.', 2);
insert into public.productos (id, sku, nombre, unidad_base, unidad_compra, factor_compra, conservacion,
                              stock_minimo, proveedor_principal_id, es_clave) values
  ('c0000000-0000-4000-8000-000000000001','CAR-01','Carne molida 80/20','g','kg',1000,'refrigerado',5000,'b0000000-0000-4000-8000-000000000001',true),
  ('c0000000-0000-4000-8000-000000000002','PAP-01','Papas prefritas 3/8','g','kg',1000,'congelado',2000,'b0000000-0000-4000-8000-000000000001',true),
  ('c0000000-0000-4000-8000-000000000003','PAN-01','Pan de hamburguesa','u','docena',12,'ambiente',24,null,true);
insert into public.costos_producto values
  ('c0000000-0000-4000-8000-000000000001', 0.0085, 'USD'),
  ('c0000000-0000-4000-8000-000000000002', 0.0030, 'USD'),
  ('c0000000-0000-4000-8000-000000000003', 0.2500, 'USD');

-- dos lotes de carne: el que vence antes debe salir primero (PEPS)
insert into public.lotes (id, producto_id, sucursal_id, ubicacion_id, codigo_lote, fecha_ingreso, fecha_vencimiento, cantidad_inicial, cantidad_disponible)
select 'e0000000-0000-4000-8000-00000000000a'::uuid, 'c0000000-0000-4000-8000-000000000001'::uuid, '5b1e0000-0000-4000-8000-000000000001'::uuid,
       (select id from public.ubicaciones where nombre = 'Cava de refrigeración'), 'L-A'::text, now() - interval '2 days', current_date + 5, 10000::numeric, 10000::numeric
union all
select 'e0000000-0000-4000-8000-00000000000b', 'c0000000-0000-4000-8000-000000000001', '5b1e0000-0000-4000-8000-000000000001',
       (select id from public.ubicaciones where nombre = 'Cava de refrigeración'), 'L-B', now() - interval '1 day', current_date + 2, 10000, 10000
union all
select 'e0000000-0000-4000-8000-00000000000c', 'c0000000-0000-4000-8000-000000000003', '5b1e0000-0000-4000-8000-000000000001',
       (select id from public.ubicaciones where nombre = 'Depósito seco'), 'P-1', now() - interval '1 day', current_date - 1, 48, 48;
insert into public.costos_lote values
  ('e0000000-0000-4000-8000-00000000000a', 0.0080, 'USD'),
  ('e0000000-0000-4000-8000-00000000000b', 0.0090, 'USD'),
  ('e0000000-0000-4000-8000-00000000000c', 0.2500, 'USD');

insert into public.recetas (id, codigo, nombre, tipo, codigo_pos) values
  ('9e000000-0000-4000-8000-000000000001', 'HB-CLA', 'Hamburguesa clásica', 'plato', 'POS-101');
insert into public.receta_insumos (receta_id, producto_id, cantidad, merma_pct) values
  ('9e000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 150, 10),
  ('9e000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000003', 1, 0);
insert into public.precios_venta values ('9e000000-0000-4000-8000-000000000001', current_date - 30, 6.50, 'USD');
insert into public.ventas_diarias values ('5b1e0000-0000-4000-8000-000000000001', current_date, '9e000000-0000-4000-8000-000000000001', 40);

-- cambiar de persona: JWT de Supabase + encabezados que PostgREST expone a la base
create function pg_temp.como(p_auth text, p_disp text default 'd0000000-0000-4000-8000-000000000001') returns void
language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_auth, 'role', 'authenticated', 'dispositivo_id', p_disp)::text, false);
  select set_config('request.headers',
    '{"x-forwarded-for":"190.202.14.33, 10.0.0.1","user-agent":"TotosControl/1.0 (Android 14; Tablet línea 1)"}', false);
$$;
\set gerente 'reset role; select pg_temp.como(''f0000000-0000-4000-8000-000000000001'', ''d0000000-0000-4000-8000-000000000002''); set role authenticated;'
\set sup1    'reset role; select pg_temp.como(''f0000000-0000-4000-8000-000000000002''); set role authenticated;'
\set sup2    'reset role; select pg_temp.como(''f0000000-0000-4000-8000-000000000003''); set role authenticated;'
\set op1     'reset role; select pg_temp.como(''f0000000-0000-4000-8000-000000000004''); set role authenticated;'
\set op2     'reset role; select pg_temp.como(''f0000000-0000-4000-8000-000000000005''); set role authenticated;'
\set interno 'reset role; select set_config(''request.jwt.claims'', '''', false);'
-- respuestas completas y en rango para una planilla, con un ítem que falla
create function pg_temp.respuestas(p_codigo text, p_ref text, p_valor numeric, p_evid uuid) returns jsonb
language sql as $$
  select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'item_id', i.id,
    'valor_bool', case when i.tipo = 'pass_fail' then i.ref <> coalesce(p_ref, '') end,
    'valor_num', case when i.tipo = 'number' then case when i.ref = p_ref then p_valor
                      else coalesce((i.valor_min + i.valor_max) / 2, i.valor_max - 1, i.valor_min + 1, 1) end end,
    'valor_texto', case when i.tipo = 'text' then 'Sin novedad' end,
    'valor_hora', case when i.tipo = 'time' then '12:00' end,
    'evidencia_id', case when i.ref = p_ref then p_evid end,
    'observacion', case when i.ref = p_ref then 'Falla de prueba' end)))
  from public.plantilla_items i join public.plantillas p on p.id = i.plantilla_id
  where p.codigo = p_codigo and p.vigente
$$;
\o /dev/null

-- =============================================================================
:op1
do $$ begin
  assert (select count(*) from public.costos_producto) = 0, 'el operativo ve costos de productos';
  assert (select count(*) from public.costos_lote) = 0,     'el operativo ve costos de lotes';
  assert (select count(*) from public.lotes) = 0,           'el operativo ve lotes';
  assert (select count(*) from public.v_stock) = 0,         'el operativo ve existencias';
  assert (select count(*) from public.ordenes_compra) = 0,  'el operativo ve órdenes de compra';
  assert (select count(*) from public.precios_venta) = 0,   'el operativo ve precios de venta';
  assert (select count(*) from public.productos) = 3,       'el operativo no ve el catálogo';
  assert (select count(*) from public.receta_insumos) = 2,  'el operativo no ve los gramajes';
  raise notice 'OK T01 operativo: ve catálogo y gramajes, no ve costos, lotes, existencias ni compras';
end $$;

do $$ begin
  perform * from auditoria.registros limit 1;
  raise exception 'FALLO T02 el operativo leyó la auditoría';
exception when insufficient_privilege then
  raise notice 'OK T02 operativo sin acceso a auditoría: %', sqlerrm;
end $$;
do $$ begin
  perform * from privado.credenciales_pin limit 1;
  raise exception 'FALLO T02 el operativo leyó credenciales';
exception when insufficient_privilege then
  raise notice 'OK T02 operativo sin acceso a credenciales PIN: %', sqlerrm;
end $$;
do $$ begin
  perform public.consultar_auditoria(now() - interval '1 day', now());
  raise exception 'FALLO T02 consultar_auditoria abierta al operativo';
exception when insufficient_privilege then
  raise notice 'OK T02 operativo no consulta auditoría por RPC: %', sqlerrm;
end $$;
do $$ begin
  perform public.kpi_tablero(current_date - 30, current_date);
  raise exception 'FALLO T02 kpi abierto al operativo';
exception when insufficient_privilege then
  raise notice 'OK T02 operativo no ve indicadores: %', sqlerrm;
end $$;
do $$ begin
  assert (select count(*) from public.plantillas) = (select count(*) from public.plantillas p where p.rol_asignado = 'operativo'),
    'el operativo ve planillas de otros roles';
  raise notice 'OK T03 operativo ve solo sus % planillas de las 55', (select count(*) from public.plantillas);
end $$;

-- ---------- Firma con PIN ----------
do $$ begin
  insert into public.movimientos (id, sucursal_id, producto_id, tipo, cantidad, motivo_merma)
  values ('11111111-0000-4000-8000-000000000001', '5b1e0000-0000-4000-8000-000000000001',
          'c0000000-0000-4000-8000-000000000001', 'merma', 100, 'error_cocina');
  raise exception 'FALLO T04 merma sin firma aceptada';
exception when insufficient_privilege then
  raise notice 'OK T04 merma sin firma rechazada: %', sqlerrm;
end $$;

do $$
declare r jsonb; f uuid;
begin
  r := public.firmar(current_setting('t.pin_o1'), 'crear', 'movimientos', '11111111-0000-4000-8000-000000000001');
  assert (r ->> 'ok')::boolean, 'firma correcta rechazada: ' || r::text;
  f := (r ->> 'firma_id')::uuid;
  insert into public.movimientos (id, sucursal_id, producto_id, tipo, cantidad, motivo_merma, firma_id)
  values ('11111111-0000-4000-8000-000000000001', '5b1e0000-0000-4000-8000-000000000001',
          'c0000000-0000-4000-8000-000000000001', 'merma', 100, 'error_cocina', f);
  assert (select estado from public.movimientos where id = '11111111-0000-4000-8000-000000000001') = 'aplicado';
  raise notice 'OK T05 merma de 100 g firmada con PIN y aplicada (bajo el umbral de aprobación)';
  -- la misma firma no sirve para otro registro
  begin
    insert into public.movimientos (id, sucursal_id, producto_id, tipo, cantidad, motivo_merma, firma_id)
    values ('11111111-0000-4000-8000-000000000002', '5b1e0000-0000-4000-8000-000000000001',
            'c0000000-0000-4000-8000-000000000001', 'merma', 50, 'error_cocina', f);
    raise exception 'FALLO T06 firma reutilizada';
  exception when insufficient_privilege then
    raise notice 'OK T06 firma reutilizada en otro registro rechazada: %', sqlerrm;
  end;
end $$;

:sup1
do $$ begin
  assert (select cantidad_disponible from public.lotes where codigo_lote = 'L-B') = 9900,
    'PEPS: debía salir del lote L-B, que vence antes';
  assert (select cantidad_disponible from public.lotes where codigo_lote = 'L-A') = 10000;
  raise notice 'OK T07 PEPS: la merma salió del lote que vence primero (L-B)';
end $$;

:op1
do $$
declare r jsonb;
begin
  r := public.firmar(current_setting('t.pin_o1'), 'crear', 'movimientos', '11111111-0000-4000-8000-000000000003');
  -- se simula que pasaron más de 120 s
  perform set_config('t.firma_vieja', r ->> 'firma_id', false);
end $$;
:interno
update public.firmas set expira_en = now() - interval '1 second' where id = current_setting('t.firma_vieja')::uuid;
:op1
do $$ begin
  insert into public.movimientos (id, sucursal_id, producto_id, tipo, cantidad, motivo_merma, firma_id)
  values ('11111111-0000-4000-8000-000000000003', '5b1e0000-0000-4000-8000-000000000001',
          'c0000000-0000-4000-8000-000000000001', 'merma', 50, 'error_cocina', current_setting('t.firma_vieja')::uuid);
  raise exception 'FALLO T08 firma vencida aceptada';
exception when insufficient_privilege then
  raise notice 'OK T08 firma vencida rechazada: %', sqlerrm;
end $$;

-- intentos fallidos y bloqueo (Olga)
:op2
do $$
declare r jsonb; i int;
begin
  for i in 1..4 loop
    r := public.firmar('9999', 'crear', 'movimientos', gen_random_uuid());
    assert r ->> 'motivo' = 'pin_incorrecto', r::text;
  end loop;
  assert (r ->> 'intentos_restantes')::int = 1, r::text;
  r := public.firmar('9999', 'crear', 'movimientos', gen_random_uuid());
  assert r ->> 'motivo' = 'bloqueado', r::text;
  r := public.firmar(current_setting('t.pin_o2'), 'crear', 'movimientos', gen_random_uuid());
  assert r ->> 'motivo' = 'bloqueado', 'el PIN correcto no debe funcionar durante el bloqueo';
  raise notice 'OK T09 5 PIN fallidos bloquean 15 min, incluso con el PIN correcto después';
end $$;
:sup1
do $$ begin
  assert exists (select 1 from public.alertas where tipo = 'pin_bloqueado'), 'sin alerta al supervisor';
  raise notice 'OK T09 el supervisor recibe la alerta de PIN bloqueado';
end $$;

-- ---------- Aprobación de merma por supervisor ----------
:op1
do $$
declare r jsonb;
begin
  r := public.firmar(current_setting('t.pin_o1'), 'crear', 'movimientos', '22222222-0000-4000-8000-000000000001');
  insert into public.movimientos (id, sucursal_id, producto_id, tipo, cantidad, motivo_merma, detalle, firma_id)
  values ('22222222-0000-4000-8000-000000000001', '5b1e0000-0000-4000-8000-000000000001',
          'c0000000-0000-4000-8000-000000000001', 'merma', 2000, 'temperatura', 'Cava abierta toda la noche',
          (r ->> 'firma_id')::uuid);
  assert (select estado from public.movimientos where id = '22222222-0000-4000-8000-000000000001') = 'pendiente_aprobacion';
  raise notice 'OK T10 merma de 2 kg (≈ USD 18) queda pendiente de aprobación; el operativo no ve el valor';
  r := public.resolver_aprobacion('22222222-0000-4000-8000-000000000001', current_setting('t.pin_o1'), true);
  assert r ->> 'motivo' = 'sin_permiso', r::text;
  raise notice 'OK T11 el operativo no puede aprobar con su PIN';
  -- la supervisora teclea su PIN en la tablet del operativo
  r := public.resolver_aprobacion('22222222-0000-4000-8000-000000000001', current_setting('t.pin_s1'), true, 'Se revisó la cava');
  assert (r ->> 'ok')::boolean, r::text;
  assert (select estado from public.movimientos where id = '22222222-0000-4000-8000-000000000001') = 'aplicado';
  raise notice 'OK T12 la supervisora aprueba con su PIN en la tablet del operativo';
end $$;

:sup1
do $$
declare r jsonb;
begin
  assert (select cantidad_disponible from public.lotes where codigo_lote = 'L-B') = 7900;
  assert not exists (select 1 from public.alertas where movimiento_id = '22222222-0000-4000-8000-000000000001' and estado <> 'resuelta');
  r := public.firmar(current_setting('t.pin_s1'), 'crear', 'movimientos', '22222222-0000-4000-8000-000000000002');
  insert into public.movimientos (id, sucursal_id, producto_id, tipo, cantidad, motivo_merma, firma_id)
  values ('22222222-0000-4000-8000-000000000002', '5b1e0000-0000-4000-8000-000000000001',
          'c0000000-0000-4000-8000-000000000001', 'merma', 3000, 'dano', (r ->> 'firma_id')::uuid);
  r := public.resolver_aprobacion('22222222-0000-4000-8000-000000000002', current_setting('t.pin_s1'), true);
  assert r ->> 'motivo' = 'no_puede_aprobar_lo_propio', r::text;
  r := public.resolver_aprobacion('22222222-0000-4000-8000-000000000002', current_setting('t.pin_s2'), false, 'No hay evidencia');
  assert r ->> 'estado' = 'rechazado', r::text;
  assert (select cantidad_disponible from public.lotes where codigo_lote = 'L-B') = 7900, 'una merma rechazada no descuenta';
  raise notice 'OK T13 nadie aprueba su propia merma; la rechazada no descuenta stock';
end $$;

:op1
do $$ begin
  insert into public.movimientos (id, sucursal_id, producto_id, tipo, cantidad, firma_id)
  values ('33333333-0000-4000-8000-000000000001', '5b1e0000-0000-4000-8000-000000000001',
          'c0000000-0000-4000-8000-000000000001', 'entrada_compra', 5000,
          ((public.firmar(current_setting('t.pin_o1'), 'crear', 'movimientos', '33333333-0000-4000-8000-000000000001')) ->> 'firma_id')::uuid);
  raise exception 'FALLO T14 entrada directa aceptada';
exception when insufficient_privilege then
  raise notice 'OK T14 una entrada de compra no se registra por la tabla: %', sqlerrm;
end $$;
do $$
declare n int;
begin
  update public.movimientos set cantidad = 1 where id = '11111111-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  assert n = 0, 'el operativo editó un movimiento';
  raise notice 'OK T15 el operativo no puede editar movimientos (RLS: 0 filas)';
end $$;
:sup1
do $$ begin
  update public.movimientos set cantidad = 1,
    firma_id = ((public.firmar(current_setting('t.pin_s1'), 'modificar', 'movimientos', '11111111-0000-4000-8000-000000000001')) ->> 'firma_id')::uuid
  where id = '11111111-0000-4000-8000-000000000001';
  raise exception 'FALLO T16 se editó la cantidad';
exception when insufficient_privilege then
  raise notice 'OK T16 el supervisor tampoco edita cantidades: %', sqlerrm;
end $$;
do $$ begin
  update public.movimientos set anulado = true, motivo_anulacion = 'Registrado dos veces',
    firma_id = ((public.firmar(current_setting('t.pin_s1'), 'anular', 'movimientos', '11111111-0000-4000-8000-000000000001')) ->> 'firma_id')::uuid
  where id = '11111111-0000-4000-8000-000000000001';
  assert (select estado from public.movimientos where id = '11111111-0000-4000-8000-000000000001') = 'anulado';
  assert (select cantidad_disponible from public.lotes where codigo_lote = 'L-B') = 8000, 'la anulación no devolvió el stock';
  raise notice 'OK T17 anular con firma devuelve el stock al lote y deja el registro';
end $$;

-- ---------- Checklists ----------
:op1
do $$
declare r jsonb; v_pl uuid;
begin
  select id into v_pl from public.plantillas where codigo = '08A';
  -- freidora 1 con TPM 26 % (se descarta desde 24 %), sin foto
  r := public.firmar(current_setting('t.pin_o1'), 'crear', 'checklist_ejecuciones', '44444444-0000-4000-8000-000000000001');
  begin
    perform public.enviar_checklist(jsonb_build_object('id', '44444444-0000-4000-8000-000000000001', 'plantilla_id', v_pl),
      pg_temp.respuestas('08A', '08A-1.2', 26, null), (r ->> 'firma_id')::uuid);
    raise exception 'FALLO T18 crítico fuera de rango sin foto aceptado';
  exception when check_violation then
    raise notice 'OK T18 fuera de rango sin foto rechazado: %', sqlerrm;
  end;
end $$;
do $$
declare r jsonb; v_pl uuid;
begin
  select id into v_pl from public.plantillas where codigo = '08A';
  -- con la foto (subida antes a Storage)
  insert into public.evidencias (id, sucursal_id, ruta_storage, sha256, tomada_en)
  values ('55555555-0000-4000-8000-000000000001', '5b1e0000-0000-4000-8000-000000000001',
          '5b1e0000-0000-4000-8000-000000000001/2026/10/55555555.webp', 'abc123', now());
  r := public.firmar(current_setting('t.pin_o1'), 'crear', 'checklist_ejecuciones', '44444444-0000-4000-8000-000000000001');
  r := public.enviar_checklist(jsonb_build_object('id', '44444444-0000-4000-8000-000000000001', 'plantilla_id', v_pl),
         pg_temp.respuestas('08A', '08A-1.2', 26, '55555555-0000-4000-8000-000000000001'), (r ->> 'firma_id')::uuid);
  assert (r ->> 'ok')::boolean and (r ->> 'criticos_no_cumple')::int = 1 and (r ->> 'incidencias')::int = 1
         and (r ->> 'operacion_bloqueada')::boolean, r::text;
  assert (select count(*) from public.checklist_ejecuciones) = 1, 'el operativo no ve su planilla';
  raise notice 'OK T19 freidoras (08A) enviada con foto: puntaje %, 1 crítico, freidora bloqueada', r ->> 'puntaje';
end $$;

:op2
do $$ begin
  assert (select count(*) from public.checklist_ejecuciones) = 0, 'Olga ve la planilla de Óscar';
  assert (select count(*) from public.incidencias) = 0, 'Olga ve incidencias ajenas';
  raise notice 'OK T20 otro operativo no ve planillas ni incidencias ajenas';
end $$;

:sup1
do $$ begin
  assert exists (select 1 from public.incidencias where severidad = 'critica' and bloquea_operacion
                 and descripcion like 'Valor 26 %%'), 'sin incidencia crítica de TPM';
  assert exists (select 1 from public.alertas where tipo = 'operacion_bloqueada'), 'sin alerta de bloqueo';
  raise notice 'OK T21 el TPM fuera de límite abrió una incidencia crítica y avisó "No operar" al supervisor';
end $$;
:sup2
do $$
declare r jsonb;
begin
  insert into public.evidencias (id, sucursal_id, ruta_storage, sha256, tomada_en)
  values ('55555555-0000-4000-8000-000000000003', '5b1e0000-0000-4000-8000-000000000001', 'x/2026/10/3.webp', 'ghi', now());
  r := public.firmar(current_setting('t.pin_s2'), 'crear', 'checklist_ejecuciones', '44444444-0000-4000-8000-000000000004');
  r := public.enviar_checklist(jsonb_build_object('id', '44444444-0000-4000-8000-000000000004',
         'plantilla_id', (select id from public.plantillas where codigo = '14A'), 'horario', '16:00'),
         pg_temp.respuestas('14A', '14A-1.1', 8, '55555555-0000-4000-8000-000000000003'), (r ->> 'firma_id')::uuid);
  assert exists (select 1 from public.incidencias where origen = 'temperatura' and severidad = 'critica'
                 and descripcion like 'Valor 8 °C%'), 'sin incidencia de temperatura';
  raise notice 'OK T21 cava a 8 °C en la planilla 14A de las 16:00: incidencia crítica de temperatura';
end $$;

:op1
do $$
declare r jsonb;
begin
  r := public.firmar(current_setting('t.pin_o1'), 'crear', 'checklist_ejecuciones', '44444444-0000-4000-8000-000000000002');
  perform public.enviar_checklist(jsonb_build_object('id', '44444444-0000-4000-8000-000000000002',
           'plantilla_id', current_setting('t.pl01')), '[]', (r ->> 'firma_id')::uuid);
  raise exception 'FALLO T22 operativo llenó la apertura';
exception when others then
  if sqlerrm like 'FALLO%' then raise; end if;
  raise notice 'OK T22 el operativo no llena planillas del supervisor: %', sqlerrm;
end $$;

:sup1
do $$
declare r jsonb; v_pl uuid; v_resp jsonb;
begin
  select id into v_pl from public.plantillas where codigo = '01';
  r := public.firmar(current_setting('t.pin_s1'), 'crear', 'checklist_ejecuciones', '44444444-0000-4000-8000-000000000003');
  begin
    perform public.enviar_checklist(jsonb_build_object('id', '44444444-0000-4000-8000-000000000003', 'plantilla_id', v_pl),
      '[]', (r ->> 'firma_id')::uuid);
    raise exception 'FALLO T23 planilla vacía aceptada';
  exception when others then
    if sqlerrm like 'FALLO%' then raise; end if;
    raise notice 'OK T23 planilla incompleta rechazada: %', left(sqlerrm, 70);
  end;
end $$;
do $$
declare r jsonb; v_pl uuid;
begin
  select id into v_pl from public.plantillas where codigo = '01';
  -- apertura con "temperaturas registradas" en No → operación bloqueada
  insert into public.evidencias (id, sucursal_id, ruta_storage, sha256, tomada_en)
  values ('55555555-0000-4000-8000-000000000002', '5b1e0000-0000-4000-8000-000000000001', 'x/2026/10/2.webp', 'def', now());
  r := public.firmar(current_setting('t.pin_s1'), 'crear', 'checklist_ejecuciones', '44444444-0000-4000-8000-000000000003');
  r := public.enviar_checklist(jsonb_build_object('id', '44444444-0000-4000-8000-000000000003', 'plantilla_id', v_pl,
         'horario', '11:00'), pg_temp.respuestas('01', '01-2.1', null, '55555555-0000-4000-8000-000000000002'),
         (r ->> 'firma_id')::uuid);
  assert (r ->> 'operacion_bloqueada')::boolean, r::text;
  assert (select count(*) from public.alertas where tipo = 'operacion_bloqueada') = 2, 'sin alerta de bloqueo';
  raise notice 'OK T24 apertura con un crítico en No: puntaje %, operación bloqueada y alertada', r ->> 'puntaje';
end $$;
do $$ begin

  -- la supervisora no revisa su propia planilla
  begin
    update public.checklist_ejecuciones set estado = 'revisada',
      firma_id = ((public.firmar(current_setting('t.pin_s1'), 'aprobar', 'checklist_ejecuciones', '44444444-0000-4000-8000-000000000003')) ->> 'firma_id')::uuid
    where id = '44444444-0000-4000-8000-000000000003';
    raise exception 'FALLO T25 revisó su propia planilla';
  exception when insufficient_privilege then
    raise notice 'OK T25 nadie revisa su propia planilla: %', sqlerrm;
  end;
end $$;
do $$ begin
  begin
    update public.checklist_ejecuciones set puntaje = 100 where id = '44444444-0000-4000-8000-000000000001';
    raise exception 'FALLO T26 se cambió el puntaje';
  exception when insufficient_privilege then
    raise notice 'OK T26 el puntaje calculado no se puede cambiar: %', sqlerrm;
  end;
  -- pero sí revisa la del operativo
  update public.checklist_ejecuciones set estado = 'revisada', nota_revision = 'Aceite cambiado a las 11:40',
    firma_id = ((public.firmar(current_setting('t.pin_s1'), 'aprobar', 'checklist_ejecuciones', '44444444-0000-4000-8000-000000000001')) ->> 'firma_id')::uuid
  where id = '44444444-0000-4000-8000-000000000001';
  assert (select estado = 'revisada' and puntaje < 100 and revisada_por = 'a0000000-0000-4000-8000-000000000002'
          from public.checklist_ejecuciones where id = '44444444-0000-4000-8000-000000000001'), 'revisión mal aplicada';
  raise notice 'OK T26 la supervisora revisa con firma la planilla del operativo';
end $$;

do $$ begin
  update public.checklist_respuestas set valor_num = 4;
  raise exception 'FALLO T27 se editó una respuesta';
exception when insufficient_privilege then
  raise notice 'OK T27 las respuestas firmadas no se editan: %', sqlerrm;
end $$;

-- ---------- Incidencias ----------
do $$
declare v_inc uuid;
begin
  select id into v_inc from public.incidencias where origen = 'temperatura';
  update public.incidencias set estado = 'resuelta', accion_correctiva = 'Producto trasladado a la cava 2 y técnico llamado',
    firma_id = ((public.firmar(current_setting('t.pin_s1'), 'modificar', 'incidencias', v_inc)) ->> 'firma_id')::uuid
  where id = v_inc;
  perform set_config('t.inc', v_inc::text, false);
  raise notice 'OK T28 incidencia resuelta con acción correctiva y firma';
end $$;
:sup2
do $$ begin
  update public.incidencias set estado = 'verificada',
    firma_id = ((public.firmar(current_setting('t.pin_s2'), 'modificar', 'incidencias', current_setting('t.inc')::uuid)) ->> 'firma_id')::uuid
  where id = current_setting('t.inc')::uuid;
  raise exception 'FALLO T29 supervisor verificó una crítica';
exception when insufficient_privilege then
  raise notice 'OK T29 una incidencia crítica solo la verifica el gerente: %', sqlerrm;
end $$;
:gerente
do $$ begin
  update public.incidencias set estado = 'verificada',
    firma_id = ((public.firmar(current_setting('t.pin_admin'), 'modificar', 'incidencias', current_setting('t.inc')::uuid)) ->> 'firma_id')::uuid
  where id = current_setting('t.inc')::uuid;
  assert (select estado from public.incidencias where id = current_setting('t.inc')::uuid) = 'verificada';
  raise notice 'OK T29 el gerente verifica la incidencia crítica';
end $$;

-- ---------- Compras, recepción a ciegas y transferencias ----------
do $$
declare r jsonb;
begin
  r := public.firmar(current_setting('t.pin_admin'), 'crear', 'ordenes_compra', '66666666-0000-4000-8000-000000000001');
  insert into public.ordenes_compra (id, sucursal_id, proveedor_id, estado, creado_por, firma_id)
  values ('66666666-0000-4000-8000-000000000001', '5b1e0000-0000-4000-8000-000000000001',
          'b0000000-0000-4000-8000-000000000001', 'enviada', 'a0000000-0000-4000-8000-000000000001', (r ->> 'firma_id')::uuid);
  insert into public.orden_compra_lineas (orden_id, producto_id, cantidad, precio_unitario) values
    ('66666666-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 10, 8.20),
    ('66666666-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 20, 3.10);
  raise notice 'OK T30 orden de compra con precios creada por el gerente (líneas con la firma de la orden)';
end $$;

:op1
do $$
declare r jsonb;
begin
  assert (select count(*) from public.orden_compra_lineas) = 0, 'el receptor ve la orden';
  r := public.firmar(current_setting('t.pin_o1'), 'crear', 'recepciones', '77777777-0000-4000-8000-000000000001');
  r := public.registrar_recepcion(
    jsonb_build_object('id', '77777777-0000-4000-8000-000000000001', 'orden_id', '66666666-0000-4000-8000-000000000001',
                       'proveedor_id', 'b0000000-0000-4000-8000-000000000001', 'numero_factura', '00012345'),
    jsonb_build_array(
      jsonb_build_object('producto_id', 'c0000000-0000-4000-8000-000000000001', 'cantidad_recibida', 10000,
                         'temperatura_llegada', 7.5, 'fecha_vencimiento', current_date + 4,
                         'ubicacion_id', (select id from public.ubicaciones where nombre = 'Cava de refrigeración')),
      jsonb_build_object('producto_id', 'c0000000-0000-4000-8000-000000000002', 'cantidad_recibida', 20000,
                         'temperatura_llegada', -19, 'fecha_vencimiento', current_date + 90, 'codigo_lote', 'PF-889',
                         'ubicacion_id', (select id from public.ubicaciones where nombre = 'Cava de congelación'))),
    (r ->> 'firma_id')::uuid);
  assert r ->> 'estado' = 'aceptada_con_diferencias' and (r ->> 'lineas_rechazadas')::int = 1, r::text;
  raise notice 'OK T31 recepción a ciegas: carne a 7,5 °C rechazada, papas aceptadas → %', r ->> 'estado';
end $$;
:gerente
do $$ begin
  assert (select cl.costo_unitario from public.costos_lote cl join public.lotes l on l.id = cl.lote_id
          where l.codigo_lote = 'PF-889') = 0.0031, 'el costo del lote no salió de la orden de compra';
  raise notice 'OK T32 el lote de papas tomó su costo de la orden (USD 0,0031/g) sin que el receptor lo viera';
end $$;

:op1
do $$
declare r jsonb;
begin
  r := public.firmar(current_setting('t.pin_o1'), 'crear', 'transferencias', '88888888-0000-4000-8000-000000000001');
  r := public.registrar_transferencia('88888888-0000-4000-8000-000000000001',
         (select id from public.ubicaciones where nombre = 'Cava de refrigeración'),
         (select id from public.ubicaciones where nombre = 'Línea caliente'),
         jsonb_build_array(jsonb_build_object('producto_id', 'c0000000-0000-4000-8000-000000000001', 'cantidad', 9000)),
         (r ->> 'firma_id')::uuid, 'Reposición de línea');
  assert (r ->> 'ok')::boolean, r::text;
end $$;
:gerente
do $$ begin
  assert (select count(*) from public.lotes l join public.ubicaciones u on u.id = l.ubicacion_id
          where u.nombre = 'Línea caliente' and l.cantidad_disponible > 0) = 2, 'la transferencia debía partir 2 lotes';
  assert (select sum(l.cantidad_disponible * cl.costo_unitario) from public.lotes l
          join public.costos_lote cl on cl.lote_id = l.id join public.ubicaciones u on u.id = l.ubicacion_id
          where u.nombre = 'Línea caliente') = 8000 * 0.009 + 1000 * 0.008, 'el costo no viajó con los lotes';
  raise notice 'OK T33 transferencia de 9 kg a la línea: PEPS tomó 8 kg de L-B y 1 kg de L-A, con su costo';
end $$;

-- ---------- Alertas automáticas ----------
:interno
select app.revisar_vencimientos();
:sup1
do $$ begin
  assert exists (select 1 from public.alertas where tipo = 'lote_vencido'), 'sin alerta de vencido';
  assert (select bloqueado from public.lotes where codigo_lote = 'P-1'), 'el lote vencido no se bloqueó';
  assert exists (select 1 from public.alertas where tipo = 'stock_bajo'), 'sin alerta de stock bajo';
  raise notice 'OK T34 lote de pan vencido bloqueado y alertado; al quedar en cero, alerta de stock bajo';
end $$;
:op1
do $$ begin
  assert exists (select 1 from public.alertas where tipo = 'vencimiento_proximo'), 'el operativo no ve "usar primero"';
  assert not exists (select 1 from public.alertas where tipo in ('stock_bajo','pin_bloqueado')), 'el operativo ve alertas de supervisor';
  raise notice 'OK T35 el operativo ve "por vencer, úselo primero", no las alertas de supervisión';
end $$;

-- ---------- Quick Switch ----------
:interno
do $$
declare r jsonb; i int;
begin
  r := privado.abrir_sesion_por_pin('d0000000-0000-4000-8000-000000000001', 'secreto-falso', current_setting('t.pin_o1'));
  assert r ->> 'motivo' = 'dispositivo_no_registrado', r::text;
  r := privado.abrir_sesion_por_pin('d0000000-0000-4000-8000-000000000001', 'secreto-tablet-1', current_setting('t.pin_s2'));
  assert (r ->> 'ok')::boolean and r ->> 'rol' = 'supervisor', r::text;
  raise notice 'OK T36 Quick Switch: el PIN solo identifica a la persona en un dispositivo registrado → %', r ->> 'nombre';
  for i in 1..10 loop
    r := privado.abrir_sesion_por_pin('d0000000-0000-4000-8000-000000000001', 'secreto-tablet-1', '0000');
  end loop;
  r := privado.abrir_sesion_por_pin('d0000000-0000-4000-8000-000000000001', 'secreto-tablet-1', current_setting('t.pin_s2'));
  assert r ->> 'motivo' = 'dispositivo_bloqueado', r::text;
  raise notice 'OK T37 10 PIN errados en 5 min bloquean la tablet';
  update public.dispositivos set bloqueado_hasta = null;
end $$;

-- ---------- PIN: asignación y unicidad ----------
:gerente
do $$
declare r jsonb;
begin
  r := public.firmar(current_setting('t.pin_admin'), 'modificar', 'usuarios', 'a0000000-0000-4000-8000-000000000002');
  begin
    perform public.asignar_pin('a0000000-0000-4000-8000-000000000002', 4, (r ->> 'firma_id')::uuid);
    raise exception 'FALLO T38 PIN de 4 a supervisor';
  exception when others then
    if sqlerrm like 'FALLO%' then raise; end if;
    raise notice 'OK T38 supervisores y gerente usan 6 dígitos: %', sqlerrm;
  end;
  r := public.firmar(current_setting('t.pin_admin'), 'modificar', 'usuarios', 'a0000000-0000-4000-8000-000000000005');
  r := public.asignar_pin('a0000000-0000-4000-8000-000000000005', 4, (r ->> 'firma_id')::uuid);
  assert (r ->> 'pin_provisional') ~ '^[0-9]{4}$', r::text;
  perform set_config('t.pin_o2', r ->> 'pin_provisional', false);
  raise notice 'OK T38 PIN provisional de 4 dígitos generado y desbloqueado';
end $$;
:op2
do $$
declare r jsonb;
begin
  r := public.regenerar_mi_pin(current_setting('t.pin_o2'));
  assert (r ->> 'ok')::boolean and (r ->> 'pin') <> current_setting('t.pin_o2'), r::text;
  raise notice 'OK T39 la empleada cambia su PIN provisional; el gerente no conoce el definitivo';
end $$;
:interno
do $$ begin
  assert not exists (select 1 from privado.credenciales_pin c, lateral (select 1) x
                     where privado.pin_trivial(current_setting('t.pin_o1'))), 'PIN trivial generado';
  assert (select count(distinct pin_indice) = count(*) from privado.credenciales_pin), 'PIN repetidos';
  raise notice 'OK T40 no hay dos personas con el mismo PIN (índice HMAC único)';
end $$;

-- ---------- Reportes ----------
:sup1
do $$
declare k jsonb;
begin
  k := public.kpi_tablero(current_date - 30, current_date);
  assert k ->> 'mermas_usd' is null and k ->> 'valor_inventario_usd' is null, 'el supervisor ve dinero';
  assert (select count(*) from public.costo_receta('9e000000-0000-4000-8000-000000000001')) = 0, 'el supervisor ve food cost';
  raise notice 'OK T41 supervisor: indicadores operativos sin montos → %', k::text;
end $$;
:gerente
do $$
declare k jsonb; c record;
begin
  k := public.kpi_tablero(current_date - 30, current_date);
  assert (k ->> 'valor_inventario_usd')::numeric > 0 and (k ->> 'mermas_usd')::numeric > 0, k::text;
  select * into c from public.costo_receta('9e000000-0000-4000-8000-000000000001');
  raise notice 'OK T42 gerente: inventario USD %, mermas USD %, food cost hamburguesa % %%',
    k ->> 'valor_inventario_usd', k ->> 'mermas_usd', c.food_cost_pct;
  assert (select count(*) from public.exportar_movimientos(current_date - 1, current_date)) > 0;
  raise notice 'OK T43 el gerente exporta movimientos valorizados (queda en la auditoría)';
end $$;

-- ---------- Auditoría ----------
:gerente
do $$
declare a record;
begin
  select * into a from public.consultar_auditoria(now() - interval '1 hour', now() + interval '1 hour', 'movimientos')
  where accion = 'ANULAR' limit 1;
  assert a.id is not null, 'sin registro de anulación';
  assert a.valores_anteriores ->> 'estado' = 'aplicado' and a.valores_nuevos ->> 'estado' = 'anulado', 'sin antes/después';
  assert a.firma_id is not null and host(a.ip) = '190.202.14.33' and a.dispositivo_id is not null, 'sin firma, IP o dispositivo';
  raise notice 'OK T44 auditoría: % % por % con firma, IP %, campos %',
    a.accion, a.tabla, a.rol, host(a.ip), a.campos_modificados;
  select * into a from public.consultar_auditoria(now() - interval '1 hour', now() + interval '1 hour', 'movimientos')
  where accion = 'UPDATE' and registro_id = '22222222-0000-4000-8000-000000000001' limit 1;
  assert a.usuario_id = 'a0000000-0000-4000-8000-000000000002' and a.usuario_sesion_id = 'a0000000-0000-4000-8000-000000000004',
    'la aprobación debe registrar a quien firmó y a quien tenía la sesión';
  raise notice 'OK T45 la aprobación queda a nombre de la supervisora, en la sesión del operativo';
  assert exists (select 1 from public.consultar_auditoria(now() - interval '1 hour', now() + interval '1 hour')
                 where accion = 'EXPORTAR'), 'la exportación no quedó registrada';
end $$;
:interno
do $$ begin
  update auditoria.registros set accion = 'X' where id = 1;
  raise exception 'FALLO T46 auditoría editable';
exception when insufficient_privilege then
  raise notice 'OK T46 ni el dueño de la base edita la auditoría: %', sqlerrm;
end $$;
do $$ begin
  assert auditoria.verificar_cadena() is null, 'cadena de hash rota';
  raise notice 'OK T47 cadena de hash íntegra en % registros', (select count(*) from auditoria.registros);
end $$;
-- si alguien con acceso total desactiva el trigger y altera un registro, la cadena lo delata
alter table auditoria.registros disable trigger auditoria_inmutable;
select set_config('t.alterado', (select (max(id) - 40)::text from auditoria.registros), false);
update auditoria.registros set valores_nuevos = '{"cantidad": 1}' where id = current_setting('t.alterado')::bigint;
alter table auditoria.registros enable trigger auditoria_inmutable;
do $$ begin
  assert auditoria.verificar_cadena() = current_setting('t.alterado')::bigint, 'la alteración no se detectó';
  raise notice 'OK T48 una alteración directa se detecta en el registro %', auditoria.verificar_cadena();
end $$;

-- ---------- API anónima ----------
reset role;
select set_config('request.jwt.claims', '{"role":"anon"}', false);
set role anon;
do $$ begin
  perform 1 from public.productos limit 1;
  raise exception 'FALLO T49 anon lee productos';
exception when insufficient_privilege then
  raise notice 'OK T49 la clave anónima no lee ninguna tabla: %', sqlerrm;
end $$;
do $$ begin
  perform public.firmar('1234', 'crear', 'movimientos', gen_random_uuid());
  raise exception 'FALLO T49 anon firma';
exception when insufficient_privilege then
  raise notice 'OK T49 la clave anónima no ejecuta funciones: %', sqlerrm;
end $$;

-- ---------- Freidora 2: 170 a 185 °C ----------
:op1
do $$
declare r jsonb; v_pl uuid;
begin
  select id into v_pl from public.plantillas where codigo = '08A';
  assert (select (valor_min, valor_max) = (170::numeric, 185::numeric) from public.plantilla_items where ref = '08A-2.1'),
         'la freidora 2 no tiene el rango 170-185';
  insert into public.evidencias (id, sucursal_id, ruta_storage, sha256, tomada_en)
  values ('55555555-0000-4000-8000-000000000009', '5b1e0000-0000-4000-8000-000000000001',
          '5b1e0000-0000-4000-8000-000000000001/2026/10/55555559.webp', 'abc129', now());
  r := public.firmar(current_setting('t.pin_o1'), 'crear', 'checklist_ejecuciones', '44444444-0000-4000-8000-000000000009');
  r := public.enviar_checklist(jsonb_build_object('id', '44444444-0000-4000-8000-000000000009', 'plantilla_id', v_pl),
         pg_temp.respuestas('08A', '08A-2.1', 165, '55555555-0000-4000-8000-000000000009'), (r ->> 'firma_id')::uuid);
  assert (r ->> 'ok')::boolean and (r ->> 'criticos_no_cumple')::int = 0 and (r ->> 'incidencias')::int = 1
         and not (r ->> 'operacion_bloqueada')::boolean, r::text;
  raise notice 'OK T50 freidora 2 a 165 °C: no cumple (rango 170-185), incidencia abierta sin bloquear el equipo';
end $$;

-- ---------- Programación y cumplimiento ----------
:interno
select app.generar_programacion(current_date);
do $$ begin
  assert (select count(*) from public.checklist_programacion where fecha = current_date) > 40, 'programación incompleta';
  raise notice 'OK T51 programación del día: % planillas/horarios esperados',
    (select count(*) from public.checklist_programacion where fecha = current_date);
end $$;
do $$ begin
  perform app.generar_programacion('2027-07-01');
  perform app.generar_programacion('2027-08-01');
  assert exists (select 1 from public.checklist_programacion c join public.plantillas p on p.id = c.plantilla_id
                 where p.codigo = '12F' and c.fecha = '2027-07-01'), '12F no se programó el 1 de julio';
  assert not exists (select 1 from public.checklist_programacion c join public.plantillas p on p.id = c.plantilla_id
                     where p.codigo = '12F' and c.fecha = '2027-08-01'), '12F se programó en agosto';
  assert (select count(distinct p.codigo) from public.checklist_programacion c join public.plantillas p on p.id = c.plantilla_id
          where p.codigo like '05A_' and c.fecha = '2027-07-01') = 4, 'faltan planillas de baños';
  raise notice 'OK T52 12F semestral sale el 1 de enero y el 1 de julio; cada baño tiene su hoja horaria (% rondas el día)',
    (select count(*) from public.checklist_programacion c join public.plantillas p on p.id = c.plantilla_id
     where p.codigo like '05A_' and c.fecha = '2027-07-01');
end $$;
reset role;
\o
