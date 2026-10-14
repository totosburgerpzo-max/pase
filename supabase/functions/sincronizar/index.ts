// Envía lo que se firmó sin internet, uno por uno, cuando la tablet vuelve a tener conexión.
// POST multipart: "envio" (JSON) + una parte por foto, con el id de la evidencia como nombre.
//   envio = { dispositivo, secreto, tipo: 'planilla' | 'incidencia', usuario_id, firmada_en,
//             planilla?: { ejecucion, respuestas, evidencias }, incidencia?: { incidencia, evidencia } }
// La base comprueba el secreto del equipo, que esa persona entró con su PIN en este equipo en
// los últimos días y que la firma tiene menos de 72 horas. Después se abre una sesión de esa
// persona solo para este envío: las fotos y el registro quedan a su nombre, con sus permisos.
import {
  abrirSesion, cerrarSesion, ErrorPase, json, rpc, servir, subirFoto, texto, uuid,
} from '../_compartido/mod.ts';

interface Evidencia { id: string; ruta: string }

servir(async (req) => {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new ErrorPase(400, 'Envío no válido');
  }
  let e: Record<string, any>;
  try {
    e = JSON.parse(String(form.get('envio') ?? ''));
  } catch {
    throw new ErrorPase(400, 'Falta el envío');
  }
  const dispositivo = uuid(e.dispositivo, 'el equipo');
  const secreto = texto(e.secreto, 'el secreto del equipo');
  const usuario = uuid(e.usuario_id, 'la persona');
  const firmadaEn = new Date(texto(e.firmada_en, 'la hora de la firma', 40));
  if (isNaN(firmadaEn.getTime())) throw new ErrorPase(400, 'Hora de la firma no válida');

  let entidad: string, entidadId: string, evidencias: Evidencia[];
  if (e.tipo === 'planilla') {
    entidad = 'checklist_ejecuciones';
    entidadId = uuid(e.planilla?.ejecucion?.id, 'la planilla');
    evidencias = Array.isArray(e.planilla?.evidencias) ? e.planilla.evidencias : [];
  } else if (e.tipo === 'incidencia') {
    entidad = 'incidencias';
    entidadId = uuid(e.incidencia?.incidencia?.id, 'la incidencia');
    evidencias = e.incidencia?.evidencia ? [e.incidencia.evidencia] : [];
  } else {
    throw new ErrorPase(400, 'Tipo de envío no válido');
  }
  for (const ev of evidencias) {
    uuid(ev?.id, 'el id de la foto');
    if (typeof ev.ruta !== 'string' || !/^[0-9a-f-]{36}\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.(webp|jpg)$/i.test(ev.ruta)) {
      throw new ErrorPase(400, 'Ruta de foto no válida');
    }
  }

  const f = await rpc<{ ok: boolean; motivo?: string; firma_id: string; correo: string }>(req, 'sincronizar_firma', {
    p_dispositivo: dispositivo, p_secreto: secreto, p_usuario: usuario, p_accion: 'crear',
    p_entidad: entidad, p_entidad_id: entidadId, p_firmada_en: firmadaEn.toISOString(),
  });
  // Rechazos definitivos: la app los deja a la vista del supervisor en vez de reintentar
  if (!f.ok) return json(req, { ok: false, motivo: f.motivo }, 422);

  const s = await abrirSesion(f.correo);
  try {
    await rpc(req, 'pin_vincular_sesion', {
      p_session: s.session_id, p_dispositivo: dispositivo, p_usuario: usuario, p_metodo: 'sincronizacion',
    });
    for (const ev of evidencias) {
      const foto = form.get(ev.id);
      if (foto instanceof Blob) await subirFoto(ev.ruta, foto, s.access_token);
    }
    const resultado = e.tipo === 'planilla'
      ? await rpc(req, 'enviar_planilla', {
        p_ejecucion: { ...e.planilla.ejecucion, sin_conexion: true, completada_en: e.planilla.ejecucion.completada_en ?? firmadaEn.toISOString() },
        p_respuestas: e.planilla.respuestas ?? [],
        p_evidencias: evidencias,
        p_firma: f.firma_id,
      }, s.access_token)
      : await rpc(req, 'reportar_incidencia', {
        p_incidencia: e.incidencia.incidencia,
        p_evidencia: e.incidencia.evidencia ?? null,
        p_firma: f.firma_id,
      }, s.access_token);
    return json(req, { ok: true, resultado });
  } finally {
    await rpc(req, 'cerrar_sesion_equipo', {}, s.access_token).catch(() => {});
    await cerrarSesion(s.access_token);
  }
});
