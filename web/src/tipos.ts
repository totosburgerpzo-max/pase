// Lo que devuelve la API de Pase (funciones pase_* de la migración 20261014000004)

export type Rol = 'operativo' | 'supervisor' | 'admin';
export type Severidad = 'critica' | 'alta' | 'media' | 'baja';
export type EstadoIncidencia = 'abierta' | 'en_proceso' | 'resuelta' | 'verificada' | 'anulada';
export type EstadoEjecucion = 'completada' | 'revisada' | 'observada' | 'anulada';
export type AccionFirma = 'crear' | 'modificar' | 'anular' | 'aprobar' | 'rechazar';
export type TipoCampo = 'pass_fail' | 'number' | 'text' | 'choice' | 'photo' | 'time';
export type TipoEquipo = 'tablet_cocina' | 'tablet_caja' | 'telefono' | 'pc_gerencia';

export interface Contexto {
  usuario: { id: string; nombre: string; apellido: string; rol: Rol; nivel: number; cargo: string | null; turno: string | null; sucursal_id: string };
  permisos: string[];
  pin: { longitud: number; debe_cambiar: boolean } | null;
  sucursal: { id: string; nombre: string; zona_horaria: string };
  dispositivo: { id: string; nombre: string; tipo: TipoEquipo } | null;
  parametros: Record<string, any>;
  aal: string;
  hora_servidor: string;
}

export interface Item {
  id: string; ref: string; texto: string; tipo: TipoCampo; critico: boolean; unidad: string | null;
  min: number | null; max: number | null; opciones: string[] | null; foto_si_falla: boolean; admite_na: boolean; ayuda: string | null;
}
export interface Seccion { id: string; orden: number; titulo: string; hora: string | null; items: Item[] }
export interface Plantilla {
  id: string; codigo: string; nombre: string; area: string; tipo: string; frecuencia: string; horarios: string[];
  rol_asignado: Rol; rol_revisor: Rol; bloquea: boolean; minutos: number | null; version: number;
  objetivo: string | null; documento: string | null; secciones: Seccion[];
}

export interface Programada {
  id: string; plantilla_id: string; codigo: string; nombre: string; area: string; rol_asignado: Rol;
  minutos: number | null; bloquea: boolean; horario: string; desde: string; vence_en: string;
  ejecucion_id: string | null; hecha_en: string | null; hecha_por: string | null; hecha_por_id: string | null;
  puntaje: number | null; no_cumple: number | null; criticos: number | null;
}
export interface Hoy { fecha: string; ahora: string; programadas: Programada[] }

export interface EjecucionResumen {
  id: string; plantilla_id: string; codigo: string; nombre: string; area: string; horario: string;
  completada_en: string; realizada_por: string; realizada_por_nombre: string; estado: EstadoEjecucion;
  puntaje: number | null; total: number; cumple: number; no_cumple: number; criticos: number; sin_conexion: boolean;
  revisada_por_nombre: string | null; revisada_en: string | null; nota_revision: string | null; rol_revisor: Rol;
}
export interface Evidencia { id: string; ruta: string; mime: string }
export interface Respuesta {
  item_id: string; ref: string; texto: string; tipo: TipoCampo; seccion: string; critico: boolean; unidad: string | null;
  min: number | null; max: number | null; valor_bool: boolean | null; valor_num: number | null; valor_texto: string | null;
  valor_opcion: string | null; valor_hora: string | null; no_aplica: boolean; observacion: string | null;
  cumple: boolean | null; evidencia: Evidencia | null;
}
export interface Ejecucion extends EjecucionResumen {
  version: number; iniciada_en: string | null; dispositivo: string | null;
  firma: { id: string; metodo: string; firmante: string; creada_en: string; firmada_sin_conexion_en: string | null } | null;
  respuestas: Respuesta[]; incidencias: Incidencia[];
}

export interface Incidencia {
  id: string; titulo: string; descripcion: string | null; area: string | null; origen: string; severidad: Severidad;
  estado: EstadoIncidencia; bloquea: boolean; escalada: boolean; reportada_en: string; vence_en: string | null;
  reportada_por: string | null; reportada_por_nombre: string | null; asignada_a: string | null; asignada_a_nombre: string | null;
  accion_correctiva: string | null; causa_raiz: string | null; resuelta_en: string | null; resuelta_por: string | null;
  resuelta_por_nombre: string | null; verificada_en: string | null; verificada_por_nombre: string | null;
  ejecucion_id: string | null; codigo_plantilla: string | null; nombre_plantilla: string | null; ref_item: string | null;
  evidencia: Evidencia | null;
}

export interface Alerta {
  id: string; tipo: string; severidad: Severidad; estado: 'abierta' | 'vista' | 'resuelta'; titulo: string;
  detalle: string | null; creada_en: string; incidencia_id: string | null; vista_por_nombre: string | null;
}

export interface Panel {
  fecha: string; ahora: string;
  programadas: { total: number; hechas: number; vencidas: number; pendientes: number };
  vencidas: { id: string; codigo: string; nombre: string; area: string; horario: string; vence_en: string; rol_asignado: Rol; bloquea: boolean }[];
  por_area: { area: string; total: number; hechas: number; pct: number | null }[];
  por_revisar: { id: string; codigo: string; nombre: string; realizada_por_nombre: string; completada_en: string; puntaje: number | null; no_cumple: number; criticos: number; sin_conexion: boolean; propia: boolean }[];
  incidencias: { activas: number; criticas: number; bloquean: number; por_verificar: number; fuera_de_plazo: number };
  alertas_abiertas: number;
  tendencia: { fecha: string; pct: number | null; puntaje: number | null }[];
}

export interface Persona {
  id: string; nombre: string; apellido: string; cedula: string | null; cargo: string | null; rol: Rol; turno: string | null;
  activo: boolean; correo: string | null; creado_en: string; tiene_pin: boolean; pin_longitud: number | null;
  debe_cambiar_pin: boolean; pin_bloqueado_hasta: string | null; ultimo_ingreso: string | null;
}

export interface Equipo {
  id: string; nombre: string; tipo: TipoEquipo; activo: boolean; este: boolean; ultimo_uso: string | null;
  registrado_en: string; bloqueado_hasta: string | null; registrado_por_nombre: string | null;
}

export interface RegistroBitacora {
  id: number; ocurrido_en: string; usuario: string | null; rol: string | null; accion: string; tabla: string;
  registro_id: string | null; antes: any; despues: any; campos: string[] | null; metodo: string | null;
  dispositivo: string | null; ip: string | null; sesion: string | null; hash: string;
}
