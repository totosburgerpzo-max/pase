// Genera la llave anónima y la de servicio (JWT HS256) para el Supabase local.
// Uso: node llaves.mjs <secreto>   → imprime ANON_KEY=… y SERVICE_ROLE_KEY=…
import { createHmac } from 'node:crypto';

export function firmarJwt(payload, secreto) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const cuerpo = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`;
  return `${cuerpo}.${createHmac('sha256', secreto).update(cuerpo).digest('base64url')}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const secreto = process.argv[2];
  if (!secreto) { console.error('Falta el secreto'); process.exit(1); }
  const base = { iss: 'supabase-local', iat: 1760400000, exp: 2075760000 };
  console.log(`ANON_KEY=${firmarJwt({ ...base, role: 'anon' }, secreto)}`);
  console.log(`SERVICE_ROLE_KEY=${firmarJwt({ ...base, role: 'service_role' }, secreto)}`);
}
