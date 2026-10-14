// Datos de demostración del Supabase local: cuatro personas con PIN conocido (las mismas del
// prototipo), la cuenta de correo de la gerente y una tablet ya registrada para las pruebas
// de la API. Nada de esto va a producción.
import pg from 'pg';

const URL_API = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SERVICIO = process.env.SERVICE_ROLE_KEY;
const SUCURSAL = '5b1e0000-0000-4000-8000-000000000001';
export const DEMO = {
  sucursal: SUCURSAL,
  tablet: { id: 'd0000000-0000-4000-8000-0000000000aa', nombre: 'Tablet demo', secreto: 'secreto-de-la-tablet-demo' },
  gerente: { correo: 'gerente@pase.test', clave: 'Gerente-Local-2026' },
  personas: [
    { id: 'a0000000-0000-4000-8000-0000000000a1', nombre: 'Ana', apellido: 'Pérez', rol: 'operativo', cargo: 'Cocina · línea caliente', turno: 'mediodia', pin: '4821' },
    { id: 'a0000000-0000-4000-8000-0000000000a2', nombre: 'Carlos', apellido: 'Medina', rol: 'operativo', cargo: 'Salón y drive-thru', turno: 'noche', pin: '9054' },
    { id: 'a0000000-0000-4000-8000-0000000000a3', nombre: 'Luis', apellido: 'Rojas', rol: 'supervisor', cargo: 'Supervisor del turno noche', turno: 'noche', pin: '730914' },
    { id: 'a0000000-0000-4000-8000-0000000000a4', nombre: 'Mariela', apellido: 'Contreras', rol: 'admin', cargo: 'Gerente general', turno: 'gerencia', pin: '552108', gerente: true },
  ],
};

async function crearCuenta(cuerpo) {
  const r = await fetch(`${URL_API}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICIO, authorization: `Bearer ${SERVICIO}`, 'content-type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`No se creó la cuenta ${cuerpo.email}: ${JSON.stringify(j)}`);
  return j.id;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = new pg.Client({ host: '127.0.0.1', port: 54322, user: 'postgres', database: 'postgres' });
  await db.connect();
  for (const p of DEMO.personas) {
    const authId = p.gerente
      ? await crearCuenta({ email: DEMO.gerente.correo, password: DEMO.gerente.clave, email_confirm: true })
      : await crearCuenta({ email: `${p.id}@personal.pase.invalid`, email_confirm: true });
    await db.query(
      `insert into public.usuarios (id, auth_id, sucursal_id, nombre, apellido, cargo, rol, turno)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [p.id, authId, SUCURSAL, p.nombre, p.apellido, p.cargo, p.rol, p.turno]);
    await db.query(
      `insert into privado.credenciales_pin (usuario_id, pin_hash, pin_indice, longitud, debe_cambiar)
       values ($1, extensions.crypt($2, extensions.gen_salt('bf', 10)), privado.indice_pin($2), length($2), false)`,
      [p.id, p.pin]);
  }
  await db.query(
    `insert into public.dispositivos (id, sucursal_id, nombre, tipo) values ($1, $2, $3, 'tablet_cocina')`,
    [DEMO.tablet.id, SUCURSAL, DEMO.tablet.nombre]);
  await db.query(`insert into privado.dispositivo_secretos values ($1, extensions.digest($2, 'sha256'))`,
    [DEMO.tablet.id, DEMO.tablet.secreto]);
  await db.end();
  console.log(`Datos de demostración: ${DEMO.personas.length} personas y ${DEMO.tablet.nombre}`);
}
