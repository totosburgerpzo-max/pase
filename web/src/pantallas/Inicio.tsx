import { useMemo, useState } from 'react';
import { rpc } from '../api';
import { useApp, useCarga } from '../contexto';
import type { EjecucionResumen, Incidencia, Panel as TPanel, Programada } from '../tipos';
import {
  Boton, Estado, IcoDerecha, IcoLista, IcoLlave, Seccion, Titular, area, corto, cx, hora, plural,
} from '../ui/comun';
import { TarjetaIncidencia } from './Incidencias';

const NIVEL = { operativo: 10, supervisor: 20, admin: 30 } as const;

/** Estado de una línea del riel según la hora */
export function estadoDe(p: Programada, ahora: number, enCola: boolean) {
  if (p.ejecucion_id) return { t: `Hecha a las ${hora(Date.parse(p.hecha_en!))}`, c: '#17633b', abierta: false };
  if (enCola) return { t: 'Firmada · por enviar', c: '#17633b', abierta: false };
  const resta = Math.round((Date.parse(p.vence_en) - ahora) / 60_000);
  if (resta < 0) return { t: `Vencida hace ${-resta < 60 ? `${-resta} min` : `${Math.floor(-resta / 60)} h`}`, c: '#b3261e', abierta: true };
  if (resta <= 20) return { t: `Vence en ${resta} min`, c: '#8a4b00', abierta: true };
  if (resta <= 120) return { t: `Faltan ${Math.floor(resta / 60) ? `${Math.floor(resta / 60)} h ` : ''}${resta % 60} min`, c: 'inherit', abierta: true };
  return { t: 'Pendiente', c: 'inherit', abierta: true };
}

export function Riel({ items, vacio }: { items: Programada[]; vacio: string }) {
  if (!items.length) return <p className="text-[15px] text-tenue">{vacio}</p>;
  return (
    <div className="relative min-w-0">
      <div className="riel" aria-hidden="true" />
      <ul className="sin-barra -mt-[6px] flex min-w-0 gap-4 overflow-x-auto pb-5 pl-3 pr-4">
        {items.map((p) => <li key={p.id}><Comanda p={p} /></li>)}
      </ul>
    </div>
  );
}

function Comanda({ p }: { p: Programada }) {
  const { ahora, ir, cola } = useApp();
  const enCola = cola.some((c) => (c.planilla?.ejecucion as { programacion_id?: string } | undefined)?.programacion_id === p.id);
  const e = estadoDe(p, ahora, enCola);
  const hecha = !e.abierta;
  return (
    <div className="relative pt-[3px]">
      <span className="absolute left-1/2 top-0 z-10 h-[10px] w-12 -translate-x-1/2 rounded-b-[3px] bg-tenue/80" aria-hidden="true" />
      <button type="button" disabled={hecha} onClick={() => ir({ id: 'planilla', prog: p.id })}
        className={cx('comanda comanda-sombra block w-[184px] px-3.5 pt-4 text-left transition-transform',
          'enabled:hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mostaza',
          hecha && 'opacity-75')}
        aria-label={`Planilla ${p.codigo}, ${p.nombre}. ${e.t}`}>
        <span className="flex justify-between font-mono text-[10.5px] uppercase tracking-[0.14em] opacity-70">
          <span>POE {p.codigo.replace(/[A-Z]\d?$/, '')}</span><span>{area(p.area)}</span>
        </span>
        <span className="mt-1.5 block font-display text-[54px] font-black leading-[0.82]">{p.codigo}</span>
        <span className="mt-2 block min-h-[38px] text-[14px] font-semibold leading-tight">{corto(p.nombre, 52)}</span>
        <span className="mt-3 block border-t border-dashed border-papel-tinta/30 pt-2 font-mono text-[12px]">
          <span className="flex items-baseline justify-between"><span className="opacity-70">{p.horario ? `HORA ${p.horario}` : 'VENCE'}</span><b className="num text-[16px]">{hora(Date.parse(p.vence_en))}</b></span>
          <span className="mt-0.5 block font-semibold" style={{ color: e.c }}>{e.t}</span>
          {p.hecha_por && <span className="block truncate opacity-70">{p.hecha_por}</span>}
        </span>
        {hecha && (
          <span className="absolute right-2 top-12 rotate-[-13deg] rounded-[4px] border-[2.5px] border-[#17633b] px-2 font-display text-[24px] font-black uppercase leading-tight text-[#17633b]" aria-hidden="true">{p.ejecucion_id ? 'Hecha' : 'Firmada'}</span>
        )}
      </button>
    </div>
  );
}

/* ===================================================================== */
export function Inicio() {
  const { usuario, hoy, ahora, ir, enLinea, parametro, puede, catalogo } = useApp();
  const [verTodo, setVerTodo] = useState(false);
  const [otras, setOtras] = useState(false);
  const anticipacion = parametro('planilla.minutos_anticipacion', 60) * 60_000;
  const supervisa = usuario.nivel >= NIVEL.supervisor;

  const { abiertas, despues, hechas, operativos } = useMemo(() => {
    const todas = hoy?.programadas ?? [];
    const mias = todas.filter((p) => p.rol_asignado === usuario.rol || (usuario.rol === 'admin' && p.rol_asignado === 'supervisor'));
    const abierta = (p: Programada) => !p.ejecucion_id && Date.parse(p.desde) - anticipacion <= ahora;
    const orden = (a: Programada, b: Programada) => a.vence_en.localeCompare(b.vence_en);
    return {
      abiertas: mias.filter(abierta).sort(orden),
      despues: mias.filter((p) => !p.ejecucion_id && !abierta(p)).sort(orden),
      hechas: mias.filter((p) => p.ejecucion_id).sort((a, b) => (b.hecha_en ?? '').localeCompare(a.hecha_en ?? '')),
      operativos: supervisa ? todas.filter((p) => p.rol_asignado === 'operativo' && abierta(p)).sort(orden) : [],
    };
  }, [hoy, usuario.rol, anticipacion, ahora, supervisa]);
  const vencidas = abiertas.filter((p) => Date.parse(p.vence_en) < ahora);
  const urgentes = abiertas.filter((p) => { const r = Date.parse(p.vence_en) - ahora; return r >= 0 && r <= 20 * 60_000; });
  const opVencidas = operativos.filter((p) => Date.parse(p.vence_en) < ahora).length;
  const porEvento = catalogo.filter((p) => p.frecuencia === 'por_evento' && NIVEL[p.rol_asignado] <= usuario.nivel);
  const h = new Date(ahora).getHours();

  return (
    <main className="mx-auto grid max-w-[1280px] gap-9 px-4 py-7 sm:px-6">
      <Titular ojo={h < 11 ? 'Antes de abrir' : h < 18 ? 'Turno mediodía · 11:00 a 18:00' : 'Turno noche · 18:00 a 00:00'}
        titulo={usuario.rol === 'admin' ? 'Operación' : 'Mi turno'}>
        {!hoy ? 'Cargando el riel del día…' : abiertas.length === 0 ? 'No tienes planillas abiertas ahora.' : (
          <>Tienes {plural(abiertas.length, 'planilla abierta', 'planillas abiertas')}
            {vencidas.length ? <>, <b className="font-semibold text-mal">{plural(vencidas.length, 'vencida', 'vencidas')}</b></> : ''}
            {urgentes.length ? <>; <b className="font-semibold text-aviso">{urgentes.length === 1 ? `la ${urgentes[0]!.codigo} vence` : `${urgentes.length} vencen`} en menos de 20 minutos</b></> : ''}.
            {' '}Tócala en el riel para empezar.</>
        )}
      </Titular>

      <Seccion titulo={usuario.rol === 'operativo' ? 'Planillas del turno' : 'Planillas de supervisión'}
        extra={`${plural(abiertas.length, 'abierta', 'abiertas')} · ${plural(hechas.length, 'hecha', 'hechas')} hoy`}>
        <Riel items={abiertas} vacio={despues.length ? `La próxima abre a las ${hora(Date.parse(despues[0]!.desde) - anticipacion)}.` : 'Nada pendiente en el riel.'} />
        {despues.length > 0 && (
          <div>
            <button type="button" onClick={() => setVerTodo((v) => !v)} aria-expanded={verTodo}
              className="text-[15px] font-semibold text-tenue underline underline-offset-4 hover:text-tinta">
              {verTodo ? 'Ocultar lo de más tarde' : `Más tarde hoy: ${plural(despues.length, 'planilla', 'planillas')}`}
            </button>
            {verTodo && <ul className="mt-3 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
              {despues.map((p) => (
                <li key={p.id} className="flex items-baseline gap-3 border-b border-linea/60 py-1.5 text-[15px]">
                  <span className="num w-12 shrink-0 font-mono text-[13px] text-tenue">{hora(Date.parse(p.desde))}</span>
                  <span className="font-mono text-[13px] font-semibold">{p.codigo}</span>
                  <span className="min-w-0 truncate">{p.nombre}</span>
                </li>
              ))}
            </ul>}
          </div>
        )}
      </Seccion>

      {supervisa && (
        <Seccion titulo="Planillas de los operativos" extra={<>{plural(operativos.length, 'abierta', 'abiertas')}{opVencidas ? <b className="text-mal"> · {opVencidas} vencidas</b> : ''}</>}>
          <Riel items={operativos} vacio="Los operativos están al día." />
        </Seccion>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <button type="button" onClick={() => ir({ id: 'falla' })}
          className="tecla group flex min-h-[96px] items-start gap-4 rounded-[8px] p-4 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mostaza">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-[6px] bg-tinta text-fondo group-hover:bg-mostaza group-hover:text-mostaza-tinta"><IcoLlave className="h-6 w-6" /></span>
          <span className="min-w-0"><span className="block text-[19px] font-semibold leading-tight">Reportar una falla</span>
            <span className="mt-1 block text-[15px] leading-snug text-tenue">Equipo, limpieza, plagas o seguridad</span></span>
        </button>
        <button type="button" onClick={() => setOtras((v) => !v)} aria-expanded={otras} disabled={!porEvento.length}
          className="tecla group flex min-h-[96px] items-start gap-4 rounded-[8px] p-4 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mostaza disabled:opacity-50">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-[6px] bg-tinta text-fondo group-hover:bg-mostaza group-hover:text-mostaza-tinta"><IcoLista className="h-6 w-6" /></span>
          <span className="min-w-0"><span className="block text-[19px] font-semibold leading-tight">Llenar otra planilla</span>
            <span className="mt-1 block text-[15px] leading-snug text-tenue">Las que se hacen cuando ocurre algo: {plural(porEvento.length, 'planilla', 'planillas')}</span></span>
        </button>
      </div>
      {otras && (
        <ul className="-mt-5 grid gap-2 sm:grid-cols-2">
          {porEvento.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => ir({ id: 'planilla', plantilla: p.id })}
                className="flex w-full items-center gap-3 rounded-[8px] border border-linea bg-superficie px-4 py-3 text-left hover:border-tinta">
                <span className="font-display text-[30px] font-black leading-none">{p.codigo}</span>
                <span className="min-w-0 flex-1"><span className="block font-semibold leading-snug">{p.nombre}</span><span className="block text-[13px] text-tenue">{area(p.area)}</span></span>
                <IcoDerecha className="h-5 w-5 text-tenue" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {enLinea ? (
        <div className="grid gap-8 lg:grid-cols-2">
          {supervisa ? <PorRevisar /> : <MisIncidencias />}
          <FirmadoHoy />
        </div>
      ) : (
        <p className="rounded-[8px] border border-linea bg-superficie px-4 py-3 text-[15px] text-tenue">
          Sin conexión no se ven las incidencias ni el historial. Lo que firmes ahora se envía al volver la señal.
        </p>
      )}
      {supervisa && enLinea && puede('incidencias.gestionar') && <IncidenciasActivas />}
    </main>
  );
}

function MisIncidencias() {
  const { usuario } = useApp();
  const { datos, error, cargando, recargar } = useCarga(() => rpc<Incidencia[]>('pase_incidencias', { p_activas: true, p_limite: 50 }), []);
  const mias = (datos ?? []).filter((i) => i.reportada_por === usuario.id || i.asignada_a === usuario.id);
  return (
    <Seccion titulo="Mis incidencias" extra={mias.length ? plural(mias.length, 'activa', 'activas') : undefined}>
      <Estado cargando={cargando && !datos} error={error} onReintentar={recargar} vacio={!mias.length && 'Nada pendiente a tu nombre.'}>
        <div className="grid gap-3">{mias.map((i) => <TarjetaIncidencia key={i.id} i={i} alCambiar={recargar} />)}</div>
      </Estado>
    </Seccion>
  );
}

function IncidenciasActivas() {
  const { ir } = useApp();
  const { datos, error, cargando, recargar } = useCarga(() => rpc<Incidencia[]>('pase_incidencias', { p_activas: true, p_limite: 6 }), []);
  return (
    <Seccion titulo="Incidencias activas" extra={<button type="button" className="font-semibold underline underline-offset-4" onClick={() => ir({ id: 'incidencias' })}>Ver todas</button>}>
      <Estado cargando={cargando && !datos} error={error} onReintentar={recargar} vacio={!datos?.length && 'No hay incidencias activas.'}>
        <div className="grid gap-3 lg:grid-cols-2">{(datos ?? []).map((i) => <TarjetaIncidencia key={i.id} i={i} alCambiar={recargar} />)}</div>
      </Estado>
    </Seccion>
  );
}

function PorRevisar() {
  const { ir } = useApp();
  const { datos, error, cargando, recargar } = useCarga(() => rpc<TPanel>('pase_panel'), []);
  const lista = datos?.por_revisar.filter((x) => !x.propia) ?? [];
  return (
    <Seccion titulo="Por revisar" extra={plural(lista.length, 'planilla', 'planillas')}>
      <Estado cargando={cargando && !datos} error={error} onReintentar={recargar} vacio={!lista.length && 'Nada por revisar.'}>
        <ul className="grid">
          {lista.slice(0, 8).map((e) => (
            <li key={e.id}>
              <button type="button" onClick={() => ir({ id: 'ejecucion', ejec: e.id })}
                className="grid w-full grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-3 border-b border-linea/70 py-2.5 text-left hover:bg-hundido/50">
                <span className="num font-mono text-[13px] text-tenue">{hora(Date.parse(e.completada_en))}</span>
                <span className="min-w-0"><span className="block truncate text-[15px] font-semibold">{e.codigo} · {e.nombre}</span>
                  <span className="block text-[13px] text-tenue">{e.realizada_por_nombre}{e.sin_conexion ? ' · sin conexión' : ''}</span></span>
                <span className={cx('text-[14px] font-semibold', e.criticos ? 'text-mal' : e.no_cumple ? 'text-aviso' : 'text-bien')}>
                  {e.criticos ? `${e.criticos} crítico` : e.no_cumple ? `${e.no_cumple} no cumple` : 'Cumple'}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {lista.length > 8 && <Boton variante="fantasma" onClick={() => ir({ id: 'panel' })}>Ver las {lista.length} en el panel</Boton>}
      </Estado>
    </Seccion>
  );
}

function FirmadoHoy() {
  const { ir, ahora } = useApp();
  const desde = new Date(ahora); desde.setHours(0, 0, 0, 0);
  const { datos, error, cargando, recargar } = useCarga(
    () => rpc<EjecucionResumen[]>('pase_ejecuciones', { p_desde: desde.toISOString(), p_solo_mias: true, p_limite: 30 }), []);
  return (
    <Seccion titulo="Lo que firmaste hoy" extra={datos ? plural(datos.length, 'planilla', 'planillas') : undefined}>
      <Estado cargando={cargando && !datos} error={error} onReintentar={recargar}
        vacio={!datos?.length && 'Todavía nada en este turno. Cada planilla que firmes aparece aquí.'}>
        <ol className="grid">
          {(datos ?? []).map((e) => (
            <li key={e.id}>
              <button type="button" onClick={() => ir({ id: 'ejecucion', ejec: e.id })}
                className="grid w-full grid-cols-[64px_minmax(0,1fr)_auto] gap-3 border-b border-linea/70 py-2.5 text-left hover:bg-hundido/50">
                <span className="num font-mono text-[13px] text-tenue">{hora(Date.parse(e.completada_en))}</span>
                <span className="min-w-0 truncate text-[15px] font-medium">{e.codigo} · {e.nombre}</span>
                <span className={cx('num text-[14px] font-semibold', e.no_cumple ? 'text-mal' : 'text-bien')}>{e.puntaje != null ? `${Math.round(e.puntaje)} %` : '—'}</span>
              </button>
            </li>
          ))}
        </ol>
      </Estado>
    </Seccion>
  );
}
