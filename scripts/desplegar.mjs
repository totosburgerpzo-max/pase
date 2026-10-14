// Publica Pase en el proyecto de Supabase de Totos Burger con la Management API: no hace falta
// la contraseña de la base ni la CLI, solo un token personal de Supabase.
//
//   migraciones  aplica las de supabase/migrations que falten, cada una en una sola transacción,
//                y las anota en supabase_migrations.schema_migrations (la misma tabla de la CLI)
//   funciones    sube las Edge Functions pin-sesion, sincronizar y personal (validan ellas el
//                acceso: van sin verificación de JWT)
//   secretos     PASE_ORIGENES (el sitio, para CORS) y PASE_CORREO_DOMINIO
//   auth         registro cerrado, 2FA con app autenticadora, links de vuelta al sitio, límites
//                y correos de invitación y de contraseña en español
//   config       escribe web/config.json con la URL y la llave pública (para construir la app)
//   gerente      con --gerente correo Nombre Apellido: la invita por correo y la da de alta
//
// Variables: SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF y PASE_SITIO (p. ej.
// https://pase-totos.pages.dev). Ninguna llave se imprime.
//
// Uso: node scripts/desplegar.mjs                      todo menos la gerente
//      node scripts/desplegar.mjs --solo auth,secretos  solo esos pasos
//      node scripts/desplegar.mjs --solo gerente --gerente correo@x.com Nombre Apellido
//      node scripts/desplegar.mjs --ensayo              muestra lo que haría, sin cambiar nada
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASOS = ['migraciones', 'funciones', 'secretos', 'auth', 'config', 'gerente'];
const FUNCIONES = ['pin-sesion', 'sincronizar', 'personal'];

/* ---------- argumentos ---------- */
const args = process.argv.slice(2);
const opcion = (nombre, n = 1) => {
  const i = args.indexOf(nombre);
  return i < 0 ? null : args.slice(i + 1, i + 1 + n);
};
const ensayo = args.includes('--ensayo');
const gerente = opcion('--gerente', 3);
const solo = opcion('--solo')?.[0]?.split(',').map((s) => s.trim()) ?? PASOS.filter((p) => p !== 'gerente' || gerente);
const salidaConfig = opcion('--config')?.[0] ?? path.join(RAIZ, 'web', 'config.json');
for (const p of solo) if (!PASOS.includes(p)) fallar(`Paso desconocido: ${p}. Pasos: ${PASOS.join(', ')}`);
if (solo.includes('gerente') && (!gerente || gerente.length < 3 || !/^\S+@\S+\.\S+$/.test(gerente[0]))) {
  fallar('Para invitar a la gerente: --gerente correo@dominio Nombre Apellido');
}

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const REF = process.env.SUPABASE_PROJECT_REF;
const SITIO = (process.env.PASE_SITIO ?? '').replace(/\/+$/, '');
const API = (process.env.PASE_API_GESTION ?? 'https://api.supabase.com/v1').replace(/\/+$/, '');
const URL_PROYECTO = (process.env.PASE_URL_PROYECTO ?? `https://${REF}.supabase.co`).replace(/\/+$/, '');
if (!TOKEN || !REF) fallar('Faltan SUPABASE_ACCESS_TOKEN y SUPABASE_PROJECT_REF en las variables del entorno.');
if (!/^[a-z0-9-]{3,40}$/.test(REF)) fallar('SUPABASE_PROJECT_REF no parece una referencia de proyecto (solo minúsculas y números).');
if ((solo.includes('auth') || solo.includes('secretos') || solo.includes('gerente')) && !/^https?:\/\/[^/]+$/.test(SITIO)) {
  fallar('Falta PASE_SITIO: la dirección de la app, p. ej. https://pase-totos.pages.dev (sin barra al final).');
}

function fallar(m) {
  console.error(`\n✗ ${m}`);
  process.exit(1);
}
const titulo = (t) => console.log(`\n== ${t}`);
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

/* ---------- Management API ---------- */
async function api(metodo, ruta, cuerpo, formulario) {
  const r = await fetch(API + ruta, {
    method: metodo,
    headers: { authorization: `Bearer ${TOKEN}`, ...(cuerpo !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: formulario ?? (cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined),
  });
  const texto = await r.text();
  let j;
  try { j = texto ? JSON.parse(texto) : null; } catch { j = texto; }
  if (!r.ok) {
    const detalle = typeof j === 'string' ? j : j?.message ?? j?.error ?? JSON.stringify(j);
    const e = new Error(`${metodo} ${ruta.split('?')[0]} → ${r.status}: ${String(detalle).slice(0, 600)}`);
    e.estado = r.status;
    throw e;
  }
  return j;
}
const sql = (query) => api('POST', `/projects/${REF}/database/query`, { query });

/* ---------- 0. El proyecto ---------- */
titulo('Proyecto');
const proyecto = await api('GET', `/projects/${REF}`).catch((e) => fallar(
  e.estado === 401 ? 'El token no sirve (¿se copió completo? ¿lo revocaron?).' : e.estado === 404 ? `No hay un proyecto ${REF} en esa cuenta.` : e.message));
console.log(`${proyecto.name} (${REF}) · región ${proyecto.region} · estado ${proyecto.status}`);
if (proyecto.status && proyecto.status !== 'ACTIVE_HEALTHY') {
  fallar(proyecto.status === 'INACTIVE' ? 'El proyecto está pausado: reactívalo en el panel de Supabase (Restore project).' : `El proyecto no está listo (${proyecto.status}).`);
}
if (ensayo) console.log('Modo ensayo: no se cambia nada.');

/* ---------- 1. Migraciones ---------- */
if (solo.includes('migraciones')) {
  titulo('Migraciones');
  const carpeta = path.join(RAIZ, 'supabase', 'migrations');
  const archivos = fs.readdirSync(carpeta).filter((f) => /^\d{14}_.+\.sql$/.test(f)).sort();
  const tabla = await sql(`select to_regclass('supabase_migrations.schema_migrations') is not null as hay`);
  const hechas = new Set(tabla[0]?.hay ? (await sql('select version from supabase_migrations.schema_migrations')).map((r) => r.version) : []);
  let aplicadas = 0;
  for (const f of archivos) {
    const version = f.slice(0, 14);
    const nombre = f.slice(15, -4);
    if (hechas.has(version)) { console.log(`· ${f} ya estaba`); continue; }
    if (ensayo) { console.log(`→ aplicaría ${f}`); continue; }
    const cuerpo = fs.readFileSync(path.join(carpeta, f), 'utf8');
    // Todo en una sola consulta: Postgres la corre como una transacción, así que o entra
    // la migración completa con su registro, o no entra nada.
    const t = Date.now();
    try {
      await sql(`create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
${cuerpo}
;
insert into supabase_migrations.schema_migrations (version, name) values (${lit(version)}, ${lit(nombre)});`);
    } catch (e) {
      fallar(`${f} no se aplicó (no quedó nada a medias): ${e.message}`);
    }
    aplicadas++;
    console.log(`✓ ${f} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
  }
  if (!ensayo) {
    const [r] = await sql(`select count(*)::int as usuarios, (select count(*)::int from public.plantillas) as plantillas from public.usuarios`);
    console.log(`${aplicadas ? `${aplicadas} aplicadas` : 'Nada nuevo'}. La base tiene ${r.plantillas} plantillas y ${r.usuarios} personas.`);
  }
}

/* ---------- 2. Edge Functions ---------- */
if (solo.includes('funciones')) {
  titulo('Edge Functions');
  const base = path.join(RAIZ, 'supabase', 'functions');
  const compartidos = fs.readdirSync(path.join(base, '_compartido')).map((f) => `_compartido/${f}`);
  for (const slug of FUNCIONES) {
    const propios = fs.readdirSync(path.join(base, slug)).map((f) => `${slug}/${f}`);
    const archivos = [...propios, ...compartidos];
    if (ensayo) { console.log(`→ subiría ${slug} (${archivos.length} archivos)`); continue; }
    const datos = new FormData();
    datos.append('metadata', JSON.stringify({ name: slug, entrypoint_path: `supabase/functions/${slug}/index.ts`, verify_jwt: false }));
    for (const a of archivos) {
      datos.append('file', new Blob([fs.readFileSync(path.join(base, a))], { type: 'application/typescript' }), `supabase/functions/${a}`);
    }
    try {
      const r = await api('POST', `/projects/${REF}/functions/deploy?slug=${slug}`, undefined, datos);
      console.log(`✓ ${slug} versión ${r?.version ?? '?'} (${r?.status ?? 'ok'})`);
    } catch (e) {
      fallar(`${slug} no se subió: ${e.message}\n  Alternativa con la CLI: npx supabase functions deploy ${slug} --project-ref ${REF} --no-verify-jwt --use-api`);
    }
  }
  if (!ensayo) {
    const lista = await api('GET', `/projects/${REF}/functions`);
    for (const slug of FUNCIONES) {
      const f = lista.find((x) => x.slug === slug);
      if (!f) fallar(`${slug} no aparece en el proyecto`);
      if (f.verify_jwt) console.log(`! ${slug} quedó con verificación de JWT: desactívala en el panel (Edge Functions → ${slug} → Settings)`);
    }
  }
}

/* ---------- 3. Secretos de las funciones ---------- */
if (solo.includes('secretos')) {
  titulo('Secretos de las funciones');
  const secretos = [
    { name: 'PASE_ORIGENES', value: new URL(SITIO).origin },
    { name: 'PASE_CORREO_DOMINIO', value: 'personal.pase.invalid' },
  ];
  if (ensayo) console.log(`→ fijaría ${secretos.map((s) => s.name).join(', ')}`);
  else {
    await api('POST', `/projects/${REF}/secrets`, secretos);
    console.log(`✓ ${secretos.map((s) => `${s.name}=${s.value}`).join(' · ')}`);
  }
}

/* ---------- 4. Auth ---------- */
if (solo.includes('auth')) {
  titulo('Auth');
  const correo = (accion, boton, extra) => `<div style="font-family:Arial,sans-serif;max-width:520px;color:#15191c">
<p style="font-size:20px;font-weight:bold;margin:0 0 16px">Pase · Totos Burger</p>
<p>${accion}</p>
<p style="margin:24px 0"><a href="{{ .ConfirmationURL }}" style="background:#f2b705;color:#15191c;padding:12px 20px;border-radius:8px;font-weight:bold;text-decoration:none">${boton}</a></p>
<p style="color:#5b6670;font-size:14px">${extra}</p>
</div>`;
  // Por grupos: si Supabase no acepta uno (cambió un nombre, o el plan no lo permite), los demás se aplican igual
  const grupos = [
    ['Acceso', {
      site_url: SITIO,
      uri_allow_list: `${SITIO}/,${SITIO}/**`,
      disable_signup: true,
      external_email_enabled: true,
      mailer_otp_exp: 86400,
      password_min_length: 10,
    }],
    ['Verificación en dos pasos', {
      mfa_totp_enroll_enabled: true,
      mfa_totp_verify_enabled: true,
      mfa_max_enrolled_factors: 10,
    }],
    // Cada ingreso con PIN canjea un link en el servidor: con el límite de fábrica (30 cada
    // 5 minutos) un cambio de turno podría trancarse
    ['Límites', { rate_limit_verify: 300 }],
    ['Correos en español', {
      mailer_subjects_invite: 'Tu acceso de gerente a Pase',
      mailer_templates_invite_content: correo('Te dieron acceso como gerente a Pase, las planillas de calidad de Totos Burger.',
        'Crear mi contraseña', 'Ábrelo en la computadora o tablet que vas a registrar. El link sirve una sola vez y vence en 24 horas. Si no esperabas este correo, ignóralo.'),
      mailer_subjects_recovery: 'Contraseña nueva para Pase',
      mailer_templates_recovery_content: correo('Pediste crear una contraseña nueva para tu cuenta de gerente en Pase.',
        'Crear una contraseña nueva', 'El link sirve una sola vez y vence en 24 horas. Si no lo pediste tú, ignora este correo: tu contraseña sigue igual.'),
    }],
  ];
  for (const [nombre, cambios] of grupos) {
    if (ensayo) { console.log(`→ ${nombre}: ${Object.keys(cambios).join(', ')}`); continue; }
    try {
      await api('PATCH', `/projects/${REF}/config/auth`, cambios);
      console.log(`✓ ${nombre}`);
    } catch (e) {
      console.log(`! ${nombre} no se aplicó: ${e.message}`);
    }
  }
  if (!ensayo) {
    const a = await api('GET', `/projects/${REF}/config/auth`);
    const mal = [['site_url', SITIO], ['disable_signup', true], ['mfa_totp_enroll_enabled', true], ['mfa_totp_verify_enabled', true]]
      .filter(([k, v]) => a?.[k] !== undefined && a[k] !== v).map(([k]) => k);
    if (mal.length) fallar(`Auth quedó distinto en: ${mal.join(', ')}. Revísalo en Authentication → Settings.`);
  }
}

/* ---------- llaves (solo en memoria) ---------- */
let llaves = null;
async function obtenerLlaves() {
  llaves ??= await api('GET', `/projects/${REF}/api-keys?reveal=true`);
  const de = (tipos, nombres) => llaves.find((k) => tipos.includes(k.type) && k.api_key)?.api_key
    ?? llaves.find((k) => nombres.includes(k.name) && k.api_key)?.api_key;
  return {
    publica: de(['publishable'], ['anon']),
    secreta: de(['secret'], ['service_role']),
  };
}

/* ---------- 5. Configuración de la app ---------- */
if (solo.includes('config')) {
  titulo('Configuración de la app');
  const { publica } = await obtenerLlaves();
  if (!publica) fallar('No encontré la llave pública (publishable o anon) del proyecto.');
  const config = { supabaseUrl: URL_PROYECTO, supabaseLlave: publica };
  if (ensayo) console.log(`→ escribiría ${path.relative(RAIZ, salidaConfig)}`);
  else {
    fs.writeFileSync(salidaConfig, JSON.stringify(config, null, 2) + '\n');
    console.log(`✓ ${salidaConfig.startsWith(RAIZ) ? path.relative(RAIZ, salidaConfig) : salidaConfig}: ${URL_PROYECTO} y la llave pública (${publica.slice(0, 14)}…)`);
    console.log('  Son datos públicos (van dentro de la app); la seguridad está en la base y en las funciones.');
  }
}

/* ---------- 6. La gerente ---------- */
if (solo.includes('gerente')) {
  titulo('Gerente');
  const [email, nombre, apellido] = gerente;
  const correo = email.trim().toLowerCase();
  const [existe] = await sql(`select id, email_confirmed_at is not null as confirmada, encrypted_password <> '' as con_clave
                              from auth.users where lower(email) = ${lit(correo)}`);
  let id = existe?.id;
  if (ensayo) console.log(existe ? `→ ${correo} ya tiene cuenta; la daría de alta como gerente` : `→ invitaría a ${correo} y la daría de alta como gerente`);
  else {
    if (!id) {
      const { secreta } = await obtenerLlaves();
      if (!secreta) fallar('No encontré la llave secreta (secret o service_role) para enviar la invitación.');
      const r = await fetch(`${URL_PROYECTO}/auth/v1/invite?redirect_to=${encodeURIComponent(`${SITIO}/`)}`, {
        method: 'POST',
        headers: { apikey: secreta, ...(secreta.startsWith('eyJ') ? { authorization: `Bearer ${secreta}` } : {}), 'content-type': 'application/json' },
        body: JSON.stringify({ email: correo }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        fallar(`La invitación no salió (${r.status}): ${j?.msg ?? j?.message ?? JSON.stringify(j)}\n` +
          '  Con el correo de fábrica de Supabase solo llegan correos a los miembros del equipo del proyecto;\n' +
          '  para otros correos hace falta configurar SMTP propio (Authentication → Emails → SMTP).');
      }
      id = j.id;
      console.log(`✓ Invitación enviada a ${correo}: el link abre ${SITIO} y vence en 24 horas`);
    } else {
      console.log(`· ${correo} ya tenía cuenta${existe.con_clave ? ' con contraseña' : ''}; no se envía otra invitación`);
    }
    const [g] = await sql(`select app.alta_gerente(${lit(id)}::uuid, ${lit(nombre)}, ${lit(apellido)}) as id`);
    console.log(`✓ ${nombre} ${apellido} es gerente en Pase (${g.id})`);
    console.log('  Al abrir el link: crea su contraseña, activa la app autenticadora, genera su PIN y registra el equipo.');
  }
}

console.log(`\nListo${ensayo ? ' (ensayo)' : ''}.`);
