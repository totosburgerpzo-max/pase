// Pruebas de punta a punta de la API contra el Supabase local (sh local/iniciar.sh):
// Auth real (GoTrue), PostgREST, Storage simulado y las Edge Functions, como lo usa la app.
// Usa los datos de demostración (local/sembrar.mjs) y crea lo suyo con ids nuevos, así que
// se puede correr varias veces sobre la misma base.
import { createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';
import { DEMO } from '../local/sembrar.mjs';

const URL_API = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const llaves = Object.fromEntries(fs.readFileSync('/tmp/pase-local/llaves.env', 'utf8')
  .split('\n').filter(Boolean).map((l) => l.split('=')));
const ANON = llaves.ANON_KEY;
const SERVICIO = llaves.SERVICE_ROLE_KEY;
const db = new pg.Client({ host: '127.0.0.1', port: 54322, user: 'postgres', database: 'postgres' });
await db.connect();

let fallas = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log(`OK  ${msg}`);
  else { fallas++; console.log(`MAL ${msg}`, extra === undefined ? '' : JSON.stringify(extra)); }
};

/* ---------- cliente mínimo (lo mismo que hace web/src/api) ---------- */
async function pedir(ruta, { metodo = 'POST', cuerpo, token, tipo = 'application/json', apikey = ANON } = {}) {
  const r = await fetch(`${URL_API}${ruta}`, {
    method: metodo,
    headers: { apikey, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cuerpo !== undefined ? { 'content-type': tipo } : {}) },
    body: cuerpo === undefined ? undefined : tipo === 'application/json' ? JSON.stringify(cuerpo) : cuerpo,
  });
  const texto = await r.text();
  let j = null;
  try { j = texto ? JSON.parse(texto) : null; } catch { j = texto; }
  return { estado: r.status, j, crudo: texto };
}
const rpc = (nombre, args, token) => pedir(`/rest/v1/rpc/${nombre}`, { cuerpo: args ?? {}, token });
const fn = (nombre, cuerpo, token) => pedir(`/functions/v1/${nombre}`, { cuerpo, token });
const pinSesion = (pin, disp = DEMO.tablet) => fn('pin-sesion', { dispositivo: disp.id, secreto: disp.secreto, pin });
const firmar = async (token, pin, accion, entidad, id) =>
  (await rpc('firmar', { p_pin: pin, p_accion: accion, p_entidad: entidad, p_entidad_id: id }, token)).j;

function totp(secreto, t = Date.now()) {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secreto.replace(/=+$/, '').toUpperCase()) bits += abc.indexOf(c).toString(2).padStart(5, '0');
  const clave = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = createHmac('sha1', clave).update(contador).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

// Una imagen WebP mínima válida (1×1)
const WEBP = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=', 'base64');
const hoy = new Date();
const rutaFoto = (id, suc = DEMO.sucursal) =>
  `${suc}/${hoy.getUTCFullYear()}/${String(hoy.getUTCMonth() + 1).padStart(2, '0')}/${id}.webp`;
const [ana, carlos, luis, mariela] = DEMO.personas;

/* ---------- 1. Ingreso con PIN ---------- */
{
  const r = await fn('pin-sesion', { dispositivo: DEMO.tablet.id, secreto: 'otro', pin: ana.pin });
  ok(r.estado === 403 && r.j.motivo === 'dispositivo_no_registrado', 'P01 un equipo con secreto falso no abre sesión', r);
  const m = await pinSesion('0000');
  ok(m.estado === 401 && m.j.motivo === 'pin_incorrecto', 'P01 PIN errado: 401 pin_incorrecto', m);
}
const sAna = (await pinSesion(ana.pin)).j;
{
  ok(sAna.ok && sAna.usuario.nombre === 'Ana Pérez' && sAna.dispositivo.nombre === DEMO.tablet.nombre, 'P02 Ana entra con su PIN en la tablet demo', sAna);
  const c = await rpc('pase_contexto', {}, sAna.sesion.access_token);
  ok(c.j?.usuario?.id === ana.id && c.j?.dispositivo?.id === DEMO.tablet.id, 'P02 su sesión la identifica a ella y al equipo', c);
  const t = await pedir('/auth/v1/token?grant_type=refresh_token', { cuerpo: { refresh_token: sAna.sesion.refresh_token } });
  const c2 = await rpc('pase_contexto', {}, t.j?.access_token);
  ok(t.estado === 200 && c2.j?.usuario?.id === ana.id, 'P03 al renovar el token la sesión sigue atada al equipo', { t: t.estado, c2 });
  sAna.sesion = t.j;
}
{
  // Una sesión de Auth válida pero sin equipo (p. ej. un enlace mágico) no ve nada
  const g = await pedir('/auth/v1/admin/generate_link', { cuerpo: { type: 'magiclink', email: `${ana.id}@personal.pase.invalid` }, apikey: SERVICIO, token: SERVICIO });
  const v = await pedir('/auth/v1/verify', { cuerpo: { type: 'magiclink', token_hash: g.j.hashed_token } });
  const c = await rpc('pase_contexto', {}, v.j.access_token);
  const u = await pedir('/rest/v1/usuarios?select=id', { metodo: 'GET', token: v.j.access_token });
  ok(v.estado === 200 && c.j === null && Array.isArray(u.j) && u.j.length === 0, 'P04 una sesión sin equipo no ve ni su propia ficha', { c: c.j, u: u.j });
}

/* ---------- 2. Fotos y planilla ---------- */
const tokAna = sAna.sesion.access_token;
const idFoto = randomUUID();
{
  const malMime = await pedir(`/storage/v1/object/evidencias/${rutaFoto(randomUUID())}`, { cuerpo: Buffer.from('hola'), tipo: 'text/plain', token: tokAna });
  ok(malMime.estado === 400 && malMime.j.statusCode === '415', 'P05 Storage rechaza lo que no es imagen', malMime.j);
  const otra = await pedir(`/storage/v1/object/evidencias/${rutaFoto(randomUUID(), randomUUID())}`, { cuerpo: WEBP, tipo: 'image/webp', token: tokAna });
  ok(otra.estado === 400 && otra.j.statusCode === '403', 'P05 nadie sube fotos a la carpeta de otra sucursal', otra.j);
  const sube = await pedir(`/storage/v1/object/evidencias/${rutaFoto(idFoto)}`, { cuerpo: WEBP, tipo: 'image/webp', token: tokAna });
  ok(sube.estado === 200, 'P05 Ana sube la foto a la carpeta de su sucursal', sube.j);
}
const idEjec = randomUUID();
{
  const hoyJ = (await rpc('pase_hoy', {}, tokAna)).j;
  // La primera línea libre del riel (la 08A si nadie la hizo hoy; la prueba se puede repetir)
  const libres = hoyJ.programadas.filter((x) => !x.ejecucion_id);
  const prog = libres.find((x) => x.codigo === '08A') ?? libres[0];
  const cat = (await rpc('pase_catalogo', {}, tokAna)).j;
  const pl = cat.find((p) => p.id === prog?.plantilla_id);
  ok(prog && pl, `P06 el riel de Ana trae la ${prog?.codigo} y el catálogo sus ítems`, { prog: !!prog, pl: !!pl });
  const items = pl.secciones.flatMap((s) => s.items);
  const respuestas = items.map((i) => ({
    item_id: i.id,
    ...(i.tipo === 'pass_fail' ? { valor_bool: true } : {}),
    ...(i.tipo === 'number' ? { valor_num: i.min != null && i.max != null ? (i.min + i.max) / 2 : 1 } : {}),
    ...(i.tipo === 'text' ? { valor_texto: 'Sin novedad' } : {}),
    ...(i.tipo === 'choice' ? { valor_opcion: i.opciones[0] } : {}),
    ...(i.tipo === 'time' ? { valor_hora: '12:00' } : {}),
    ...(i.tipo === 'photo' ? { evidencia_id: idFoto } : {}),
  }));
  if (!items.some((i) => i.tipo === 'photo')) respuestas[0].evidencia_id = idFoto;
  const f = await firmar(tokAna, ana.pin, 'crear', 'checklist_ejecuciones', idEjec);
  ok(f?.ok, 'P06 Ana firma la planilla con su PIN', f);
  const evid = [{ id: idFoto, ruta: rutaFoto(idFoto), sha256: 'x', bytes: WEBP.length, mime: 'image/webp' }];
  const r = await rpc('enviar_planilla', {
    p_ejecucion: { id: idEjec, plantilla_id: pl.id, programacion_id: prog.id, iniciada_en: new Date(Date.now() - 6e5).toISOString() },
    p_respuestas: respuestas, p_evidencias: evid, p_firma: f.firma_id,
  }, tokAna);
  ok(r.estado === 200 && r.j.ok && Number(r.j.puntaje) === 100, 'P06 la planilla llega completa (100 %)', r.j);
  const d = (await rpc('pase_ejecucion', { p_id: idEjec }, tokAna)).j;
  const ruta = d?.respuestas?.find((x) => x.evidencia)?.evidencia?.ruta;
  ok(ruta === rutaFoto(idFoto) && d.dispositivo === DEMO.tablet.nombre, 'P07 el detalle trae la foto y el equipo', d && { ruta, disp: d.dispositivo });
  const foto = await fetch(`${URL_API}/storage/v1/object/authenticated/evidencias/${ruta}`, { headers: { apikey: ANON, authorization: `Bearer ${tokAna}` } });
  ok(foto.status === 200 && Buffer.from(await foto.arrayBuffer()).equals(WEBP), 'P07 Ana vuelve a ver su foto');
  const hoy2 = (await rpc('pase_hoy', {}, tokAna)).j.programadas.find((x) => x.id === prog.id);
  ok(hoy2.ejecucion_id === idEjec && hoy2.hecha_por === 'Ana Pérez', 'P08 la línea del riel queda hecha por Ana', hoy2);
}
{
  const sCarlos = (await pinSesion(carlos.pin)).j;
  const foto = await fetch(`${URL_API}/storage/v1/object/authenticated/evidencias/${rutaFoto(idFoto)}`, { headers: { apikey: ANON, authorization: `Bearer ${sCarlos.sesion.access_token}` } });
  ok(foto.status === 400, 'P09 otro operativo no ve la foto de Ana');
  const sLuis = (await pinSesion(luis.pin)).j;
  const f2 = await fetch(`${URL_API}/storage/v1/object/authenticated/evidencias/${rutaFoto(idFoto)}`, { headers: { apikey: ANON, authorization: `Bearer ${sLuis.sesion.access_token}` } });
  ok(f2.status === 200, 'P09 el supervisor sí la ve');
}

/* ---------- 3. Registro de una tablet nueva (gerente con 2FA) ---------- */
const disp2 = { id: randomUUID(), nombre: `Tablet prueba ${Date.now() % 100000}` };
let idGerente;
{
  const correo = `gerente.${Date.now()}@pase.test`;
  const clave = 'Clave-de-prueba-2026';
  const authId = (await pedir('/auth/v1/admin/users', { cuerpo: { email: correo, password: clave, email_confirm: true }, apikey: SERVICIO, token: SERVICIO })).j.id;
  const idG = randomUUID();
  idGerente = idG;
  const pinG = String(100000 + Math.floor(Math.random() * 899999));
  await db.query(`insert into public.usuarios (id, auth_id, sucursal_id, nombre, apellido, cargo, rol, turno)
                  values ($1, $2, $3, 'Prueba', 'Gerente', 'Gerente', 'admin', 'gerencia')`, [idG, authId, DEMO.sucursal]);
  await db.query(`insert into privado.credenciales_pin (usuario_id, pin_hash, pin_indice, longitud, debe_cambiar)
                  values ($1, extensions.crypt($2, extensions.gen_salt('bf', 6)), privado.indice_pin($2), 6, false)`, [idG, pinG]);

  const l = await pedir('/auth/v1/token?grant_type=password', { cuerpo: { email: correo, password: clave } });
  ok(l.estado === 200, 'P10 la gerente entra con correo y contraseña', l.j);
  const t1 = l.j.access_token;
  ok((await rpc('pase_contexto', {}, t1)).j === null, 'P10 sin 2FA ni equipo no ve nada');
  const sin2fa = await rpc('registrar_este_dispositivo', { p_id: disp2.id, p_nombre: disp2.nombre, p_tipo: 'tablet_cocina', p_pin: pinG }, t1);
  ok(sin2fa.j?.motivo === 'requiere_2fa', 'P10 sin 2FA no registra equipos', sin2fa.j);

  const fac = await pedir('/auth/v1/factors', { cuerpo: { factor_type: 'totp', friendly_name: 'Pase' }, token: t1 });
  const ch = await pedir(`/auth/v1/factors/${fac.j.id}/challenge`, { cuerpo: {}, token: t1 });
  const ve = await pedir(`/auth/v1/factors/${fac.j.id}/verify`, { cuerpo: { challenge_id: ch.j.id, code: totp(fac.j.totp.secret) }, token: t1 });
  ok(ve.estado === 200 && JSON.parse(Buffer.from(ve.j.access_token.split('.')[1], 'base64url')).aal === 'aal2', 'P11 activa la app autenticadora y sube a aal2', ve.j);
  const t2 = ve.j.access_token;
  const pinMal = await rpc('registrar_este_dispositivo', { p_id: disp2.id, p_nombre: disp2.nombre, p_tipo: 'tablet_cocina', p_pin: '000000' }, t2);
  ok(pinMal.j?.ok === false, 'P11 con un PIN que no es el suyo no registra', pinMal.j);
  const reg = await rpc('registrar_este_dispositivo', { p_id: disp2.id, p_nombre: disp2.nombre, p_tipo: 'tablet_cocina', p_pin: pinG }, t2);
  ok(reg.j?.ok && reg.j.secreto?.length >= 32, 'P12 registra la tablet y recibe su secreto una sola vez', reg.j && { ok: reg.j.ok });
  disp2.secreto = reg.j.secreto;
  const c = (await rpc('pase_contexto', {}, t2)).j;
  ok(c?.dispositivo?.id === disp2.id, 'P12 su sesión queda en el equipo nuevo', c?.dispositivo);
  const lu = await pinSesion(luis.pin, disp2);
  ok(lu.j?.ok && lu.j.dispositivo.id === disp2.id, 'P13 Luis entra con su PIN en la tablet nueva', lu.j);
  // Otro login de la gerente (aal1) en una PC se ata a un equipo ya registrado con su secreto
  const l2 = await pedir('/auth/v1/token?grant_type=password', { cuerpo: { email: correo, password: clave } });
  const vMal = await rpc('vincular_dispositivo', { p_dispositivo: disp2.id, p_secreto: 'no' }, l2.j.access_token);
  const vBien = await rpc('vincular_dispositivo', { p_dispositivo: disp2.id, p_secreto: disp2.secreto }, l2.j.access_token);
  ok(vMal.j?.ok === false && vBien.j?.ok === true && (await rpc('pase_contexto', {}, l2.j.access_token)).j?.usuario?.id === idG,
    'P14 una sesión con correo se ata a un equipo registrado solo con su secreto', { vMal: vMal.j, vBien: vBien.j });
}

/* ---------- 4. Alta de personal ---------- */
let nora;
{
  const sMar = (await pinSesion(mariela.pin)).j;
  const tok = sMar.sesion.access_token;
  const id = randomUUID();
  const noPuede = await fn('personal', { usuario: { id, nombre: 'Nora', apellido: 'Nueva', rol: 'operativo' }, firma: randomUUID() }, tokAna);
  ok(noPuede.estado === 403, 'P15 un operativo no da de alta personal', noPuede.j);
  const sinFirma = await fn('personal', { usuario: { id, nombre: 'Nora', apellido: 'Nueva', rol: 'operativo' }, firma: randomUUID() }, tok);
  const cuentas = await db.query(`select count(*)::int n from auth.users where email = $1`, [`${id}@personal.pase.invalid`]);
  ok(sinFirma.estado >= 400 && cuentas.rows[0].n === 0, 'P15 sin firma válida no queda ninguna cuenta a medias', sinFirma.j);
  const f = await firmar(tok, mariela.pin, 'crear', 'usuarios', id);
  const alta = await fn('personal', { usuario: { id, nombre: 'Nora', apellido: 'Nueva', cargo: 'Cocina', rol: 'operativo', turno: 'mediodia' }, longitud: 4, firma: f.firma_id }, tok);
  ok(alta.estado === 200 && /^\d{4}$/.test(alta.j.pin_provisional), 'P16 la gerente da de alta a Nora y recibe su PIN provisional', alta.j);
  const sNora = await pinSesion(alta.j.pin_provisional);
  ok(sNora.j?.ok && sNora.j.usuario.debe_cambiar_pin === true, 'P16 Nora entra con el provisional y se le pide cambiarlo', sNora.j?.usuario);
  const nuevo = await rpc('regenerar_mi_pin', { p_pin_actual: alta.j.pin_provisional }, sNora.j.sesion.access_token);
  ok(nuevo.j?.ok && /^\d{4}$/.test(nuevo.j.pin) && nuevo.j.pin !== alta.j.pin_provisional, 'P17 Nora recibe su PIN definitivo', nuevo.j && { ok: nuevo.j.ok });
  const viejo = await pinSesion(alta.j.pin_provisional);
  ok(viejo.estado === 401, 'P17 el provisional ya no abre sesión');
  nora = { id, pin: nuevo.j.pin };
}

/* ---------- 5. Lo firmado sin internet ---------- */
const sinc = async (envio, fotos = {}) => {
  const form = new FormData();
  form.set('envio', JSON.stringify(envio));
  for (const [k, v] of Object.entries(fotos)) form.set(k, new Blob([v], { type: 'image/webp' }), `${k}.webp`);
  const r = await fetch(`${URL_API}/functions/v1/sincronizar`, { method: 'POST', body: form });
  return { estado: r.status, j: await r.json() };
};
{
  await pinSesion(carlos.pin); // Carlos entró con su PIN en esta tablet hace poco
  const cat = (await rpc('pase_catalogo', {}, tokAna)).j;
  const pl = cat.find((p) => p.codigo === '17A') ?? cat[0];
  const items = pl.secciones.flatMap((s) => s.items);
  const idE = randomUUID();
  const idF = randomUUID();
  const firmadaEn = new Date(Date.now() - 15 * 60000).toISOString();
  const envio = {
    dispositivo: DEMO.tablet.id, secreto: DEMO.tablet.secreto, tipo: 'planilla', usuario_id: carlos.id, firmada_en: firmadaEn,
    planilla: {
      ejecucion: { id: idE, plantilla_id: pl.id, iniciada_en: new Date(Date.now() - 25 * 60000).toISOString(), completada_en: firmadaEn },
      respuestas: items.map((i, n) => ({
        item_id: i.id,
        ...(i.tipo === 'pass_fail' ? { valor_bool: true } : {}),
        ...(i.tipo === 'number' ? { valor_num: i.min != null && i.max != null ? (i.min + i.max) / 2 : 1 } : {}),
        ...(i.tipo === 'text' ? { valor_texto: 'Sin novedad' } : {}),
        ...(i.tipo === 'choice' ? { valor_opcion: i.opciones[0] } : {}),
        ...(i.tipo === 'time' ? { valor_hora: '12:00' } : {}),
        ...(n === 0 || i.tipo === 'photo' ? { evidencia_id: idF } : {}),
      })),
      evidencias: [{ id: idF, ruta: rutaFoto(idF), sha256: 'y', bytes: WEBP.length, mime: 'image/webp', tomada_en: firmadaEn }],
    },
  };
  const malo = await sinc({ ...envio, secreto: 'falso' }, { [idF]: WEBP });
  ok(malo.estado === 422 && malo.j.motivo === 'dispositivo_no_registrado', 'P18 sin el secreto del equipo no se acepta nada', malo.j);
  const r = await sinc(envio, { [idF]: WEBP });
  ok(r.estado === 200 && r.j.ok && r.j.resultado?.ok, 'P18 la planilla firmada sin internet llega con su foto', r.j);
  const otra = await sinc(envio, { [idF]: WEBP });
  ok(otra.estado === 200 && otra.j.resultado?.ya_existia, 'P19 reenviarla no la duplica', otra.j);
  const fila = (await db.query(`select e.registrada_sin_conexion, e.completada_en, e.realizada_por, f.metodo, f.firmada_sin_conexion_en
                                from public.checklist_ejecuciones e join public.firmas f on f.id = e.firma_id where e.id = $1`, [idE])).rows[0];
  ok(fila?.registrada_sin_conexion && fila.metodo === 'pin_sin_conexion' && fila.realizada_por === carlos.id
     && Math.abs(new Date(fila.completada_en) - new Date(firmadaEn)) < 1000, 'P19 queda a nombre de Carlos, con la hora real y marcada sin conexión', fila);
  const dueno = (await db.query(`select owner_id from storage.objects where name = $1`, [rutaFoto(idF)])).rows[0];
  const authCarlos = (await db.query(`select auth_id from public.usuarios where id = $1`, [carlos.id])).rows[0].auth_id;
  ok(dueno?.owner_id === authCarlos, 'P19 la foto queda a nombre de Carlos', dueno);
  const sinIngreso = await sinc({ ...envio, usuario_id: idGerente, planilla: { ...envio.planilla, ejecucion: { ...envio.planilla.ejecucion, id: randomUUID() } } });
  ok(sinIngreso.estado === 422 && sinIngreso.j.motivo === 'sin_ingreso_reciente', 'P20 si esa persona no entró en esta tablet, no se acepta', sinIngreso.j);
  const inc = await sinc({
    dispositivo: DEMO.tablet.id, secreto: DEMO.tablet.secreto, tipo: 'incidencia', usuario_id: carlos.id, firmada_en: firmadaEn,
    incidencia: { incidencia: { id: randomUUID(), titulo: 'Fuga de agua en el lavaplatos', severidad: 'media', area: 'Cocina' }, evidencia: null },
  });
  ok(inc.estado === 200 && inc.j.resultado?.ok, 'P21 una incidencia reportada sin internet también llega', inc.j);
  const abiertas = (await db.query(`select count(*)::int n from privado.sesiones_dispositivo where metodo = 'sincronizacion'`)).rows[0].n;
  ok(abiertas === 0, 'P21 las sesiones de sincronización se cierran al terminar', { abiertas });
}

/* ---------- 6. Bloqueo de la tablet ---------- */
{
  const s = (await pinSesion(luis.pin)).j;
  await rpc('cerrar_sesion_equipo', {}, s.sesion.access_token);
  ok((await rpc('pase_contexto', {}, s.sesion.access_token)).j === null, 'P22 al bloquear la pantalla la sesión deja de valer');
  const conocidos = new Set([...DEMO.personas.map((p) => p.pin), nora.pin]);
  const errados = Array.from({ length: 20 }, (_, i) => String(1000 + i)).filter((p) => !conocidos.has(p)).slice(0, 10);
  for (const p of errados) await pinSesion(p, disp2);
  const b = await pinSesion(luis.pin, disp2);
  ok(b.estado === 423 && b.j.motivo === 'dispositivo_bloqueado', 'P23 diez PIN errados bloquean la tablet, aun con un PIN bueno', b.j);
}

await db.end();
console.log(fallas ? `\n${fallas} prueba(s) fallaron` : '\nPruebas de la API: todas pasaron');
process.exit(fallas ? 1 : 0);
