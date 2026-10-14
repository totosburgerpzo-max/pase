// Construye la app web en web/dist: un sitio estático que Cloudflare Pages publica tal cual.
//   JS (esbuild) y CSS (Tailwind) con nombre por contenido, index.html, manifest, service
//   worker con la lista de archivos para funcionar sin internet, _headers y _redirects.
// La URL de Supabase y la llave pública salen de las variables PASE_SUPABASE_URL y
// PASE_SUPABASE_LLAVE, o de web/config.json (son públicas: la seguridad está en la base).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(WEB, 'dist');
const desarrollo = process.argv.includes('--desarrollo');

const archivoConfig = path.join(WEB, 'config.json');
const config = fs.existsSync(archivoConfig) ? JSON.parse(fs.readFileSync(archivoConfig, 'utf8')) : {};
const supabaseUrl = (process.env.PASE_SUPABASE_URL ?? config.supabaseUrl ?? '').replace(/\/$/, '');
const supabaseLlave = process.env.PASE_SUPABASE_LLAVE ?? config.supabaseLlave ?? '';
if (!supabaseUrl || !supabaseLlave) {
  console.error('Falta la URL o la llave pública de Supabase (web/config.json o PASE_SUPABASE_URL y PASE_SUPABASE_LLAVE)');
  process.exit(1);
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, 'assets'), { recursive: true });
const huella = (b) => createHash('sha256').update(b).digest('hex').slice(0, 10);

// 1. Archivos públicos tal cual (íconos, fuentes)
fs.cpSync(path.join(WEB, 'publico'), DIST, { recursive: true });

// 2. CSS
const cssTmp = path.join(DIST, 'assets', 'app.css');
execFileSync(path.join(WEB, '..', 'node_modules', '.bin', 'tailwindcss'),
  ['-c', path.join(WEB, 'tailwind.config.cjs'), '-i', path.join(WEB, 'src', 'estilos.css'), '-o', cssTmp, ...(desarrollo ? [] : ['--minify'])],
  { stdio: ['ignore', 'ignore', 'inherit'] });
const css = fs.readFileSync(cssTmp);
const nombreCss = `assets/app-${huella(css)}.css`;
fs.renameSync(cssTmp, path.join(DIST, nombreCss));

// 3. JS
const version = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const r = await build({
  entryPoints: [path.join(WEB, 'src', 'main.tsx')],
  bundle: true,
  minify: !desarrollo,
  sourcemap: desarrollo ? 'inline' : false,
  format: 'esm',
  target: ['chrome90', 'safari15', 'firefox100'],
  jsx: 'automatic',
  write: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify(desarrollo ? 'development' : 'production'),
    __PASE__: JSON.stringify({ supabaseUrl, supabaseLlave, version }),
  },
  logLevel: 'warning',
});
const js = r.outputFiles[0].contents;
const nombreJs = `assets/app-${huella(js)}.js`;
fs.writeFileSync(path.join(DIST, nombreJs), js);

// 4. index.html
const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8')
  .replaceAll('%CSS%', `/${nombreCss}`)
  .replaceAll('%JS%', `/${nombreJs}`);
fs.writeFileSync(path.join(DIST, 'index.html'), html);

// 5. Manifest (instalar como app en la tablet)
fs.writeFileSync(path.join(DIST, 'manifest.webmanifest'), JSON.stringify({
  name: 'Pase · Totos Burger',
  short_name: 'Pase',
  description: 'Planillas de calidad con firma por PIN',
  lang: 'es-VE',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'any',
  background_color: '#e7ebed',
  theme_color: '#15191c',
  icons: [
    { src: '/iconos/icono-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/iconos/icono-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/iconos/icono-mascara-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}, null, 2));

// 6. Service worker: guarda todo lo necesario para abrir sin internet
const todos = [];
const recorrer = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) recorrer(p);
    else todos.push('/' + path.relative(DIST, p).split(path.sep).join('/'));
  }
};
recorrer(DIST);
const precache = todos.filter((f) => !/latin-ext|\/_headers$|\/_redirects$|\.svg$|apple-touch/.test(f))
  .map((f) => (f === '/index.html' ? '/' : f)).sort();
const sw = fs.readFileSync(path.join(WEB, 'src', 'sw.js'), 'utf8')
  .replace('%VERSION%', `${version}-${huella(precache.join('|') + js + css)}`)
  .replace('%ARCHIVOS%', JSON.stringify(precache));
fs.writeFileSync(path.join(DIST, 'sw.js'), sw);

// 7. Cabeceras de seguridad y rutas para Cloudflare Pages
const origenApi = new URL(supabaseUrl).origin;
fs.writeFileSync(path.join(DIST, '_headers'), `/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' blob: data:; connect-src 'self' ${origenApi}; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(self), microphone=(), geolocation=(), payment=()
  Strict-Transport-Security: max-age=31536000
  X-Frame-Options: DENY

/sw.js
  Cache-Control: no-cache

/index.html
  Cache-Control: no-cache

/assets/*
  Cache-Control: public, max-age=31536000, immutable
`);
fs.writeFileSync(path.join(DIST, '_redirects'), '/* /index.html 200\n');

const kb = (n) => `${Math.round(n / 1024)} KB`;
console.log(`Pase ${version}: ${nombreJs} (${kb(js.length)}), ${nombreCss} (${kb(css.length)}), ${precache.length} archivos para usar sin internet`);
console.log(`API: ${supabaseUrl}`);
