# Pase · planillas de calidad con firma por PIN

App web de Totos Burger para llenar las planillas de calidad (checklists), reportar fallas con foto
y llevar la bitácora de auditoría. Cada registro se firma con el PIN de quien lo hace, en una tablet
registrada por la gerente. Funciona sin internet y envía lo pendiente al volver la señal.

Fase 1 (esta versión): ingreso con PIN y cambio rápido de persona, las 55 planillas, incidencias con
foto y su flujo (atender, resolver, verificar), panel del día, historial y revisión, alertas,
personal y PIN provisional, equipos, bitácora encadenada y trabajo sin conexión.

## Cómo está hecho

| Parte | Qué es |
|---|---|
| `web/` | La app: React 18 + TypeScript + Tailwind, construida con esbuild como sitio estático (PWA con service worker). Se publica en Cloudflare Pages. |
| `supabase/migrations/` | La base en Supabase (Postgres): tablas, RLS, firma por PIN (`firmar()`), bitácora con hash encadenado, plantillas y la API de la app (funciones `pase_*`). |
| `supabase/functions/` | Edge Functions: `pin-sesion` (entrar con PIN en un equipo registrado), `sincronizar` (lo firmado sin internet) y `personal` (alta de personas). |
| `scripts/desplegar.mjs` | Publica todo en el proyecto de Supabase con la Management API. |
| `local/` | Un Supabase local sin Docker para desarrollar y probar (Postgres 16, GoTrue, PostgREST, Deno y una puerta tipo Kong con Storage simulado). |
| `pruebas/` | Pruebas de la base, de la API, de punta a punta en Chromium y el ensayo de la publicación. |

Seguridad, en corto: el link solo no da acceso a nada. Un equipo lo registra la gerente en el propio
equipo con correo, contraseña, código de su app autenticadora y PIN; a partir de ahí, cada persona entra
con su PIN y cada cambio lleva una firma. Los registros no se borran (se anulan con firma) y la bitácora
detecta cualquier alteración hecha por fuera de la app.

## Trabajar en local

Requisitos: Node 20 o más nuevo, Postgres 16 (`/usr/lib/postgresql/16/bin`) y, para la prueba en
navegador, Playwright con Chromium.

```sh
npm install
npm run local:bajar        # una vez: PostgREST, Supabase Auth y Deno en local/bin
npm run local:limpio       # base nueva con datos de demostración (puertos 54321-54326)
PASE_SUPABASE_URL=http://127.0.0.1:54321 PASE_SUPABASE_LLAVE=<ANON_KEY de /tmp/pase-local/llaves.env> npm run construir
npm run servir             # http://127.0.0.1:5173
```

Datos de demostración (solo local): gerente `gerente@pase.test` / `Gerente-Local-2026`; PIN de Ana 4821,
Carlos 9054, Luis (supervisor) 730914 y Mariela (gerente) 552108.

## Pruebas

```sh
npm run tipos              # TypeScript sin errores
npm run prueba:sql         # 102 pruebas de la base (esquema, firmas, RLS, API)
npm run prueba:api         # la API y las Edge Functions por HTTP
npm run prueba:e2e         # un turno completo en Chromium, con y sin internet (capturas en pruebas/capturas/)
npm run prueba:despliegue  # publica en un Supabase local vacío y hace el primer ingreso de la gerente
```

`prueba:e2e` y `prueba:despliegue` reinician la base local.

## Publicar

Hace falta, a nombre de Totos Burger: un proyecto de Supabase (`pase-totos`, región East US), una cuenta
de Cloudflare y este repositorio en GitHub. El entorno donde corre el script necesita las variables
`SUPABASE_ACCESS_TOKEN` (token personal de Supabase) y `SUPABASE_PROJECT_REF`, y salida a
`api.supabase.com` y `*.supabase.co`. Ninguna llave va en el chat ni en el repositorio.

1. **Base, funciones y Auth.** Con la dirección que tendrá la app:
   ```sh
   PASE_SITIO=https://pase-totos.pages.dev npm run desplegar -- --ensayo   # qué haría
   PASE_SITIO=https://pase-totos.pages.dev npm run desplegar
   ```
   Aplica las migraciones que falten (cada una entera o nada), sube las tres funciones, fija sus
   secretos, configura Auth (registro cerrado, app autenticadora, links al sitio, correos en español)
   y escribe `web/config.json` con la URL y la llave pública. Ese archivo se sube al repositorio: sus
   datos son públicos y van dentro de la app de todas formas. Se puede correr las veces que haga falta.
2. **El sitio.** En Cloudflare: Workers & Pages → Create → Pages → Connect to Git → este repositorio.
   Build command `npm run construir`, output directory `web/dist` (la versión de Node sale de `.nvmrc`).
   Si Cloudflare asigna otra dirección, se corre de nuevo `npm run desplegar -- --solo secretos,auth`
   con el `PASE_SITIO` real.
3. **La gerente.** `npm run desplegar -- --solo gerente --gerente correo@dominio Nombre Apellido`.
   Le llega un correo para crear su contraseña; al abrirlo en la PC de gerencia activa la app
   autenticadora, genera su PIN (lo ve una sola vez) y registra ese equipo. El correo de fábrica de
   Supabase solo llega a los miembros del equipo del proyecto en Supabase: para otra persona, agrégala
   en Organization → Team o configura un SMTP propio (Authentication → Emails).
4. **Las tablets.** En cada una se abre el link de la app y la gerente toca «Soy la gerente: empezar».
   Después da de alta al personal en «Personal»; cada persona recibe un PIN provisional que cambia en
   su primer ingreso.

Las planillas del día se programan solas (pg_cron, 00:05 hora de Caracas) y también al abrir la app.
