-- =============================================================================
-- Totos Control · datos base: roles, permisos, unidades, parámetros, sucursal
-- =============================================================================
insert into public.roles (codigo, nombre, nivel) values
  ('operativo',  'Operativo (personal de línea)', 10),
  ('supervisor', 'Supervisor de turno',            20),
  ('admin',      'Gerente / Administrador',        30);

insert into public.permisos (codigo, modulo, descripcion) values
  ('checklists.ejecutar',              'checklists', 'Llenar y firmar las planillas asignadas a su rol'),
  ('checklists.ver_todos',             'checklists', 'Ver las planillas de toda la sucursal'),
  ('checklists.revisar',               'checklists', 'Revisar u observar planillas llenadas por otros'),
  ('checklists.plantillas.gestionar',  'checklists', 'Crear, versionar y publicar plantillas'),
  ('incidencias.reportar',             'incidencias', 'Reportar una incidencia'),
  ('incidencias.gestionar',            'incidencias', 'Asignar y resolver incidencias'),
  ('incidencias.verificar',            'incidencias', 'Verificar y cerrar incidencias críticas'),
  ('inventario.movimientos.registrar', 'inventario', 'Registrar mermas y salidas a producción'),
  ('inventario.recepcion.registrar',   'inventario', 'Recibir mercancía (a ciegas)'),
  ('inventario.transferencia.registrar','inventario', 'Mover mercancía entre ubicaciones'),
  ('inventario.conteo.contar',         'inventario', 'Registrar cantidades en un conteo abierto'),
  ('inventario.conteo.aprobar',        'inventario', 'Abrir y aprobar conteos físicos'),
  ('inventario.ver_stock',             'inventario', 'Ver existencias, lotes y movimientos de todos'),
  ('inventario.ajuste.aprobar',        'inventario', 'Aprobar mermas y ajustes, anular movimientos'),
  ('inventario.catalogo.gestionar',    'inventario', 'Gestionar productos, proveedores y ubicaciones'),
  ('inventario.costos.ver',            'finanzas',   'Ver y editar costos y precios de venta'),
  ('compras.gestionar',                'finanzas',   'Crear y aprobar órdenes de compra con precios'),
  ('recetas.ver',                      'recetas',    'Ver fichas técnicas con gramajes (sin costos)'),
  ('recetas.gestionar',                'recetas',    'Crear y editar fichas técnicas'),
  ('reportes.operativos',              'reportes',   'Ver indicadores operativos y consumo teórico vs real'),
  ('reportes.financieros',             'reportes',   'Ver valor del inventario, mermas en USD y food cost'),
  ('datos.exportar',                   'reportes',   'Exportar datos (queda en la auditoría)'),
  ('usuarios.ver',                     'seguridad',  'Ver el personal y los dispositivos de la sucursal'),
  ('usuarios.gestionar',               'seguridad',  'Crear usuarios y asignar PIN'),
  ('dispositivos.gestionar',           'seguridad',  'Registrar y bloquear dispositivos'),
  ('auditoria.ver',                    'seguridad',  'Consultar la bitácora de auditoría'),
  ('parametros.gestionar',             'seguridad',  'Cambiar parámetros del sistema');

insert into public.rol_permisos (rol, permiso)
select 'admin', codigo from public.permisos
union all
select 'supervisor', unnest(array[
  'checklists.ejecutar','checklists.ver_todos','checklists.revisar',
  'incidencias.reportar','incidencias.gestionar',
  'inventario.movimientos.registrar','inventario.recepcion.registrar','inventario.transferencia.registrar',
  'inventario.conteo.contar','inventario.conteo.aprobar','inventario.ver_stock','inventario.ajuste.aprobar',
  'recetas.ver','reportes.operativos','usuarios.ver'])
union all
select 'operativo', unnest(array[
  'checklists.ejecutar','incidencias.reportar',
  'inventario.movimientos.registrar','inventario.recepcion.registrar','inventario.transferencia.registrar',
  'inventario.conteo.contar','recetas.ver']);

insert into public.unidades (codigo, nombre, magnitud, factor_a_base) values
  ('g', 'gramo', 'masa', 1), ('kg', 'kilogramo', 'masa', 1000),
  ('ml', 'mililitro', 'volumen', 1), ('L', 'litro', 'volumen', 1000),
  ('u', 'unidad', 'unidad', 1), ('docena', 'docena', 'unidad', 12);

insert into public.parametros (clave, valor, descripcion) values
  ('pin.max_intentos',              '5',    'Intentos fallidos seguidos antes de bloquear el PIN'),
  ('pin.minutos_bloqueo',           '15',   'Minutos de bloqueo del PIN'),
  ('firma.segundos_vigencia',       '120',  'Segundos que dura una firma antes de usarse'),
  ('dispositivo.max_fallos_5min',   '10',   'Fallos de PIN en 5 minutos que bloquean el dispositivo'),
  ('sesion.segundos_inactividad',   '90',   'La tablet vuelve a la pantalla de PIN tras este tiempo'),
  ('merma.umbral_aprobacion_usd',   '10',   'Mermas desde este valor requieren aprobación del supervisor'),
  ('merma.meta_pct_ventas',         '2',    'Meta de merma como % de ventas (POE 07)'),
  ('recepcion.temp_max_refrigerado','5',    'Límite de llegada para refrigerados, °C (POE 13)'),
  ('recepcion.temp_max_congelado',  '-18',  'Límite de llegada para congelados, °C (POE 13)'),
  ('recepcion.tolerancia_pct',      '2',    'Diferencia aceptada contra la orden de compra, %'),
  ('alerta.dias_vencimiento',       '3',    'Días de anticipación de la alerta de vencimiento'),
  ('caja.tolerancia_usd',           '2',    'Diferencia de caja aceptada por turno (POE 11)'),
  ('incidencia.sla_minutos',        '{"critica":30,"alta":120,"media":1440,"baja":4320}', 'Plazo de atención por severidad'),
  ('horarios.alias',                '{"Apertura":"11:00","Cierre":"23:30"}', 'Hora de los horarios con nombre');

insert into public.sucursales (id, nombre, direccion)
values ('5b1e0000-0000-4000-8000-000000000001', 'Totos Burger Alta Vista', 'Alta Vista');

insert into public.ubicaciones (sucursal_id, nombre, tipo) values
  ('5b1e0000-0000-4000-8000-000000000001', 'Cava de refrigeración', 'cava_refrigeracion'),
  ('5b1e0000-0000-4000-8000-000000000001', 'Cava de congelación',   'cava_congelacion'),
  ('5b1e0000-0000-4000-8000-000000000001', 'Depósito seco',         'almacen_seco'),
  ('5b1e0000-0000-4000-8000-000000000001', 'Línea caliente',        'linea'),
  ('5b1e0000-0000-4000-8000-000000000001', 'Producción',            'produccion'),
  ('5b1e0000-0000-4000-8000-000000000001', 'Barra de bebidas',      'barra'),
  ('5b1e0000-0000-4000-8000-000000000001', 'Químicos',              'quimicos');
