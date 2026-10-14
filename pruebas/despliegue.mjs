// Ensayo de la publicación: un Supabase local vacío (como un proyecto recién creado), la
// Management API imitada (local/gestion_falsa.mjs) y scripts/desplegar.mjs completo. Después,
// en un navegador, la gerente abre el link de su invitación y hace su primer ingreso, como lo
// hará en la tienda, y da de alta a la primera persona del equipo.
//
// Uso: npm run prueba:despliegue   (deja la base local en el estado "recién publicado";
//      npm run local:limpio la devuelve a los datos de demostración)
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CAPTURAS = path.join(RAIZ, 'pruebas', 'capturas', 'despliegue');
const WEB = 'http://127.0.0.1:5173';
const GERENTE = { correo: 'gerente.nueva@pase.test', nombre: 'Gabriela', apellido: 'Suárez', clave: 'Primer-Ingreso-2026' };

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  const global = execFileSync('npm', ['root', '-g']).toString().trim();
  ({ chromium } = createRequire(path.join(global, 'x.js'))('playwright'));
}
const ok = (c, msg, extra) => {
  if (!c) { console.log(`FALLO ${msg}`, extra ?? ''); throw new Error(msg); }
  console.log(`OK  ${msg}`);
};
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

/* ---------- 0. Proyecto vacío y Management API imitada ---------- */
execFileSync('sh', [path.join(RAIZ, 'local', 'iniciar.sh'), '--limpio'], { env: { ...process.env, PASE_SIN_MIGRACIONES: '1' }, stdio: ['ignore', 'ignore', 'inherit'] });
const llaves = Object.fromEntries(fs.readFileSync('/tmp/pase-local/llaves.env', 'utf8').split('\n').filter(Boolean).map((l) => l.split('=')));
const gestion = spawn('node', [path.join(RAIZ, 'local', 'gestion_falsa.mjs')], { env: { ...process.env, ...llaves }, stdio: ['ignore', 'ignore', 'inherit'] });
// Espera a que un servicio responda (con la máquina ocupada puede tardar unos segundos en arrancar)
async function esperar(url, headers = {}) {
  for (let i = 0; i < 60; i++) {
    try { await fetch(url, { headers }); return; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error(`${url} no arrancó`);
}
await esperar('http://127.0.0.1:54330/v1/projects/pase-local', { authorization: 'Bearer token-falso' });
const db = new pg.Client({ host: '127.0.0.1', port: 54322, user: 'postgres', database: 'postgres' });
await db.connect();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pase-despliegue-'));
const archivoConfig = path.join(tmp, 'config.json');
const entorno = {
  ...process.env, SUPABASE_ACCESS_TOKEN: 'token-falso', SUPABASE_PROJECT_REF: 'pase-local',
  PASE_API_GESTION: 'http://127.0.0.1:54330/v1', PASE_URL_PROYECTO: 'http://127.0.0.1:54321', PASE_SITIO: WEB,
};
const desplegar = (...a) => {
  const r = spawnSync('node', [path.join(RAIZ, 'scripts', 'desplegar.mjs'), '--config', archivoConfig, ...a], { env: entorno, encoding: 'utf8' });
  return { codigo: r.status, salida: r.stdout + r.stderr };
};
const estado = async () => (await fetch('http://127.0.0.1:54330/v1/projects/pase-local/_estado', { headers: { authorization: 'Bearer token-falso' } })).json();

let navegador;
let servidor;
try {
  /* ---------- 1. El script ---------- */
  ok((await db.query(`select to_regclass('public.usuarios') is null as vacia`)).rows[0].vacia, 'D01 el proyecto local está vacío, como uno recién creado');

  let r = desplegar('--ensayo', '--gerente', GERENTE.correo, GERENTE.nombre, GERENTE.apellido);
  ok(r.codigo === 0 && /aplicaría 20261014000004_api_fase1\.sql/.test(r.salida) && (await estado()).consultas <= 2,
    'D02 el ensayo dice lo que haría sin cambiar nada', r.salida);

  const sinSitio = spawnSync('node', [path.join(RAIZ, 'scripts', 'desplegar.mjs'), '--solo', 'auth'], { env: { ...entorno, PASE_SITIO: '' }, encoding: 'utf8' });
  ok(sinSitio.status === 1 && /Falta PASE_SITIO/.test(sinSitio.stderr), 'D03 sin la dirección del sitio no toca Auth');

  // La premisa de las migraciones: varias sentencias en una consulta entran todas o ninguna
  const rota = await fetch('http://127.0.0.1:54330/v1/projects/pase-local/database/query', {
    method: 'POST', headers: { authorization: 'Bearer token-falso', 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'create table public.t_atomica (x int); insert into public.t_atomica values (1); select 1/0;' }),
  });
  ok(rota.status === 400 && (await db.query(`select to_regclass('public.t_atomica') is null as nada`)).rows[0].nada,
    'D04 una consulta que falla a la mitad no deja nada a medias');

  r = desplegar('--gerente', GERENTE.correo, GERENTE.nombre, GERENTE.apellido);
  console.log(r.salida.split('\n').map((l) => `    ${l}`).join('\n'));
  ok(r.codigo === 0, 'D05 el script publica todo de una vez', r.salida);
  const migr = (await db.query('select version from supabase_migrations.schema_migrations order by 1')).rows.map((x) => x.version);
  const plantillas = (await db.query('select count(*)::int n from public.plantillas')).rows[0].n;
  ok(migr.length === fs.readdirSync(path.join(RAIZ, 'supabase', 'migrations')).length && plantillas === 55,
    `D05 las ${migr.length} migraciones quedan anotadas y la base tiene las ${plantillas} plantillas`);
  const e = await estado();
  ok(e.funciones.length === 3 && e.funciones.every((f) => !f.verify_jwt && f.archivos.includes('supabase/functions/_compartido/mod.ts')),
    'D05 las tres funciones suben con su código compartido y sin verificación de JWT', e.funciones);
  ok(e.secretos.PASE_ORIGENES === WEB && e.auth.site_url === WEB && e.auth.disable_signup === true && e.auth.mfa_totp_enroll_enabled === true
    && /Crear mi contraseña/.test(e.auth.mailer_templates_invite_content ?? ''),
    'D05 secretos y Auth: sitio, registro cerrado, 2FA y correos en español', { secretos: e.secretos, site_url: e.auth.site_url });
  const config = JSON.parse(fs.readFileSync(archivoConfig, 'utf8'));
  ok(config.supabaseUrl === 'http://127.0.0.1:54321' && config.supabaseLlave === llaves.ANON_KEY, 'D05 escribe la configuración de la app con la llave pública');
  ok(!r.salida.includes(llaves.SERVICE_ROLE_KEY) && !r.salida.includes(llaves.ANON_KEY), 'D05 no imprime ninguna llave completa');
  const ger = (await db.query(`select u.id, u.rol, a.invited_at is not null as invitada,
                                      exists (select 1 from privado.credenciales_pin c where c.usuario_id = u.id) as con_pin
                               from public.usuarios u join auth.users a on a.id = u.auth_id where a.email = $1`, [GERENTE.correo])).rows[0];
  ok(ger?.rol === 'admin' && ger.invitada && !ger.con_pin, 'D06 la gerente queda invitada por correo y dada de alta, todavía sin PIN', ger);

  r = desplegar('--gerente', GERENTE.correo, GERENTE.nombre, GERENTE.apellido);
  const total = (await db.query('select count(*)::int n from public.usuarios')).rows[0].n;
  ok(r.codigo === 0 && /Nada nuevo/.test(r.salida) && /ya tenía cuenta/.test(r.salida) && total === 1,
    'D07 correrlo otra vez no repite migraciones, invitaciones ni personas', r.salida);

  /* ---------- 2. El primer ingreso, en el navegador ---------- */
  execFileSync('node', [path.join(RAIZ, 'web', 'construir.mjs')], {
    env: { ...process.env, PASE_SUPABASE_URL: config.supabaseUrl, PASE_SUPABASE_LLAVE: config.supabaseLlave }, stdio: ['ignore', 'ignore', 'inherit'],
  });
  servidor = spawn('node', [path.join(RAIZ, 'web', 'servir.mjs')], { stdio: 'ignore' });
  await esperar(WEB);
  fs.rmSync(CAPTURAS, { recursive: true, force: true });
  fs.mkdirSync(CAPTURAS, { recursive: true });
  navegador = await chromium.launch();
  const page = await (await navegador.newContext({ viewport: { width: 1180, height: 820 }, locale: 'es-VE' })).newPage();
  const errores = [];
  page.on('pageerror', (x) => errores.push(x.message));
  let n = 0;
  const foto = (nombre) => page.screenshot({ path: path.join(CAPTURAS, `${String(++n).padStart(2, '0')}-${nombre}.png`) });

  // El link del correo: GoTrue guarda el mismo token que va en el correo
  const { confirmation_token: token } = (await db.query('select confirmation_token from auth.users where email = $1', [GERENTE.correo])).rows[0];
  await page.goto(`http://127.0.0.1:54321/auth/v1/verify?token=${token}&type=invite&redirect_to=${encodeURIComponent(`${WEB}/`)}`);
  await page.getByRole('heading', { name: 'Crea tu contraseña' }).waitFor({ timeout: 20_000 });
  await foto('crear-clave');
  await page.getByLabel('Contraseña nueva').fill(GERENTE.clave);
  await page.getByLabel('Repítela').fill(GERENTE.clave);
  await page.getByRole('button', { name: 'Guardar contraseña' }).click();
  await page.getByRole('heading', { name: 'Activa la verificación en dos pasos' }).waitFor({ timeout: 20_000 });
  await foto('activar-2fa');
  const secreto = (await page.locator('code').innerText()).replace(/\s/g, '');
  await page.getByLabel('Código de 6 números').fill(totp(secreto));
  await page.getByRole('button', { name: 'Verificar' }).click();
  await page.getByRole('heading', { name: 'Tu PIN de gerente' }).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Generar mi PIN' }).click();
  const pin = (await page.getByLabel('Tu PIN nuevo').innerText()).trim();
  await page.getByRole('button', { name: 'Ya me lo aprendí' }).click();
  await page.getByLabel('Escríbelo de memoria').fill(pin);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByLabel('Nombre', { exact: true }).fill('PC de gerencia');
  await page.getByRole('radio', { name: 'PC de gerencia' }).click();
  await page.getByRole('button', { name: 'Registrar este equipo' }).click();
  const teclado = page.getByRole('group', { name: 'Teclado numérico' });
  await teclado.waitFor({ timeout: 20_000 });
  await page.keyboard.type(pin, { delay: 70 });
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Panel del día' }).waitFor({ timeout: 20_000 });
  await foto('panel');
  ok(true, 'D08 la gerente abre el link de la invitación, crea su contraseña, activa la app autenticadora, genera su PIN, registra su PC y entra');

  await page.getByRole('navigation', { name: 'Secciones' }).getByRole('button', { name: 'Personal', exact: true }).click();
  await page.getByRole('button', { name: 'Agregar persona' }).click();
  await page.getByLabel('Nombre', { exact: true }).fill('Primera');
  await page.getByLabel('Apellido').fill('Persona');
  await page.getByLabel('Turno').selectOption('mediodia');
  await page.getByRole('button', { name: 'Firmar y agregar' }).click();
  await page.getByRole('dialog').filter({ has: teclado }).waitFor();
  await page.waitForTimeout(250);
  await page.keyboard.type(pin, { delay: 70 });
  const dialogo = page.getByRole('dialog', { name: 'PIN provisional' });
  await dialogo.waitFor({ timeout: 20_000 });
  await foto('primera-persona');
  ok(/^\d{4}$/.test((await dialogo.locator('p.num').innerText()).trim()), 'D09 da de alta a la primera persona del equipo con su PIN provisional');
  ok(!errores.length, 'D10 sin errores de JavaScript', errores);
  console.log('\nEnsayo de la publicación: todo pasó.');
} catch (x) {
  console.log('ERROR', x.message);
  process.exitCode = 1;
} finally {
  await navegador?.close();
  servidor?.kill();
  gestion.kill();
  await db.end();
  fs.rmSync(tmp, { recursive: true, force: true });
}
