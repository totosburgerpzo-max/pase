// Sirve web/dist en http://127.0.0.1:5173 como lo haría Cloudflare Pages: aplica _headers
// y devuelve index.html para cualquier ruta que no sea un archivo. Solo para pruebas locales.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const PUERTO = Number(process.env.PUERTO ?? 5173);
const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

// _headers: bloques "ruta" seguidos de líneas "  Cabecera: valor"; * al final es comodín
function leerCabeceras() {
  const reglas = [];
  const f = path.join(DIST, '_headers');
  if (!fs.existsSync(f)) return reglas;
  let actual = null;
  for (const linea of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!linea.trim()) continue;
    if (!/^\s/.test(linea)) { actual = { patron: linea.trim(), cabeceras: [] }; reglas.push(actual); continue; }
    const i = linea.indexOf(':');
    if (actual && i > 0) actual.cabeceras.push([linea.slice(0, i).trim(), linea.slice(i + 1).trim()]);
  }
  return reglas;
}
const coincide = (patron, ruta) => (patron.endsWith('*') ? ruta.startsWith(patron.slice(0, -1)) : ruta === patron);

http.createServer((req, res) => {
  const ruta = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let archivo = path.normalize(path.join(DIST, ruta));
  if (!archivo.startsWith(DIST)) { res.writeHead(400).end(); return; }
  let rutaReglas = ruta;
  if (!fs.existsSync(archivo) || fs.statSync(archivo).isDirectory()) {
    archivo = path.join(DIST, 'index.html');
    rutaReglas = '/index.html';
  }
  for (const r of leerCabeceras()) if (coincide(r.patron, rutaReglas)) for (const [k, v] of r.cabeceras) res.setHeader(k, v);
  // En local no hay HTTPS: HSTS no aplica
  res.removeHeader('Strict-Transport-Security');
  res.setHeader('Content-Type', TIPOS[path.extname(archivo)] ?? 'application/octet-stream');
  fs.createReadStream(archivo).pipe(res);
}).listen(PUERTO, '127.0.0.1', () => console.log(`Pase en http://127.0.0.1:${PUERTO}`));
