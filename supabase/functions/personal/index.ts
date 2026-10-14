// Alta de una persona del equipo. La hace la gerente desde la app, con su sesión y su firma.
// POST { usuario: {id, nombre, apellido, cedula?, cargo?, rol, turno?}, longitud?, firma }
//   → { ok, usuario_id, pin_provisional }
// Crea la cuenta de Supabase Auth (un correo interno que no recibe mensajes; la persona entra
// solo con su PIN) y luego la ficha en la base, que valida permiso y firma con el token de quien
// llama. Si la ficha falla, la cuenta se borra.
import {
  borrarCuenta, crearCuenta, DOMINIO_CORREO, ErrorPase, json, leerJson, rpc, servir, tokenDe, uuid,
} from '../_compartido/mod.ts';

servir(async (req) => {
  const token = tokenDe(req);
  if (!token) throw new ErrorPase(401, 'Inicia sesión');
  const b = await leerJson(req);
  const u = (b.usuario ?? {}) as Record<string, unknown>;
  const id = uuid(u.id, 'el id de la persona');
  const firma = uuid(b.firma, 'la firma');

  // Antes de crear nada en Auth: ¿quien llama puede dar de alta personal?
  const ctx = await rpc<{ permisos: string[] } | null>(req, 'pase_contexto', {}, token);
  if (!ctx?.permisos?.includes('usuarios.gestionar')) throw new ErrorPase(403, 'Sin permiso para gestionar el personal');

  const authId = await crearCuenta(`${id}@${DOMINIO_CORREO}`);
  try {
    const r = await rpc<{ ok: boolean; usuario_id: string; pin_provisional: string }>(req, 'crear_usuario', {
      p_usuario: {
        id, nombre: u.nombre, apellido: u.apellido, cedula: u.cedula, cargo: u.cargo, rol: u.rol, turno: u.turno,
      },
      p_auth_id: authId,
      p_longitud: b.longitud ?? 4,
      p_firma: firma,
    }, token);
    return json(req, r);
  } catch (e) {
    await borrarCuenta(authId);
    throw e;
  }
});
