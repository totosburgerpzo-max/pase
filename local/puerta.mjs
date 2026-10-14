// Puerta del Supabase local: hace lo que Kong hace en Supabase (rutas, llave de la API, CORS)
// y simula Storage con las mismas políticas de RLS de storage.objects.
//   /rest/v1/*       → PostgREST :54325
//   /auth/v1/*       → GoTrue :54324
//   /functions/v1/*  → Edge Functions (Deno) :54326, sin CORS ni llave: la función responde
//   /storage/v1/*    → Storage simulado (archivos en disco, filas en storage.objects)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import pg from 'pg';
import { firmarJwt } from './llaves.mjs';

const { JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY } = process.env;
const ALMACEN = process.env.ALMACEN ?? '/tmp/pase-local/storage';
const PUERTO = Number(process.env.PUERTO ?? 54321);
const DESTINOS = { rest: 54325, auth: 54324, functions: 54326 };
const pool = new pg.Pool({ host: '127.0.0.1', port: 54322, user: 'postgres', database: 'postgres', max: 5 });

const CORS = {
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type, x-upsert, prefer, range, accept-profile, content-profile, x-supabase-api-version',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-expose-headers': 'content-range, content-type, x-supabase-api-version',
  'access-control-max-age': '600',
};
const corsDe = (req) => ({ ...CORS, 'access-control-allow-origin': req.headers.origin ?? '*' });

function json(res, req, estado, cuerpo, cors = true) {
  res.writeHead(estado, { 'content-type': 'application/json', ...(cors ? corsDe(req) : {}) });
  res.end(JSON.stringify(cuerpo));
}

function verificarJwt(token) {
  const partes = String(token ?? '').split('.');
  if (partes.length !== 3) return null;
  const esperado = createHmac('sha256', JWT_SECRET).update(`${partes[0]}.${partes[1]}`).digest();
  const dado = Buffer.from(partes[2], 'base64url');
  if (dado.length !== esperado.length || !timingSafeEqual(dado, esperado)) return null;
  const claims = JSON.parse(Buffer.from(partes[1], 'base64url').toString());
  if (claims.exp && claims.exp * 1000 < Date.now()) return null;
  return claims;
}

function proxy(req, res, puerto, ruta, cors) {
  const headers = { ...req.headers, host: `127.0.0.1:${puerto}` };
  const ip = req.socket.remoteAddress?.replace('::ffff:', '') ?? '127.0.0.1';
  headers['x-forwarded-for'] = headers['x-forwarded-for'] ? `${headers['x-forwarded-for']}, ${ip}` : ip;
  const p = http.request({ host: '127.0.0.1', port: puerto, method: req.method, path: ruta, headers }, (r) => {
    const h = { ...r.headers };
    if (cors) Object.assign(h, corsDe(req));
    res.writeHead(r.statusCode ?? 502, h);
    r.pipe(res);
  });
  p.on('error', (e) => json(res, req, 502, { message: `Servicio no disponible: ${e.message}` }, cors));
  req.pipe(p);
}

const leerCuerpo = (req) => new Promise((ok, mal) => {
  const partes = [];
  req.on('data', (c) => partes.push(c));
  req.on('end', () => ok(Buffer.concat(partes)));
  req.on('error', mal);
});

/* ---------------- Storage simulado ---------------- */
async function comoUsuario(claims, fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    if (claims.role !== 'service_role') {
      await c.query(`select set_config('role', $1, true), set_config('request.jwt.claims', $2, true)`,
        [claims.role === 'authenticated' ? 'authenticated' : 'anon', JSON.stringify(claims)]);
    }
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

async function storage(req, res, ruta, url) {
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const m = ruta.match(/^\/object\/(sign\/|authenticated\/|public\/)?([^/]+)\/(.+)$/);
  if (!m) return json(res, req, 404, { statusCode: '404', error: 'not_found', message: 'Ruta no simulada' });
  const [, modo, bucket, nombre] = m;
  const archivo = path.join(ALMACEN, bucket, decodeURIComponent(nombre));
  if (!archivo.startsWith(path.join(ALMACEN, bucket) + path.sep)) return json(res, req, 400, { message: 'Ruta inválida' });

  if (modo === 'sign/' && req.method === 'GET') {
    const t = verificarJwt(url.searchParams.get('token'));
    if (!t || t.url !== `${bucket}/${decodeURIComponent(nombre)}`) return json(res, req, 400, { statusCode: '400', error: 'InvalidJWT', message: 'Firma inválida o vencida' });
    return servirArchivo(req, res, archivo);
  }
  const claims = verificarJwt(token);
  if (!claims) return json(res, req, 400, { statusCode: '403', error: 'Unauthorized', message: 'invalid signature' });

  try {
    if (!modo && (req.method === 'POST' || req.method === 'PUT')) {
      const cuerpo = await leerCuerpo(req);
      const tipo = String(req.headers['content-type'] ?? 'application/octet-stream').split(';')[0];
      const b = (await pool.query('select * from storage.buckets where id = $1', [bucket])).rows[0];
      if (!b) return json(res, req, 400, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' });
      if (b.allowed_mime_types?.length && !b.allowed_mime_types.includes(tipo))
        return json(res, req, 400, { statusCode: '415', error: 'invalid_mime_type', message: `mime type ${tipo} is not supported` });
      if (b.file_size_limit && cuerpo.length > Number(b.file_size_limit))
        return json(res, req, 400, { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' });
      const id = randomUUID();
      await comoUsuario(claims, (c) => c.query(
        `insert into storage.objects (id, bucket_id, name, owner, owner_id, metadata) values ($1, $2, $3, $4, $5, $6)`,
        [id, bucket, decodeURIComponent(nombre), claims.sub ?? null, claims.sub ?? null, { mimetype: tipo, size: cuerpo.length }]));
      fs.mkdirSync(path.dirname(archivo), { recursive: true });
      fs.writeFileSync(archivo, cuerpo);
      return json(res, req, 200, { Key: `${bucket}/${decodeURIComponent(nombre)}`, Id: id });
    }
    const visible = async () => (await comoUsuario(claims, (c) => c.query(
      'select metadata from storage.objects where bucket_id = $1 and name = $2', [bucket, decodeURIComponent(nombre)]))).rows[0];
    if (modo === 'authenticated/' && req.method === 'GET') {
      const fila = await visible();
      if (!fila) return json(res, req, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      return servirArchivo(req, res, archivo, fila.metadata?.mimetype);
    }
    if (modo === 'sign/' && req.method === 'POST') {
      const { expiresIn = 60 } = JSON.parse((await leerCuerpo(req)).toString() || '{}');
      if (!(await visible())) return json(res, req, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      const t = firmarJwt({ url: `${bucket}/${decodeURIComponent(nombre)}`, exp: Math.floor(Date.now() / 1000) + expiresIn }, JWT_SECRET);
      return json(res, req, 200, { signedURL: `/object/sign/${bucket}/${nombre}?token=${t}` });
    }
  } catch (e) {
    const rls = /row-level security/.test(e.message);
    const dup = e.code === '23505';
    return json(res, req, 400, { statusCode: rls ? '403' : dup ? '409' : '500', error: rls ? 'Unauthorized' : dup ? 'Duplicate' : 'internal', message: e.message });
  }
  return json(res, req, 405, { message: 'Método no simulado' });
}

function servirArchivo(req, res, archivo, tipo) {
  if (!fs.existsSync(archivo)) return json(res, req, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
  res.writeHead(200, { 'content-type': tipo ?? 'application/octet-stream', 'cache-control': 'private, max-age=3600', ...corsDe(req) });
  fs.createReadStream(archivo).pipe(res);
}

/* ---------------- Rutas ---------------- */
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/salud') return json(res, req, 200, { ok: true });
  const [, servicio, version, ...resto] = url.pathname.split('/');
  const ruta = '/' + resto.join('/') + url.search;
  if (servicio === 'functions' && version === 'v1') {
    return proxy(req, res, DESTINOS.functions, ruta, false);
  }
  if (!['rest', 'auth', 'storage'].includes(servicio) || version !== 'v1') return json(res, req, 404, { message: 'no route matched' });
  if (req.method === 'OPTIONS') { res.writeHead(204, corsDe(req)); return res.end(); }

  // Kong: la llave va en "apikey"; sin Authorization se usa la llave como token
  const llave = req.headers.apikey ?? url.searchParams.get('apikey');
  const libre = servicio === 'auth' && /^\/(verify|callback|authorize|health|settings)/.test(ruta)
             || servicio === 'storage' && /^\/object\/(sign|public)\//.test(ruta.split('?')[0]) && req.method === 'GET';
  if (!libre && llave !== ANON_KEY && llave !== SERVICE_ROLE_KEY) return json(res, req, 401, { message: 'Invalid API key' });
  if (!req.headers.authorization && llave) req.headers.authorization = `Bearer ${llave}`;

  if (servicio === 'storage') return void storage(req, res, ruta.split('?')[0], url).catch((e) => json(res, req, 500, { message: e.message }));
  return proxy(req, res, DESTINOS[servicio], ruta, true);
}).listen(PUERTO, '127.0.0.1', () => console.log(`Puerta en http://127.0.0.1:${PUERTO}`));
