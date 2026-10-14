import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CONFIG, ErrorApi, auth, cuandoSePierdaLaSesion, funcion, hayServidor, rpc, usarSesion, type Sesion } from './api';
import {
  bloqueadoHasta, equipoLocal, guardar, identificarSinConexion, leer, limpiarFallos, olvidarEquipo, recordarPin,
  registrarFallo, comprobarSinConexion, type EquipoLocal,
} from './local';
import { pendientes, sincronizar, type EnvioPendiente } from './cola';
import { AppCtx, mensajeDe, useApp, type Ctx, type Firma, type Recibo, type Ruta, type SolicitudFirma, type Tono, type Usuario } from './contexto';
import type { Alerta, Contexto, Hoy, Plantilla } from './tipos';
import { PinConfirmModal, IconoCandado, IconoSinSenal, iniciales, type ResultadoFirma } from './ui/PinConfirmModal';
import { Boton, IcoCampana, IcoNube, IcoSenal, IcoSync, ROL, cx, hora } from './ui/comun';
import { Bloqueo, CambioPin, EquipoDadoDeBaja, Marca } from './pantallas/Bloqueo';
import { Registro } from './pantallas/Registro';
import { Clave, leerLinkDeCorreo, type LinkCorreo } from './pantallas/Clave';
import { Inicio } from './pantallas/Inicio';
import { Planilla } from './pantallas/Planilla';
import { Falla, Incidencias } from './pantallas/Incidencias';
import { Panel, Historial, DetalleEjecucion, Alertas } from './pantallas/Panel';
import { Personal } from './pantallas/Personal';
import { Equipos } from './pantallas/Equipos';
import { Bitacora } from './pantallas/Bitacora';
import { Cola } from './pantallas/Cola';

type Fase =
  | { id: 'cargando' } | { id: 'registro'; sesion?: string } | { id: 'clave'; link: LinkCorreo } | { id: 'baja' } | { id: 'bloqueo' }
  | { id: 'cambio_pin'; contexto: Contexto; pin: string }
  | { id: 'app'; contexto: Contexto; enLinea: boolean };

const DIAS_VERIFICADOR = 7;

/* ===================================================================== */
export function App() {
  const [fase, setFase] = useState<Fase>({ id: 'cargando' });
  const [equipo, setEquipo] = useState<EquipoLocal | null>(null);
  const [red, setRed] = useState(() => navigator.onLine);
  const [cola, setCola] = useState<EnvioPendiente[]>([]);
  const [hoyCache, setHoyCache] = useState<Hoy | null>(null);

  useEffect(() => {
    // Link de un correo de Auth (invitación o contraseña olvidada): se lee y se borra de la barra
    const link = leerLinkDeCorreo();
    if (link) history.replaceState(null, '', location.pathname + location.search);
    void (async () => {
      const e = await equipoLocal();
      setEquipo(e);
      setCola(await pendientes());
      setHoyCache((await leer<Hoy>('kv', 'hoy:10')) ?? null);
      setFase(link ? { id: 'clave', link } : e ? { id: 'bloqueo' } : { id: 'registro' });
    })();
  }, []);

  /* --- Conexión: se prueba el servidor al recuperar la red y cada 20 s mientras no hay --- */
  const redCaida = useCallback(() => setRed(false), []);
  useEffect(() => {
    const on = () => void hayServidor().then(setRed);
    const off = () => setRed(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  useEffect(() => {
    if (red) return;
    const t = window.setInterval(() => { if (navigator.onLine) void hayServidor().then((s) => s && setRed(true)); }, 20_000);
    return () => window.clearInterval(t);
  }, [red]);

  /* --- Cola: se envía sola al haber red (no necesita sesión: usa el secreto del equipo) --- */
  const refrescarCola = useCallback(async () => setCola(await pendientes()), []);
  const sincronizando = useRef(false);
  const [enviando, setEnviando] = useState(false);
  const sincronizarAhora = useCallback(async () => {
    if (!equipo || sincronizando.current) return;
    sincronizando.current = true;
    setEnviando(true);
    try {
      const r = await sincronizar(equipo);
      if (r.enviados) avisarRef.current(r.enviados === 1 ? 'Se envió 1 registro firmado sin conexión.' : `Se enviaron ${r.enviados} registros firmados sin conexión.`, 'bien');
      if (r.rechazados) avisarRef.current(`${r.rechazados === 1 ? 'Un registro no fue aceptado' : `${r.rechazados} registros no fueron aceptados`}: revisa «Por enviar».`, 'mal');
    } catch { /* se reintenta luego */ } finally {
      sincronizando.current = false;
      setEnviando(false);
      setCola(await pendientes());
    }
  }, [equipo]);
  useEffect(() => {
    if (!red || !cola.some((c) => c.estado === 'pendiente')) return;
    void sincronizarAhora();
    const t = window.setInterval(() => void sincronizarAhora(), 60_000);
    return () => window.clearInterval(t);
  }, [red, cola.length, sincronizarAhora]); // eslint-disable-line react-hooks/exhaustive-deps

  /* --- Avisos --- */
  const [avisos, setAvisos] = useState<{ id: number; texto: string; tono: Tono }[]>([]);
  const nAviso = useRef(0);
  const avisar = useCallback((texto: string, tono: Tono = 'info') => {
    const id = ++nAviso.current;
    setAvisos((a) => [...a.slice(-2), { id, texto, tono }]);
    window.setTimeout(() => setAvisos((a) => a.filter((x) => x.id !== id)), 7000);
  }, []);
  const avisarRef = useRef(avisar);

  /* --- Entrar --- */
  const bloquear = useCallback(() => {
    setFase((f) => {
      if (f.id === 'app' && f.enLinea) {
        void rpc('cerrar_sesion_equipo').catch(() => {});
      }
      return { id: 'bloqueo' };
    });
    setAvisos([]);
    window.setTimeout(() => usarSesion(null), 300);
    history.replaceState(null, '', '#');
  }, []);
  useEffect(() => cuandoSePierdaLaSesion(() => {
    bloquear();
    avisarRef.current('La sesión venció. Vuelve a entrar con tu PIN.', 'aviso');
  }), [bloquear]);

  const entrar = useCallback(async (pin: string): Promise<{ mensaje: string; hasta?: number } | null> => {
    if (!equipo) return { mensaje: 'Equipo no registrado' };
    if (red) {
      try {
        const r = await funcion<{ sesion: Sesion; usuario: { debe_cambiar_pin: boolean } }>('pin-sesion',
          { dispositivo: equipo.id, secreto: equipo.secreto, pin });
        usarSesion(r.sesion);
        const ctx = await rpc<Contexto | null>('pase_contexto');
        if (!ctx) throw new ErrorApi(403, 'El servidor no reconoció la sesión');
        await limpiarFallos();
        if (r.usuario.debe_cambiar_pin) { setFase({ id: 'cambio_pin', contexto: ctx, pin }); return null; }
        await recordarPin(pin, ctx);
        setFase({ id: 'app', contexto: ctx, enLinea: true });
        return null;
      } catch (e) {
        if (e instanceof ErrorApi && !e.red) {
          usarSesion(null);
          if (e.codigo === 'pin_incorrecto') return { mensaje: 'PIN no reconocido. Revisa los dígitos e inténtalo de nuevo.' };
          if (e.codigo === 'dispositivo_bloqueado') return { mensaje: 'Esta tablet quedó bloqueada por intentos fallidos.', hasta: Date.parse(e.datos?.hasta ?? '') || Date.now() + 15 * 60_000 };
          if (e.codigo === 'dispositivo_no_registrado') { setFase({ id: 'baja' }); return null; }
          return { mensaje: e.message };
        }
        setRed(false);
      }
    }
    // Sin internet: solo quien entró en este equipo en los últimos días
    const h = await bloqueadoHasta();
    if (h) return { mensaje: 'Esta tablet quedó bloqueada por intentos fallidos.', hasta: h };
    const ctx = await identificarSinConexion(pin, DIAS_VERIFICADOR);
    if (!ctx) {
      const hasta = await registrarFallo();
      return { mensaje: `Sin internet solo entran quienes usaron esta tablet en los últimos ${DIAS_VERIFICADOR} días, con el PIN de entonces.`, hasta: hasta ?? undefined };
    }
    await limpiarFallos();
    setFase({ id: 'app', contexto: ctx, enLinea: false });
    return null;
  }, [equipo, red]);

  const registrado = useCallback(async (e: EquipoLocal) => { setEquipo(e); setFase({ id: 'bloqueo' }); }, []);
  const registrarDeNuevo = useCallback(async () => { await olvidarEquipo(); setEquipo(null); setFase({ id: 'registro' }); }, []);

  // Versión nueva de la app: se activa en la pantalla de bloqueo, nunca a mitad de una planilla
  useEffect(() => {
    if (fase.id !== 'bloqueo' || !('serviceWorker' in navigator)) return;
    void navigator.serviceWorker.getRegistration().then((r) => r?.waiting?.postMessage('activar'));
  }, [fase.id]);

  let contenido: React.ReactNode;
  if (fase.id === 'cargando') contenido = <main className="acero grid flex-1 place-items-center"><Marca /></main>;
  else if (fase.id === 'registro') contenido = <Registro key={fase.sesion ?? ''} onRegistrado={registrado} sesionInicial={fase.sesion} />;
  else if (fase.id === 'clave') contenido = (
    <Clave link={fase.link} onSalir={() => setFase(equipo ? { id: 'bloqueo' } : { id: 'registro' })}
      onListo={(token) => {
        // En un equipo ya registrado solo se cambia la contraseña; si no, sigue el registro con esa sesión
        if (equipo) { void auth.salir(token); setFase({ id: 'bloqueo' }); avisar('Contraseña guardada.', 'bien'); }
        else setFase({ id: 'registro', sesion: token });
      }} />
  );
  else if (fase.id === 'baja') contenido = <EquipoDadoDeBaja onRegistrar={registrarDeNuevo} />;
  else if (fase.id === 'bloqueo' || !equipo) contenido = (
    <Bloqueo equipo={equipo!} enLinea={red} porEnviar={cola.length} hoy={hoyCache} onPin={entrar} />
  );
  else if (fase.id === 'cambio_pin') contenido = (
    <CambioPin contexto={fase.contexto} pinProvisional={fase.pin} onCancelar={bloquear}
      onListo={async (pin, ctx) => { await recordarPin(pin, ctx); setFase({ id: 'app', contexto: ctx, enLinea: true }); }} />
  );
  else contenido = (
    <Trabajo key={fase.contexto.usuario.id + String(fase.enLinea)} equipo={equipo} contexto={fase.contexto} sesionEnLinea={fase.enLinea}
      red={red} redCaida={redCaida} cola={cola} enviando={enviando} refrescarCola={refrescarCola} sincronizarAhora={sincronizarAhora}
      avisar={avisar} onBloquear={bloquear} onHoy={setHoyCache} />
  );

  return (
    <div className="flex flex-1 flex-col">
      {contenido}
      <Avisos avisos={avisos} onCerrar={(id) => setAvisos((a) => a.filter((x) => x.id !== id))} />
    </div>
  );
}

/* ===================================================================== */
/* Una persona trabajando                                                  */
/* ===================================================================== */
function Trabajo({ equipo, contexto, sesionEnLinea, red, redCaida, cola, enviando, refrescarCola, sincronizarAhora, avisar, onBloquear, onHoy }: {
  equipo: EquipoLocal; contexto: Contexto; sesionEnLinea: boolean; red: boolean; redCaida: () => void;
  cola: EnvioPendiente[]; enviando: boolean; refrescarCola: () => Promise<void>; sincronizarAhora: () => Promise<void>;
  avisar: (t: string, tono?: Tono) => void; onBloquear: () => void; onHoy: (h: Hoy) => void;
}) {
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setAhora(Date.now()), 15_000); return () => window.clearInterval(t); }, []);
  const enLinea = sesionEnLinea && red;
  const u = contexto.usuario;
  const usuario: Usuario = useMemo(() => ({
    id: u.id, nombre: u.nombre, nombreCompleto: `${u.nombre} ${u.apellido}`, rol: u.rol, nivel: u.nivel, cargo: u.cargo,
    turno: u.turno, sucursal: u.sucursal_id, pinLongitud: contexto.pin?.longitud ?? 4,
  }), [u, contexto.pin]);
  const permisos = useMemo(() => new Set(contexto.permisos), [contexto.permisos]);
  const puede = useCallback((p: string) => permisos.has(p), [permisos]);
  const parametro = useCallback(<T,>(k: string, d: T): T => (contexto.parametros?.[k] ?? d) as T, [contexto.parametros]);

  /* --- Rutas (el botón Atrás del equipo funciona) --- */
  const inicial: Ruta = u.rol === 'admin' && permisos.has('checklists.ver_todos') ? { id: 'panel' } : { id: 'inicio' };
  const [ruta, setRuta] = useState<Ruta>(inicial);
  useEffect(() => {
    history.replaceState({ ruta: inicial }, '', '#');
    const f = (e: PopStateEvent) => setRuta((e.state?.ruta as Ruta) ?? inicial);
    window.addEventListener('popstate', f);
    return () => window.removeEventListener('popstate', f);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const ir = useCallback((r: Ruta) => {
    history.pushState({ ruta: r }, '', `#${r.id}`);
    setRuta(r);
    window.scrollTo({ top: 0 });
  }, []);
  const volver = useCallback(() => { if (history.state?.ruta && history.length > 1) history.back(); else ir(inicial); }, [ir]); // eslint-disable-line react-hooks/exhaustive-deps

  /* --- Bloqueo por inactividad (la pausa al tomar una foto no cuenta) --- */
  const segundos = parametro('sesion.segundos_inactividad', 90);
  const ultimo = useRef(Date.now());
  const modalAbierto = useRef(false);
  useEffect(() => {
    const tocar = () => { ultimo.current = Date.now(); };
    const eventos = ['pointerdown', 'keydown', 'touchstart', 'scroll'] as const;
    eventos.forEach((e) => window.addEventListener(e, tocar, { passive: true }));
    let oculto = 0;
    const vis = () => {
      if (document.visibilityState === 'hidden') oculto = Date.now();
      else { if (oculto && Date.now() - oculto > 10 * 60_000) onBloquear(); else ultimo.current = Date.now(); oculto = 0; }
    };
    document.addEventListener('visibilitychange', vis);
    const t = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      if (Date.now() - ultimo.current > segundos * 1000 && !modalAbierto.current) onBloquear();
    }, 1000);
    return () => {
      eventos.forEach((e) => window.removeEventListener(e, tocar));
      document.removeEventListener('visibilitychange', vis);
      window.clearInterval(t);
    };
  }, [segundos, onBloquear]);

  /* --- Catálogo y riel del día (en caché para trabajar sin internet) --- */
  const [catalogo, setCatalogo] = useState<Plantilla[]>([]);
  const [hoy, setHoy] = useState<Hoy | null>(null);
  const claveHoy = `hoy:${u.nivel}`;
  const recargarHoy = useCallback(async () => {
    if (!enLinea) { setHoy((await leer<Hoy>('kv', claveHoy)) ?? null); return; }
    try {
      const h = await rpc<Hoy>('pase_hoy');
      setHoy(h);
      onHoy(h);
      await guardar('kv', claveHoy, h);
    } catch (e) {
      if (e instanceof ErrorApi && e.red) redCaida();
      setHoy((await leer<Hoy>('kv', claveHoy)) ?? null);
    }
  }, [enLinea, claveHoy, onHoy, redCaida]);
  useEffect(() => {
    void (async () => {
      const guardado = await leer<{ en: number; version: string; plantillas: Plantilla[] }>('kv', 'catalogo');
      if (guardado) setCatalogo(guardado.plantillas);
      if (enLinea && (!guardado || Date.now() - guardado.en > 3600_000 || guardado.version !== CONFIG.version)) {
        try {
          const c = await rpc<Plantilla[]>('pase_catalogo');
          setCatalogo(c);
          await guardar('kv', 'catalogo', { en: Date.now(), version: CONFIG.version, plantillas: c });
        } catch (e) { if (e instanceof ErrorApi && e.red) redCaida(); }
      }
    })();
    void recargarHoy();
    if (!enLinea) return;
    const t = window.setInterval(() => void recargarHoy(), 120_000);
    return () => window.clearInterval(t);
  }, [enLinea]); // eslint-disable-line react-hooks/exhaustive-deps

  /* --- Alertas (supervisores y gerente) --- */
  const [alertasAbiertas, setAlertasAbiertas] = useState(0);
  const vistas = useRef(new Set<string>());
  const refrescarAlertas = useCallback(async () => {
    if (!enLinea || u.nivel < 20) return;
    try {
      const a = await rpc<Alerta[]>('pase_alertas', { p_limite: 50 });
      const abiertas = a.filter((x) => x.estado === 'abierta');
      const nuevas = abiertas.filter((x) => !vistas.current.has(x.id));
      if (vistas.current.size && nuevas.length) avisar(nuevas.length === 1 ? `Alerta: ${nuevas[0]!.titulo}` : `${nuevas.length} alertas nuevas`, 'aviso');
      abiertas.forEach((x) => vistas.current.add(x.id));
      if (!vistas.current.size) vistas.current.add('-');
      setAlertasAbiertas(abiertas.length);
    } catch { /* se reintenta */ }
  }, [enLinea, u.nivel, avisar]);
  useEffect(() => {
    void refrescarAlertas();
    const t = window.setInterval(() => void refrescarAlertas(), 60_000);
    return () => window.clearInterval(t);
  }, [refrescarAlertas]);

  /* --- Firmar con PIN --- */
  const [solicitud, setSolicitud] = useState<{ n: number; s: SolicitudFirma; resolver: (f: Firma | null) => void } | null>(null);
  const nSol = useRef(0);
  const fallosSinConexion = useRef(0);
  const firmar = useCallback((s: SolicitudFirma) => new Promise<Firma | null>((resolver) => {
    modalAbierto.current = true;
    setSolicitud({ n: ++nSol.current, s, resolver });
  }), []);
  const firmante = { nombre: usuario.nombreCompleto, rol: usuario.rol };
  const verificarSinConexion = async (pin: string): Promise<ResultadoFirma> => {
    const dias = parametro('sin_conexion.dias_verificador', DIAS_VERIFICADOR);
    if (await comprobarSinConexion(usuario.id, pin, dias)) {
      fallosSinConexion.current = 0;
      return { ok: true, firmaId: crypto.randomUUID(), firmante, firmadoEn: new Date().toISOString(), sinConexion: true };
    }
    fallosSinConexion.current++;
    if (fallosSinConexion.current >= 5) { window.setTimeout(onBloquear, 1500); return { ok: false, motivo: 'error', mensaje: 'Cinco PIN equivocados: la tablet se bloquea.' }; }
    return { ok: false, motivo: 'pin_incorrecto', intentosRestantes: 5 - fallosSinConexion.current };
  };
  const verificar = async (pin: string): Promise<ResultadoFirma> => {
    const s = solicitud!.s;
    if (!enLinea) {
      if (s.requiereConexion) return { ok: false, motivo: 'requiere_conexion' };
      return verificarSinConexion(pin);
    }
    try {
      const r = await rpc<any>('firmar', { p_pin: pin, p_accion: s.accion, p_entidad: s.entidad, p_entidad_id: s.entidadId });
      if (r.ok) return { ok: true, firmaId: r.firma_id, firmante, firmadoEn: new Date().toISOString() };
      if (r.motivo === 'pin_incorrecto') return { ok: false, motivo: 'pin_incorrecto', intentosRestantes: r.intentos_restantes ?? 0 };
      if (r.motivo === 'bloqueado') return { ok: false, motivo: 'pin_bloqueado', bloqueadoHasta: r.bloqueado_hasta };
      if (r.motivo === 'dispositivo_no_registrado') return { ok: false, motivo: 'error', mensaje: 'Esta tablet está bloqueada o ya no está registrada.' };
      if (r.motivo === 'sin_sesion') { window.setTimeout(onBloquear, 1500); return { ok: false, motivo: 'error', mensaje: 'La sesión venció. Vuelve a entrar con tu PIN.' }; }
      return { ok: false, motivo: 'error', mensaje: 'No se pudo firmar.' };
    } catch (e) {
      if (e instanceof ErrorApi && e.red) {
        redCaida();
        if (s.requiereConexion) return { ok: false, motivo: 'requiere_conexion' };
        return verificarSinConexion(pin);
      }
      return { ok: false, motivo: 'error', mensaje: mensajeDe(e) };
    }
  };

  /* --- Comprobante --- */
  const [recibo, setRecibo] = useState<{ r: Recibo; resolver: () => void } | null>(null);
  const verRecibo = useCallback((r: Recibo) => new Promise<void>((resolver) => setRecibo({ r, resolver })), []);

  const ctx: Ctx = {
    ahora, equipo, contexto, usuario, enLinea, sinSesionEnLinea: !sesionEnLinea, puede, ruta, ir, volver, firmar,
    recibo: verRecibo, avisar, catalogo, hoy, recargarHoy, cola, refrescarCola, sincronizarAhora,
    alertasAbiertas, refrescarAlertas, redCaida, parametro,
  };

  return (
    <AppCtx.Provider value={ctx}>
      <Encabezado red={red} enviando={enviando} onBloquear={onBloquear} />
      <div className="flex-1">
        {ruta.id === 'inicio' && <Inicio />}
        {ruta.id === 'panel' && <Panel />}
        {ruta.id === 'planilla' && <Planilla key={ruta.prog ?? ruta.plantilla} progId={ruta.prog} plantillaId={ruta.plantilla} />}
        {ruta.id === 'falla' && <Falla />}
        {ruta.id === 'incidencias' && <Incidencias />}
        {ruta.id === 'ejecucion' && <DetalleEjecucion key={ruta.ejec} id={ruta.ejec} />}
        {ruta.id === 'historial' && <Historial />}
        {ruta.id === 'alertas' && <Alertas />}
        {ruta.id === 'personal' && <Personal />}
        {ruta.id === 'equipos' && <Equipos />}
        {ruta.id === 'bitacora' && <Bitacora />}
        {ruta.id === 'cola' && <Cola />}
      </div>
      <footer className="mx-auto w-full max-w-[1280px] px-4 pb-8 pt-6 text-[13px] text-tenue sm:px-6">
        Pase · {contexto.sucursal?.nombre ?? 'Totos Burger'} · {equipo.nombre} · versión {CONFIG.version}
      </footer>

      {solicitud && (
        <PinConfirmModal key={solicitud.n} abierto modo="propio"
          titulo={solicitud.s.titulo} accion={solicitud.s.accion} tabla={solicitud.s.entidad}
          referencia={solicitud.s.referencia} cambios={solicitud.s.cambios} advertencia={solicitud.s.advertencia}
          firmante={{ ...firmante, iniciales: iniciales(usuario.nombreCompleto) }}
          longitudPin={usuario.pinLongitud} sinConexion={!enLinea} dispositivo={equipo.nombre}
          verificarPin={verificar}
          onFirmado={(f) => { const r = solicitud.resolver; modalAbierto.current = false; setSolicitud(null); r(f); }}
          onCancelar={() => { const r = solicitud.resolver; modalAbierto.current = false; setSolicitud(null); r(null); }} />
      )}
      {recibo && <Comprobante r={recibo.r} equipo={equipo.nombre} onListo={() => { const r = recibo.resolver; setRecibo(null); r(); }} />}
    </AppCtx.Provider>
  );
}

/* ===================================================================== */
function Encabezado({ red, enviando, onBloquear }: { red: boolean; enviando: boolean; onBloquear: () => void }) {
  const { usuario, enLinea, sinSesionEnLinea, ruta, ir, puede, cola, alertasAbiertas } = useApp();
  const pestañas: { id: Ruta['id']; t: string }[] = [
    ...(puede('checklists.ver_todos') ? [{ id: 'panel' as const, t: 'Panel' }] : []),
    { id: 'inicio', t: usuario.rol === 'admin' ? 'Operación' : 'Mi turno' },
    ...(puede('incidencias.gestionar') ? [{ id: 'incidencias' as const, t: 'Incidencias' }] : [{ id: 'falla' as const, t: 'Reportar falla' }]),
    { id: 'historial', t: 'Historial' },
    ...(puede('usuarios.ver') && usuario.rol === 'admin' ? [{ id: 'personal' as const, t: 'Personal' }] : []),
    ...(puede('dispositivos.gestionar') ? [{ id: 'equipos' as const, t: 'Equipos' }] : []),
    ...(puede('auditoria.ver') ? [{ id: 'bitacora' as const, t: 'Bitácora' }] : []),
  ];
  const porEnviar = cola.length;
  const rechazados = cola.filter((c) => c.estado === 'rechazado').length;
  const nav = (clase: string) => pestañas.map((p) => (
    <button key={p.id} type="button" onClick={() => ir({ id: p.id } as Ruta)} aria-current={ruta.id === p.id ? 'page' : undefined}
      className={cx(clase, ruta.id === p.id ? 'bg-tinta text-fondo' : 'text-tenue hover:bg-hundido hover:text-tinta')}>{p.t}</button>
  ));
  return (
    <header className="sticky top-0 z-30 border-b border-linea bg-superficie/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1280px] items-center gap-2 px-4 py-2.5 sm:px-6">
        <button type="button" onClick={() => ir({ id: usuario.rol === 'admin' && puede('checklists.ver_todos') ? 'panel' : 'inicio' })}
          className="shrink-0 rounded-[6px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-mostaza" aria-label="Ir al inicio">
          <Marca chica />
        </button>
        <nav className="ml-2 hidden min-w-0 items-center gap-1 overflow-x-auto sin-barra lg:flex" aria-label="Secciones">
          {nav('h-10 shrink-0 rounded-[6px] px-3 text-[15px] font-semibold')}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {(porEnviar > 0 || !enLinea) && (
            <button type="button" onClick={() => ir({ id: 'cola' })}
              className={cx('flex h-10 items-center gap-2 rounded-[6px] px-3 text-[14px] font-semibold',
                rechazados ? 'bg-mal/15 text-mal' : !enLinea ? 'bg-aviso/15 text-aviso' : 'text-tenue hover:bg-hundido')}>
              {enviando ? <IcoSync className="h-4 w-4 animate-spin" /> : !red ? <IconoSinSenal className="h-4 w-4" /> : porEnviar ? <IcoNube className="h-4 w-4" /> : <IcoSenal className="h-4 w-4" />}
              <span className="hidden sm:inline">{enviando ? 'Enviando…' : !red ? 'Sin conexión' : sinSesionEnLinea ? 'Sin sesión en línea' : ''}{porEnviar ? `${!red || sinSesionEnLinea ? ' · ' : ''}${porEnviar} por enviar` : ''}</span>
              <span className="sm:hidden">{porEnviar || ''}</span>
            </button>
          )}
          {usuario.nivel >= 20 && enLinea && (
            <button type="button" onClick={() => ir({ id: 'alertas' })} aria-label={`Alertas: ${alertasAbiertas} abiertas`}
              className="relative grid h-10 w-10 place-items-center rounded-[6px] text-tenue hover:bg-hundido hover:text-tinta">
              <IcoCampana className="h-6 w-6" />
              {alertasAbiertas > 0 && <span className="absolute right-0.5 top-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-mal px-1 text-[11px] font-bold text-superficie">{alertasAbiertas}</span>}
            </button>
          )}
          <div className="flex items-center gap-2.5 pl-1">
            <span className="grid h-10 w-10 place-items-center rounded-[6px] bg-tinta font-display text-[19px] font-bold text-fondo">{iniciales(usuario.nombreCompleto)}</span>
            <span className="hidden leading-tight md:block">
              <span className="block text-[15px] font-semibold">{usuario.nombreCompleto}</span>
              <span className="block text-[13px] text-tenue">{ROL[usuario.rol]}{usuario.cargo ? ` · ${usuario.cargo}` : ''}</span>
            </span>
          </div>
          <Boton onClick={onBloquear} aria-label="Bloquear y cambiar de usuario" className="ml-1">
            <IconoCandado className="h-5 w-5" /><span className="hidden sm:inline">Cambiar usuario</span>
          </Boton>
        </div>
      </div>
      <nav className="flex gap-1 overflow-x-auto border-t border-linea px-4 py-1.5 sin-barra lg:hidden" aria-label="Secciones">
        {nav('h-9 shrink-0 rounded-[6px] px-3 text-[15px] font-semibold')}
      </nav>
      {!enLinea && (
        <div className="border-t border-aviso/30 bg-aviso/10 px-4 py-2 text-[14px] text-aviso sm:px-6">
          <p className="mx-auto max-w-[1280px]">
            {!red
              ? 'Sin conexión. Puedes llenar planillas y reportar fallas: se firman en esta tablet y se envían solas al volver la señal. Revisar, gestionar y administrar necesitan internet.'
              : 'Volvió la conexión. Lo firmado se está enviando; para trabajar en línea, toca «Cambiar usuario» y vuelve a entrar con tu PIN.'}
          </p>
        </div>
      )}
    </header>
  );
}


/* ===================================================================== */
function Comprobante({ r, equipo, onListo }: { r: Recibo; equipo: string; onListo: () => void }) {
  const boton = useRef<HTMLButtonElement>(null);
  useEffect(() => { boton.current?.focus(); }, []);
  const h = r.firma.firmaId.replace(/-/g, '');
  const barras = useMemo(() => {
    let x = 0;
    return h.split('').flatMap((c) => { const v = parseInt(c, 16); return [1 + (v & 3), 1 + ((v >> 2) & 3)]; })
      .map((w, i) => { const b = { x, w: i % 2 ? w * 0.6 : w }; x += w + 1; return b; });
  }, [h]);
  const ancho = barras.length ? barras[barras.length - 1]!.x + 4 : 1;
  const tono = r.aviso?.tono === 'mal' ? '#b3261e' : r.aviso?.tono === 'aviso' ? '#8a4b00' : '#17633b';
  const f = r.firma;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-[rgb(8_10_12/0.6)] p-4 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-label="Comprobante de firma">
      <div className="w-full max-w-[400px] py-4">
        <div className="mx-1 h-4 rounded-[4px] bg-tinta shadow-[0_6px_10px_-4px_rgb(0_0_0/0.5)]" aria-hidden="true" />
        <div className="comanda comanda-sombra -mt-2 animate-ticket-sale px-6 pt-7 font-mono text-[13px] leading-relaxed">
          <p className="text-center font-display text-[30px] font-black uppercase leading-none tracking-[0.04em]">Totos Burger</p>
          <p className="mt-1 text-center text-[10.5px] uppercase tracking-[0.22em]">Alta Vista · comprobante de firma</p>
          <hr className="my-4 border-dashed border-papel-tinta/35" />
          <p className="font-sans text-[18px] font-semibold leading-snug">{r.titulo}</p>
          <dl className="mt-2">
            {r.lineas.map(([k, v], i) => (
              <div key={i} className="flex justify-between gap-4"><dt className="uppercase opacity-70">{k}</dt><dd className="num text-right font-medium">{v}</dd></div>
            ))}
          </dl>
          {r.aviso && <p className="mt-3 border-l-[3px] pl-2.5 font-sans text-[14px] font-medium leading-snug" style={{ borderColor: tono, color: tono }}>{r.aviso.texto}</p>}
          <hr className="my-4 border-dashed border-papel-tinta/35" />
          <dl>
            <div className="flex justify-between gap-4"><dt className="uppercase opacity-70">Firmó</dt><dd className="font-semibold">{f.firmante.nombre}</dd></div>
            <div className="flex justify-between gap-4"><dt className="uppercase opacity-70">Rol</dt><dd>{ROL[f.firmante.rol]}</dd></div>
            <div className="flex justify-between gap-4"><dt className="uppercase opacity-70">Método</dt><dd>{f.sinConexion ? 'PIN sin conexión' : 'PIN en línea'}</dd></div>
            <div className="flex justify-between gap-4"><dt className="uppercase opacity-70">Hora</dt><dd className="num">{hora(Date.parse(f.firmadoEn), true)}</dd></div>
          </dl>
          <hr className="my-4 border-dashed border-papel-tinta/35" />
          <div className="flex justify-between gap-4"><span className="uppercase opacity-70">Equipo</span><span>{equipo}</span></div>
          <div className="flex justify-between gap-4"><span className="uppercase opacity-70">Firma</span><span className="num">{h.slice(0, 16).replace(/(.{4})/g, '$1 ').trim()}</span></div>
          <svg viewBox={`0 0 ${ancho} 30`} className="mt-4 h-10 w-full" preserveAspectRatio="none" aria-hidden="true">
            {barras.map((b, i) => <rect key={i} x={b.x} y={0} width={b.w} height={30} fill="currentColor" />)}
          </svg>
        </div>
        <Boton ref={boton} variante="primario" alto="lg" className="mt-5 w-full" onClick={onListo}>Listo</Boton>
      </div>
    </div>
  );
}

function Avisos({ avisos, onCerrar }: { avisos: { id: number; texto: string; tono: Tono }[]; onCerrar: (id: number) => void }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 px-4 pb-4" style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom, 0px))' }} aria-live="polite">
      {avisos.map((a) => (
        <div key={a.id} className={cx('pointer-events-auto flex w-full max-w-[560px] animate-subir items-start gap-3 rounded-[8px] border bg-superficie px-4 py-3 text-[15px] shadow-[0_12px_30px_-12px_rgb(0_0_0/0.45)]',
          a.tono === 'bien' ? 'border-bien/50' : a.tono === 'mal' ? 'border-mal/50' : a.tono === 'aviso' ? 'border-aviso/50' : 'border-linea')}>
          <span className={cx('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', a.tono === 'bien' ? 'bg-bien' : a.tono === 'mal' ? 'bg-mal' : a.tono === 'aviso' ? 'bg-aviso' : 'bg-info')} aria-hidden="true" />
          <p className="flex-1 leading-snug">{a.texto}</p>
          <button type="button" onClick={() => onCerrar(a.id)} className="text-[13px] font-semibold text-tenue hover:text-tinta">Cerrar</button>
        </div>
      ))}
    </div>
  );
}

