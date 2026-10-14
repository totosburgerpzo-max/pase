// Lo que la app guarda en el equipo (IndexedDB):
//   kv           datos del equipo (con su secreto cifrado), catálogo, riel del día, clave AES
//   verificadores huella del PIN de quien entró aquí en los últimos días, cifrada, para
//                poder entrar y firmar sin internet
//   cola         lo firmado sin internet, hasta que llega al servidor
//   borradores   planillas a medio llenar
//   fotos        fotos de la cola y de los borradores
// La clave AES es "no extraíble": el navegador la usa pero no deja leerla ni copiarla.
import type { Contexto, TipoEquipo } from './tipos';

const NOMBRE = 'pase';
const ALMACENES = ['kv', 'verificadores', 'cola', 'borradores', 'fotos'] as const;
type Almacen = (typeof ALMACENES)[number];

let bd: Promise<IDBDatabase> | null = null;
function abrir(): Promise<IDBDatabase> {
  bd ??= new Promise((ok, mal) => {
    const r = indexedDB.open(NOMBRE, 1);
    r.onupgradeneeded = () => {
      for (const a of ALMACENES) if (!r.result.objectStoreNames.contains(a)) r.result.createObjectStore(a);
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => mal(r.error);
  });
  return bd;
}

async function tx<T>(almacen: Almacen, modo: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  const d = await abrir();
  return new Promise((ok, mal) => {
    const t = d.transaction(almacen, modo);
    const r = f(t.objectStore(almacen));
    t.oncomplete = () => ok(r ? r.result : (undefined as T));
    t.onerror = () => mal(t.error);
    t.onabort = () => mal(t.error);
  });
}

export const leer = <T>(a: Almacen, k: string) => tx<T | undefined>(a, 'readonly', (s) => s.get(k));
export const guardar = (a: Almacen, k: string, v: unknown) => tx<IDBValidKey>(a, 'readwrite', (s) => s.put(v, k));
export const borrar = (a: Almacen, k: string) => tx<undefined>(a, 'readwrite', (s) => s.delete(k));
export async function todos<T>(a: Almacen): Promise<{ clave: string; valor: T }[]> {
  const d = await abrir();
  return new Promise((ok, mal) => {
    const salida: { clave: string; valor: T }[] = [];
    const r = d.transaction(a, 'readonly').objectStore(a).openCursor();
    r.onsuccess = () => {
      const c = r.result;
      if (!c) return ok(salida);
      salida.push({ clave: String(c.key), valor: c.value as T });
      c.continue();
    };
    r.onerror = () => mal(r.error);
  });
}

/* ---------------- Cifrado ---------------- */
interface Cifrado { iv: Uint8Array; datos: ArrayBuffer }

async function clave(): Promise<CryptoKey> {
  let k = await leer<CryptoKey>('kv', 'clave');
  if (!k) {
    k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await guardar('kv', 'clave', k);
  }
  return k;
}
async function cifrar(v: unknown): Promise<Cifrado> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const datos = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await clave(), new TextEncoder().encode(JSON.stringify(v)));
  return { iv, datos };
}
async function descifrar<T>(c: Cifrado): Promise<T> {
  const t = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: c.iv as Uint8Array<ArrayBuffer> }, await clave(), c.datos);
  return JSON.parse(new TextDecoder().decode(t));
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
export const sha256 = async (b: ArrayBuffer | Uint8Array<ArrayBuffer>) => hex(await crypto.subtle.digest('SHA-256', b));

/* ---------------- Este equipo ---------------- */
export interface EquipoLocal { id: string; nombre: string; tipo: TipoEquipo; sucursal: string; secreto: string; registrado_en: string }

export async function equipoLocal(): Promise<EquipoLocal | null> {
  const c = await leer<Cifrado>('kv', 'equipo');
  if (!c) return null;
  try { return await descifrar<EquipoLocal>(c); } catch { return null; }
}
export async function guardarEquipo(e: EquipoLocal) { await guardar('kv', 'equipo', await cifrar(e)); }
export async function olvidarEquipo() {
  for (const a of ['kv', 'verificadores', 'borradores'] as const) {
    for (const { clave: k } of await todos(a)) await borrar(a, k);
  }
}

/* ---------------- Verificadores de PIN (entrar y firmar sin internet) ---------------- */
const ITERACIONES = 120_000;
interface Verificador { usuario_id: string; sal: string; huella: string; contexto: Contexto; guardado_en: number }

async function derivar(pin: string, sal: string): Promise<string> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(sal), iterations: ITERACIONES }, base, 256);
  return hex(bits);
}

export async function recordarPin(pin: string, contexto: Contexto) {
  const sal = hex(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const v: Verificador = { usuario_id: contexto.usuario.id, sal, huella: await derivar(pin, sal), contexto, guardado_en: Date.now() };
  await guardar('verificadores', contexto.usuario.id, await cifrar(v));
}
export async function olvidarPin(usuario: string) { await borrar('verificadores', usuario); }

const vigentes = async (dias: number) => {
  const salida: Verificador[] = [];
  for (const { clave: k, valor } of await todos<Cifrado>('verificadores')) {
    try {
      const v = await descifrar<Verificador>(valor);
      if (Date.now() - v.guardado_en < dias * 86_400_000) salida.push(v);
      else await borrar('verificadores', k);
    } catch { await borrar('verificadores', k); }
  }
  return salida;
};

/** Sin internet: ¿de quién es este PIN? Solo reconoce a quien entró en este equipo hace poco. */
export async function identificarSinConexion(pin: string, dias: number): Promise<Contexto | null> {
  for (const v of await vigentes(dias)) if (await derivar(pin, v.sal) === v.huella) return v.contexto;
  return null;
}
/** Sin internet: ¿este PIN es de esta persona? (para firmar) */
export async function comprobarSinConexion(usuario: string, pin: string, dias: number): Promise<boolean> {
  const v = (await vigentes(dias)).find((x) => x.usuario_id === usuario);
  return !!v && (await derivar(pin, v.sal)) === v.huella;
}
export const personasSinConexion = async (dias: number) => (await vigentes(dias)).length;

/* ---------------- Intentos fallidos sin internet ---------------- */
interface Intentos { fallos: number[]; hasta?: number }
export async function registrarFallo(): Promise<number | null> {
  const i = (await leer<Intentos>('kv', 'intentos')) ?? { fallos: [] };
  const ahora = Date.now();
  i.fallos = [...i.fallos.filter((t) => ahora - t < 5 * 60_000), ahora];
  if (i.fallos.length >= 10) { i.hasta = ahora + 15 * 60_000; i.fallos = []; }
  await guardar('kv', 'intentos', i);
  return i.hasta && i.hasta > ahora ? i.hasta : null;
}
export async function bloqueadoHasta(): Promise<number | null> {
  const i = await leer<Intentos>('kv', 'intentos');
  return i?.hasta && i.hasta > Date.now() ? i.hasta : null;
}
export async function limpiarFallos() { await guardar('kv', 'intentos', { fallos: [] }); }
