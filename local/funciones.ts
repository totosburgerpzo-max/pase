// Corre las Edge Functions de supabase/functions como lo hace Supabase: cada una llama a
// Deno.serve(handler) y responde en /functions/v1/<nombre>. Aquí se recogen los handlers y
// se sirven todos en un solo puerto (la puerta quita el prefijo /functions/v1).
type Handler = (req: Request) => Response | Promise<Response>;

const servir = Deno.serve.bind(Deno);
const handlers = new Map<string, Handler>();
let cargando = '';

// deno-lint-ignore no-explicit-any
(Deno as any).serve = (a: any, b?: any) => {
  const h: Handler = typeof a === 'function' ? a : typeof b === 'function' ? b : a.handler;
  handlers.set(cargando, h);
  return { finished: Promise.resolve(), shutdown: async () => {}, ref() {}, unref() {}, addr: { hostname: '127.0.0.1', port: 0 } };
};

const carpeta = new URL('../supabase/functions/', import.meta.url);
for await (const e of Deno.readDir(carpeta)) {
  if (!e.isDirectory || e.name.startsWith('_')) continue;
  cargando = e.name;
  await import(new URL(`${e.name}/index.ts`, carpeta).href);
}
cargando = '';
console.log('Funciones:', [...handlers.keys()].join(', '));

servir({ hostname: '127.0.0.1', port: 54326, onListen: () => {} }, async (req) => {
  const url = new URL(req.url);
  const nombre = url.pathname.split('/').filter(Boolean)[0] ?? '';
  const h = handlers.get(nombre);
  if (!h) return new Response(JSON.stringify({ error: 'Función no encontrada' }), { status: 404 });
  try {
    return await h(req);
  } catch (e) {
    console.error(nombre, e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
