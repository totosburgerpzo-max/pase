// Imitación local de la Management API de Supabase, solo con lo que usa scripts/desplegar.mjs,
// para ensayar la publicación contra el Supabase local (pruebas/despliegue.mjs):
//   database/query   corre el SQL en la base local con el protocolo simple (como el panel):
//                    varias sentencias en una consulta son una sola transacción
//   functions/deploy revisa el formulario: metadata, punto de entrada y que cada import
//                    relativo venga en los archivos subidos
//   secrets, config/auth, api-keys: se guardan en memoria y se pueden consultar
import http from 'node:http';
import path from 'node:path';
import pg from 'pg';

const PUERTO = Number(process.env.PUERTO ?? 54330);
const TOKEN = process.env.TOKEN_FALSO ?? 'token-falso';
const { ANON_KEY, SERVICE_ROLE_KEY } = process.env;
const pool = new pg.Pool({ host: '127.0.0.1', port: 54322, user: 'postgres', database: 'postgres', max: 3 });
const estado = { funciones: new Map(), secretos: new Map(), auth: {}, consultas: 0 };

const responder = (res, codigo, cuerpo) => {
  res.writeHead(codigo, { 'content-type': 'application/json' });
  res.end(JSON.stringify(cuerpo));
};
const leer = (req) => new Promise((ok) => { const p = []; req.on('data', (c) => p.push(c)); req.on('end', () => ok(Buffer.concat(p))); });

http.createServer(async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return responder(res, 401, { message: 'Unauthorized' });
    const url = new URL(req.url, 'http://x');
    const m = url.pathname.match(/^\/v1\/projects\/([a-z0-9-]+)(\/.*)?$/);
    if (!m) return responder(res, 404, { message: 'Not found' });
    const [, ref, resto = ''] = m;
    const cuerpo = await leer(req);
    const j = () => JSON.parse(cuerpo.toString() || 'null');

    if (resto === '' && req.method === 'GET') return responder(res, 200, { id: ref, ref, name: 'pase-local', region: 'local', status: 'ACTIVE_HEALTHY' });

    if (resto === '/database/query' && req.method === 'POST') {
      estado.consultas++;
      const c = await pool.connect();
      try {
        const r = await c.query(j().query);
        const ultimo = Array.isArray(r) ? r[r.length - 1] : r;
        return responder(res, 201, ultimo?.rows ?? []);
      } catch (e) {
        return responder(res, 400, { message: `Failed to run sql query: ${e.message}` });
      } finally {
        c.release();
      }
    }

    if (resto === '/functions/deploy' && req.method === 'POST') {
      const slug = url.searchParams.get('slug');
      const datos = await new Request('http://x', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: cuerpo }).formData();
      const meta = JSON.parse(datos.get('metadata'));
      const archivos = new Map();
      for (const f of datos.getAll('file')) archivos.set(f.name, await f.text());
      if (!meta?.entrypoint_path || !archivos.has(meta.entrypoint_path)) {
        return responder(res, 400, { message: `Entrypoint ${meta?.entrypoint_path} not found in uploaded files` });
      }
      for (const [nombre, texto] of archivos) {
        for (const [, imp] of texto.matchAll(/from\s+'(\.{1,2}\/[^']+)'/g)) {
          const destino = path.posix.normalize(path.posix.join(path.posix.dirname(nombre), imp));
          if (!archivos.has(destino)) return responder(res, 400, { message: `Module not found: ${destino} (imported from ${nombre})` });
        }
      }
      const previa = estado.funciones.get(slug);
      const f = { id: slug, slug, name: meta.name ?? slug, version: (previa?.version ?? 0) + 1, status: 'ACTIVE',
        verify_jwt: meta.verify_jwt ?? true, entrypoint_path: meta.entrypoint_path, archivos: [...archivos.keys()] };
      estado.funciones.set(slug, f);
      return responder(res, 201, f);
    }
    if (resto === '/functions' && req.method === 'GET') return responder(res, 200, [...estado.funciones.values()]);

    if (resto === '/secrets' && req.method === 'POST') {
      for (const s of j()) estado.secretos.set(s.name, s.value);
      return responder(res, 201, {});
    }
    if (resto === '/secrets' && req.method === 'GET') {
      return responder(res, 200, [...estado.secretos].map(([name, value]) => ({ name, value })));
    }

    if (resto === '/config/auth' && req.method === 'PATCH') { Object.assign(estado.auth, j()); return responder(res, 200, estado.auth); }
    if (resto === '/config/auth' && req.method === 'GET') return responder(res, 200, estado.auth);

    if (resto === '/api-keys' && req.method === 'GET') {
      const ver = url.searchParams.get('reveal') === 'true';
      return responder(res, 200, [
        { name: 'anon', type: 'legacy', api_key: ver ? ANON_KEY : null },
        { name: 'service_role', type: 'legacy', api_key: ver ? SERVICE_ROLE_KEY : null },
      ]);
    }

    // Para que la prueba lea lo que quedó
    if (resto === '/_estado' && req.method === 'GET') {
      return responder(res, 200, { funciones: [...estado.funciones.values()], secretos: Object.fromEntries(estado.secretos), auth: estado.auth, consultas: estado.consultas });
    }
    return responder(res, 404, { message: `No route ${req.method} ${resto}` });
  } catch (e) {
    return responder(res, 500, { message: e.message });
  }
}).listen(PUERTO, '127.0.0.1', () => console.log(`Management API falsa en http://127.0.0.1:${PUERTO}/v1`));
