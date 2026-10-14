// Lo que comparten las Edge Functions de Pase: llamadas a la API de Supabase con la clave de
// servicio o con el token de la persona, sesiones de Supabase Auth abiertas desde el servidor
// y respuestas con CORS. Sin dependencias externas: solo fetch.

const URL_API = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');

// Proyectos con claves nuevas (sb_secret_…) o con las clásicas (JWT service_role)
function claveServicio(): string {
  const nuevas = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (nuevas) {
    try {
      const k = JSON.parse(nuevas);
      if (k?.default) return k.default;
    } catch { /* se usa la clásica */ }
  }
  const k = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!k) throw new Error('Falta la clave de servicio de Supabase');
  return k;
}
const SERVICIO = claveServicio();
// Una clave sb_secret_ no es un JWT: va solo en apikey y la puerta de Supabase pone el rol
const encabezadosServicio = (): Record<string, string> =>
  SERVICIO.startsWith('eyJ') ? { apikey: SERVICIO, authorization: `Bearer ${SERVICIO}` } : { apikey: SERVICIO };

/* ---------------- Respuestas ---------------- */
const ORIGENES = (Deno.env.get('PASE_ORIGENES') ?? '*').split(',').map((s) => s.trim()).filter(Boolean);

export function cors(req: Request): Record<string, string> {
  const origen = req.headers.get('origin') ?? '';
  const permitido = ORIGENES.includes('*') ? '*' : ORIGENES.includes(origen) ? origen : ORIGENES[0];
  return {
    'access-control-allow-origin': permitido,
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-max-age': '600',
    vary: 'origin',
  };
}

export function json(req: Request, cuerpo: unknown, estado = 200): Response {
  return new Response(JSON.stringify(cuerpo), {
    status: estado,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors(req) },
  });
}

export class ErrorPase extends Error {
  constructor(public estado: number, mensaje: string, public motivo?: string) {
    super(mensaje);
  }
}

// Envuelve el handler: OPTIONS, solo POST, y errores como JSON con su estado
export function servir(handler: (req: Request) => Promise<Response>) {
  Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
    if (req.method !== 'POST') return json(req, { error: 'Método no permitido' }, 405);
    try {
      return await handler(req);
    } catch (e) {
      if (e instanceof ErrorPase) return json(req, { error: e.message, motivo: e.motivo }, e.estado);
      console.error(e);
      return json(req, { error: 'Error del servidor' }, 500);
    }
  });
}

/* ---------------- Datos de la petición ---------------- */
// IP de la tablet: el primer salto de x-forwarded-for (lo pone la red de Supabase)
export function ipCliente(req: Request): string {
  return (req.headers.get('x-forwarded-for') ?? req.headers.get('cf-connecting-ip') ?? '').split(',')[0].trim();
}

export const tokenDe = (req: Request) => (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function uuid(v: unknown, campo: string): string {
  if (typeof v !== 'string' || !UUID.test(v)) throw new ErrorPase(400, `Falta ${campo}`);
  return v.toLowerCase();
}
export function texto(v: unknown, campo: string, max = 200): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new ErrorPase(400, `Falta ${campo}`);
  return v;
}

export async function leerJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const j = await req.json();
    if (j && typeof j === 'object') return j;
  } catch { /* abajo */ }
  throw new ErrorPase(400, 'Cuerpo no válido');
}

/* ---------------- API de Supabase ---------------- */
// Llama una función RPC. Sin token va con la clave de servicio y pasa la IP de la tablet en
// x-pase-ip (la base solo le cree ese encabezado al servicio). Con token, actúa la persona.
export async function rpc<T = unknown>(
  req: Request, nombre: string, args: Record<string, unknown>, token?: string,
): Promise<T> {
  const h: Record<string, string> = token
    ? { apikey: encabezadosServicio().apikey, authorization: `Bearer ${token}` }
    : { ...encabezadosServicio(), 'x-pase-ip': ipCliente(req) };
  const r = await fetch(`${URL_API}/rest/v1/rpc/${nombre}`, {
    method: 'POST',
    // El user-agent de la tablet va en x-pase-agente: con el de un navegador, Supabase rechaza
    // la clave secreta ("Forbidden use of secret API key in browser")
    headers: {
      ...h, 'content-type': 'application/json', 'user-agent': 'Pase-funciones',
      'x-pase-agente': (req.headers.get('user-agent') ?? 'Pase').slice(0, 300),
    },
    body: JSON.stringify(args),
  });
  const cuerpo = await r.text();
  const j = cuerpo ? JSON.parse(cuerpo) : null;
  if (!r.ok) {
    const estado = r.status === 401 || r.status === 403 ? 403 : r.status >= 500 ? 502 : 400;
    throw new ErrorPase(estado, j?.message ?? `Error en ${nombre}`, j?.code);
  }
  return j as T;
}

async function auth(ruta: string, cuerpo: unknown, token?: string): Promise<Response> {
  return await fetch(`${URL_API}/auth/v1${ruta}`, {
    method: 'POST',
    headers: {
      ...encabezadosServicio(),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(cuerpo),
  });
}

export interface Sesion {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at: number;
  session_id: string;
}

const reclamos = (jwt: string) =>
  JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));

// Abre una sesión de Supabase Auth para una cuenta sin enviarle nada: el servidor genera el
// enlace mágico y lo canjea él mismo. Solo se llama después de validar equipo + PIN.
export async function abrirSesion(correo: string): Promise<Sesion> {
  const g = await auth('/admin/generate_link', { type: 'magiclink', email: correo });
  const gj = await g.json();
  const hash = gj?.hashed_token ?? gj?.properties?.hashed_token;
  if (!g.ok || !hash) throw new ErrorPase(502, 'No se pudo abrir la sesión');
  let v = await auth('/verify', { type: 'magiclink', token_hash: hash });
  if (!v.ok && v.status === 400) v = await auth('/verify', { type: 'email', token_hash: hash });
  const s = await v.json();
  if (!v.ok || !s?.access_token) {
    console.error('verify', v.status, s);
    throw new ErrorPase(v.status === 429 ? 429 : 502, v.status === 429 ? 'Demasiados ingresos seguidos; espera un momento' : 'No se pudo abrir la sesión');
  }
  return {
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_in: s.expires_in,
    expires_at: s.expires_at ?? Math.floor(Date.now() / 1000) + s.expires_in,
    session_id: reclamos(s.access_token).session_id,
  };
}

export async function cerrarSesion(token: string): Promise<void> {
  await auth('/logout?scope=local', {}, token).catch(() => {});
}

export async function crearCuenta(correo: string): Promise<string> {
  const r = await auth('/admin/users', { email: correo, email_confirm: true });
  const j = await r.json();
  if (!r.ok || !j?.id) throw new ErrorPase(r.status === 422 ? 409 : 502, j?.msg ?? j?.message ?? 'No se pudo crear la cuenta');
  return j.id;
}

export async function borrarCuenta(id: string): Promise<void> {
  await fetch(`${URL_API}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: encabezadosServicio() }).catch(() => {});
}

// Sube una foto a Storage como la persona (queda como dueña del archivo)
export async function subirFoto(ruta: string, foto: Blob, token: string): Promise<void> {
  const r = await fetch(`${URL_API}/storage/v1/object/evidencias/${ruta}`, {
    method: 'POST',
    headers: { apikey: encabezadosServicio().apikey, authorization: `Bearer ${token}`, 'content-type': foto.type || 'image/webp' },
    body: foto,
  });
  if (r.ok) return;
  const j = await r.json().catch(() => ({}));
  // Ya estaba (un reintento): sirve igual
  if (String(j?.statusCode) === '409' || /already exists|Duplicate/i.test(j?.error ?? j?.message ?? '')) return;
  throw new ErrorPase(400, j?.message ?? 'No se pudo subir la foto');
}

export const DOMINIO_CORREO = Deno.env.get('PASE_CORREO_DOMINIO') ?? 'personal.pase.invalid';
