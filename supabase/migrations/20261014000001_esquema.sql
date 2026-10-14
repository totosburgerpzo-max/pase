-- =============================================================================
-- Totos Control · PWA de calidad e inventario
-- Esquema PostgreSQL 15+ / Supabase · v1.0 · 2026-10-13
--
-- Principios
--   1. La base de datos hace cumplir las reglas, no la pantalla: RLS en todas
--      las tablas, ninguna escritura sin firma con PIN y una bitácora de
--      auditoría que nadie puede editar.
--   2. Los costos viven en tablas aparte que solo lee el gerente
--      (costos_producto, costos_lote, ordenes_compra, precios_venta).
--   3. Nada se borra: "eliminar" es anular (anulado = true) con firma.
--   4. Los ids los genera el cliente (uuid) para poder trabajar sin conexión.
--
-- Esquemas
--   public     tablas, vistas y funciones expuestas por la API (PostgREST)
--   app        funciones auxiliares de RLS y triggers (no expuesto)
--   privado    credenciales PIN, secretos de dispositivo e intentos (sin API)
--   auditoria  bitácora inmutable encadenada por hash (lectura vía RPC)
--
-- Orden de ejecución: 01_schema.sql → 02_seed_base.sql → 03_seed_plantillas.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. EXTENSIONES Y ESQUEMAS
-- -----------------------------------------------------------------------------
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists app;
create schema if not exists privado;
create schema if not exists auditoria;

revoke all on schema privado, auditoria from public;
grant usage on schema app to authenticated, service_role;
grant usage on schema privado, auditoria to service_role;

-- -----------------------------------------------------------------------------
-- 1. TIPOS
-- -----------------------------------------------------------------------------
create type public.area_operativa as enum (
  'cocina','linea','produccion','almacen','salon','banos','caja','drive_thru',
  'delivery','personal','mantenimiento','seguridad','general','exteriores');
create type public.tipo_plantilla   as enum ('checklist','registro','mixto');
create type public.frecuencia       as enum ('diaria','por_turno','varias_al_dia','semanal',
                                             'quincenal','mensual','trimestral','semestral','por_evento');
create type public.tipo_campo       as enum ('pass_fail','number','text','choice','photo','time');
create type public.estado_ejecucion as enum ('completada','revisada','observada','anulada');
create type public.severidad        as enum ('critica','alta','media','baja');
create type public.estado_incidencia as enum ('abierta','en_proceso','resuelta','verificada','anulada');
create type public.tipo_movimiento  as enum (
  'entrada_compra','transferencia_entrada','ajuste_positivo',                 -- entradas
  'salida_produccion','consumo_venta','merma','transferencia_salida',
  'ajuste_negativo','devolucion_proveedor');                                  -- salidas
create type public.motivo_merma     as enum ('vencimiento','dano','error_cocina','error_pedido',
                                             'recepcion_almacen','temperatura','consumo_personal',
                                             'faltante','otro');
create type public.estado_movimiento as enum ('pendiente_aprobacion','aplicado','rechazado','anulado');
create type public.accion_firma     as enum ('crear','modificar','anular','aprobar','rechazar');
create type public.metodo_firma     as enum ('pin_en_linea','pin_sin_conexion','pin_autorizacion');
create type public.conservacion     as enum ('ambiente','refrigerado','congelado');
create type public.tipo_alerta      as enum (
  'stock_bajo','vencimiento_proximo','lote_vencido','incidencia','incidencia_escalada',
  'operacion_bloqueada','checklist_vencido','pin_bloqueado','dispositivo_bloqueado',
  'aprobacion_pendiente','diferencia_recepcion');
create type public.estado_alerta    as enum ('abierta','vista','resuelta');

-- -----------------------------------------------------------------------------
-- 2. ORGANIZACIÓN, USUARIOS, ROLES Y PERMISOS
-- -----------------------------------------------------------------------------
create table public.sucursales (
  id            uuid primary key default gen_random_uuid(),
  nombre        text not null,
  direccion     text,
  zona_horaria  text not null default 'America/Caracas',
  activa        boolean not null default true,
  creado_en     timestamptz not null default now()
);

create table public.roles (
  codigo  text primary key check (codigo in ('admin','supervisor','operativo')),
  nombre  text not null,
  nivel   smallint not null unique          -- operativo 10 · supervisor 20 · admin 30
);

create table public.permisos (
  codigo       text primary key,            -- modulo.recurso.accion
  modulo       text not null,
  descripcion  text not null
);

create table public.rol_permisos (
  rol      text references public.roles(codigo) on delete cascade,
  permiso  text references public.permisos(codigo) on delete cascade,
  primary key (rol, permiso)
);

create table public.usuarios (
  id              uuid primary key default gen_random_uuid(),
  auth_id         uuid unique references auth.users(id) on delete restrict,
  sucursal_id     uuid not null references public.sucursales(id),
  nombre          text not null,
  apellido        text not null,
  cedula          text unique,
  cargo           text,                     -- parrillero, cajero de autoservicio, supervisor de turno…
  rol             text not null default 'operativo' references public.roles(codigo),
  turno           text check (turno in ('mediodia','noche','polivalente','gerencia')),
  activo          boolean not null default true,
  creado_en       timestamptz not null default now(),
  actualizado_en  timestamptz not null default now(),
  firma_id        uuid
);

create table public.parametros (
  clave           text primary key,
  valor           jsonb not null,
  descripcion     text,
  actualizado_en  timestamptz not null default now(),
  firma_id        uuid
);

-- -----------------------------------------------------------------------------
-- 3. FUNCIONES DE CONTEXTO (usadas por RLS y triggers)
-- -----------------------------------------------------------------------------
create or replace function app.claims() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

-- Sin JWT de usuario (pg_cron, migraciones) o con la clave service_role (Edge Functions)
create or replace function app.es_proceso_interno() returns boolean
language sql stable as $$
  select coalesce(app.claims() ->> 'role', 'service_role') = 'service_role'
$$;

-- Verdadero solo dentro de una función RPC de este esquema que ya validó una firma.
-- 'app.contexto' se fija con set_config(..., true) (local a la transacción) y no se
-- puede fijar desde la API: PostgREST no expone pg_catalog.set_config.
create or replace function app.contexto_confiable() returns boolean
language sql stable as $$
  select coalesce(current_setting('app.contexto', true), '') <> ''
$$;

create or replace function app.usuario_actual() returns uuid
language sql stable security definer set search_path = '' as $$
  select u.id from public.usuarios u where u.auth_id = auth.uid() and u.activo
$$;

create or replace function app.rol_actual() returns text
language sql stable security definer set search_path = '' as $$
  select u.rol from public.usuarios u where u.auth_id = auth.uid() and u.activo
$$;

create or replace function app.nivel_actual() returns smallint
language sql stable security definer set search_path = '' as $$
  select r.nivel from public.usuarios u join public.roles r on r.codigo = u.rol
  where u.auth_id = auth.uid() and u.activo
$$;

create or replace function app.sucursal_actual() returns uuid
language sql stable security definer set search_path = '' as $$
  select u.sucursal_id from public.usuarios u where u.auth_id = auth.uid() and u.activo
$$;

create or replace function app.tiene_permiso(p_permiso text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.usuarios u
    join public.rol_permisos rp on rp.rol = u.rol
    where u.auth_id = auth.uid() and u.activo and rp.permiso = p_permiso)
$$;

create or replace function app.usuario_tiene_permiso(p_usuario uuid, p_permiso text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.usuarios u
    join public.rol_permisos rp on rp.rol = u.rol
    where u.id = p_usuario and u.activo and rp.permiso = p_permiso)
$$;

create or replace function app.es_admin() returns boolean
language sql stable as $$ select coalesce(app.rol_actual() = 'admin', false) $$;

create or replace function app.en_mi_sucursal(p_sucursal uuid) returns boolean
language sql stable as $$ select app.es_admin() or p_sucursal = app.sucursal_actual() $$;

create or replace function app.dispositivo_actual() returns uuid
language plpgsql stable as $$
begin
  return nullif(app.claims() ->> 'dispositivo_id', '')::uuid;
exception when others then return null;
end $$;

create or replace function app.encabezado(p_nombre text) returns text
language plpgsql stable as $$
begin
  return nullif(current_setting('request.headers', true), '')::jsonb ->> p_nombre;
exception when others then return null;
end $$;

create or replace function app.ip_cliente() returns inet
language plpgsql stable as $$
begin
  return nullif(trim(split_part(coalesce(app.encabezado('cf-connecting-ip'),
                                         app.encabezado('x-forwarded-for'), ''), ',', 1)), '')::inet;
exception when others then return null;
end $$;

create or replace function app.parametro(p_clave text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select valor from public.parametros where clave = p_clave
$$;

-- -----------------------------------------------------------------------------
-- 4. PIN, DISPOSITIVOS Y FIRMAS
-- -----------------------------------------------------------------------------
create table public.dispositivos (
  id               uuid primary key default gen_random_uuid(),
  sucursal_id      uuid not null references public.sucursales(id),
  nombre           text not null,                       -- "Tablet línea 1"
  tipo             text not null check (tipo in ('tablet_cocina','tablet_caja','telefono','pc_gerencia')),
  activo           boolean not null default true,
  registrado_por   uuid references public.usuarios(id),
  registrado_en    timestamptz not null default now(),
  ultimo_uso       timestamptz,
  bloqueado_hasta  timestamptz,
  firma_id         uuid
);

-- El secreto del dispositivo vive en el equipo (IndexedDB, clave no exportable);
-- aquí solo su hash. Sin dispositivo registrado, un PIN no abre sesión.
create table privado.dispositivo_secretos (
  dispositivo_id  uuid primary key references public.dispositivos(id) on delete cascade,
  secreto_hash    bytea not null
);

create table privado.credenciales_pin (
  usuario_id         uuid primary key references public.usuarios(id) on delete cascade,
  pin_hash           text not null,            -- bcrypt: crypt(pin, gen_salt('bf', 10))
  pin_indice         bytea not null unique,    -- HMAC-SHA256(pepper, pin): identifica por PIN y garantiza unicidad
  longitud           smallint not null check (longitud between 4 and 6),
  intentos_fallidos  smallint not null default 0,
  bloqueado_hasta    timestamptz,
  debe_cambiar       boolean not null default true,
  actualizado_en     timestamptz not null default now()
);

create table privado.intentos_pin (
  id              bigint generated always as identity primary key,
  dispositivo_id  uuid,
  usuario_id      uuid,
  contexto        text not null check (contexto in ('sesion','firma','autorizacion','cambio_pin')),
  exito           boolean not null,
  ip              inet,
  ocurrido_en     timestamptz not null default now()
);
create index on privado.intentos_pin (dispositivo_id, ocurrido_en desc);

create table public.firmas (
  id                       uuid primary key default gen_random_uuid(),
  usuario_id               uuid not null references public.usuarios(id),
  accion                   public.accion_firma not null,
  entidad                  text not null,          -- tabla firmada
  entidad_id               uuid not null,          -- registro firmado (uuid generado en el cliente)
  metodo                   public.metodo_firma not null default 'pin_en_linea',
  dispositivo_id           uuid references public.dispositivos(id),
  ip                       inet,
  creada_en                timestamptz not null default now(),
  expira_en                timestamptz not null,
  usada_en                 timestamptz,
  usada_txid               bigint,
  firmada_sin_conexion_en  timestamptz            -- hora del dispositivo, solo pin_sin_conexion
);
create index on public.firmas (usada_txid);
create index on public.firmas (usuario_id, creada_en desc);

alter table public.usuarios     add foreign key (firma_id) references public.firmas(id);
alter table public.parametros   add foreign key (firma_id) references public.firmas(id);
alter table public.dispositivos add foreign key (firma_id) references public.firmas(id);

-- -----------------------------------------------------------------------------
-- 5. AUDITORÍA (append-only, encadenada por hash)
-- -----------------------------------------------------------------------------
create table auditoria.registros (
  id                  bigint generated always as identity primary key,
  ocurrido_en         timestamptz not null,
  usuario_id          uuid,           -- quien firmó (puede ser un supervisor que autoriza)
  usuario_sesion_id   uuid,           -- quien tenía la sesión abierta en el dispositivo
  rol                 text,
  accion              text not null,  -- INSERT · UPDATE · ANULAR · PIN_FALLIDO · SESION_PIN · EXPORTAR …
  tabla               text,
  registro_id         text,
  valores_anteriores  jsonb,
  valores_nuevos      jsonb,
  campos_modificados  text[],
  firma_id            uuid,
  ip                  inet,
  dispositivo_id      uuid,
  user_agent          text,
  txid                bigint not null default txid_current(),
  hash_anterior       bytea,
  hash                bytea not null
);
create index on auditoria.registros (tabla, registro_id);
create index on auditoria.registros (usuario_id, ocurrido_en desc);
create index on auditoria.registros (ocurrido_en desc);

create or replace function auditoria.texto_hash(r auditoria.registros) returns bytea
language sql stable as $$
  select convert_to(concat_ws('|',
    to_char(r.ocurrido_en at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    r.usuario_id, r.usuario_sesion_id, r.accion, r.tabla, r.registro_id,
    r.valores_anteriores::text, r.valores_nuevos::text, r.firma_id, host(r.ip), r.dispositivo_id), 'UTF8')
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
  r.user_agent         := left(app.encabezado('user-agent'), 300);
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

-- Devuelve el id del primer registro alterado, o null si la cadena está íntegra
create or replace function auditoria.verificar_cadena() returns bigint
language plpgsql stable security definer set search_path = '' as $$
declare
  r auditoria.registros;
  v_prev bytea;
begin
  for r in select * from auditoria.registros order by id loop
    if r.hash_anterior is distinct from v_prev
       or r.hash <> extensions.digest(coalesce(v_prev, '\x'::bytea) || auditoria.texto_hash(r), 'sha256') then
      return r.id;
    end if;
    v_prev := r.hash;
  end loop;
  return null;
end $$;

create or replace function auditoria.bloquear_cambios() returns trigger
language plpgsql as $$
begin
  raise exception 'La bitácora de auditoría es de solo inserción' using errcode = '42501';
end $$;

create trigger auditoria_inmutable before update or delete on auditoria.registros
  for each row execute function auditoria.bloquear_cambios();
create trigger auditoria_sin_truncate before truncate on auditoria.registros
  for each statement execute function auditoria.bloquear_cambios();

-- Trigger genérico: AFTER INSERT/UPDATE/DELETE en cada tabla de negocio.
-- TG_ARGV[0] = columna que identifica el registro (por defecto 'id').
create or replace function auditoria.registrar_cambio() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old    jsonb;
  v_new    jsonb;
  v_campos text[];
  v_firma  uuid;
  v_firmante uuid;
  v_accion text := TG_OP;
begin
  if TG_OP in ('UPDATE','DELETE') then v_old := to_jsonb(OLD); end if;
  if TG_OP in ('INSERT','UPDATE') then v_new := to_jsonb(NEW); end if;

  if TG_OP = 'UPDATE' then
    select array_agg(k order by k) into v_campos
    from jsonb_object_keys(v_new) k where v_new -> k is distinct from v_old -> k;
    if v_campos is null then return null; end if;           -- sin cambios reales
    if coalesce((v_new ->> 'anulado')::boolean, false)
       and not coalesce((v_old ->> 'anulado')::boolean, false) then
      v_accion := 'ANULAR';
    end if;
  end if;

  -- la firma consumida en esta transacción identifica a quien firmó
  select f.id, f.usuario_id into v_firma, v_firmante
  from public.firmas f where f.usada_txid = txid_current()
  order by (f.entidad = TG_TABLE_NAME
            and f.entidad_id::text = coalesce(v_new, v_old) ->> coalesce(TG_ARGV[0], 'id')) desc,
           f.usada_en desc
  limit 1;

  perform auditoria.anotar(
    v_accion, TG_TABLE_NAME,
    coalesce(v_new, v_old) ->> coalesce(TG_ARGV[0], 'id'),
    v_old, v_new,
    coalesce(v_firma, (coalesce(v_new, v_old) ->> 'firma_id')::uuid),
    v_campos, v_firmante);
  return null;
end $$;

-- -----------------------------------------------------------------------------
-- 6. INVENTARIO
-- -----------------------------------------------------------------------------
create table public.categorias (
  id        uuid primary key default gen_random_uuid(),
  nombre    text not null unique,
  padre_id  uuid references public.categorias(id),
  orden     int not null default 0,
  anulado   boolean not null default false,
  firma_id  uuid references public.firmas(id)
);

create table public.unidades (
  codigo        text primary key,                       -- g, kg, ml, L, u, caja12…
  nombre        text not null,
  magnitud      text not null check (magnitud in ('masa','volumen','unidad')),
  factor_a_base numeric(14,6) not null check (factor_a_base > 0)   -- base: g, ml, u
);

create table public.proveedores (
  id              uuid primary key default gen_random_uuid(),
  rif             text unique,
  razon_social    text not null,
  contacto        text,
  telefono        text,
  correo          text,
  dias_entrega    smallint not null default 1,          -- tiempo de entrega para el punto de reorden
  condiciones_pago text,
  permiso_sanitario_vence date,
  activo          boolean not null default true,
  anulado         boolean not null default false,
  firma_id        uuid references public.firmas(id)
);

create table public.ubicaciones (
  id           uuid primary key default gen_random_uuid(),
  sucursal_id  uuid not null references public.sucursales(id),
  nombre       text not null,
  tipo         text not null check (tipo in ('cava_refrigeracion','cava_congelacion','almacen_seco',
                                             'linea','produccion','barra','quimicos')),
  activa       boolean not null default true,
  anulado      boolean not null default false,
  firma_id     uuid references public.firmas(id),
  unique (sucursal_id, nombre)
);

create table public.productos (
  id                     uuid primary key default gen_random_uuid(),
  sku                    text unique,
  nombre                 text not null,
  categoria_id           uuid references public.categorias(id),
  unidad_base            text not null references public.unidades(codigo),
  unidad_compra          text references public.unidades(codigo),
  factor_compra          numeric(14,4) not null default 1,   -- unidades base por unidad de compra
  conservacion           public.conservacion not null default 'ambiente',
  vida_util_dias         int,
  controla_vencimiento   boolean not null default true,
  stock_minimo           numeric(14,3) not null default 0,   -- unidad base
  stock_maximo           numeric(14,3),
  dias_seguridad         smallint not null default 2,
  es_clave               boolean not null default false,     -- entra en el conteo diario (POE 06)
  proveedor_principal_id uuid references public.proveedores(id),
  activo                 boolean not null default true,
  anulado                boolean not null default false,
  creado_en              timestamptz not null default now(),
  firma_id               uuid references public.firmas(id)
);

-- SOLO GERENTE: costo estándar por unidad base
create table public.costos_producto (
  producto_id     uuid primary key references public.productos(id) on delete cascade,
  costo_estandar  numeric(14,4) not null check (costo_estandar >= 0),
  moneda          char(3) not null default 'USD',
  actualizado_en  timestamptz not null default now(),
  firma_id        uuid references public.firmas(id)
);

create table public.lotes (
  id                   uuid primary key default gen_random_uuid(),
  producto_id          uuid not null references public.productos(id),
  sucursal_id          uuid not null references public.sucursales(id),
  ubicacion_id         uuid not null references public.ubicaciones(id),
  codigo_lote          text,
  fecha_ingreso        timestamptz not null default now(),
  fecha_vencimiento    date,
  cantidad_inicial     numeric(14,3) not null check (cantidad_inicial > 0),
  cantidad_disponible  numeric(14,3) not null check (cantidad_disponible >= 0),
  bloqueado            boolean not null default false,       -- vencido o en cuarentena
  lote_origen_id       uuid references public.lotes(id),     -- si nació de una transferencia
  recepcion_linea_id   uuid,
  creado_en            timestamptz not null default now()
);
create index on public.lotes (producto_id, sucursal_id, fecha_vencimiento, fecha_ingreso)
  where cantidad_disponible > 0;

-- SOLO GERENTE: costo real de cada lote (valoración PEPS)
create table public.costos_lote (
  lote_id         uuid primary key references public.lotes(id) on delete cascade,
  costo_unitario  numeric(14,4) not null check (costo_unitario >= 0),
  moneda          char(3) not null default 'USD'
);

-- SOLO GERENTE: compras con precios
create table public.ordenes_compra (
  id                     uuid primary key default gen_random_uuid(),
  numero                 bigint generated always as identity unique,
  sucursal_id            uuid not null references public.sucursales(id),
  proveedor_id           uuid not null references public.proveedores(id),
  fecha                  date not null default current_date,
  fecha_entrega          date,
  forma_pago             text,
  estado                 text not null default 'borrador'
                         check (estado in ('borrador','enviada','recibida_parcial','recibida','cancelada')),
  creado_por             uuid references public.usuarios(id),
  anulado                boolean not null default false,
  firma_id               uuid references public.firmas(id)
);

create table public.orden_compra_lineas (
  id               uuid primary key default gen_random_uuid(),
  orden_id         uuid not null references public.ordenes_compra(id) on delete cascade,
  producto_id      uuid not null references public.productos(id),
  cantidad         numeric(14,3) not null check (cantidad > 0),   -- en unidad de compra
  precio_unitario  numeric(14,4) not null check (precio_unitario >= 0),   -- por unidad de compra
  anulado          boolean not null default false,
  firma_id         uuid references public.firmas(id)
);

-- Recepción "a ciegas": quien recibe cuenta y pesa sin ver lo pedido ni los precios
create table public.recepciones (
  id                    uuid primary key,
  sucursal_id           uuid not null references public.sucursales(id),
  orden_id              uuid references public.ordenes_compra(id),
  proveedor_id          uuid not null references public.proveedores(id),
  numero_factura        text,
  recibida_en           timestamptz not null default now(),
  temperatura_vehiculo  numeric(5,1),
  estado                text not null default 'en_proceso'
                        check (estado in ('en_proceso','aceptada','aceptada_con_diferencias','rechazada')),
  recibido_por          uuid not null references public.usuarios(id),
  ejecucion_id          uuid,                           -- checklist 13 asociado
  anulado               boolean not null default false,
  firma_id              uuid references public.firmas(id)
);

create table public.recepcion_lineas (
  id                   uuid primary key default gen_random_uuid(),
  recepcion_id         uuid not null references public.recepciones(id) on delete cascade,
  producto_id          uuid not null references public.productos(id),
  ubicacion_id         uuid not null references public.ubicaciones(id),
  cantidad_recibida    numeric(14,3) not null check (cantidad_recibida >= 0),   -- unidad base, aceptada
  cantidad_rechazada   numeric(14,3) not null default 0 check (cantidad_rechazada >= 0),
  motivo_rechazo       text,
  temperatura_llegada  numeric(5,1),
  fecha_vencimiento    date,
  codigo_lote          text,
  evidencia_id         uuid,
  firma_id             uuid references public.firmas(id)
);

create table public.movimientos (
  id                    uuid primary key,                 -- generado en el cliente
  sucursal_id           uuid not null references public.sucursales(id),
  producto_id           uuid not null references public.productos(id),
  tipo                  public.tipo_movimiento not null,
  cantidad              numeric(14,3) not null check (cantidad > 0),   -- unidad base; el tipo da el signo
  ubicacion_origen_id   uuid references public.ubicaciones(id),
  ubicacion_destino_id  uuid references public.ubicaciones(id),
  lote_id               uuid references public.lotes(id),  -- opcional; si falta, se aplica PEPS
  motivo_merma          public.motivo_merma,
  detalle               text,
  referencia_tipo       text,                             -- recepcion · transferencia · conteo · ejecucion
  referencia_id         uuid,
  evidencia_id          uuid,
  estado                public.estado_movimiento not null default 'aplicado',
  requiere_aprobacion   boolean not null default false,
  aprobado_por          uuid references public.usuarios(id),
  aprobado_en           timestamptz,
  nota_aprobacion       text,
  firma_aprobacion_id   uuid references public.firmas(id),
  creado_por            uuid references public.usuarios(id),
  creado_en             timestamptz not null default now(),
  registrado_sin_conexion boolean not null default false,
  dispositivo_id        uuid references public.dispositivos(id),
  anulado               boolean not null default false,
  motivo_anulacion      text,
  firma_id              uuid references public.firmas(id),
  constraint merma_con_motivo check (tipo <> 'merma' or motivo_merma is not null),
  constraint otro_con_detalle check (motivo_merma is distinct from 'otro' or length(coalesce(detalle,'')) >= 5)
);
create index on public.movimientos (sucursal_id, creado_en desc);
create index on public.movimientos (producto_id, tipo, creado_en desc);
create index on public.movimientos (estado) where estado = 'pendiente_aprobacion';

-- De qué lotes salió (o a qué lote entró) cada movimiento: base de la valoración PEPS
create table public.movimiento_lotes (
  movimiento_id  uuid not null references public.movimientos(id) on delete cascade,
  lote_id        uuid not null references public.lotes(id),
  cantidad       numeric(14,3) not null check (cantidad > 0),
  primary key (movimiento_id, lote_id)
);

create table public.transferencias (
  id            uuid primary key,
  sucursal_id   uuid not null references public.sucursales(id),
  origen_id     uuid not null references public.ubicaciones(id),
  destino_id    uuid not null references public.ubicaciones(id),
  enviado_por   uuid not null references public.usuarios(id),
  creada_en     timestamptz not null default now(),
  nota          text,
  anulado       boolean not null default false,
  firma_id      uuid references public.firmas(id),
  check (origen_id <> destino_id)
);

create table public.transferencia_lineas (
  id                uuid primary key default gen_random_uuid(),
  transferencia_id  uuid not null references public.transferencias(id) on delete cascade,
  producto_id       uuid not null references public.productos(id),
  cantidad          numeric(14,3) not null check (cantidad > 0),
  firma_id          uuid references public.firmas(id)
);

-- Conteo físico a ciegas: se registra lo contado; el sistema calcula la diferencia al aprobar
create table public.conteos (
  id                   uuid primary key,
  sucursal_id          uuid not null references public.sucursales(id),
  tipo                 text not null check (tipo in ('diario_clave','semanal','mensual_valorizado')),
  estado               text not null default 'abierto' check (estado in ('abierto','aprobado','anulado')),
  abierto_por          uuid references public.usuarios(id),
  abierto_en           timestamptz not null default now(),
  aprobado_por         uuid references public.usuarios(id),
  aprobado_en          timestamptz,
  firma_aprobacion_id  uuid references public.firmas(id),
  anulado              boolean not null default false,
  firma_id             uuid references public.firmas(id)
);

create table public.conteo_lineas (
  id                uuid primary key default gen_random_uuid(),
  conteo_id         uuid not null references public.conteos(id) on delete cascade,
  producto_id       uuid not null references public.productos(id),
  ubicacion_id      uuid not null references public.ubicaciones(id),
  cantidad_contada  numeric(14,3) not null check (cantidad_contada >= 0),   -- unidad base
  contado_por       uuid references public.usuarios(id),
  contado_en        timestamptz not null default now(),
  firma_id          uuid references public.firmas(id)
);

-- -----------------------------------------------------------------------------
-- 7. RECETAS (FICHAS TÉCNICAS) Y CONSUMO TEÓRICO
-- -----------------------------------------------------------------------------
create table public.recetas (
  id                  uuid primary key default gen_random_uuid(),
  codigo              text unique,
  nombre              text not null,
  tipo                text not null check (tipo in ('plato','subreceta')),
  rendimiento         numeric(14,3) not null default 1 check (rendimiento > 0),
  unidad_rendimiento  text not null default 'u' references public.unidades(codigo),
  producto_id         uuid references public.productos(id),   -- subreceta inventariada (salsa de la casa)
  codigo_pos          text unique,                             -- para cruzar con las ventas del POS
  activo              boolean not null default true,
  anulado             boolean not null default false,
  firma_id            uuid references public.firmas(id)
);

create table public.receta_insumos (
  id            uuid primary key default gen_random_uuid(),
  receta_id     uuid not null references public.recetas(id) on delete cascade,
  producto_id   uuid references public.productos(id),
  subreceta_id  uuid references public.recetas(id),
  cantidad      numeric(14,4) not null check (cantidad > 0),   -- neta, en unidad base, por rendimiento
  merma_pct     numeric(5,2) not null default 0 check (merma_pct >= 0 and merma_pct < 100),
  firma_id      uuid references public.firmas(id),
  check (num_nonnulls(producto_id, subreceta_id) = 1)
);

-- SOLO GERENTE
create table public.precios_venta (
  receta_id      uuid not null references public.recetas(id) on delete cascade,
  vigente_desde  date not null,
  precio         numeric(14,2) not null check (precio >= 0),
  moneda         char(3) not null default 'USD',
  firma_id       uuid references public.firmas(id),
  primary key (receta_id, vigente_desde)
);

-- Importadas del POS por una Edge Function (service_role)
create table public.ventas_diarias (
  sucursal_id  uuid not null references public.sucursales(id),
  fecha        date not null,
  receta_id    uuid not null references public.recetas(id),
  cantidad     numeric(14,3) not null check (cantidad >= 0),
  importado_en timestamptz not null default now(),
  primary key (sucursal_id, fecha, receta_id)
);

-- -----------------------------------------------------------------------------
-- 8. CHECKLISTS, EVIDENCIAS E INCIDENCIAS
-- -----------------------------------------------------------------------------
create table public.plantillas (
  id                 uuid primary key default gen_random_uuid(),
  codigo             text not null,                 -- 01, 14A…
  version            int not null default 1,
  nombre             text not null,
  documento_origen   text,                          -- PDF del POE
  tipo               public.tipo_plantilla not null,
  area               public.area_operativa not null,
  frecuencia         public.frecuencia not null,
  horarios           text[] not null default '{}',  -- {"11:00"} · {"Apertura","16:00","20:00","Cierre"}
  rol_asignado       text not null references public.roles(codigo),
  rol_revisor        text not null references public.roles(codigo),
  minutos_estimados  int,
  objetivo           text,
  bloquea_operacion  boolean not null default false,   -- un crítico "No cumple" detiene la operación
  vigente            boolean not null default true,
  creado_en          timestamptz not null default now(),
  anulado            boolean not null default false,
  firma_id           uuid references public.firmas(id),
  unique (codigo, version)
);
create unique index plantillas_una_vigente on public.plantillas (codigo) where vigente;

create table public.plantilla_secciones (
  id            uuid primary key default gen_random_uuid(),
  plantilla_id  uuid not null references public.plantillas(id) on delete cascade,
  orden         int not null,
  titulo        text not null,
  hora          text,
  firma_id      uuid references public.firmas(id),
  unique (plantilla_id, orden)
);

create table public.plantilla_items (
  id                uuid primary key default gen_random_uuid(),
  plantilla_id      uuid not null references public.plantillas(id) on delete cascade,
  seccion_id        uuid not null references public.plantilla_secciones(id) on delete cascade,
  orden             int not null,
  ref               text not null,                -- 14A-1.3
  texto             text not null check (length(texto) <= 180),
  tipo              public.tipo_campo not null,
  critico           boolean not null default false,
  unidad            text,
  valor_min         numeric,
  valor_max         numeric,
  opciones          jsonb,
  foto_si_falla     boolean not null default false,
  admite_no_aplica  boolean not null default true,
  ayuda             text,
  firma_id          uuid references public.firmas(id),
  unique (plantilla_id, ref),
  check (tipo <> 'number' or unidad is not null),
  check (tipo <> 'choice' or jsonb_array_length(opciones) >= 2),
  check (not critico or tipo not in ('pass_fail','number') or foto_si_falla)
);

-- Qué se espera cada día; la genera pg_cron y permite medir el % de cumplimiento
create table public.checklist_programacion (
  id            uuid primary key default gen_random_uuid(),
  sucursal_id   uuid not null references public.sucursales(id),
  plantilla_id  uuid not null references public.plantillas(id),
  fecha         date not null,
  horario       text not null default '',
  vence_en      timestamptz not null,
  ejecucion_id  uuid,
  alertada      boolean not null default false,
  unique (sucursal_id, plantilla_id, fecha, horario)
);

create table public.checklist_ejecuciones (
  id                       uuid primary key,          -- generado en el cliente
  sucursal_id              uuid not null references public.sucursales(id),
  plantilla_id             uuid not null references public.plantillas(id),
  horario                  text not null default '',
  iniciada_en              timestamptz,
  completada_en            timestamptz not null default now(),
  realizada_por            uuid not null references public.usuarios(id),
  estado                   public.estado_ejecucion not null default 'completada',
  total_items              int,
  items_cumple             int,
  items_no_cumple          int,
  criticos_no_cumple       int,
  puntaje                  numeric(5,2),             -- % de ítems evaluables que cumplen
  revisada_por             uuid references public.usuarios(id),
  revisada_en              timestamptz,
  nota_revision            text,
  registrada_sin_conexion  boolean not null default false,
  dispositivo_id           uuid references public.dispositivos(id),
  anulado                  boolean not null default false,
  firma_id                 uuid references public.firmas(id)
);
create index on public.checklist_ejecuciones (sucursal_id, completada_en desc);
create index on public.checklist_ejecuciones (realizada_por, completada_en desc);

create table public.evidencias (
  id              uuid primary key,
  sucursal_id     uuid not null references public.sucursales(id),
  ruta_storage    text not null unique,          -- evidencias/<sucursal>/<aaaa>/<mm>/<id>.webp
  sha256          text not null,                 -- detecta fotos reutilizadas
  mime            text not null default 'image/webp',
  bytes           int,
  tomada_en       timestamptz not null,          -- hora de la cámara, impresa en la marca de agua
  subida_por      uuid references public.usuarios(id),
  dispositivo_id  uuid references public.dispositivos(id),
  creado_en       timestamptz not null default now()
);

create table public.checklist_respuestas (
  id            uuid primary key default gen_random_uuid(),
  ejecucion_id  uuid not null references public.checklist_ejecuciones(id) on delete cascade,
  item_id       uuid not null references public.plantilla_items(id),
  valor_bool    boolean,
  valor_num     numeric,
  valor_texto   text,
  valor_opcion  text,
  valor_hora    time,
  no_aplica     boolean not null default false,
  cumple        boolean,                         -- lo calcula el trigger según tipo y límites
  observacion   text,
  evidencia_id  uuid references public.evidencias(id),
  firma_id      uuid references public.firmas(id),
  unique (ejecucion_id, item_id)
);

create table public.incidencias (
  id                   uuid primary key default gen_random_uuid(),
  sucursal_id          uuid not null references public.sucursales(id),
  origen               text not null default 'manual'
                       check (origen in ('checklist','temperatura','recepcion','inventario','manual')),
  ejecucion_id         uuid references public.checklist_ejecuciones(id),
  respuesta_id         uuid references public.checklist_respuestas(id),
  plantilla_id         uuid references public.plantillas(id),
  item_id              uuid references public.plantilla_items(id),
  titulo               text not null,
  descripcion          text,
  severidad            public.severidad not null default 'media',
  estado               public.estado_incidencia not null default 'abierta',
  bloquea_operacion    boolean not null default false,
  reportada_por        uuid references public.usuarios(id),
  reportada_en         timestamptz not null default now(),
  asignada_a           uuid references public.usuarios(id),
  vence_en             timestamptz,                -- SLA según severidad
  accion_correctiva    text,
  causa_raiz           text,
  resuelta_por         uuid references public.usuarios(id),
  resuelta_en          timestamptz,
  verificada_por       uuid references public.usuarios(id),
  verificada_en        timestamptz,
  escalada             boolean not null default false,
  evidencia_id         uuid references public.evidencias(id),
  anulado              boolean not null default false,
  firma_id             uuid references public.firmas(id)
);
create index on public.incidencias (sucursal_id, estado, severidad);

-- -----------------------------------------------------------------------------
-- 9. ALERTAS Y NOTIFICACIONES
-- -----------------------------------------------------------------------------
create table public.alertas (
  id               uuid primary key default gen_random_uuid(),
  sucursal_id      uuid not null references public.sucursales(id),
  tipo             public.tipo_alerta not null,
  severidad        public.severidad not null default 'media',
  titulo           text not null,
  detalle          text,
  rol_destino      text references public.roles(codigo),   -- lo ve ese rol y los superiores
  usuario_destino  uuid references public.usuarios(id),
  producto_id      uuid references public.productos(id),
  lote_id          uuid references public.lotes(id),
  incidencia_id    uuid references public.incidencias(id),
  movimiento_id    uuid references public.movimientos(id),
  estado           public.estado_alerta not null default 'abierta',
  creada_en        timestamptz not null default now(),
  vista_por        uuid references public.usuarios(id),
  vista_en         timestamptz,
  resuelta_por     uuid references public.usuarios(id),
  resuelta_en      timestamptz,
  clave_unica      text unique                             -- evita alertas duplicadas
);
create index on public.alertas (sucursal_id, estado, creada_en desc);

-- Un INSERT en alertas dispara (Database Webhook) la Edge Function "notificar",
-- que envía Web Push a estas suscripciones y WhatsApp si la severidad es crítica.
create table public.suscripciones_push (
  id              uuid primary key default gen_random_uuid(),
  usuario_id      uuid not null references public.usuarios(id) on delete cascade,
  dispositivo_id  uuid references public.dispositivos(id),
  endpoint        text not null unique,
  p256dh          text not null,
  auth            text not null,
  creada_en       timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- 10. FIRMA CON PIN
-- -----------------------------------------------------------------------------
create or replace function privado.pin_pepper() returns bytea
language plpgsql stable security definer set search_path = '' as $$
declare v text;
begin
  -- En Supabase el pepper vive en Vault: select vault.create_secret('<64 hex>', 'pin_pepper');
  select decrypted_secret into v from vault.decrypted_secrets where name = 'pin_pepper';
  if v is null then raise exception 'Falta el secreto pin_pepper en Vault'; end if;
  return convert_to(v, 'UTF8');
end $$;

create or replace function privado.indice_pin(p_pin text) returns bytea
language sql stable security definer set search_path = '' as $$
  select extensions.hmac(convert_to(p_pin, 'UTF8'), privado.pin_pepper(), 'sha256')
$$;

create or replace function privado.pin_trivial(p_pin text) returns boolean
language sql immutable as $$
  select p_pin ~ '^(\d)\1+$'                              -- 1111, 000000
      or position(p_pin in '01234567890123') > 0          -- 1234, 456789
      or position(p_pin in '98765432109876') > 0          -- 4321
      or p_pin ~ '^(\d\d)\1+$'                            -- 1212, 909090
      or p_pin ~ '^(\d\d\d)\1$'                           -- 123123
$$;

create or replace function privado.pin_aleatorio(p_longitud int) returns text
language plpgsql volatile set search_path = '' as $$
declare v text := ''; b int;
begin
  while length(v) < p_longitud loop
    b := get_byte(extensions.gen_random_bytes(1), 0);
    if b < 250 then v := v || (b % 10)::text; end if;   -- sin sesgo de módulo
  end loop;
  return v;
end $$;

-- Genera un PIN único, no trivial; lo devuelve en claro una sola vez
create or replace function privado.nuevo_pin(p_usuario uuid, p_longitud int) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare v_pin text;
begin
  for i in 1..200 loop
    v_pin := privado.pin_aleatorio(p_longitud);
    continue when privado.pin_trivial(v_pin);
    if not exists (select 1 from privado.credenciales_pin c
                   where c.pin_indice = privado.indice_pin(v_pin) and c.usuario_id <> p_usuario) then
      insert into privado.credenciales_pin as c (usuario_id, pin_hash, pin_indice, longitud)
      values (p_usuario, extensions.crypt(v_pin, extensions.gen_salt('bf', 10)), privado.indice_pin(v_pin), p_longitud)
      on conflict (usuario_id) do update
        set pin_hash = excluded.pin_hash, pin_indice = excluded.pin_indice, longitud = excluded.longitud,
            intentos_fallidos = 0, bloqueado_hasta = null, actualizado_en = now();
      return v_pin;
    end if;
  end loop;
  raise exception 'No se pudo generar un PIN único';
end $$;

-- Registra un intento fallido sin identificar a nadie y bloquea el dispositivo si abusan
create or replace function privado.fallo_en_dispositivo(p_dispositivo uuid, p_contexto text) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_fallos int;
  v_max int := coalesce((app.parametro('dispositivo.max_fallos_5min'))::int, 10);
  v_suc uuid;
begin
  insert into privado.intentos_pin (dispositivo_id, contexto, exito, ip)
  values (p_dispositivo, p_contexto, false, app.ip_cliente());
  select count(*) into v_fallos from privado.intentos_pin
  where dispositivo_id = p_dispositivo and not exito and ocurrido_en > now() - interval '5 minutes';
  if v_fallos >= v_max then
    update public.dispositivos set bloqueado_hasta = now() + interval '5 minutes'
    where id = p_dispositivo returning sucursal_id into v_suc;
    if v_suc is not null then
      insert into public.alertas (sucursal_id, tipo, severidad, titulo, detalle, rol_destino, clave_unica)
      values (v_suc, 'dispositivo_bloqueado', 'alta', 'Dispositivo bloqueado por intentos de PIN',
              format('%s intentos fallidos en 5 minutos', v_fallos), 'supervisor',
              'disp:' || p_dispositivo || ':' || to_char(now(), 'YYYYMMDDHH24MI'))
      on conflict (clave_unica) do nothing;
    end if;
    return true;
  end if;
  return false;
end $$;

-- Identifica a una persona solo por su PIN único (Quick Switch y autorizaciones)
create or replace function privado.identificar_pin(p_pin text, p_dispositivo uuid, p_contexto text)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare
  c privado.credenciales_pin;
  u public.usuarios;
  d public.dispositivos;
begin
  select * into d from public.dispositivos where id = p_dispositivo;
  if d.id is null or not d.activo or d.bloqueado_hasta > now() then return null; end if;
  if p_pin !~ '^[0-9]{4,6}$' then
    perform privado.fallo_en_dispositivo(p_dispositivo, p_contexto);
    return null;
  end if;
  select * into c from privado.credenciales_pin where pin_indice = privado.indice_pin(p_pin);
  if c.usuario_id is not null then
    select * into u from public.usuarios where id = c.usuario_id;
  end if;
  if c.usuario_id is null or u.id is null or not u.activo
     or extensions.crypt(p_pin, c.pin_hash) <> c.pin_hash
     or (u.sucursal_id <> d.sucursal_id and u.rol <> 'admin')
     or c.bloqueado_hasta > now() then
    perform privado.fallo_en_dispositivo(p_dispositivo, p_contexto);
    return null;
  end if;
  insert into privado.intentos_pin (dispositivo_id, usuario_id, contexto, exito, ip)
  values (p_dispositivo, u.id, p_contexto, true, app.ip_cliente());
  update public.dispositivos set ultimo_uso = now() where id = p_dispositivo;
  return u.id;
end $$;

-- QUICK SWITCH · solo la Edge Function "pin-sesion" (service_role) la llama.
-- Si devuelve ok, la función emite un JWT corto (sub = auth_id, dispositivo_id)
-- y el dispositivo cambia de persona sin cerrar la app.
create or replace function privado.abrir_sesion_por_pin(
  p_dispositivo uuid, p_secreto text, p_pin text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  d public.dispositivos;
  v_usuario uuid;
  u public.usuarios;
  v_debe_cambiar boolean;
begin
  select * into d from public.dispositivos where id = p_dispositivo;
  if d.id is null or not d.activo or not exists (
       select 1 from privado.dispositivo_secretos s
       where s.dispositivo_id = d.id and s.secreto_hash = extensions.digest(p_secreto, 'sha256')) then
    return jsonb_build_object('ok', false, 'motivo', 'dispositivo_no_registrado');
  end if;
  if d.bloqueado_hasta > now() then
    return jsonb_build_object('ok', false, 'motivo', 'dispositivo_bloqueado', 'hasta', d.bloqueado_hasta);
  end if;
  v_usuario := privado.identificar_pin(p_pin, d.id, 'sesion');
  if v_usuario is null then
    return jsonb_build_object('ok', false, 'motivo', 'pin_incorrecto');
  end if;
  select * into u from public.usuarios where id = v_usuario;
  select debe_cambiar into v_debe_cambiar from privado.credenciales_pin where usuario_id = v_usuario;
  perform auditoria.anotar('SESION_PIN', 'dispositivos', d.id::text, null,
                           jsonb_build_object('dispositivo', d.nombre), null, null, v_usuario);
  return jsonb_build_object('ok', true, 'usuario_id', u.id, 'auth_id', u.auth_id, 'rol', u.rol,
                            'sucursal_id', u.sucursal_id, 'nombre', u.nombre || ' ' || u.apellido,
                            'debe_cambiar_pin', v_debe_cambiar);
end $$;

create or replace function app.es_entidad_firmable(p_entidad text) returns boolean
language sql immutable as $$
  select p_entidad in ('usuarios','parametros','dispositivos','categorias','proveedores','ubicaciones',
    'productos','costos_producto','ordenes_compra','recepciones','movimientos','transferencias',
    'conteos','recetas','precios_venta','plantillas','checklist_ejecuciones','incidencias')
$$;

-- FIRMAR · el modal "Confirmación de cambios con PIN" llama esta función.
-- Verifica el PIN de la persona con sesión abierta y devuelve una firma de un solo
-- uso, válida 120 s, atada a una acción y a un registro concretos.
-- Nunca lanza error por PIN incorrecto: devuelve ok=false para que el intento fallido
-- quede guardado (un error desharía el registro del intento).
create or replace function public.firmar(
  p_pin text, p_accion public.accion_firma, p_entidad text, p_entidad_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_usuario  uuid := app.usuario_actual();
  v_disp     uuid := app.dispositivo_actual();
  c          privado.credenciales_pin;
  v_max      int := coalesce((app.parametro('pin.max_intentos'))::int, 5);
  v_bloqueo  int := coalesce((app.parametro('pin.minutos_bloqueo'))::int, 15);
  v_vigencia int := coalesce((app.parametro('firma.segundos_vigencia'))::int, 120);
  v_suc      uuid;
  v_firma    public.firmas;
begin
  if v_usuario is null then
    return jsonb_build_object('ok', false, 'motivo', 'sin_sesion');
  end if;
  if not app.es_entidad_firmable(p_entidad) or p_entidad_id is null then
    return jsonb_build_object('ok', false, 'motivo', 'entidad_no_firmable');
  end if;
  if not exists (select 1 from public.dispositivos d
                 where d.id = v_disp and d.activo and coalesce(d.bloqueado_hasta, '-infinity') < now()) then
    return jsonb_build_object('ok', false, 'motivo', 'dispositivo_no_registrado');
  end if;

  select * into c from privado.credenciales_pin where usuario_id = v_usuario for update;
  if c.usuario_id is null then
    return jsonb_build_object('ok', false, 'motivo', 'sin_pin');
  end if;
  if c.bloqueado_hasta > now() then
    return jsonb_build_object('ok', false, 'motivo', 'bloqueado', 'bloqueado_hasta', c.bloqueado_hasta);
  end if;

  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' or extensions.crypt(p_pin, c.pin_hash) <> c.pin_hash then
    insert into privado.intentos_pin (dispositivo_id, usuario_id, contexto, exito, ip)
    values (v_disp, v_usuario, 'firma', false, app.ip_cliente());
    if c.intentos_fallidos + 1 >= v_max then
      update privado.credenciales_pin
        set intentos_fallidos = 0, bloqueado_hasta = now() + make_interval(mins => v_bloqueo)
      where usuario_id = v_usuario;
      select sucursal_id into v_suc from public.usuarios where id = v_usuario;
      insert into public.alertas (sucursal_id, tipo, severidad, titulo, detalle, rol_destino, usuario_destino, clave_unica)
      values (v_suc, 'pin_bloqueado', 'alta', 'PIN bloqueado por intentos fallidos',
              format('%s intentos seguidos al firmar %s', v_max, p_entidad), 'supervisor', null,
              'pin:' || v_usuario || ':' || to_char(now(), 'YYYYMMDDHH24MI'))
      on conflict (clave_unica) do nothing;
      perform auditoria.anotar('PIN_BLOQUEADO', p_entidad, p_entidad_id::text, null, null);
      return jsonb_build_object('ok', false, 'motivo', 'bloqueado',
                                'bloqueado_hasta', now() + make_interval(mins => v_bloqueo));
    end if;
    update privado.credenciales_pin set intentos_fallidos = intentos_fallidos + 1 where usuario_id = v_usuario;
    perform auditoria.anotar('PIN_FALLIDO', p_entidad, p_entidad_id::text, null, null);
    return jsonb_build_object('ok', false, 'motivo', 'pin_incorrecto',
                              'intentos_restantes', v_max - c.intentos_fallidos - 1);
  end if;

  update privado.credenciales_pin set intentos_fallidos = 0 where usuario_id = v_usuario;
  insert into privado.intentos_pin (dispositivo_id, usuario_id, contexto, exito, ip)
  values (v_disp, v_usuario, 'firma', true, app.ip_cliente());
  insert into public.firmas (usuario_id, accion, entidad, entidad_id, metodo, dispositivo_id, ip, expira_en)
  values (v_usuario, p_accion, p_entidad, p_entidad_id, 'pin_en_linea', v_disp, app.ip_cliente(),
          now() + make_interval(secs => v_vigencia))
  returning * into v_firma;
  return jsonb_build_object('ok', true, 'firma_id', v_firma.id, 'expira_en', v_firma.expira_en);
end $$;

-- Valida y consume una firma (dentro de RPCs y del trigger exigir_firma)
create or replace function app.consumir_firma(
  p_firma uuid, p_entidad text, p_entidad_id uuid, p_acciones public.accion_firma[])
returns public.firmas language plpgsql volatile security definer set search_path = '' as $$
declare f public.firmas;
begin
  select * into f from public.firmas where id = p_firma for update;
  if f.id is null then
    raise exception 'Se requiere firma con PIN' using errcode = '42501',
      hint = 'Llame a firmar() y envíe firma_id con el cambio';
  end if;
  if f.usuario_id is distinct from app.usuario_actual() then
    raise exception 'La firma pertenece a otra persona' using errcode = '42501';
  end if;
  if f.entidad <> p_entidad or f.entidad_id <> p_entidad_id then
    raise exception 'La firma no corresponde a este registro' using errcode = '42501';
  end if;
  if not (f.accion = any (p_acciones)) then
    raise exception 'La firma es para "%", no para esta acción', f.accion using errcode = '42501';
  end if;
  if f.usada_en is not null and f.usada_txid <> txid_current() then
    raise exception 'La firma ya fue utilizada' using errcode = '42501';
  end if;
  if f.usada_en is null and f.expira_en < now() then
    raise exception 'La firma venció; confirme de nuevo con su PIN' using errcode = '42501';
  end if;
  update public.firmas set usada_en = coalesce(usada_en, clock_timestamp()), usada_txid = txid_current()
  where id = f.id returning * into f;
  return f;
end $$;

-- TRIGGER BEFORE INSERT/UPDATE/DELETE en cada tabla firmable.
-- TG_ARGV[0] = columna con el id firmado · TG_ARGV[1] = entidad (si es una tabla hija)
-- TG_ARGV[2] = columnas que mantiene el sistema (la API no tiene permiso sobre ellas)
create or replace function app.exigir_firma() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_col      text := coalesce(TG_ARGV[0], 'id');
  v_entidad  text := coalesce(TG_ARGV[1], TG_TABLE_NAME);
  v_es_hija  boolean := coalesce(TG_ARGV[1], TG_TABLE_NAME) <> TG_TABLE_NAME;
  v_sistema  text[] := string_to_array(TG_ARGV[2], ',');
  v_id       uuid;
  v_acciones public.accion_firma[];
  v_firma    uuid;
begin
  if TG_OP = 'DELETE' then
    if app.es_proceso_interno() then return OLD; end if;
    raise exception 'No se borran registros: anúlelo con firma' using errcode = '42501';
  end if;
  if app.es_proceso_interno() then return NEW; end if;
  if TG_OP = 'UPDATE' and v_sistema is not null and not exists (
       select 1 from jsonb_each(to_jsonb(NEW)) n
       where n.key <> all (v_sistema) and n.value is distinct from to_jsonb(OLD) -> n.key) then
    return NEW;                       -- solo cambió estado técnico (último uso, bloqueo)
  end if;

  v_id := (to_jsonb(NEW) ->> v_col)::uuid;

  -- 1) Dentro de una RPC que ya validó y consumió una firma en esta transacción
  if app.contexto_confiable() then
    select id into v_firma from public.firmas where usada_txid = txid_current()
    order by usada_en desc limit 1;
    if v_firma is not null then
      if NEW.firma_id is null then NEW.firma_id := v_firma; end if;
      return NEW;
    end if;
  end if;

  -- 2) Varias filas de la misma entidad en una sola petición (p. ej. líneas de un conteo)
  select id into v_firma from public.firmas
  where usada_txid = txid_current() and entidad = v_entidad and entidad_id = v_id
  limit 1;
  if v_firma is not null then
    NEW.firma_id := v_firma;
    return NEW;
  end if;

  -- 3) Caso normal: la fila trae una firma nueva de quien tiene la sesión
  v_acciones := case
    when v_es_hija then array['crear','modificar']::public.accion_firma[]
    when TG_OP = 'INSERT' then array['crear']::public.accion_firma[]
    when coalesce((to_jsonb(NEW) ->> 'anulado')::boolean, false)
         and not coalesce((to_jsonb(OLD) ->> 'anulado')::boolean, false)
      then array['anular']::public.accion_firma[]
    else array['modificar','aprobar','rechazar']::public.accion_firma[] end;
  if TG_OP = 'UPDATE' and NEW.firma_id is not distinct from OLD.firma_id then
    raise exception 'Se requiere una firma nueva para modificar este registro' using errcode = '42501';
  end if;
  perform app.consumir_firma(NEW.firma_id, v_entidad, v_id, v_acciones);
  return NEW;
end $$;

-- Firmas hechas sin conexión: la Edge Function "sincronizar" (service_role) las
-- registra tras validar el HMAC del dispositivo; luego reenvía el cambio con un JWT
-- de esa persona, así que RLS y triggers se aplican igual que en línea.
create or replace function public.registrar_firma_sin_conexion(
  p_usuario uuid, p_dispositivo uuid, p_accion public.accion_firma, p_entidad text,
  p_entidad_id uuid, p_firmada_en timestamptz)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not app.es_proceso_interno() then
    raise exception 'Solo el servicio de sincronización registra firmas sin conexión' using errcode = '42501';
  end if;
  if not app.es_entidad_firmable(p_entidad) then raise exception 'Entidad no firmable'; end if;
  insert into public.firmas (usuario_id, accion, entidad, entidad_id, metodo, dispositivo_id,
                             expira_en, firmada_sin_conexion_en)
  values (p_usuario, p_accion, p_entidad, p_entidad_id, 'pin_sin_conexion', p_dispositivo,
          now() + interval '10 minutes', p_firmada_en)
  returning id into v_id;
  return v_id;
end $$;

-- Gestión de PIN
create or replace function public.asignar_pin(p_usuario uuid, p_longitud int, p_firma uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_rol text; v_pin text;
begin
  if not app.tiene_permiso('usuarios.gestionar') then
    raise exception 'Sin permiso para gestionar usuarios' using errcode = '42501';
  end if;
  select rol into v_rol from public.usuarios where id = p_usuario;
  if v_rol is null then raise exception 'Usuario no existe'; end if;
  if p_longitud not between 4 and 6 then raise exception 'El PIN tiene de 4 a 6 dígitos'; end if;
  if v_rol in ('admin','supervisor') and p_longitud <> 6 then
    raise exception 'Supervisores y gerentes usan PIN de 6 dígitos';
  end if;
  perform app.consumir_firma(p_firma, 'usuarios', p_usuario, array['modificar']::public.accion_firma[]);
  v_pin := privado.nuevo_pin(p_usuario, p_longitud);
  update privado.credenciales_pin set debe_cambiar = true where usuario_id = p_usuario;
  perform auditoria.anotar('PIN_ASIGNADO', 'usuarios', p_usuario::text, null, null, p_firma);
  -- PIN provisional: se muestra una vez en la tablet al empleado, que debe regenerarlo
  -- en su primer uso (regenerar_mi_pin), así ni el gerente conoce el PIN definitivo.
  return jsonb_build_object('ok', true, 'pin_provisional', v_pin);
end $$;

create or replace function public.regenerar_mi_pin(p_pin_actual text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_usuario uuid := app.usuario_actual(); c privado.credenciales_pin; v_pin text;
begin
  select * into c from privado.credenciales_pin where usuario_id = v_usuario for update;
  if c.usuario_id is null or c.bloqueado_hasta > now()
     or extensions.crypt(coalesce(p_pin_actual, ''), c.pin_hash) <> c.pin_hash then
    insert into privado.intentos_pin (dispositivo_id, usuario_id, contexto, exito, ip)
    values (app.dispositivo_actual(), v_usuario, 'cambio_pin', false, app.ip_cliente());
    return jsonb_build_object('ok', false, 'motivo', 'pin_incorrecto');
  end if;
  v_pin := privado.nuevo_pin(v_usuario, c.longitud);
  update privado.credenciales_pin set debe_cambiar = false where usuario_id = v_usuario;
  perform auditoria.anotar('PIN_REGENERADO', 'usuarios', v_usuario::text, null, null);
  return jsonb_build_object('ok', true, 'pin', v_pin);
end $$;

create or replace function public.registrar_dispositivo(
  p_id uuid, p_nombre text, p_tipo text, p_firma uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_secreto text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  if not app.tiene_permiso('dispositivos.gestionar') then
    raise exception 'Sin permiso para registrar dispositivos' using errcode = '42501';
  end if;
  perform app.consumir_firma(p_firma, 'dispositivos', p_id, array['crear']::public.accion_firma[]);
  perform set_config('app.contexto', 'registrar_dispositivo', true);
  insert into public.dispositivos (id, sucursal_id, nombre, tipo, registrado_por, firma_id)
  values (p_id, app.sucursal_actual(), p_nombre, p_tipo, app.usuario_actual(), p_firma);
  insert into privado.dispositivo_secretos values (p_id, extensions.digest(v_secreto, 'sha256'));
  -- el secreto se guarda en el dispositivo y no se vuelve a mostrar
  perform set_config('app.contexto', '', true);
  return jsonb_build_object('ok', true, 'dispositivo_id', p_id, 'secreto', v_secreto);
end $$;

-- -----------------------------------------------------------------------------
-- 11. INVENTARIO: PEPS, MOVIMIENTOS, ALERTAS
-- -----------------------------------------------------------------------------
create or replace function app.es_salida(p_tipo public.tipo_movimiento) returns boolean
language sql immutable as $$
  select p_tipo in ('salida_produccion','consumo_venta','merma','transferencia_salida',
                    'ajuste_negativo','devolucion_proveedor')
$$;

-- Descuenta en orden PEPS: primero lo que vence antes, luego lo que entró antes
create or replace function app.consumir_peps(
  p_movimiento uuid, p_producto uuid, p_sucursal uuid, p_ubicacion uuid, p_lote uuid,
  p_cantidad numeric, p_permitir_faltante boolean, p_incluir_bloqueados boolean)
returns numeric language plpgsql volatile security definer set search_path = '' as $$
declare
  r record;
  v_resta numeric := p_cantidad;
  v_toma numeric;
begin
  for r in
    select l.id, l.cantidad_disponible from public.lotes l
    where l.producto_id = p_producto and l.sucursal_id = p_sucursal
      and l.cantidad_disponible > 0
      and (p_ubicacion is null or l.ubicacion_id = p_ubicacion)
      and (p_lote is null or l.id = p_lote)
      and (not l.bloqueado or p_incluir_bloqueados or p_lote is not null)
    order by l.bloqueado desc, l.fecha_vencimiento nulls last, l.fecha_ingreso, l.id
    for update
  loop
    exit when v_resta <= 0;
    v_toma := least(r.cantidad_disponible, v_resta);
    update public.lotes set cantidad_disponible = cantidad_disponible - v_toma where id = r.id;
    insert into public.movimiento_lotes (movimiento_id, lote_id, cantidad) values (p_movimiento, r.id, v_toma);
    v_resta := v_resta - v_toma;
  end loop;
  if v_resta > 0 and not p_permitir_faltante then
    raise exception 'Stock insuficiente: faltan % (unidad base)', v_resta using errcode = 'P0001';
  end if;
  return greatest(v_resta, 0);
end $$;

-- Valor estimado de una salida (para decidir si requiere aprobación); el operativo
-- nunca lo ve, solo recibe "pendiente de aprobación".
create or replace function app.valor_estimado(
  p_producto uuid, p_sucursal uuid, p_ubicacion uuid, p_cantidad numeric)
returns numeric language sql stable security definer set search_path = '' as $$
  select p_cantidad * coalesce(
    (select cl.costo_unitario from public.lotes l join public.costos_lote cl on cl.lote_id = l.id
     where l.producto_id = p_producto and l.sucursal_id = p_sucursal and l.cantidad_disponible > 0
       and (p_ubicacion is null or l.ubicacion_id = p_ubicacion)
     order by l.fecha_vencimiento nulls last, l.fecha_ingreso limit 1),
    (select costo_estandar from public.costos_producto where producto_id = p_producto), 0)
$$;

-- Punto de reorden = consumo diario promedio (28 días) × (días de entrega + días de seguridad)
create or replace function app.punto_reorden(p_producto uuid, p_sucursal uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select greatest(p.stock_minimo,
    coalesce((select sum(ml.cantidad) / 28.0 from public.movimientos m
              join public.movimiento_lotes ml on ml.movimiento_id = m.id
              where m.producto_id = p.id and m.sucursal_id = p_sucursal and m.estado = 'aplicado'
                and m.tipo in ('salida_produccion','consumo_venta','merma')
                and m.creado_en > now() - interval '28 days'), 0)
    * (coalesce(pr.dias_entrega, 1) + p.dias_seguridad))
  from public.productos p left join public.proveedores pr on pr.id = p.proveedor_principal_id
  where p.id = p_producto
$$;

create or replace function app.revisar_stock(p_producto uuid, p_sucursal uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_stock numeric; v_reorden numeric; v_nombre text;
begin
  select coalesce(sum(cantidad_disponible), 0) into v_stock from public.lotes
  where producto_id = p_producto and sucursal_id = p_sucursal and not bloqueado;
  v_reorden := app.punto_reorden(p_producto, p_sucursal);
  if v_stock <= v_reorden then
    select nombre into v_nombre from public.productos where id = p_producto;
    insert into public.alertas (sucursal_id, tipo, severidad, titulo, detalle, rol_destino, producto_id, clave_unica)
    values (p_sucursal, 'stock_bajo', case when v_stock = 0 then 'alta' else 'media' end::public.severidad,
            'Stock bajo: ' || v_nombre,
            format('Quedan %s; punto de reorden %s', round(v_stock, 2), round(v_reorden, 2)),
            'supervisor', p_producto,
            'stock:' || p_producto || ':' || p_sucursal || ':' || current_date)
    on conflict (clave_unica) do nothing;
  end if;
end $$;

create or replace function app.aplicar_movimiento(p_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare m public.movimientos; v_lote uuid;
begin
  select * into m from public.movimientos where id = p_id;
  if app.es_salida(m.tipo) then
    perform app.consumir_peps(m.id, m.producto_id, m.sucursal_id, m.ubicacion_origen_id, m.lote_id,
                              m.cantidad, m.tipo = 'consumo_venta',
                              m.tipo = 'merma' or m.tipo = 'ajuste_negativo' or m.tipo = 'devolucion_proveedor');
  elsif m.tipo = 'ajuste_positivo' then
    insert into public.lotes (producto_id, sucursal_id, ubicacion_id, codigo_lote, cantidad_inicial, cantidad_disponible)
    values (m.producto_id, m.sucursal_id, coalesce(m.ubicacion_destino_id, m.ubicacion_origen_id),
            'AJUSTE', m.cantidad, m.cantidad)
    returning id into v_lote;
    insert into public.costos_lote (lote_id, costo_unitario)
    select v_lote, costo_estandar from public.costos_producto where producto_id = m.producto_id;
    insert into public.movimiento_lotes values (m.id, v_lote, m.cantidad);
  end if;
  -- entrada_compra y transferencia_entrada: sus lotes los crea la RPC que las registra
  perform app.revisar_stock(m.producto_id, m.sucursal_id);
end $$;

create or replace function app.revertir_movimiento(p_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare m public.movimientos; r record;
begin
  select * into m from public.movimientos where id = p_id;
  for r in select * from public.movimiento_lotes where movimiento_id = p_id loop
    if app.es_salida(m.tipo) then
      update public.lotes set cantidad_disponible = cantidad_disponible + r.cantidad where id = r.lote_id;
    else
      update public.lotes set cantidad_disponible = cantidad_disponible - r.cantidad
      where id = r.lote_id and cantidad_disponible >= r.cantidad;
      if not found then
        raise exception 'No se puede anular: ese lote ya se consumió';
      end if;
    end if;
  end loop;
end $$;

-- BEFORE INSERT: quién, de dónde y si necesita aprobación (no se puede falsear desde la API)
create or replace function app.preparar_movimiento() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_umbral numeric := coalesce((app.parametro('merma.umbral_aprobacion_usd'))::numeric, 10);
  v_valor  numeric;
begin
  if app.es_proceso_interno() or app.contexto_confiable() then
    NEW.creado_por := coalesce(NEW.creado_por, app.usuario_actual());
    return NEW;
  end if;
  NEW.creado_por := app.usuario_actual();
  NEW.creado_en := now();
  NEW.dispositivo_id := app.dispositivo_actual();
  NEW.aprobado_por := null; NEW.aprobado_en := null; NEW.firma_aprobacion_id := null;
  NEW.anulado := false;
  if not app.en_mi_sucursal(NEW.sucursal_id) then
    raise exception 'Solo puede registrar movimientos de su sucursal' using errcode = '42501';
  end if;
  if NEW.tipo in ('entrada_compra','transferencia_entrada','transferencia_salida','consumo_venta') then
    raise exception 'Use registrar_recepcion() o registrar_transferencia() para este tipo de movimiento'
      using errcode = '42501';
  end if;
  if NEW.tipo in ('ajuste_positivo','ajuste_negativo','devolucion_proveedor')
     and not app.tiene_permiso('inventario.ajuste.aprobar') then
    raise exception 'Los ajustes y devoluciones los registra un supervisor' using errcode = '42501';
  end if;

  NEW.estado := 'aplicado';
  NEW.requiere_aprobacion := false;
  if not app.es_admin() then
    v_valor := app.valor_estimado(NEW.producto_id, NEW.sucursal_id, NEW.ubicacion_origen_id, NEW.cantidad);
    if NEW.tipo in ('ajuste_positivo','ajuste_negativo','devolucion_proveedor')
       or (NEW.tipo = 'merma' and (v_valor >= v_umbral or NEW.motivo_merma in ('faltante','otro'))) then
      NEW.requiere_aprobacion := true;
      NEW.estado := 'pendiente_aprobacion';
    end if;
  end if;
  return NEW;
end $$;

create or replace function app.despues_de_movimiento() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_nombre text;
begin
  if NEW.estado = 'aplicado' then
    perform app.aplicar_movimiento(NEW.id);
  elsif NEW.estado = 'pendiente_aprobacion' then
    select nombre into v_nombre from public.productos where id = NEW.producto_id;
    insert into public.alertas (sucursal_id, tipo, severidad, titulo, detalle, rol_destino, producto_id, movimiento_id, clave_unica)
    values (NEW.sucursal_id, 'aprobacion_pendiente', 'media',
            initcap(replace(NEW.tipo::text, '_', ' ')) || ' por aprobar: ' || v_nombre,
            format('%s (unidad base) · motivo %s', NEW.cantidad, coalesce(NEW.motivo_merma::text, '-')),
            'supervisor', NEW.producto_id, NEW.id, 'aprob:' || NEW.id)
    on conflict (clave_unica) do nothing;
  end if;
  return null;
end $$;

-- BEFORE UPDATE: desde la API solo se puede anular (con motivo); el resto pasa por RPC
create or replace function app.proteger_movimiento() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v public.movimientos;
begin
  if app.es_proceso_interno() or app.contexto_confiable() then return NEW; end if;
  if not NEW.anulado or OLD.anulado then
    raise exception 'Un movimiento no se edita: anúlelo y registre uno nuevo' using errcode = '42501';
  end if;
  if length(coalesce(NEW.motivo_anulacion, '')) < 5 then
    raise exception 'Indique el motivo de la anulación';
  end if;
  v := NEW;
  NEW := OLD;
  NEW.anulado := true;
  NEW.motivo_anulacion := v.motivo_anulacion;
  NEW.firma_id := v.firma_id;
  if OLD.estado = 'aplicado' then perform app.revertir_movimiento(OLD.id); end if;
  NEW.estado := 'anulado';
  return NEW;
end $$;

-- APROBAR O RECHAZAR un ajuste o merma pendiente. El supervisor teclea su PIN en
-- cualquier dispositivo registrado (incluida la tablet del operativo): el PIN único
-- lo identifica. Nadie aprueba lo que registró.
create or replace function public.resolver_aprobacion(
  p_movimiento uuid, p_pin text, p_aprobar boolean, p_nota text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  m public.movimientos;
  v_aprob uuid;
  v_suc uuid;
  v_firma uuid;
begin
  if app.usuario_actual() is null then return jsonb_build_object('ok', false, 'motivo', 'sin_sesion'); end if;
  select * into m from public.movimientos where id = p_movimiento for update;
  if m.id is null or m.estado <> 'pendiente_aprobacion' then
    return jsonb_build_object('ok', false, 'motivo', 'no_pendiente');
  end if;
  v_aprob := privado.identificar_pin(p_pin, app.dispositivo_actual(), 'autorizacion');
  if v_aprob is null then return jsonb_build_object('ok', false, 'motivo', 'pin_incorrecto'); end if;
  if not app.usuario_tiene_permiso(v_aprob, 'inventario.ajuste.aprobar') then
    return jsonb_build_object('ok', false, 'motivo', 'sin_permiso');
  end if;
  if v_aprob = m.creado_por then
    return jsonb_build_object('ok', false, 'motivo', 'no_puede_aprobar_lo_propio');
  end if;
  select sucursal_id into v_suc from public.usuarios where id = v_aprob;
  if v_suc <> m.sucursal_id and not app.usuario_tiene_permiso(v_aprob, 'datos.exportar') then
    return jsonb_build_object('ok', false, 'motivo', 'otra_sucursal');
  end if;

  insert into public.firmas (usuario_id, accion, entidad, entidad_id, metodo, dispositivo_id, ip,
                             expira_en, usada_en, usada_txid)
  values (v_aprob, case when p_aprobar then 'aprobar' else 'rechazar' end::public.accion_firma,
          'movimientos', m.id, 'pin_autorizacion', app.dispositivo_actual(), app.ip_cliente(),
          now(), clock_timestamp(), txid_current())
  returning id into v_firma;

  perform set_config('app.contexto', 'resolver_aprobacion', true);
  update public.movimientos
     set estado = case when p_aprobar then 'aplicado' else 'rechazado' end::public.estado_movimiento,
         aprobado_por = v_aprob, aprobado_en = now(), nota_aprobacion = p_nota, firma_aprobacion_id = v_firma
   where id = m.id;
  if p_aprobar then perform app.aplicar_movimiento(m.id); end if;
  update public.alertas set estado = 'resuelta', resuelta_por = v_aprob, resuelta_en = now()
   where movimiento_id = m.id and tipo = 'aprobacion_pendiente' and estado <> 'resuelta';
  perform set_config('app.contexto', '', true);
  return jsonb_build_object('ok', true, 'estado', case when p_aprobar then 'aplicado' else 'rechazado' end,
                            'aprobado_por', v_aprob);
end $$;

-- RECEPCIÓN DE MERCANCÍA (POE 13): crea lotes con vencimiento, toma el costo de la
-- orden de compra sin mostrarlo, rechaza por temperatura y avisa diferencias.
create or replace function public.registrar_recepcion(p_recepcion jsonb, p_lineas jsonb, p_firma uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id      uuid := (p_recepcion ->> 'id')::uuid;
  v_suc     uuid := app.sucursal_actual();
  v_oc      uuid := nullif(p_recepcion ->> 'orden_id', '')::uuid;
  v_tol     numeric := coalesce((app.parametro('recepcion.tolerancia_pct'))::numeric, 2);
  l         jsonb;
  p         public.productos;
  v_cant    numeric;
  v_rech    numeric;
  v_motivo  text;
  v_temp    numeric;
  v_tmax    numeric;
  v_venc    date;
  v_lote    uuid;
  v_mov     uuid;
  v_costo   numeric;
  v_pedido  numeric;
  n_dif     int := 0;
  n_rech    int := 0;
  n_ok      int := 0;
  v_estado  text;
begin
  if not app.tiene_permiso('inventario.recepcion.registrar') then
    raise exception 'Sin permiso para recibir mercancía' using errcode = '42501';
  end if;
  perform app.consumir_firma(p_firma, 'recepciones', v_id, array['crear']::public.accion_firma[]);
  perform set_config('app.contexto', 'registrar_recepcion', true);

  insert into public.recepciones (id, sucursal_id, orden_id, proveedor_id, numero_factura,
                                  temperatura_vehiculo, recibido_por, ejecucion_id, firma_id)
  values (v_id, v_suc, v_oc, (p_recepcion ->> 'proveedor_id')::uuid, p_recepcion ->> 'numero_factura',
          (p_recepcion ->> 'temperatura_vehiculo')::numeric, app.usuario_actual(),
          nullif(p_recepcion ->> 'ejecucion_id', '')::uuid, p_firma);

  for l in select * from jsonb_array_elements(p_lineas) loop
    select * into p from public.productos where id = (l ->> 'producto_id')::uuid;
    if p.id is null then raise exception 'Producto % no existe', l ->> 'producto_id'; end if;
    v_cant   := coalesce((l ->> 'cantidad_recibida')::numeric, 0);
    v_rech   := coalesce((l ->> 'cantidad_rechazada')::numeric, 0);
    v_motivo := l ->> 'motivo_rechazo';
    v_temp   := (l ->> 'temperatura_llegada')::numeric;
    v_venc   := (l ->> 'fecha_vencimiento')::date;
    v_tmax   := case p.conservacion
                  when 'refrigerado' then (app.parametro('recepcion.temp_max_refrigerado'))::numeric
                  when 'congelado'   then (app.parametro('recepcion.temp_max_congelado'))::numeric end;

    if v_tmax is not null and v_cant > 0 and v_temp is null then
      raise exception 'Registre la temperatura de llegada de %', p.nombre;
    end if;
    if v_tmax is not null and v_temp > v_tmax then
      v_rech := v_rech + v_cant; v_cant := 0;
      v_motivo := format('Llegó a %s °C (límite %s °C)', v_temp, v_tmax);
    elsif p.controla_vencimiento and v_cant > 0 and v_venc is null then
      raise exception 'Indique la fecha de vencimiento de %', p.nombre;
    elsif v_venc < current_date then
      v_rech := v_rech + v_cant; v_cant := 0; v_motivo := 'Producto vencido';
    end if;

    insert into public.recepcion_lineas (recepcion_id, producto_id, ubicacion_id, cantidad_recibida,
      cantidad_rechazada, motivo_rechazo, temperatura_llegada, fecha_vencimiento, codigo_lote, evidencia_id, firma_id)
    values (v_id, p.id, (l ->> 'ubicacion_id')::uuid, v_cant, v_rech, v_motivo, v_temp, v_venc,
            l ->> 'codigo_lote', nullif(l ->> 'evidencia_id', '')::uuid, p_firma);

    if v_rech > 0 then n_rech := n_rech + 1; end if;
    if v_cant > 0 then
      n_ok := n_ok + 1;
      insert into public.lotes (producto_id, sucursal_id, ubicacion_id, codigo_lote, fecha_vencimiento,
                                cantidad_inicial, cantidad_disponible)
      values (p.id, v_suc, (l ->> 'ubicacion_id')::uuid, l ->> 'codigo_lote', v_venc, v_cant, v_cant)
      returning id into v_lote;

      select ocl.precio_unitario / nullif(p.factor_compra, 0), ocl.cantidad * p.factor_compra
        into v_costo, v_pedido
      from public.orden_compra_lineas ocl
      where ocl.orden_id = v_oc and ocl.producto_id = p.id and not ocl.anulado limit 1;
      v_costo := coalesce(v_costo, (select costo_estandar from public.costos_producto where producto_id = p.id));
      if v_costo is not null then
        insert into public.costos_lote (lote_id, costo_unitario) values (v_lote, v_costo);
      end if;

      v_mov := gen_random_uuid();
      insert into public.movimientos (id, sucursal_id, producto_id, tipo, cantidad, ubicacion_destino_id,
        lote_id, referencia_tipo, referencia_id, estado, creado_por, dispositivo_id, firma_id)
      values (v_mov, v_suc, p.id, 'entrada_compra', v_cant, (l ->> 'ubicacion_id')::uuid, v_lote,
              'recepcion', v_id, 'aplicado', app.usuario_actual(), app.dispositivo_actual(), p_firma);
      insert into public.movimiento_lotes values (v_mov, v_lote, v_cant);

      if v_pedido is not null and abs(v_cant - v_pedido) > v_pedido * v_tol / 100 then
        n_dif := n_dif + 1;
      end if;
    end if;
  end loop;

  v_estado := case when n_ok = 0 then 'rechazada'
                   when n_dif > 0 or n_rech > 0 then 'aceptada_con_diferencias'
                   else 'aceptada' end;
  update public.recepciones set estado = v_estado where id = v_id;

  if v_estado <> 'aceptada' then
    insert into public.alertas (sucursal_id, tipo, severidad, titulo, detalle, rol_destino, clave_unica)
    values (v_suc, 'diferencia_recepcion', case when v_estado = 'rechazada' then 'alta' else 'media' end::public.severidad,
            'Recepción con diferencias', format('%s líneas rechazadas, %s con cantidad distinta a la orden', n_rech, n_dif),
            'supervisor', 'recep:' || v_id)
    on conflict (clave_unica) do nothing;
  end if;
  perform set_config('app.contexto', '', true);
  return jsonb_build_object('ok', true, 'estado', v_estado, 'lineas_rechazadas', n_rech, 'lineas_con_diferencia', n_dif);
end $$;

-- TRANSFERENCIA entre ubicaciones (cava → línea): los lotes conservan vencimiento,
-- fecha de ingreso (orden PEPS) y costo.
create or replace function public.registrar_transferencia(
  p_id uuid, p_origen uuid, p_destino uuid, p_lineas jsonb, p_firma uuid, p_nota text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_suc uuid := app.sucursal_actual();
  l jsonb; v_sal uuid; v_ent uuid; ml record; o public.lotes; v_nuevo uuid; n int := 0;
begin
  if not app.tiene_permiso('inventario.transferencia.registrar') then
    raise exception 'Sin permiso para transferir' using errcode = '42501';
  end if;
  if (select count(*) from public.ubicaciones where id in (p_origen, p_destino) and sucursal_id = v_suc) <> 2 then
    raise exception 'Origen y destino deben ser ubicaciones distintas de su sucursal';
  end if;
  perform app.consumir_firma(p_firma, 'transferencias', p_id, array['crear']::public.accion_firma[]);
  perform set_config('app.contexto', 'registrar_transferencia', true);
  insert into public.transferencias (id, sucursal_id, origen_id, destino_id, enviado_por, nota, firma_id)
  values (p_id, v_suc, p_origen, p_destino, app.usuario_actual(), p_nota, p_firma);

  for l in select * from jsonb_array_elements(p_lineas) loop
    insert into public.transferencia_lineas (transferencia_id, producto_id, cantidad, firma_id)
    values (p_id, (l ->> 'producto_id')::uuid, (l ->> 'cantidad')::numeric, p_firma);
    v_sal := gen_random_uuid(); v_ent := gen_random_uuid();
    insert into public.movimientos (id, sucursal_id, producto_id, tipo, cantidad, ubicacion_origen_id,
      referencia_tipo, referencia_id, estado, creado_por, dispositivo_id, firma_id)
    values (v_sal, v_suc, (l ->> 'producto_id')::uuid, 'transferencia_salida', (l ->> 'cantidad')::numeric,
            p_origen, 'transferencia', p_id, 'aplicado', app.usuario_actual(), app.dispositivo_actual(), p_firma);
    insert into public.movimientos (id, sucursal_id, producto_id, tipo, cantidad, ubicacion_destino_id,
      referencia_tipo, referencia_id, estado, creado_por, dispositivo_id, firma_id)
    values (v_ent, v_suc, (l ->> 'producto_id')::uuid, 'transferencia_entrada', (l ->> 'cantidad')::numeric,
            p_destino, 'transferencia', p_id, 'aplicado', app.usuario_actual(), app.dispositivo_actual(), p_firma);
    for ml in select * from public.movimiento_lotes where movimiento_id = v_sal loop
      select * into o from public.lotes where id = ml.lote_id;
      insert into public.lotes (producto_id, sucursal_id, ubicacion_id, codigo_lote, fecha_ingreso,
        fecha_vencimiento, cantidad_inicial, cantidad_disponible, bloqueado, lote_origen_id)
      values (o.producto_id, o.sucursal_id, p_destino, o.codigo_lote, o.fecha_ingreso, o.fecha_vencimiento,
              ml.cantidad, ml.cantidad, o.bloqueado, o.id)
      returning id into v_nuevo;
      insert into public.costos_lote (lote_id, costo_unitario)
      select v_nuevo, costo_unitario from public.costos_lote where lote_id = o.id;
      insert into public.movimiento_lotes values (v_ent, v_nuevo, ml.cantidad);
    end loop;
    n := n + 1;
  end loop;
  perform set_config('app.contexto', '', true);
  return jsonb_build_object('ok', true, 'lineas', n);
end $$;

-- APROBAR CONTEO (a ciegas): compara lo contado con el sistema y genera los ajustes
create or replace function public.aprobar_conteo(p_conteo uuid, p_pin text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  k public.conteos; v_aprob uuid; v_firma uuid; r record; n int := 0; v_mov uuid;
begin
  select * into k from public.conteos where id = p_conteo for update;
  if k.id is null or k.estado <> 'abierto' then return jsonb_build_object('ok', false, 'motivo', 'no_abierto'); end if;
  v_aprob := privado.identificar_pin(p_pin, app.dispositivo_actual(), 'autorizacion');
  if v_aprob is null then return jsonb_build_object('ok', false, 'motivo', 'pin_incorrecto'); end if;
  if not app.usuario_tiene_permiso(v_aprob, 'inventario.conteo.aprobar') then
    return jsonb_build_object('ok', false, 'motivo', 'sin_permiso');
  end if;
  insert into public.firmas (usuario_id, accion, entidad, entidad_id, metodo, dispositivo_id, ip, expira_en, usada_en, usada_txid)
  values (v_aprob, 'aprobar', 'conteos', k.id, 'pin_autorizacion', app.dispositivo_actual(), app.ip_cliente(),
          now(), clock_timestamp(), txid_current())
  returning id into v_firma;
  perform set_config('app.contexto', 'aprobar_conteo', true);

  for r in
    with contado as (
      select producto_id, ubicacion_id, sum(cantidad_contada) as contado
      from public.conteo_lineas where conteo_id = k.id group by 1, 2),
    sistema as (
      select l.producto_id, l.ubicacion_id, sum(l.cantidad_disponible) as sistema
      from public.lotes l join contado c using (producto_id, ubicacion_id)
      where l.sucursal_id = k.sucursal_id group by 1, 2)
    select c.producto_id, c.ubicacion_id, c.contado - coalesce(s.sistema, 0) as diferencia
    from contado c left join sistema s using (producto_id, ubicacion_id)
    where c.contado <> coalesce(s.sistema, 0)
  loop
    v_mov := gen_random_uuid();
    insert into public.movimientos (id, sucursal_id, producto_id, tipo, cantidad, ubicacion_origen_id,
      ubicacion_destino_id, referencia_tipo, referencia_id, estado, aprobado_por, aprobado_en,
      firma_aprobacion_id, creado_por, firma_id)
    values (v_mov, k.sucursal_id, r.producto_id,
            case when r.diferencia > 0 then 'ajuste_positivo' else 'ajuste_negativo' end::public.tipo_movimiento,
            abs(r.diferencia), r.ubicacion_id, r.ubicacion_id, 'conteo', k.id, 'aplicado', v_aprob, now(),
            v_firma, k.abierto_por, v_firma);
    n := n + 1;
  end loop;
  update public.conteos set estado = 'aprobado', aprobado_por = v_aprob, aprobado_en = now(),
                            firma_aprobacion_id = v_firma where id = k.id;
  perform set_config('app.contexto', '', true);
  return jsonb_build_object('ok', true, 'ajustes', n);
end $$;

-- -----------------------------------------------------------------------------
-- 12. CHECKLISTS E INCIDENCIAS
-- -----------------------------------------------------------------------------
create or replace function app.sla_minutos(p_sev public.severidad) returns int
language sql stable as $$
  select coalesce((app.parametro('incidencia.sla_minutos') ->> p_sev::text)::int,
                  case p_sev when 'critica' then 30 when 'alta' then 120 when 'media' then 1440 else 4320 end)
$$;

-- BEFORE INSERT en respuestas: calcula "cumple" y exige la foto cuando falla
create or replace function app.evaluar_respuesta() returns trigger
language plpgsql security definer set search_path = '' as $$
declare i public.plantilla_items; e public.checklist_ejecuciones;
begin
  select * into i from public.plantilla_items where id = NEW.item_id;
  select * into e from public.checklist_ejecuciones where id = NEW.ejecucion_id;
  if i.plantilla_id is distinct from e.plantilla_id then
    raise exception 'El ítem % no pertenece a esta planilla', i.ref;
  end if;
  if NEW.no_aplica then
    if not i.admite_no_aplica then
      raise exception 'El ítem "%" es obligatorio y no admite "No aplica"', i.texto;
    end if;
    NEW.cumple := null;
    return NEW;
  end if;
  NEW.cumple := case i.tipo
    when 'pass_fail' then NEW.valor_bool
    when 'number' then case when NEW.valor_num is null then null
                            else NEW.valor_num between coalesce(i.valor_min, '-infinity'::numeric)
                                                   and coalesce(i.valor_max, 'infinity'::numeric) end
    else null end;
  if (i.tipo = 'photo' or (NEW.cumple = false and i.foto_si_falla)) and NEW.evidencia_id is null then
    raise exception 'Foto obligatoria: "%"', i.texto using errcode = '23514';
  end if;
  return NEW;
end $$;

-- AFTER INSERT en respuestas: un "No cumple" abre una incidencia y avisa al supervisor
create or replace function app.respuesta_genera_incidencia() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  i public.plantilla_items; e public.checklist_ejecuciones; p public.plantillas;
  v_sev public.severidad; v_inc uuid; v_bloquea boolean;
begin
  if NEW.cumple is distinct from false then return null; end if;
  select * into i from public.plantilla_items where id = NEW.item_id;
  select * into e from public.checklist_ejecuciones where id = NEW.ejecucion_id;
  select * into p from public.plantillas where id = e.plantilla_id;
  v_sev := case when i.critico then 'critica' when i.tipo = 'number' then 'alta' else 'media' end;
  v_bloquea := i.critico and p.bloquea_operacion;

  insert into public.incidencias (sucursal_id, origen, ejecucion_id, respuesta_id, plantilla_id, item_id,
    titulo, descripcion, severidad, bloquea_operacion, reportada_por, vence_en, evidencia_id, firma_id)
  values (e.sucursal_id, case when i.unidad = '°C' then 'temperatura' else 'checklist' end,
          e.id, NEW.id, p.id, i.id,
          left(p.codigo || ' · ' || i.texto, 180),
          concat_ws(' · ',
            case when i.tipo = 'number' then format('Valor %s %s (límite %s a %s)', NEW.valor_num, i.unidad,
                                                    coalesce(i.valor_min::text, '−'), coalesce(i.valor_max::text, '−')) end,
            NEW.observacion),
          v_sev, v_bloquea, e.realizada_por, now() + make_interval(mins => app.sla_minutos(v_sev)),
          NEW.evidencia_id, NEW.firma_id)
  returning id into v_inc;

  insert into public.alertas (sucursal_id, tipo, severidad, titulo, detalle, rol_destino, incidencia_id, clave_unica)
  values (e.sucursal_id, case when v_bloquea then 'operacion_bloqueada' else 'incidencia' end::public.tipo_alerta,
          v_sev, case when v_bloquea then 'No operar: ' else 'No cumple: ' end || left(i.texto, 120),
          p.codigo || ' ' || p.nombre, 'supervisor', v_inc, 'inc:' || v_inc);
  return null;
end $$;

-- ENVIAR CHECKLIST: la planilla se llena en el dispositivo (también sin conexión) y
-- se envía completa con una sola firma.
create or replace function public.enviar_checklist(p_ejecucion jsonb, p_respuestas jsonb, p_firma uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id       uuid := (p_ejecucion ->> 'id')::uuid;
  v_usuario  uuid := app.usuario_actual();
  v_suc      uuid := app.sucursal_actual();
  p          public.plantillas;
  r          jsonb;
  v_faltan   text;
  v_tz       text;
  v_res      record;
begin
  if v_usuario is null then raise exception 'Sesión no válida' using errcode = '42501'; end if;
  if not app.tiene_permiso('checklists.ejecutar') then
    raise exception 'Sin permiso para llenar planillas' using errcode = '42501';
  end if;
  select * into p from public.plantillas
  where id = (p_ejecucion ->> 'plantilla_id')::uuid and vigente and not anulado;
  if p.id is null then raise exception 'Planilla no encontrada o no vigente'; end if;
  if app.nivel_actual() < (select nivel from public.roles where codigo = p.rol_asignado) then
    raise exception 'La planilla % no está asignada a su rol', p.codigo using errcode = '42501';
  end if;

  perform app.consumir_firma(p_firma, 'checklist_ejecuciones', v_id, array['crear']::public.accion_firma[]);
  perform set_config('app.contexto', 'enviar_checklist', true);

  insert into public.checklist_ejecuciones (id, sucursal_id, plantilla_id, horario, iniciada_en, completada_en,
    realizada_por, registrada_sin_conexion, dispositivo_id, firma_id)
  values (v_id, v_suc, p.id, coalesce(p_ejecucion ->> 'horario', ''), (p_ejecucion ->> 'iniciada_en')::timestamptz,
          coalesce((p_ejecucion ->> 'completada_en')::timestamptz, now()), v_usuario,
          coalesce((p_ejecucion ->> 'sin_conexion')::boolean, false), app.dispositivo_actual(), p_firma);

  for r in select * from jsonb_array_elements(p_respuestas) loop
    insert into public.checklist_respuestas (ejecucion_id, item_id, valor_bool, valor_num, valor_texto,
      valor_opcion, valor_hora, no_aplica, observacion, evidencia_id, firma_id)
    values (v_id, (r ->> 'item_id')::uuid, (r ->> 'valor_bool')::boolean, (r ->> 'valor_num')::numeric,
            r ->> 'valor_texto', r ->> 'valor_opcion', (r ->> 'valor_hora')::time,
            coalesce((r ->> 'no_aplica')::boolean, false), r ->> 'observacion',
            nullif(r ->> 'evidencia_id', '')::uuid, p_firma);
  end loop;

  select string_agg(i.ref, ', ' order by i.orden) into v_faltan
  from public.plantilla_items i
  where i.plantilla_id = p.id and i.tipo in ('pass_fail','number','photo')
    and not exists (select 1 from public.checklist_respuestas x
                    where x.ejecucion_id = v_id and x.item_id = i.id
                      and (x.no_aplica or x.valor_bool is not null or x.valor_num is not null or x.evidencia_id is not null));
  if v_faltan is not null then
    raise exception 'Faltan ítems por responder: %', v_faltan;
  end if;

  select count(*) filter (where not x.no_aplica)                                  as total,
         count(*) filter (where x.cumple)                                         as si,
         count(*) filter (where x.cumple = false)                                 as no,
         count(*) filter (where x.cumple = false and i.critico)                   as criticos,
         round(100.0 * count(*) filter (where x.cumple)
               / nullif(count(*) filter (where x.cumple is not null), 0), 2)       as puntaje
    into v_res
  from public.checklist_respuestas x join public.plantilla_items i on i.id = x.item_id
  where x.ejecucion_id = v_id;

  update public.checklist_ejecuciones
     set total_items = v_res.total, items_cumple = v_res.si, items_no_cumple = v_res.no,
         criticos_no_cumple = v_res.criticos, puntaje = v_res.puntaje
   where id = v_id;

  select zona_horaria into v_tz from public.sucursales where id = v_suc;
  update public.checklist_programacion
     set ejecucion_id = v_id
   where sucursal_id = v_suc and plantilla_id = p.id and ejecucion_id is null
     and horario = coalesce(p_ejecucion ->> 'horario', '')
     and fecha = (coalesce((p_ejecucion ->> 'completada_en')::timestamptz, now()) at time zone v_tz)::date;

  perform set_config('app.contexto', '', true);
  return jsonb_build_object('ok', true, 'ejecucion_id', v_id, 'puntaje', v_res.puntaje,
    'no_cumple', v_res.no, 'criticos_no_cumple', v_res.criticos,
    'operacion_bloqueada', p.bloquea_operacion and v_res.criticos > 0,
    'incidencias', (select count(*) from public.incidencias where ejecucion_id = v_id));
end $$;

-- BEFORE UPDATE en ejecuciones: el supervisor solo revisa (estado y nota); no edita respuestas
create or replace function app.proteger_ejecucion() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v public.checklist_ejecuciones;
begin
  if app.es_proceso_interno() or app.contexto_confiable() then return NEW; end if;
  if NEW.estado not in ('revisada','observada','anulada') then
    raise exception 'Estado de revisión no válido';
  end if;
  if NEW.estado = 'observada' and length(coalesce(NEW.nota_revision, '')) < 5 then
    raise exception 'Una planilla observada lleva nota';
  end if;
  if NEW.estado = 'anulada' and not app.es_admin() then
    raise exception 'Solo el gerente anula planillas' using errcode = '42501';
  end if;
  if OLD.realizada_por = app.usuario_actual() and not app.es_admin() then
    raise exception 'No puede revisar una planilla que usted llenó' using errcode = '42501';
  end if;
  v := NEW;
  NEW := OLD;
  NEW.estado := v.estado;
  NEW.nota_revision := v.nota_revision;
  NEW.anulado := v.estado = 'anulada';
  NEW.firma_id := v.firma_id;
  NEW.revisada_por := app.usuario_actual();
  NEW.revisada_en := now();
  return NEW;
end $$;

-- BEFORE INSERT/UPDATE en incidencias: flujo abierta → en_proceso → resuelta → verificada
create or replace function app.flujo_incidencia() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v public.incidencias;
begin
  if app.es_proceso_interno() or app.contexto_confiable() then return NEW; end if;
  if TG_OP = 'INSERT' then
    if not app.en_mi_sucursal(NEW.sucursal_id) then
      raise exception 'Solo puede reportar en su sucursal' using errcode = '42501';
    end if;
    NEW.origen := 'manual'; NEW.estado := 'abierta'; NEW.reportada_por := app.usuario_actual();
    NEW.reportada_en := now(); NEW.vence_en := now() + make_interval(mins => app.sla_minutos(NEW.severidad));
    NEW.resuelta_por := null; NEW.verificada_por := null; NEW.escalada := false;
    return NEW;
  end if;

  v := NEW;
  NEW := OLD;                         -- lo descriptivo no se reescribe
  NEW.firma_id := v.firma_id;
  NEW.asignada_a := v.asignada_a;
  NEW.accion_correctiva := v.accion_correctiva;
  NEW.causa_raiz := v.causa_raiz;
  NEW.estado := v.estado;
  if v.estado = OLD.estado then return NEW; end if;
  case v.estado
    when 'en_proceso' then null;
    when 'resuelta' then
      if length(coalesce(v.accion_correctiva, '')) < 5 then
        raise exception 'Describa la acción correctiva para resolver';
      end if;
      NEW.resuelta_por := app.usuario_actual(); NEW.resuelta_en := now();
    when 'verificada' then
      if OLD.estado <> 'resuelta' then raise exception 'Solo se verifica una incidencia resuelta'; end if;
      if OLD.severidad = 'critica' and not app.tiene_permiso('incidencias.verificar') then
        raise exception 'Las incidencias críticas las verifica el gerente' using errcode = '42501';
      end if;
      if OLD.resuelta_por = app.usuario_actual() then
        raise exception 'Quien resolvió no verifica' using errcode = '42501';
      end if;
      NEW.verificada_por := app.usuario_actual(); NEW.verificada_en := now();
    when 'anulada' then
      if not app.es_admin() then raise exception 'Solo el gerente anula incidencias' using errcode = '42501'; end if;
      NEW.anulado := true;
    else raise exception 'Transición no permitida: % → %', OLD.estado, v.estado;
  end case;
  return NEW;
end $$;

create or replace function app.despues_de_incidencia() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if TG_OP = 'INSERT' and NEW.origen = 'manual' then
    insert into public.alertas (sucursal_id, tipo, severidad, titulo, detalle, rol_destino, incidencia_id, clave_unica)
    values (NEW.sucursal_id, 'incidencia', NEW.severidad, 'Incidencia: ' || left(NEW.titulo, 150),
            NEW.descripcion, 'supervisor', NEW.id, 'inc:' || NEW.id)
    on conflict (clave_unica) do nothing;
  elsif TG_OP = 'UPDATE' and NEW.estado in ('resuelta','verificada','anulada') then
    update public.alertas set estado = 'resuelta', resuelta_por = app.usuario_actual(), resuelta_en = now()
     where incidencia_id = NEW.id and estado <> 'resuelta';
  end if;
  return null;
end $$;

-- Las plantillas con ejecuciones no se editan: se publica una versión nueva
create or replace function app.proteger_plantilla() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_plantilla uuid;
begin
  if TG_OP = 'DELETE' then v_plantilla := OLD.plantilla_id; else v_plantilla := NEW.plantilla_id; end if;
  if not app.es_proceso_interno()
     and exists (select 1 from public.checklist_ejecuciones where plantilla_id = v_plantilla) then
    raise exception 'La planilla ya tiene registros: cree una versión nueva' using errcode = '42501';
  end if;
  if TG_OP = 'DELETE' then return OLD; end if;
  return NEW;
end $$;

create or replace function public.nueva_version_plantilla(p_plantilla uuid, p_nuevo_id uuid, p_firma uuid)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare p public.plantillas; s record; v_sec uuid;
begin
  if not app.tiene_permiso('checklists.plantillas.gestionar') then
    raise exception 'Sin permiso' using errcode = '42501';
  end if;
  perform app.consumir_firma(p_firma, 'plantillas', p_nuevo_id, array['crear']::public.accion_firma[]);
  perform set_config('app.contexto', 'nueva_version_plantilla', true);
  select * into p from public.plantillas where id = p_plantilla;
  insert into public.plantillas (id, codigo, version, nombre, documento_origen, tipo, area, frecuencia, horarios,
    rol_asignado, rol_revisor, minutos_estimados, objetivo, bloquea_operacion, vigente, firma_id)
  values (p_nuevo_id, p.codigo, (select max(version) + 1 from public.plantillas where codigo = p.codigo),
          p.nombre, p.documento_origen, p.tipo, p.area, p.frecuencia, p.horarios, p.rol_asignado,
          p.rol_revisor, p.minutos_estimados, p.objetivo, p.bloquea_operacion, false, p_firma);
  for s in select * from public.plantilla_secciones where plantilla_id = p.id order by orden loop
    insert into public.plantilla_secciones (plantilla_id, orden, titulo, hora, firma_id)
    values (p_nuevo_id, s.orden, s.titulo, s.hora, p_firma) returning id into v_sec;
    insert into public.plantilla_items (plantilla_id, seccion_id, orden, ref, texto, tipo, critico, unidad,
      valor_min, valor_max, opciones, foto_si_falla, admite_no_aplica, ayuda, firma_id)
    select p_nuevo_id, v_sec, orden, ref, texto, tipo, critico, unidad, valor_min, valor_max, opciones,
           foto_si_falla, admite_no_aplica, ayuda, p_firma
    from public.plantilla_items where seccion_id = s.id;
  end loop;
  perform set_config('app.contexto', '', true);
  return p_nuevo_id;   -- se edita como borrador y se publica con vigente = true
end $$;

-- Al publicar una versión, la anterior deja de estar vigente
create or replace function app.publicar_version() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_previo text;
begin
  if NEW.vigente and (TG_OP = 'INSERT' or not OLD.vigente) then
    v_previo := coalesce(current_setting('app.contexto', true), '');
    perform set_config('app.contexto', 'publicar_version', true);
    update public.plantillas set vigente = false where codigo = NEW.codigo and id <> NEW.id and vigente;
    perform set_config('app.contexto', v_previo, true);
  end if;
  return NEW;
end $$;

-- -----------------------------------------------------------------------------
-- 13. TAREAS PROGRAMADAS (pg_cron)
-- -----------------------------------------------------------------------------
create or replace function app.hora_de(p_horario text) returns time
language sql stable as $$
  select case
    when p_horario ~ '^\d{1,2}:\d{2}$' then p_horario::time      -- '24:00' se acepta como 24:00:00
    else coalesce((app.parametro('horarios.alias') ->> p_horario)::time, '23:59'::time) end
$$;

create or replace function app.generar_programacion(p_fecha date default current_date) returns int
language plpgsql volatile security definer set search_path = '' as $$
declare n int := 0; s record; p record; h text; v_tol int := 60;
begin
  for s in select * from public.sucursales where activa loop
    for p in select * from public.plantillas where vigente and not anulado and frecuencia <> 'por_evento' loop
      continue when p.frecuencia = 'semanal'    and extract(isodow from p_fecha) <> 1;
      continue when p.frecuencia = 'quincenal'  and extract(day from p_fecha) not in (1, 16);
      continue when p.frecuencia = 'mensual'    and extract(day from p_fecha) <> 1;
      continue when p.frecuencia = 'trimestral' and (extract(day from p_fecha) <> 1
                                                     or extract(month from p_fecha) not in (1, 4, 7, 10));
      continue when p.frecuencia = 'semestral'  and (extract(day from p_fecha) <> 1
                                                     or extract(month from p_fecha) not in (1, 7));
      foreach h in array (case when cardinality(p.horarios) = 0 then array[''] else p.horarios end) loop
        insert into public.checklist_programacion (sucursal_id, plantilla_id, fecha, horario, vence_en)
        values (s.id, p.id, p_fecha, h,
                case when h = '' then ((p_fecha + 1)::timestamp at time zone s.zona_horaria)
                     else ((p_fecha + app.hora_de(h))::timestamp at time zone s.zona_horaria)
                          + make_interval(mins => v_tol) end)
        on conflict do nothing;
        n := n + 1;
      end loop;
    end loop;
  end loop;
  return n;
end $$;

create or replace function app.alertar_checklists_vencidos() returns int
language plpgsql volatile security definer set search_path = '' as $$
declare n int;
begin
  with vencidas as (
    update public.checklist_programacion cp set alertada = true
    where cp.ejecucion_id is null and not cp.alertada and cp.vence_en < now()
    returning cp.*)
  insert into public.alertas (sucursal_id, tipo, severidad, titulo, detalle, rol_destino, clave_unica)
  select v.sucursal_id, 'checklist_vencido', case when p.bloquea_operacion then 'alta' else 'media' end::public.severidad,
         'Planilla sin llenar: ' || p.codigo || ' ' || p.nombre,
         nullif(v.horario, ''), 'supervisor', 'prog:' || v.id
  from vencidas v join public.plantillas p on p.id = v.plantilla_id
  on conflict (clave_unica) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function app.revisar_vencimientos() returns int
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_dias int := coalesce((app.parametro('alerta.dias_vencimiento'))::int, 3);
  n int := 0; m int;
begin
  with vencidos as (
    update public.lotes set bloqueado = true
    where not bloqueado and cantidad_disponible > 0 and fecha_vencimiento < current_date
    returning *)
  insert into public.alertas (sucursal_id, tipo, severidad, titulo, detalle, rol_destino, producto_id, lote_id, clave_unica)
  select v.sucursal_id, 'lote_vencido', 'critica', 'Vencido y bloqueado: ' || p.nombre,
         format('Lote %s venció el %s; registre la merma', coalesce(v.codigo_lote, '-'), v.fecha_vencimiento),
         'supervisor', p.id, v.id, 'venc:' || v.id
  from vencidos v join public.productos p on p.id = v.producto_id
  on conflict (clave_unica) do nothing;
  get diagnostics n = row_count;
  perform app.revisar_stock(x.producto_id, x.sucursal_id)
  from (select distinct producto_id, sucursal_id from public.lotes
        where bloqueado and cantidad_disponible > 0 and fecha_vencimiento < current_date) x;

  insert into public.alertas (sucursal_id, tipo, severidad, titulo, detalle, rol_destino, producto_id, lote_id, clave_unica)
  select l.sucursal_id, 'vencimiento_proximo',
         case when l.fecha_vencimiento <= current_date + 1 then 'alta' else 'media' end::public.severidad,
         'Por vencer: ' || p.nombre,
         format('%s (unidad base) vencen el %s; úselos primero (PEPS)', l.cantidad_disponible, l.fecha_vencimiento),
         'operativo', p.id, l.id, 'porvencer:' || l.id || ':' || current_date
  from public.lotes l join public.productos p on p.id = l.producto_id
  where not l.bloqueado and l.cantidad_disponible > 0
    and l.fecha_vencimiento between current_date and current_date + v_dias
  on conflict (clave_unica) do nothing;
  get diagnostics m = row_count;
  return n + m;
end $$;

create or replace function app.escalar_incidencias() returns int
language plpgsql volatile security definer set search_path = '' as $$
declare n int;
begin
  with escaladas as (
    update public.incidencias set escalada = true
    where estado in ('abierta','en_proceso') and not escalada and vence_en < now()
    returning *)
  insert into public.alertas (sucursal_id, tipo, severidad, titulo, detalle, rol_destino, incidencia_id, clave_unica)
  select e.sucursal_id, 'incidencia_escalada', e.severidad, 'Sin atender a tiempo: ' || left(e.titulo, 150),
         format('Venció el plazo de %s minutos', app.sla_minutos(e.severidad)), 'admin', e.id, 'esc:' || e.id
  from escaladas e
  on conflict (clave_unica) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- -----------------------------------------------------------------------------
-- 14. VISTAS Y REPORTES
-- -----------------------------------------------------------------------------
-- security_invoker: cada quien ve lo que su RLS le permite (el operativo, nada)
create view public.v_stock with (security_invoker = true) as
select l.sucursal_id, p.id as producto_id, p.nombre, p.unidad_base, p.conservacion,
       sum(l.cantidad_disponible) filter (where not l.bloqueado)            as disponible,
       sum(l.cantidad_disponible) filter (where l.bloqueado)                as bloqueado,
       min(l.fecha_vencimiento) filter (where not l.bloqueado and l.cantidad_disponible > 0) as proximo_vencimiento,
       p.stock_minimo, p.stock_maximo
from public.lotes l join public.productos p on p.id = l.producto_id
group by l.sucursal_id, p.id;

create or replace function public.kpi_tablero(p_desde date, p_hasta date, p_sucursal uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_suc uuid := case when app.es_admin() then coalesce(p_sucursal, app.sucursal_actual()) else app.sucursal_actual() end;
  v_fin boolean := app.tiene_permiso('reportes.financieros');
  v jsonb;
begin
  if not app.tiene_permiso('reportes.operativos') then
    raise exception 'Sin acceso a reportes' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'cumplimiento_checklists_pct', (
      select round(100.0 * count(*) filter (where ejecucion_id is not null) / nullif(count(*), 0), 1)
      from public.checklist_programacion where sucursal_id = v_suc and fecha between p_desde and p_hasta),
    'puntaje_promedio_pct', (
      select round(avg(puntaje), 1) from public.checklist_ejecuciones
      where sucursal_id = v_suc and not anulado and completada_en::date between p_desde and p_hasta),
    'incidencias_abiertas', (
      select count(*) from public.incidencias where sucursal_id = v_suc and estado in ('abierta','en_proceso')),
    'incidencias_criticas_abiertas', (
      select count(*) from public.incidencias
      where sucursal_id = v_suc and estado in ('abierta','en_proceso') and severidad = 'critica'),
    'incidencias_resueltas_en_plazo_pct', (
      select round(100.0 * count(*) filter (where resuelta_en <= vence_en) / nullif(count(*), 0), 1)
      from public.incidencias where sucursal_id = v_suc and resuelta_en::date between p_desde and p_hasta),
    'mermas_registros', (
      select count(*) from public.movimientos where sucursal_id = v_suc and tipo = 'merma'
        and estado = 'aplicado' and creado_en::date between p_desde and p_hasta),
    'mermas_usd', case when v_fin then (
      select round(coalesce(sum(ml.cantidad * cl.costo_unitario), 0), 2)
      from public.movimientos m join public.movimiento_lotes ml on ml.movimiento_id = m.id
      join public.costos_lote cl on cl.lote_id = ml.lote_id
      where m.sucursal_id = v_suc and m.tipo = 'merma' and m.estado = 'aplicado'
        and m.creado_en::date between p_desde and p_hasta) end,
    'valor_inventario_usd', case when v_fin then (
      select round(coalesce(sum(l.cantidad_disponible * cl.costo_unitario), 0), 2)
      from public.lotes l join public.costos_lote cl on cl.lote_id = l.id
      where l.sucursal_id = v_suc and not l.bloqueado) end,
    'productos_bajo_reorden', (
      select count(*) from public.productos p
      where p.activo and (select coalesce(sum(cantidad_disponible), 0) from public.lotes l
                          where l.producto_id = p.id and l.sucursal_id = v_suc and not l.bloqueado)
                         <= app.punto_reorden(p.id, v_suc)),
    'lotes_por_vencer', (
      select count(*) from public.lotes where sucursal_id = v_suc and not bloqueado and cantidad_disponible > 0
        and fecha_vencimiento between current_date and current_date + 3)
  ) into v;
  return v;
end $$;

-- Explosión de recetas (con subrecetas) → insumo bruto por unidad vendida
create or replace function app.explosion_receta(p_receta uuid, p_cantidad numeric)
returns table (producto_id uuid, cantidad numeric) language sql stable security definer set search_path = '' as $$
  with recursive arbol as (
    select ri.producto_id, ri.subreceta_id,
           p_cantidad / r.rendimiento * ri.cantidad / (1 - ri.merma_pct / 100) as cantidad, 1 as nivel
    from public.receta_insumos ri join public.recetas r on r.id = ri.receta_id
    where ri.receta_id = p_receta
    union all
    select ri.producto_id, ri.subreceta_id,
           a.cantidad / r.rendimiento * ri.cantidad / (1 - ri.merma_pct / 100), a.nivel + 1
    from arbol a join public.recetas r on r.id = a.subreceta_id
    join public.receta_insumos ri on ri.receta_id = r.id
    where a.nivel < 6)
  select producto_id, sum(cantidad) from arbol where producto_id is not null group by producto_id
$$;

-- Consumo teórico (ventas POS × receta) frente al real (salidas registradas)
create or replace function public.consumo_teorico_vs_real(p_desde date, p_hasta date)
returns table (producto_id uuid, producto text, consumo_teorico numeric, consumo_real numeric, diferencia_pct numeric)
language sql stable security definer set search_path = '' as $$
  with teorico as (
    select e.producto_id, sum(e.cantidad) as teorico
    from public.ventas_diarias v
    cross join lateral app.explosion_receta(v.receta_id, v.cantidad) e
    where v.sucursal_id = app.sucursal_actual() and v.fecha between p_desde and p_hasta
    group by e.producto_id),
  reales as (
    select m.producto_id, sum(m.cantidad) as cantidad
    from public.movimientos m
    where m.sucursal_id = app.sucursal_actual() and m.estado = 'aplicado'
      and m.tipo in ('salida_produccion','consumo_venta','merma','ajuste_negativo')
      and m.creado_en::date between p_desde and p_hasta
    group by m.producto_id)
  select p.id, p.nombre, round(t.teorico, 3), round(coalesce(r.cantidad, 0), 3),
         round(100 * (coalesce(r.cantidad, 0) - t.teorico) / nullif(t.teorico, 0), 1)
  from teorico t join public.productos p on p.id = t.producto_id
  left join reales r on r.producto_id = t.producto_id
  where app.tiene_permiso('reportes.operativos')
  order by 5 desc nulls last
$$;

create or replace function public.costo_receta(p_receta uuid)
returns table (costo numeric, precio numeric, food_cost_pct numeric)
language sql stable security definer set search_path = '' as $$
  with c as (
    select sum(e.cantidad * cp.costo_estandar) as costo
    from app.explosion_receta(p_receta, (select rendimiento from public.recetas where id = p_receta)) e
    join public.costos_producto cp on cp.producto_id = e.producto_id),
  pv as (
    select precio from public.precios_venta where receta_id = p_receta and vigente_desde <= current_date
    order by vigente_desde desc limit 1)
  select round(c.costo, 4), pv.precio, round(100 * c.costo / nullif(pv.precio, 0), 1)
  from c left join pv on true
  where app.tiene_permiso('inventario.costos.ver')
$$;

create or replace function public.consultar_auditoria(
  p_desde timestamptz, p_hasta timestamptz, p_tabla text default null, p_usuario uuid default null,
  p_limite int default 500)
returns table (id bigint, ocurrido_en timestamptz, usuario_id uuid, usuario_sesion_id uuid, rol text,
               accion text, tabla text, registro_id text, valores_anteriores jsonb, valores_nuevos jsonb,
               campos_modificados text[], firma_id uuid, ip inet, dispositivo_id uuid)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.tiene_permiso('auditoria.ver') then
    raise exception 'Solo el gerente consulta la auditoría' using errcode = '42501';
  end if;
  return query
    select a.id, a.ocurrido_en, a.usuario_id, a.usuario_sesion_id, a.rol, a.accion, a.tabla, a.registro_id,
           a.valores_anteriores, a.valores_nuevos, a.campos_modificados, a.firma_id, a.ip, a.dispositivo_id
    from auditoria.registros a
    where a.ocurrido_en between p_desde and p_hasta
      and (p_tabla is null or a.tabla = p_tabla)
      and (p_usuario is null or a.usuario_id = p_usuario)
    order by a.id desc
    limit least(p_limite, 5000);
end $$;

-- Exportación: solo gerente, y queda en la auditoría
create or replace function public.exportar_movimientos(p_desde date, p_hasta date)
returns table (fecha timestamptz, producto text, tipo public.tipo_movimiento, motivo public.motivo_merma,
               cantidad numeric, unidad text, valor_usd numeric, estado public.estado_movimiento,
               registrado_por text, aprobado_por text)
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not app.tiene_permiso('datos.exportar') then
    raise exception 'Solo el gerente exporta datos' using errcode = '42501';
  end if;
  perform auditoria.anotar('EXPORTAR', 'movimientos', null, null,
                           jsonb_build_object('desde', p_desde, 'hasta', p_hasta));
  return query
    select m.creado_en, p.nombre, m.tipo, m.motivo_merma, m.cantidad, p.unidad_base,
           (select round(sum(ml.cantidad * cl.costo_unitario), 2) from public.movimiento_lotes ml
            join public.costos_lote cl on cl.lote_id = ml.lote_id where ml.movimiento_id = m.id),
           m.estado, uc.nombre || ' ' || uc.apellido, ua.nombre || ' ' || ua.apellido
    from public.movimientos m join public.productos p on p.id = m.producto_id
    left join public.usuarios uc on uc.id = m.creado_por
    left join public.usuarios ua on ua.id = m.aprobado_por
    where m.sucursal_id = app.sucursal_actual() and m.creado_en::date between p_desde and p_hasta
    order by m.creado_en;
end $$;

-- -----------------------------------------------------------------------------
-- 15. TRIGGERS
-- -----------------------------------------------------------------------------
-- Firma obligatoria (BEFORE). Nombre con prefijo "a_" para que corra antes que los demás.
do $$
declare t text;
begin
  foreach t in array array['usuarios','parametros','categorias','proveedores','ubicaciones',
    'productos','ordenes_compra','recepciones','movimientos','transferencias','conteos','recetas',
    'plantillas','checklist_ejecuciones','incidencias'] loop
    execute format('create trigger a_exigir_firma before insert or update or delete on public.%I
                    for each row execute function app.exigir_firma()', t);
  end loop;
end $$;

create trigger a_exigir_firma before insert or update or delete on public.dispositivos
  for each row execute function app.exigir_firma('id', 'dispositivos', 'ultimo_uso,bloqueado_hasta');

-- Tablas hijas: la firma es la del registro padre
create trigger a_exigir_firma before insert or update or delete on public.costos_producto
  for each row execute function app.exigir_firma('producto_id', 'costos_producto');
create trigger a_exigir_firma before insert or update or delete on public.orden_compra_lineas
  for each row execute function app.exigir_firma('orden_id', 'ordenes_compra');
create trigger a_exigir_firma before insert or update or delete on public.recepcion_lineas
  for each row execute function app.exigir_firma('recepcion_id', 'recepciones');
create trigger a_exigir_firma before insert or update or delete on public.transferencia_lineas
  for each row execute function app.exigir_firma('transferencia_id', 'transferencias');
create trigger a_exigir_firma before insert or update or delete on public.conteo_lineas
  for each row execute function app.exigir_firma('conteo_id', 'conteos');
create trigger a_exigir_firma before insert or update or delete on public.receta_insumos
  for each row execute function app.exigir_firma('receta_id', 'recetas');
create trigger a_exigir_firma before insert or update or delete on public.precios_venta
  for each row execute function app.exigir_firma('receta_id', 'precios_venta');
create trigger a_exigir_firma before insert or update or delete on public.plantilla_secciones
  for each row execute function app.exigir_firma('plantilla_id', 'plantillas');
create trigger a_exigir_firma before insert or update or delete on public.plantilla_items
  for each row execute function app.exigir_firma('plantilla_id', 'plantillas');
create trigger a_exigir_firma before insert or update or delete on public.checklist_respuestas
  for each row execute function app.exigir_firma('ejecucion_id', 'checklist_ejecuciones');

-- Reglas de negocio (BEFORE, después de la firma)
create trigger b_preparar before insert on public.movimientos
  for each row execute function app.preparar_movimiento();
create trigger b_proteger before update on public.movimientos
  for each row execute function app.proteger_movimiento();
create trigger c_aplicar after insert on public.movimientos
  for each row execute function app.despues_de_movimiento();
create trigger b_evaluar before insert on public.checklist_respuestas
  for each row execute function app.evaluar_respuesta();
create trigger c_incidencia after insert on public.checklist_respuestas
  for each row execute function app.respuesta_genera_incidencia();
create trigger b_proteger before update on public.checklist_ejecuciones
  for each row execute function app.proteger_ejecucion();
create trigger b_flujo before insert or update on public.incidencias
  for each row execute function app.flujo_incidencia();
create trigger c_despues after insert or update on public.incidencias
  for each row execute function app.despues_de_incidencia();
create trigger b_proteger before insert or update or delete on public.plantilla_items
  for each row execute function app.proteger_plantilla();
create trigger b_proteger before insert or update or delete on public.plantilla_secciones
  for each row execute function app.proteger_plantilla();
create trigger b_publicar before insert or update of vigente on public.plantillas
  for each row execute function app.publicar_version();

create or replace function app.sellar_evidencia() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if app.es_proceso_interno() then return NEW; end if;
  NEW.subida_por := app.usuario_actual();
  NEW.dispositivo_id := app.dispositivo_actual();
  NEW.creado_en := now();
  if not app.en_mi_sucursal(NEW.sucursal_id) then raise exception 'Sucursal no válida' using errcode = '42501'; end if;
  return NEW;
end $$;
create trigger b_sellar before insert on public.evidencias
  for each row execute function app.sellar_evidencia();

create or replace function app.proteger_alerta() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v public.alertas;
begin
  if app.es_proceso_interno() or app.contexto_confiable() then return NEW; end if;
  v := NEW; NEW := OLD;                -- desde la API solo se marca como vista
  if v.estado = 'vista' and OLD.estado = 'abierta' then
    NEW.estado := 'vista'; NEW.vista_por := app.usuario_actual(); NEW.vista_en := now();
  end if;
  return NEW;
end $$;
create trigger b_proteger before update on public.alertas
  for each row execute function app.proteger_alerta();

-- Auditoría (AFTER) en todas las tablas de negocio
do $$
declare t record;
begin
  for t in select * from (values
    ('usuarios','id'),('rol_permisos','rol'),('parametros','clave'),('dispositivos','id'),
    ('categorias','id'),('proveedores','id'),('ubicaciones','id'),('productos','id'),
    ('costos_producto','producto_id'),('lotes','id'),('costos_lote','lote_id'),('ordenes_compra','id'),
    ('orden_compra_lineas','id'),('recepciones','id'),('recepcion_lineas','id'),('movimientos','id'),
    ('transferencias','id'),('conteos','id'),('conteo_lineas','id'),('recetas','id'),
    ('receta_insumos','id'),('precios_venta','receta_id'),('plantillas','id'),
    ('plantilla_secciones','id'),('plantilla_items','id'),('checklist_ejecuciones','id'),
    ('checklist_respuestas','id'),('evidencias','id'),('incidencias','id')) as x(tabla, col)
  loop
    execute format('create trigger z_auditoria after insert or update or delete on public.%I
                    for each row execute function auditoria.registrar_cambio(%L)', t.tabla, t.col);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 16. ROW LEVEL SECURITY
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- Las funciones se envuelven en (select …) para que Postgres las evalúe una vez por consulta
-- Organización
create policy ver on public.sucursales for select to authenticated
  using ((select app.en_mi_sucursal(id)));
create policy gestionar on public.sucursales for all to authenticated
  using ((select app.tiene_permiso('parametros.gestionar')))
  with check ((select app.tiene_permiso('parametros.gestionar')));

create policy ver on public.roles        for select to authenticated using (true);
create policy ver on public.permisos     for select to authenticated using (true);
create policy ver on public.rol_permisos for select to authenticated using (true);
-- la matriz rol-permiso se cambia por migración, no desde la app

create policy ver on public.usuarios for select to authenticated
  using (auth_id = (select auth.uid())
         or ((select app.tiene_permiso('usuarios.ver')) and (select app.en_mi_sucursal(sucursal_id))));
create policy crear on public.usuarios for insert to authenticated
  with check ((select app.tiene_permiso('usuarios.gestionar')) and (select app.en_mi_sucursal(sucursal_id)));
create policy modificar on public.usuarios for update to authenticated
  using ((select app.tiene_permiso('usuarios.gestionar')) and (select app.en_mi_sucursal(sucursal_id)))
  with check ((select app.tiene_permiso('usuarios.gestionar')) and (select app.en_mi_sucursal(sucursal_id)));

create policy ver on public.parametros for select to authenticated using (true);
create policy modificar on public.parametros for update to authenticated
  using ((select app.tiene_permiso('parametros.gestionar')))
  with check ((select app.tiene_permiso('parametros.gestionar')));

create policy ver on public.dispositivos for select to authenticated
  using ((select app.tiene_permiso('usuarios.ver')) and (select app.en_mi_sucursal(sucursal_id)));
create policy modificar on public.dispositivos for update to authenticated
  using ((select app.tiene_permiso('dispositivos.gestionar')))
  with check ((select app.tiene_permiso('dispositivos.gestionar')));

create policy ver_propias on public.firmas for select to authenticated
  using (usuario_id = (select app.usuario_actual()) or (select app.tiene_permiso('auditoria.ver')));

-- Catálogo de inventario (sin costos: todos lo leen para registrar movimientos)
create policy ver on public.categorias for select to authenticated using (true);
create policy ver on public.unidades   for select to authenticated using (true);
create policy ver on public.productos  for select to authenticated using (not anulado);
create policy ver on public.proveedores for select to authenticated using (activo and not anulado);
create policy ver on public.ubicaciones for select to authenticated
  using ((select app.en_mi_sucursal(sucursal_id)));
do $$
declare t text;
begin
  foreach t in array array['categorias','unidades','productos','proveedores','ubicaciones'] loop
    execute format('create policy gestionar on public.%I for all to authenticated
      using ((select app.tiene_permiso(''inventario.catalogo.gestionar'')))
      with check ((select app.tiene_permiso(''inventario.catalogo.gestionar'')))', t);
  end loop;
end $$;

-- Solo gerente: costos, precios, compras
do $$
declare t text;
begin
  foreach t in array array['costos_producto','costos_lote','precios_venta'] loop
    execute format('create policy solo_gerente on public.%I for all to authenticated
      using ((select app.tiene_permiso(''inventario.costos.ver'')))
      with check ((select app.tiene_permiso(''inventario.costos.ver'')))', t);
  end loop;
  foreach t in array array['ordenes_compra','orden_compra_lineas'] loop
    execute format('create policy solo_gerente on public.%I for all to authenticated
      using ((select app.tiene_permiso(''compras.gestionar'')))
      with check ((select app.tiene_permiso(''compras.gestionar'')))', t);
  end loop;
end $$;

-- Existencias: supervisor y gerente
create policy ver on public.lotes for select to authenticated
  using ((select app.tiene_permiso('inventario.ver_stock')) and (select app.en_mi_sucursal(sucursal_id)));
create policy ver on public.movimiento_lotes for select to authenticated
  using ((select app.tiene_permiso('inventario.ver_stock')));

-- Movimientos: el operativo ve solo lo que él registró
create policy ver on public.movimientos for select to authenticated
  using ((select app.en_mi_sucursal(sucursal_id))
         and (creado_por = (select app.usuario_actual()) or (select app.tiene_permiso('inventario.ver_stock'))));
create policy crear on public.movimientos for insert to authenticated
  with check ((select app.tiene_permiso('inventario.movimientos.registrar'))
              and (select app.en_mi_sucursal(sucursal_id)));
create policy anular on public.movimientos for update to authenticated
  using ((select app.tiene_permiso('inventario.ajuste.aprobar')) and (select app.en_mi_sucursal(sucursal_id)))
  with check ((select app.tiene_permiso('inventario.ajuste.aprobar')) and (select app.en_mi_sucursal(sucursal_id)));

create policy ver on public.recepciones for select to authenticated
  using ((select app.en_mi_sucursal(sucursal_id))
         and (recibido_por = (select app.usuario_actual()) or (select app.tiene_permiso('inventario.ver_stock'))));
create policy ver on public.recepcion_lineas for select to authenticated
  using (exists (select 1 from public.recepciones r where r.id = recepcion_id));
create policy ver on public.transferencias for select to authenticated
  using ((select app.en_mi_sucursal(sucursal_id))
         and (enviado_por = (select app.usuario_actual()) or (select app.tiene_permiso('inventario.ver_stock'))));
create policy ver on public.transferencia_lineas for select to authenticated
  using (exists (select 1 from public.transferencias t where t.id = transferencia_id));

create policy ver on public.conteos for select to authenticated
  using ((select app.en_mi_sucursal(sucursal_id)));
create policy abrir on public.conteos for insert to authenticated
  with check ((select app.tiene_permiso('inventario.conteo.aprobar')) and (select app.en_mi_sucursal(sucursal_id)));
create policy ver on public.conteo_lineas for select to authenticated
  using (contado_por = (select app.usuario_actual()) or (select app.tiene_permiso('inventario.conteo.aprobar')));
create policy contar on public.conteo_lineas for insert to authenticated
  with check ((select app.tiene_permiso('inventario.conteo.contar'))
              and contado_por = (select app.usuario_actual())
              and exists (select 1 from public.conteos k where k.id = conteo_id and k.estado = 'abierto'));

-- Recetas: gramajes para todos, costos solo gerente (costo_receta)
create policy ver on public.recetas for select to authenticated
  using ((select app.tiene_permiso('recetas.ver')) and not anulado);
create policy ver on public.receta_insumos for select to authenticated
  using ((select app.tiene_permiso('recetas.ver')));
do $$
declare t text;
begin
  foreach t in array array['recetas','receta_insumos'] loop
    execute format('create policy gestionar on public.%I for all to authenticated
      using ((select app.tiene_permiso(''recetas.gestionar'')))
      with check ((select app.tiene_permiso(''recetas.gestionar'')))', t);
  end loop;
end $$;
create policy ver on public.ventas_diarias for select to authenticated
  using ((select app.tiene_permiso('reportes.operativos')) and (select app.en_mi_sucursal(sucursal_id)));

-- Checklists: cada rol ve las planillas de su nivel o inferior
create policy ver on public.plantillas for select to authenticated
  using ((select app.tiene_permiso('checklists.plantillas.gestionar'))
         or (vigente and not anulado
             and (select nivel from public.roles r where r.codigo = rol_asignado) <= (select app.nivel_actual())));
create policy ver on public.plantilla_secciones for select to authenticated
  using (exists (select 1 from public.plantillas p where p.id = plantilla_id));
create policy ver on public.plantilla_items for select to authenticated
  using (exists (select 1 from public.plantillas p where p.id = plantilla_id));
do $$
declare t text;
begin
  foreach t in array array['plantillas','plantilla_secciones','plantilla_items'] loop
    execute format('create policy gestionar on public.%I for all to authenticated
      using ((select app.tiene_permiso(''checklists.plantillas.gestionar'')))
      with check ((select app.tiene_permiso(''checklists.plantillas.gestionar'')))', t);
  end loop;
end $$;

create policy ver on public.checklist_programacion for select to authenticated
  using ((select app.en_mi_sucursal(sucursal_id))
         and exists (select 1 from public.plantillas p where p.id = plantilla_id));

create policy ver on public.checklist_ejecuciones for select to authenticated
  using ((select app.en_mi_sucursal(sucursal_id))
         and (realizada_por = (select app.usuario_actual()) or (select app.tiene_permiso('checklists.ver_todos'))));
create policy revisar on public.checklist_ejecuciones for update to authenticated
  using ((select app.tiene_permiso('checklists.revisar')) and (select app.en_mi_sucursal(sucursal_id)))
  with check ((select app.tiene_permiso('checklists.revisar')) and (select app.en_mi_sucursal(sucursal_id)));
create policy ver on public.checklist_respuestas for select to authenticated
  using (exists (select 1 from public.checklist_ejecuciones e where e.id = ejecucion_id));

create policy ver on public.evidencias for select to authenticated
  using ((select app.en_mi_sucursal(sucursal_id))
         and (subida_por = (select app.usuario_actual()) or (select app.tiene_permiso('checklists.ver_todos'))));
create policy subir on public.evidencias for insert to authenticated
  with check ((select app.en_mi_sucursal(sucursal_id)));

create policy ver on public.incidencias for select to authenticated
  using ((select app.en_mi_sucursal(sucursal_id))
         and (reportada_por = (select app.usuario_actual()) or asignada_a = (select app.usuario_actual())
              or (select app.tiene_permiso('incidencias.gestionar'))));
create policy reportar on public.incidencias for insert to authenticated
  with check ((select app.tiene_permiso('incidencias.reportar')) and (select app.en_mi_sucursal(sucursal_id)));
create policy gestionar on public.incidencias for update to authenticated
  using ((select app.tiene_permiso('incidencias.gestionar')) and (select app.en_mi_sucursal(sucursal_id)))
  with check ((select app.tiene_permiso('incidencias.gestionar')) and (select app.en_mi_sucursal(sucursal_id)));

-- Alertas: las de mi rol o inferiores, o dirigidas a mí
create policy ver on public.alertas for select to authenticated
  using ((select app.en_mi_sucursal(sucursal_id))
         and (usuario_destino = (select app.usuario_actual())
              or (usuario_destino is null
                  and (select nivel from public.roles r where r.codigo = rol_destino) <= (select app.nivel_actual()))));
create policy marcar_vista on public.alertas for update to authenticated
  using ((select app.en_mi_sucursal(sucursal_id))
         and (usuario_destino = (select app.usuario_actual())
              or (select nivel from public.roles r where r.codigo = rol_destino) <= (select app.nivel_actual())));

create policy propias on public.suscripciones_push for all to authenticated
  using (usuario_id = (select app.usuario_actual()))
  with check (usuario_id = (select app.usuario_actual()));

-- -----------------------------------------------------------------------------
-- 17. PRIVILEGIOS (la API anónima no ve nada; nadie borra)
-- -----------------------------------------------------------------------------
revoke all on all tables    in schema public    from anon, authenticated;
revoke all on all sequences in schema public    from anon, authenticated;
revoke all on all functions in schema public    from public, anon, authenticated;
revoke all on all functions in schema app       from public;
revoke all on all functions in schema privado   from public;
revoke all on all functions in schema auditoria from public;
revoke all on all tables    in schema privado, auditoria from public;

grant select on all tables in schema public to authenticated;     -- RLS decide qué filas
grant insert, update on public.movimientos, public.incidencias, public.conteos,
  public.suscripciones_push, public.usuarios, public.parametros, public.categorias,
  public.productos, public.proveedores, public.ubicaciones, public.costos_producto,
  public.ordenes_compra, public.orden_compra_lineas, public.recetas, public.receta_insumos,
  public.precios_venta, public.plantillas, public.plantilla_secciones, public.plantilla_items
  to authenticated;
grant insert on public.evidencias, public.conteo_lineas to authenticated;
grant update (estado, nota_revision, firma_id) on public.checklist_ejecuciones to authenticated;
grant update (estado) on public.alertas to authenticated;
grant update (nombre, activo, firma_id) on public.dispositivos to authenticated;
grant delete on public.suscripciones_push to authenticated;

-- Funciones que usa RLS (se ejecutan como quien consulta)
grant execute on function app.claims(), app.es_proceso_interno(), app.contexto_confiable(),
  app.usuario_actual(), app.rol_actual(), app.nivel_actual(), app.sucursal_actual(),
  app.tiene_permiso(text), app.es_admin(), app.en_mi_sucursal(uuid), app.dispositivo_actual()
  to authenticated;

-- RPC expuestas a la app
grant execute on function public.firmar(text, public.accion_firma, text, uuid),
  public.regenerar_mi_pin(text),
  public.asignar_pin(uuid, int, uuid),
  public.registrar_dispositivo(uuid, text, text, uuid),
  public.resolver_aprobacion(uuid, text, boolean, text),
  public.registrar_recepcion(jsonb, jsonb, uuid),
  public.registrar_transferencia(uuid, uuid, uuid, jsonb, uuid, text),
  public.aprobar_conteo(uuid, text),
  public.enviar_checklist(jsonb, jsonb, uuid),
  public.nueva_version_plantilla(uuid, uuid, uuid),
  public.kpi_tablero(date, date, uuid),
  public.consumo_teorico_vs_real(date, date),
  public.costo_receta(uuid),
  public.consultar_auditoria(timestamptz, timestamptz, text, uuid, int),
  public.exportar_movimientos(date, date)
  to authenticated;

-- Solo Edge Functions con service_role
grant execute on function privado.abrir_sesion_por_pin(uuid, text, text),
  public.registrar_firma_sin_conexion(uuid, uuid, public.accion_firma, text, uuid, timestamptz)
  to service_role;

-- Lo que se cree después tampoco queda abierto por defecto
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 18. SOLO EN SUPABASE: Storage, pg_cron y GraphQL
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public) values ('evidencias', 'evidencias', false)
    on conflict (id) do nothing;
    -- ruta: <sucursal_id>/<aaaa>/<mm>/<uuid>.webp · se sube, no se reemplaza ni se borra
    execute $p$create policy evidencias_subir on storage.objects for insert to authenticated
      with check (bucket_id = 'evidencias'
                  and (storage.foldername(name))[1] = (select app.sucursal_actual())::text)$p$;
    execute $p$create policy evidencias_ver on storage.objects for select to authenticated
      using (bucket_id = 'evidencias'
             and (owner = (select auth.uid())
                  or ((select app.tiene_permiso('checklists.ver_todos'))
                      and (storage.foldername(name))[1] = (select app.sucursal_actual())::text)))$p$;
  end if;

  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('programar-planillas', '5 4 * * *',   $c$select app.generar_programacion(current_date)$c$);
    perform cron.schedule('planillas-vencidas',  '*/15 * * * *', $c$select app.alertar_checklists_vencidos()$c$);
    perform cron.schedule('escalar-incidencias', '*/5 * * * *',  $c$select app.escalar_incidencias()$c$);
    perform cron.schedule('vencimientos',        '0 10,19 * * *', $c$select app.revisar_vencimientos()$c$);  -- 06:00 y 15:00 VET
  end if;

  -- La app usa PostgREST; si GraphQL no se usa, se retira para no abrir otra puerta
  if exists (select 1 from pg_extension where extname = 'pg_graphql') then
    begin
      execute 'drop extension pg_graphql';
    exception when others then
      raise notice 'Desactive GraphQL desde el panel de Supabase: %', sqlerrm;
    end;
  end if;
end $$;
