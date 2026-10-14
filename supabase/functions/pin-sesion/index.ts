// Ingreso con PIN en un equipo registrado (Quick Switch).
// POST { dispositivo, secreto, pin } → { ok, sesion, usuario, dispositivo }
// La base valida el secreto del equipo y el PIN (con bloqueo por intentos); si pasa, se abre
// una sesión de Supabase Auth de esa persona y se ata a este equipo. Sin esa atadura la sesión
// no ve nada (app.sesion_valida).
import { abrirSesion, ErrorPase, json, leerJson, rpc, servir, texto, uuid } from '../_compartido/mod.ts';

interface Apertura {
  ok: boolean;
  motivo?: string;
  hasta?: string;
  usuario_id: string;
  rol: string;
  nombre: string;
  debe_cambiar_pin: boolean;
  correo: string;
  dispositivo: { id: string; nombre: string; tipo: string };
}

servir(async (req) => {
  const b = await leerJson(req);
  const dispositivo = uuid(b.dispositivo, 'el equipo');
  const secreto = texto(b.secreto, 'el secreto del equipo');
  const pin = String(b.pin ?? '');
  if (!/^\d{4,6}$/.test(pin)) throw new ErrorPase(400, 'El PIN tiene de 4 a 6 dígitos', 'pin_incorrecto');

  const r = await rpc<Apertura>(req, 'pin_abrir_sesion', { p_dispositivo: dispositivo, p_secreto: secreto, p_pin: pin });
  if (!r.ok) {
    const estado = r.motivo === 'pin_incorrecto' ? 401 : r.motivo === 'dispositivo_bloqueado' ? 423 : 403;
    return json(req, { ok: false, motivo: r.motivo, hasta: r.hasta }, estado);
  }

  const s = await abrirSesion(r.correo);
  await rpc(req, 'pin_vincular_sesion', {
    p_session: s.session_id, p_dispositivo: dispositivo, p_usuario: r.usuario_id, p_metodo: 'pin',
  });
  return json(req, {
    ok: true,
    sesion: { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at },
    usuario: { id: r.usuario_id, nombre: r.nombre, rol: r.rol, debe_cambiar_pin: r.debe_cambiar_pin },
    dispositivo: r.dispositivo,
  });
});
