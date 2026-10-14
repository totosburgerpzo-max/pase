// Lo firmado sin internet espera aquí y se envía, uno por uno, a la función "sincronizar"
// cuando vuelve la conexión. Si el servidor lo rechaza (p. ej. pasaron más de 72 horas),
// queda a la vista del supervisor con el motivo, en vez de reintentarse para siempre.
import { ErrorApi, funcionFormulario } from './api';
import { borrar, guardar, todos, type EquipoLocal } from './local';
import { leerFoto } from './fotos';

export interface EnvioPendiente {
  id: string;
  tipo: 'planilla' | 'incidencia';
  titulo: string;
  usuario_id: string;
  usuario_nombre: string;
  firmada_en: string;
  planilla?: { ejecucion: Record<string, unknown>; respuestas: Record<string, unknown>[]; evidencias: { id: string; ruta: string }[] };
  incidencia?: { incidencia: Record<string, unknown>; evidencia: { id: string; ruta: string } | null };
  fotos: string[];
  estado: 'pendiente' | 'rechazado';
  motivo?: string;
  intentos: number;
  ultimo_intento?: string;
}

export const MOTIVOS: Record<string, string> = {
  dispositivo_no_registrado: 'El equipo ya no está registrado',
  usuario_no_valido: 'La persona ya no está activa',
  fuera_de_plazo: 'Pasaron más de 72 horas desde la firma',
  sin_ingreso_reciente: 'La persona no había entrado en este equipo en los últimos días',
};

export async function encolar(e: Omit<EnvioPendiente, 'estado' | 'intentos'>) {
  await guardar('cola', e.id, { ...e, estado: 'pendiente', intentos: 0 } satisfies EnvioPendiente);
}
export const pendientes = async () =>
  (await todos<EnvioPendiente>('cola')).map((x) => x.valor).sort((a, b) => a.firmada_en.localeCompare(b.firmada_en));

export async function descartar(id: string) {
  const e = (await todos<EnvioPendiente>('cola')).find((x) => x.clave === id)?.valor;
  if (!e) return;
  for (const f of e.fotos) await borrar('fotos', f);
  await borrar('cola', id);
}

let enCurso: Promise<{ enviados: number; rechazados: number; quedan: number }> | null = null;

/** Envía lo pendiente. Se detiene en el primer corte de red y lo deja para después. */
export function sincronizar(equipo: EquipoLocal) {
  enCurso ??= (async () => {
    let enviados = 0, rechazados = 0;
    try {
      for (const e of await pendientes()) {
        if (e.estado !== 'pendiente') continue;
        const datos = new FormData();
        const { fotos, estado: _e, motivo: _m, intentos: _i, titulo: _t, usuario_nombre: _u, ultimo_intento: _x, id: _id, ...resto } = e;
        datos.set('envio', JSON.stringify({ ...resto, dispositivo: equipo.id, secreto: equipo.secreto }));
        for (const id of fotos) {
          const f = await leerFoto(id);
          if (f) datos.set(id, f.blob, `${id}.${f.mime === 'image/webp' ? 'webp' : 'jpg'}`);
        }
        try {
          await funcionFormulario('sincronizar', datos);
          for (const id of fotos) await borrar('fotos', id);
          await borrar('cola', e.id);
          enviados++;
        } catch (err) {
          if (!(err instanceof ErrorApi) || err.red || err.estado >= 500 || err.estado === 429) {
            await guardar('cola', e.id, { ...e, intentos: e.intentos + 1, ultimo_intento: new Date().toISOString() });
            break;
          }
          const motivo = err.datos?.motivo ? MOTIVOS[err.datos.motivo] ?? err.datos.motivo : err.message;
          await guardar('cola', e.id, { ...e, estado: 'rechazado', motivo, intentos: e.intentos + 1, ultimo_intento: new Date().toISOString() });
          rechazados++;
        }
      }
    } finally {
      enCurso = null;
    }
    const quedan = (await pendientes()).length;
    return { enviados, rechazados, quedan };
  })();
  return enCurso;
}
