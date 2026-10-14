// Prueba de punta a punta en un navegador real (Chromium, con Playwright) contra el Supabase
// local: la gerente registra la tablet con su app autenticadora, el equipo trabaja un turno
// (planilla con foto, falla crítica, atender, resolver, verificar, revisar), se da de alta a
// una persona nueva que estrena su PIN, y se trabaja sin internet hasta que la cola se envía.
// Deja capturas de cada pantalla en pruebas/capturas/.
//
// Uso: npm run prueba:e2e   (reinicia la base local con los datos de demostración)
//      E2E_SIN_REINICIO=1 npm run prueba:e2e   (usa la base como está)
import { execFileSync, execSync, spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { DEMO } from '../local/sembrar.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CAPTURAS = process.env.CAPTURAS ?? path.join(RAIZ, 'pruebas', 'capturas');
const WEB = 'http://127.0.0.1:5173';
const IMAGEN = path.join(RAIZ, 'web', 'publico', 'iconos', 'icono-512.png');
const [ana, , luis, mariela] = DEMO.personas;

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  const global = execSync('npm root -g').toString().trim();
  ({ chromium } = createRequire(path.join(global, 'x.js'))('playwright'));
}

/* ---------- utilidades ---------- */
let n = 0;
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

/* ---------- 0. Base, hora local y app ---------- */
if (!process.env.E2E_SIN_REINICIO) execFileSync('sh', [path.join(RAIZ, 'local', 'iniciar.sh'), '--limpio'], { stdio: ['ignore', 'ignore', 'inherit'] });
// La prueba corre "a primera hora de la tarde": la sucursal y el navegador usan una zona
// horaria fija en la que ahora son cerca de las 14:00, para que el riel tenga planillas abiertas.
let desfase = 14 - new Date().getUTCHours();
if (desfase > 14) desfase -= 24;
if (desfase < -12) desfase += 24;
const ZONA = desfase >= 0 ? `Etc/GMT-${desfase}` : `Etc/GMT+${-desfase}`;
const db = new pg.Client({ host: '127.0.0.1', port: 54322, user: 'postgres', database: 'postgres' });
await db.connect();
await db.query('update public.sucursales set zona_horaria = $1', [ZONA]);
await db.query('delete from public.checklist_programacion');

const llaves = Object.fromEntries(fs.readFileSync('/tmp/pase-local/llaves.env', 'utf8').split('\n').filter(Boolean).map((l) => l.split('=')));
execFileSync('node', [path.join(RAIZ, 'web', 'construir.mjs')], {
  env: { ...process.env, PASE_SUPABASE_URL: 'http://127.0.0.1:54321', PASE_SUPABASE_LLAVE: llaves.ANON_KEY }, stdio: ['ignore', 'ignore', 'inherit'],
});
const servidor = spawn('node', [path.join(RAIZ, 'web', 'servir.mjs')], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 600));

fs.rmSync(CAPTURAS, { recursive: true, force: true });
fs.mkdirSync(CAPTURAS, { recursive: true });
const navegador = await chromium.launch();
const contexto = await navegador.newContext({ viewport: { width: 1180, height: 820 }, locale: 'es-VE', timezoneId: ZONA, serviceWorkers: 'allow' });
const page = await contexto.newPage();
const errores = [];
page.on('pageerror', (e) => errores.push(e.message));
page.on('requestfailed', (r) => { if (!r.url().includes('/auth/v1/health') && r.failure()?.errorText !== 'net::ERR_INTERNET_DISCONNECTED') console.log('  petición fallida', r.url(), r.failure()?.errorText); });
const foto = async (nombre, completa = false, p = page) => {
  if (completa) { await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(100); }
  await p.screenshot({ path: path.join(CAPTURAS, `${String(++n).padStart(2, '0')}-${nombre}.png`), fullPage: completa });
};
// Link de un correo de Auth sin mandar el correo (lo que haría el script de publicación con /invite)
async function linkDeCorreo(tipo, email) {
  const r = await fetch('http://127.0.0.1:54321/auth/v1/admin/generate_link', {
    method: 'POST',
    headers: { apikey: llaves.SERVICE_ROLE_KEY, authorization: `Bearer ${llaves.SERVICE_ROLE_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ type: tipo, email, redirect_to: `${WEB}/` }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`generate_link ${tipo}: ${JSON.stringify(j)}`);
  return j;
}

const teclado = () => page.getByRole('group', { name: 'Teclado numérico' });
async function entrar(pin) {
  await teclado().waitFor();
  await page.keyboard.type(pin, { delay: 70 });
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Bloquear y cambiar de usuario' }).waitFor({ timeout: 20_000 });
}
async function firmar(pin, conRecibo = false) {
  await page.getByRole('dialog').filter({ has: teclado() }).waitFor();
  await page.waitForTimeout(250);
  await page.keyboard.type(pin, { delay: 70 });
  if (conRecibo) {
    const recibo = page.getByRole('dialog', { name: 'Comprobante de firma' });
    await recibo.waitFor({ timeout: 30_000 });
    return recibo;
  }
  await page.getByRole('dialog').filter({ has: teclado() }).waitFor({ state: 'detached', timeout: 20_000 });
  return null;
}
const bloquear = async () => {
  await page.getByRole('button', { name: 'Bloquear y cambiar de usuario' }).click();
  await teclado().waitFor();
};
const ir = (t) => page.getByRole('navigation', { name: 'Secciones' }).getByRole('button', { name: t, exact: true }).click();
const aviso = (texto) => page.getByText(texto).first().waitFor({ timeout: 20_000 });

async function llenarPlanilla({ fallarUno = false } = {}) {
  let fallado = !fallarUno;
  for (let vuelta = 0; vuelta < 40; vuelta++) {
    const items = page.locator('li[data-tipo]');
    const total = await items.count();
    for (let k = 0; k < total; k++) {
      const li = items.nth(k);
      const tipo = await li.getAttribute('data-tipo');
      const min = await li.getAttribute('data-min');
      const max = await li.getAttribute('data-max');
      // El primer punto que puede fallar (sí/no, o un número con límite) se marca fuera de norma
      if (!fallado && (tipo === 'pass_fail' || (tipo === 'number' && (min || max)))) {
        fallado = true;
        if (tipo === 'pass_fail') await li.getByRole('radio', { name: 'No cumple' }).click();
        else await li.locator('input').first().fill(String(max ? Number(max) + 5 : Number(min) - 5));
        const archivo = li.locator('input[type=file]');
        if (await archivo.count()) { await archivo.first().setInputFiles(IMAGEN); await li.getByText('Cambiar foto').first().waitFor(); }
        await li.getByLabel('Acción correctiva').fill('Lo corregí en el momento y avisé al supervisor');
      } else if (tipo === 'pass_fail') {
        await li.getByRole('radio', { name: 'Cumple', exact: true }).click();
      } else if (tipo === 'number') {
        const v = min && max ? (Number(min) + Number(max)) / 2 : min ? Number(min) + 2 : max ? Number(max) - 1 : 1;
        await li.locator('input').first().fill(String(v));
      } else if (tipo === 'choice') {
        await li.getByRole('radio').first().click();
      } else if (tipo === 'time') {
        await li.getByRole('button', { name: 'Ahora' }).click();
      } else if (tipo === 'photo') {
        await li.locator('input[type=file]').first().setInputFiles(IMAGEN);
        await li.getByText('Cambiar foto').first().waitFor();
      }
    }
    const enviar = page.getByRole('button', { name: 'Firmar y enviar' });
    if (await enviar.isVisible()) return enviar;
    await page.getByRole('button', { name: /Siguiente sección|Revisar/ }).click();
    await page.waitForTimeout(150);
  }
  throw new Error('La planilla no terminó');
}

try {
  /* ---------- 1. Registro de la tablet ---------- */
  await page.goto(WEB);
  await page.getByRole('heading', { name: 'Registrar este equipo' }).waitFor();
  await foto('registro-inicio');
  await page.getByRole('button', { name: 'Soy la gerente: empezar' }).click();
  await page.getByLabel('Correo').fill(DEMO.gerente.correo);
  await page.getByLabel('Contraseña').fill(DEMO.gerente.clave);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByRole('heading', { name: 'Activa la verificación en dos pasos' }).waitFor();
  const qrVisible = await page.getByAltText('Código QR para la app autenticadora').evaluate((i) => i.complete && i.naturalWidth > 0);
  ok(qrVisible, 'E01 el código QR para la app autenticadora se ve');
  await foto('registro-codigo-qr');
  const secreto = (await page.locator('code').innerText()).replace(/\s/g, '');
  await page.getByLabel('Código de 6 números').fill(totp(secreto));
  await page.getByRole('button', { name: 'Verificar' }).click();
  await page.getByRole('heading', { name: 'Este equipo' }).waitFor();
  await page.getByLabel('Nombre', { exact: true }).fill('Tablet línea caliente');
  await page.getByRole('radio', { name: 'Tablet de cocina' }).click();
  await page.getByLabel('Tu PIN').fill(mariela.pin);
  await foto('registro-equipo');
  await page.getByRole('button', { name: 'Registrar este equipo' }).click();
  await teclado().waitFor({ timeout: 20_000 });
  const disp = (await db.query(`select id from public.dispositivos where nombre = 'Tablet línea caliente' and activo`)).rows[0];
  ok(!!disp, 'E01 la gerente registra la tablet con correo, código de la app autenticadora y PIN');
  const listo = await page.evaluate(async () => !!(await navigator.serviceWorker.ready).active);
  ok(listo, 'E01 la app quedó guardada en la tablet para abrir sin internet');
  await page.waitForTimeout(500);
  await foto('bloqueo');

  /* ---------- 2. Ana llena una planilla con foto ---------- */
  await entrar(ana.pin);
  await page.getByRole('heading', { name: 'Mi turno' }).waitFor();
  await page.locator('button[aria-label^="Planilla "]').first().waitFor({ timeout: 15_000 });
  await foto('ana-mi-turno');
  // Una planilla de las que tienen puntos de sí/no, para que una falla abra su incidencia
  const conSiNo = (await db.query(`select distinct p.codigo from public.plantillas p
                                    join public.plantilla_items i on i.plantilla_id = p.id where i.tipo = 'pass_fail' and p.rol_asignado = 'operativo'`)).rows.map((r) => r.codigo);
  const abiertas = page.locator('button[aria-label^="Planilla "]:not([disabled])');
  const etiquetas = await abiertas.evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label')));
  const k = Math.max(0, etiquetas.findIndex((e) => conSiNo.includes(e.split(' ')[1].replace(',', ''))));
  const comanda = abiertas.nth(k);
  const nombrePlanilla = await comanda.getAttribute('aria-label');
  await comanda.click();
  await page.locator('li[data-tipo]').first().waitFor();
  await page.waitForTimeout(500);
  await foto('ana-planilla');
  const enviar = await llenarPlanilla({ fallarUno: true });
  await foto('ana-planilla-revision');
  await enviar.click();
  await page.getByRole('dialog').filter({ has: teclado() }).waitFor();
  await foto('ana-firma-pin');
  let recibo = await firmar(ana.pin, true);
  await page.waitForTimeout(900);
  await foto('ana-comprobante');
  await recibo.getByRole('button', { name: 'Listo' }).click().catch(() => page.getByRole('button', { name: 'Listo' }).click());
  const ej = (await db.query(`select e.id, e.items_no_cumple, f.metodo, (select count(*)::int from public.incidencias i where i.ejecucion_id = e.id) inc
                              from public.checklist_ejecuciones e join public.firmas f on f.id = e.firma_id
                              where e.realizada_por = $1 order by e.completada_en desc limit 1`, [ana.id])).rows[0];
  ok(ej && ej.metodo === 'pin_en_linea' && ej.items_no_cumple === 1 && ej.inc === 1,
    `E02 Ana firma ${nombrePlanilla?.split('.')[0]}: un punto no cumple y se abre su incidencia`, ej);
  const fotos = (await db.query(`select count(*)::int n from public.evidencias`)).rows[0].n;
  ok(fotos >= 1, `E02 las fotos llegaron al servidor (${fotos})`);

  /* ---------- 3. Ana reporta una falla crítica ---------- */
  await page.getByRole('button', { name: /Reportar una falla/ }).first().click();
  await page.getByLabel('¿Qué pasó?').fill('La cava 2 marca 9 °C');
  await page.getByRole('radio', { name: 'Cocina', exact: true }).click();
  await page.getByRole('radio', { name: /^Crítica/ }).click();
  await page.getByText('Hay que dejar de usar el equipo o el área').click();
  await page.locator('input[type=file]').setInputFiles(IMAGEN);
  await page.getByText('Cambiar foto').waitFor();
  await foto('ana-reportar-falla', true);
  await page.getByRole('button', { name: 'Firmar y reportar' }).click();
  recibo = await firmar(ana.pin, true);
  await page.waitForTimeout(900);
  await foto('ana-falla-comprobante');
  await page.getByRole('button', { name: 'Listo' }).click();
  const falla = (await db.query(`select id, severidad, bloquea_operacion, evidencia_id from public.incidencias where titulo = 'La cava 2 marca 9 °C'`)).rows[0];
  ok(falla?.severidad === 'critica' && falla.bloquea_operacion && falla.evidencia_id, 'E03 la falla crítica queda con foto y marcada «No operar»', falla);
  await bloquear();

  /* ---------- 4. Luis (supervisor) la atiende y la resuelve ---------- */
  await entrar(luis.pin);
  await foto('luis-inicio', true);
  await ir('Incidencias');
  const tarjeta = page.locator('article').filter({ hasText: 'La cava 2 marca 9 °C' });
  await tarjeta.waitFor();
  await foto('luis-incidencias');
  await tarjeta.getByRole('button', { name: 'Atender' }).click();
  await tarjeta.getByRole('button', { name: 'Firmar' }).click();
  await firmar(luis.pin);
  await aviso('Incidencia en proceso.');
  await tarjeta.getByRole('button', { name: 'Resolver' }).click();
  await tarjeta.getByLabel('¿Qué se hizo? (acción correctiva)').fill('Se pasó la mercancía a la cava 1 y se llamó al técnico de refrigeración');
  await tarjeta.getByLabel('¿Por qué pasó? (causa raíz, opcional)').fill('Empaque de la puerta dañado');
  await tarjeta.getByRole('button', { name: 'Firmar como resuelta' }).click();
  await firmar(luis.pin);
  await aviso('Resuelta. La gerente debe verificarla.');
  await foto('luis-resuelta');
  ok((await db.query(`select estado from public.incidencias where id = $1`, [falla.id])).rows[0].estado === 'resuelta', 'E04 el supervisor la atiende y la resuelve con firma');
  ok(!(await tarjeta.getByRole('button', { name: 'Verificar y cerrar' }).count()) && await tarjeta.getByText('La resolviste tú: la verifica otra persona.').isVisible(),
    'E04 quien la resolvió no puede verificarla');
  await bloquear();

  /* ---------- 5. Mariela (gerente): panel, verificar, revisar, personal, equipos, bitácora ---------- */
  await entrar(mariela.pin);
  await page.getByRole('heading', { name: 'Panel del día' }).waitFor();
  await page.getByText('Planillas hechas', { exact: true }).waitFor();
  await foto('gerente-panel', true);
  await ir('Incidencias');
  const t2 = page.locator('article').filter({ hasText: 'La cava 2 marca 9 °C' });
  await t2.getByRole('button', { name: 'Verificar y cerrar' }).click();
  await firmar(mariela.pin);
  await aviso('Incidencia verificada y cerrada.');
  ok((await db.query(`select estado from public.incidencias where id = $1`, [falla.id])).rows[0].estado === 'verificada', 'E05 la gerente verifica y cierra la incidencia crítica');

  await ir('Historial');
  await page.getByRole('button', { name: /Ana Pérez/ }).first().click();
  await page.getByRole('heading', { name: 'Revisión' }).waitFor();
  await foto('gerente-planilla-firmada', true);
  await page.getByRole('button', { name: 'Todo en orden: revisada' }).click();
  await firmar(mariela.pin);
  await aviso('Planilla revisada.');
  ok((await db.query(`select estado from public.checklist_ejecuciones where id = $1`, [ej.id])).rows[0].estado === 'revisada', 'E05 la gerente revisa la planilla de Ana');

  await ir('Personal');
  await page.getByRole('button', { name: 'Agregar persona' }).click();
  await page.getByLabel('Nombre', { exact: true }).fill('Nora');
  await page.getByLabel('Apellido').fill('Salas');
  await page.getByLabel('Cargo').fill('Cajera de autoservicio');
  await page.getByLabel('Turno').selectOption('noche');
  await foto('gerente-agregar-persona');
  await page.getByRole('button', { name: 'Firmar y agregar' }).click();
  await firmar(mariela.pin);
  const dialogoPin = page.getByRole('dialog', { name: 'PIN provisional' });
  await dialogoPin.waitFor({ timeout: 20_000 });
  const pinNora = (await dialogoPin.locator('p.num').innerText()).trim();
  await foto('gerente-pin-provisional');
  ok(/^\d{4}$/.test(pinNora), 'E06 la gerente da de alta a Nora y ve su PIN provisional una sola vez');
  await dialogoPin.getByText('Ya se lo entregué').click();
  await dialogoPin.getByRole('button', { name: 'Listo' }).click();
  await foto('gerente-personal', true);

  await ir('Equipos');
  await page.getByText('Este equipo').first().waitFor();
  await foto('gerente-equipos');
  await ir('Bitácora');
  await page.getByText(/Ana Pérez creó · Incidencias/).first().waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Verificar integridad' }).click();
  await page.getByText(/Bitácora íntegra/).waitFor({ timeout: 20_000 });
  await foto('gerente-bitacora');
  ok(true, 'E07 la bitácora muestra los cambios y su cadena está íntegra');
  await bloquear();

  /* ---------- 6. Nora estrena su PIN ---------- */
  await teclado().waitFor();
  await page.keyboard.type(pinNora, { delay: 70 });
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Hola, Nora' }).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Ver mi PIN personal' }).click();
  const pinPersonal = (await page.locator('p.num').first().innerText()).trim();
  await foto('nora-pin-personal');
  for (const d of pinPersonal) await teclado().getByRole('button', { name: d, exact: true }).click();
  await page.getByRole('button', { name: 'Bloquear y cambiar de usuario' }).waitFor({ timeout: 20_000 });
  const cred = (await db.query(`select c.debe_cambiar from privado.credenciales_pin c join public.usuarios u on u.id = c.usuario_id where u.nombre = 'Nora'`)).rows[0];
  ok(cred && !cred.debe_cambiar && pinPersonal !== pinNora, 'E08 Nora cambia el provisional por su PIN personal y entra');
  await bloquear();

  /* ---------- 7. Sin internet ---------- */
  await contexto.setOffline(true);
  await page.reload();
  await teclado().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(800);
  await foto('sin-internet-bloqueo');
  ok(true, 'E09 sin internet, la app abre desde la tablet');
  await entrar(ana.pin);
  await page.getByText(/Sin conexión/).first().waitFor();
  const otra = page.locator('button[aria-label^="Planilla "]:not([disabled])').first();
  await otra.waitFor({ timeout: 15_000 });
  await otra.click();
  await page.locator('li[data-tipo]').first().waitFor();
  const enviar2 = await llenarPlanilla();
  await enviar2.click();
  recibo = await firmar(ana.pin, true);
  await page.waitForTimeout(900);
  await foto('sin-internet-comprobante');
  await page.getByRole('button', { name: 'Listo' }).click();
  await page.getByRole('button', { name: /1 por enviar/ }).first().click();
  await page.getByRole('heading', { name: 'Por enviar' }).waitFor();
  await foto('sin-internet-por-enviar');
  ok(true, 'E10 Ana entra con su PIN y firma una planilla sin internet; queda por enviar');

  await contexto.setOffline(false);
  await page.getByText('Todo lo firmado en esta tablet ya llegó al servidor.').waitFor({ timeout: 70_000 });
  await foto('conexion-volvio');
  const offline = (await db.query(`select e.registrada_sin_conexion, f.metodo from public.checklist_ejecuciones e join public.firmas f on f.id = e.firma_id
                                   where e.realizada_por = $1 order by e.completada_en desc limit 1`, [ana.id])).rows[0];
  ok(offline?.registrada_sin_conexion && offline.metodo === 'pin_sin_conexion', 'E11 al volver la señal se envía sola, a nombre de Ana y marcada sin conexión', offline);

  /* ---------- 8. Una gerente nueva llega por su correo de invitación ---------- */
  const NUEVA = { correo: 'gabriela@pase.test', clave: 'Gabriela-Pase-2026' };
  const invitacion = await linkDeCorreo('invite', NUEVA.correo);
  await db.query(`select app.alta_gerente($1, 'Gabriela', 'Suárez')`, [invitacion.id]);
  const ctx2 = await navegador.newContext({ viewport: { width: 1180, height: 820 }, locale: 'es-VE', timezoneId: ZONA, serviceWorkers: 'allow' });
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => errores.push(e.message));
  await p2.goto(invitacion.action_link);
  await p2.getByRole('heading', { name: 'Crea tu contraseña' }).waitFor({ timeout: 20_000 });
  ok(!p2.url().includes('access_token'), 'E12 el link de la invitación abre la app y la sesión no queda en la barra de direcciones');
  await p2.getByLabel('Contraseña nueva').fill(NUEVA.clave);
  await p2.getByLabel('Repítela').fill(NUEVA.clave);
  await foto('invitacion-crear-clave', false, p2);
  await p2.getByRole('button', { name: 'Guardar contraseña' }).click();
  await p2.getByRole('heading', { name: 'Activa la verificación en dos pasos' }).waitFor({ timeout: 20_000 });
  const secreto2 = (await p2.locator('code').innerText()).replace(/\s/g, '');
  await p2.getByLabel('Código de 6 números').fill(totp(secreto2));
  await p2.getByRole('button', { name: 'Verificar' }).click();
  await p2.getByRole('heading', { name: 'Tu PIN de gerente' }).waitFor({ timeout: 20_000 });
  await p2.getByRole('button', { name: 'Generar mi PIN' }).click();
  const pinGabriela = (await p2.getByLabel('Tu PIN nuevo').innerText()).trim();
  await foto('invitacion-pin-nuevo', false, p2);
  await p2.getByRole('button', { name: 'Ya me lo aprendí' }).click();
  await p2.getByLabel('Escríbelo de memoria').fill(pinGabriela);
  await p2.getByRole('button', { name: 'Continuar' }).click();
  await p2.getByRole('heading', { name: 'Este equipo' }).waitFor();
  await p2.getByLabel('Nombre', { exact: true }).fill('PC de gerencia');
  await p2.getByRole('radio', { name: 'PC de gerencia' }).click();
  ok((await p2.getByLabel('Tu PIN').inputValue()) === pinGabriela, 'E12 genera su PIN de 6 dígitos, lo confirma de memoria y queda listo para firmar el registro');
  await p2.getByRole('button', { name: 'Registrar este equipo' }).click();
  await p2.getByRole('group', { name: 'Teclado numérico' }).waitFor({ timeout: 20_000 });
  await p2.keyboard.type(pinGabriela, { delay: 70 });
  await p2.waitForTimeout(150);
  await p2.keyboard.press('Enter');
  await p2.getByRole('heading', { name: 'Panel del día' }).waitFor({ timeout: 20_000 });
  await foto('invitacion-primer-ingreso', false, p2);
  ok(/^\d{6}$/.test(pinGabriela), 'E12 la gerente nueva registra su PC y entra con su PIN');
  await p2.getByRole('button', { name: 'Bloquear y cambiar de usuario' }).click();
  await p2.getByRole('group', { name: 'Teclado numérico' }).waitFor();

  /* ---------- 9. Contraseña olvidada ---------- */
  const NUEVA_CLAVE = 'Gabriela-Nueva-2026';
  const recuperacion = await linkDeCorreo('recovery', NUEVA.correo);
  await p2.goto(recuperacion.action_link);
  await p2.getByRole('heading', { name: 'Código de verificación' }).waitFor({ timeout: 20_000 });
  await p2.getByLabel('Código de 6 números').fill(totp(secreto2));
  await p2.getByRole('button', { name: 'Verificar' }).click();
  await p2.getByRole('heading', { name: 'Contraseña nueva' }).waitFor({ timeout: 20_000 });
  await p2.getByLabel('Contraseña nueva').fill(NUEVA_CLAVE);
  await p2.getByLabel('Repítela').fill(NUEVA_CLAVE);
  await p2.getByRole('button', { name: 'Guardar contraseña' }).click();
  await p2.getByText('Contraseña guardada.').waitFor({ timeout: 20_000 });
  ok(await p2.getByRole('group', { name: 'Teclado numérico' }).isVisible(), 'E13 con el link de recuperación pide el código de la app, cambia la contraseña y vuelve al bloqueo');

  const ctx3 = await navegador.newContext({ viewport: { width: 1180, height: 820 }, locale: 'es-VE', timezoneId: ZONA });
  const p3 = await ctx3.newPage();
  p3.on('pageerror', (e) => errores.push(e.message));
  await p3.goto(`${WEB}/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`);
  await p3.getByRole('heading', { name: 'Este link ya no sirve' }).waitFor({ timeout: 20_000 });
  await foto('link-vencido', false, p3);
  await p3.getByRole('button', { name: 'Ir a la entrada' }).click();
  await p3.getByRole('button', { name: 'Soy la gerente: empezar' }).click();
  await p3.getByLabel('Correo').fill(NUEVA.correo);
  await p3.getByRole('button', { name: '¿Olvidaste tu contraseña?' }).click();
  await p3.getByText(/le llegó un correo con un link/).waitFor({ timeout: 20_000 });
  await foto('olvide-mi-clave', false, p3);
  await p3.getByLabel('Contraseña').fill(NUEVA_CLAVE);
  await p3.getByRole('button', { name: 'Continuar' }).click();
  await p3.getByRole('heading', { name: 'Código de verificación' }).waitFor({ timeout: 20_000 });
  await p3.getByLabel('Código de 6 números').fill(totp(secreto2));
  await p3.getByRole('button', { name: 'Verificar' }).click();
  await p3.getByRole('heading', { name: 'Este equipo' }).waitFor({ timeout: 20_000 });
  ok(true, 'E14 un link vencido se explica, «¿Olvidaste tu contraseña?» pide el correo, y la contraseña nueva sirve (ya con PIN, va directo al equipo)');
  await ctx2.close();
  await ctx3.close();

  ok(!errores.length, 'E15 sin errores de JavaScript en toda la prueba', errores);
  console.log(`\nPrueba de punta a punta: todo pasó. Capturas en ${path.relative(RAIZ, CAPTURAS)}/`);
} catch (e) {
  await foto('fallo', true).catch(() => {});
  console.log('ERROR', e.message);
  if (errores.length) console.log('Errores de la página:', errores);
  process.exitCode = 1;
} finally {
  await navegador.close();
  servidor.kill();
  await db.end();
}
