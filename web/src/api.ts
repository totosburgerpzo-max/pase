// Cliente mínimo de Supabase para Pase: Auth (GoTrue), RPC (PostgREST), Storage y Edge
// Functions con fetch. La sesión vive solo en memoria: al recargar o bloquear, se vuelve a
// entrar con el PIN.
declare const __PASE__: { supabaseUrl: string; supabaseLlave: string; version: string };
export const CONFIG = __PASE__;
const URL_API = CONFIG.supabaseUrl;
const LLAVE = CONFIG.supabaseLlave;

export class ErrorApi extends Error {
  constructor(public estado: number, mensaje: string, public codigo?: string, public red = false, public datos?: any) {
    super(mensaje);
  }
}
export const esErrorDeRed = (e: unknown) => e instanceof ErrorApi && e.red;

export interface Sesion { access_token: string; refresh_token: string; expires_at: number }
let sesion: Sesion | null = null;
let renovando: Promise<void> | null = null;
let alPerderSesion: () => void = () => {};

export function usarSesion(s: Sesion | null) { sesion = s; }
export const haySesion = () => !!sesion;
export function cuandoSePierdaLaSesion(f: () => void) { alPerderSesion = f; }
export const reclamos = (jwt: string) => JSON.parse(atob(jwt.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));

async function token(): Promise<string | null> {
  if (!sesion) return null;
  if (sesion.expires_at * 1000 - Date.now() < 90_000) {
    renovando ??= (async () => {
      try {
        const s = await pedir<any>('/auth/v1/token?grant_type=refresh_token', { cuerpo: { refresh_token: sesion!.refresh_token }, sinToken: true });
        sesion = { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at };
      } catch (e) {
        if (!esErrorDeRed(e)) { sesion = null; alPerderSesion(); }
        throw e;
      } finally {
        renovando = null;
      }
    })();
    await renovando;
  }
  return sesion?.access_token ?? null;
}

interface Opciones {
  metodo?: string; cuerpo?: unknown; crudo?: BodyInit; tipo?: string; sinToken?: boolean; tokenPropio?: string;
  respuesta?: 'json' | 'blob'; tiempo?: number;
}

export async function pedir<T>(ruta: string, o: Opciones = {}): Promise<T> {
  const t = o.tokenPropio ?? (o.sinToken ? null : await token());
  const h: Record<string, string> = { apikey: LLAVE };
  if (t) h.authorization = `Bearer ${t}`;
  if (o.cuerpo !== undefined) h['content-type'] = 'application/json';
  else if (o.tipo) h['content-type'] = o.tipo;
  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), o.tiempo ?? 25_000);
  let r: Response;
  try {
    r = await fetch(URL_API + ruta, {
      method: o.metodo ?? (o.cuerpo !== undefined || o.crudo ? 'POST' : 'GET'),
      headers: h,
      body: o.cuerpo !== undefined ? JSON.stringify(o.cuerpo) : o.crudo,
      signal: control.signal,
      cache: 'no-store',
    });
  } catch {
    throw new ErrorApi(0, 'Sin conexión con el servidor', 'red', true);
  } finally {
    clearTimeout(reloj);
  }
  if (r.ok && o.respuesta === 'blob') return (await r.blob()) as T;
  const texto = await r.text();
  let j: any = null;
  try { j = texto ? JSON.parse(texto) : null; } catch { j = texto; }
  if (!r.ok) {
    if (r.status === 401 && t && !o.tokenPropio && /JWT|jwt|token/.test(j?.message ?? j?.msg ?? '')) { sesion = null; alPerderSesion(); }
    const mensaje = j?.message ?? j?.msg ?? j?.error_description ?? j?.error ?? `Error ${r.status}`;
    throw new ErrorApi(r.status, traducir(mensaje), j?.code ?? j?.error_code ?? j?.motivo, r.status >= 502 && r.status <= 504, j);
  }
  return j as T;
}

// Mensajes de GoTrue y PostgREST que la gente puede ver
function traducir(m: string): string {
  if (/Invalid login credentials/i.test(m)) return 'Correo o contraseña incorrectos';
  if (/Invalid TOTP code|invalid.*code/i.test(m)) return 'Código incorrecto o vencido. Escribe el que muestra ahora tu app.';
  if (/rate limit|too many/i.test(m)) return 'Demasiados intentos seguidos. Espera un momento.';
  if (/Email not confirmed/i.test(m)) return 'La cuenta todavía no está confirmada';
  if (/JWT expired/i.test(m)) return 'La sesión venció. Vuelve a entrar con tu PIN.';
  if (/different from the old password/i.test(m)) return 'La contraseña nueva tiene que ser distinta de la anterior.';
  if (/Password should|weak password/i.test(m)) return 'Esa contraseña es muy débil. Usa una más larga, que no sea fácil de adivinar.';
  if (/AAL2 session is required/i.test(m)) return 'Primero escribe el código de tu app autenticadora.';
  return m;
}

/* ---------- RPC y funciones ---------- */
export const rpc = <T = any>(nombre: string, args: Record<string, unknown> = {}) =>
  pedir<T>(`/rest/v1/rpc/${nombre}`, { cuerpo: args });

export const funcion = <T = any>(nombre: string, cuerpo: unknown, conSesion = false) =>
  pedir<T>(`/functions/v1/${nombre}`, { cuerpo, sinToken: !conSesion, tiempo: 40_000 });

export const funcionFormulario = <T = any>(nombre: string, datos: FormData) =>
  pedir<T>(`/functions/v1/${nombre}`, { crudo: datos, sinToken: true, tiempo: 90_000 });

/* ---------- Auth ---------- */
export interface Factor { id: string; factor_type: string; status: 'verified' | 'unverified'; friendly_name?: string }
export const auth = {
  entrar: (email: string, password: string) =>
    pedir<any>('/auth/v1/token?grant_type=password', { cuerpo: { email, password }, sinToken: true }),
  usuario: (t: string) => pedir<{ factors?: Factor[] }>('/auth/v1/user', { tokenPropio: t }),
  inscribirTotp: (t: string) =>
    pedir<{ id: string; totp: { qr_code: string; secret: string; uri: string } }>('/auth/v1/factors',
      { cuerpo: { factor_type: 'totp', friendly_name: `Pase ${new Date().toISOString().slice(0, 16)}` }, tokenPropio: t }),
  borrarFactor: (t: string, id: string) => pedir(`/auth/v1/factors/${id}`, { metodo: 'DELETE', tokenPropio: t }),
  verificarTotp: async (t: string, factor: string, codigo: string) => {
    const d = await pedir<{ id: string }>(`/auth/v1/factors/${factor}/challenge`, { cuerpo: {}, tokenPropio: t });
    return pedir<any>(`/auth/v1/factors/${factor}/verify`, { cuerpo: { challenge_id: d.id, code: codigo }, tokenPropio: t });
  },
  cambiarClave: (t: string, password: string) => pedir('/auth/v1/user', { metodo: 'PUT', cuerpo: { password }, tokenPropio: t }),
  // El correo trae un link de vuelta a esta misma página (debe estar en la lista de Auth)
  recuperar: (email: string) =>
    pedir(`/auth/v1/recover?redirect_to=${encodeURIComponent(location.origin + location.pathname)}`, { cuerpo: { email }, sinToken: true }),
  salir: (t: string) => pedir('/auth/v1/logout?scope=local', { cuerpo: {}, tokenPropio: t }).catch(() => {}),
  rpcCon: <T = any>(t: string, nombre: string, args: Record<string, unknown> = {}) =>
    pedir<T>(`/rest/v1/rpc/${nombre}`, { cuerpo: args, tokenPropio: t }),
};

/* ---------- Storage ---------- */
export const storage = {
  subir: (ruta: string, foto: Blob) =>
    pedir(`/storage/v1/object/evidencias/${ruta}`, { crudo: foto, tipo: foto.type, tiempo: 60_000 }).catch((e) => {
      if (e instanceof ErrorApi && (String(e.datos?.statusCode) === '409' || /Duplicate|already exists/i.test(e.message))) return null;
      throw e;
    }),
  ver: (ruta: string) => pedir<Blob>(`/storage/v1/object/authenticated/evidencias/${ruta}`, { respuesta: 'blob' }),
};

export async function hayServidor(): Promise<boolean> {
  try {
    await pedir('/auth/v1/health', { sinToken: true, tiempo: 6000 });
    return true;
  } catch (e) {
    return !(e instanceof ErrorApi && e.red);
  }
}
