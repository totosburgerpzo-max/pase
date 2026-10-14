import { useEffect, useMemo, useState } from 'react';
import { rpc } from '../api';
import { mensajeDe, useApp, useCarga } from '../contexto';
import type { Alerta, Ejecucion, EjecucionResumen, EstadoEjecucion, Panel as TPanel, Respuesta } from '../tipos';
import { IconoAlerta, type CambioCampo } from '../ui/PinConfirmModal';
import {
  Boton, Campo, Estado, IcoFlecha, Ojo, Opciones, PildoraSeveridad, ROL, Seccion, SoloEnLinea, Titular,
  area, claseEntrada, cuando, cx, fecha, fechaHora, hace, hora, num, plural,
} from '../ui/comun';
import { TarjetaIncidencia, VerFoto } from './Incidencias';

const ESTADO_EJEC: Record<EstadoEjecucion, { t: string; c: string }> = {
  completada: { t: 'Sin revisar', c: 'text-tenue' },
  revisada: { t: 'Revisada', c: 'text-bien' },
  observada: { t: 'Con observaciones', c: 'text-aviso' },
  anulada: { t: 'Anulada', c: 'text-mal line-through' },
};

/* ===================================================================== */
/* Panel del día (supervisores y gerente)                                   */
/* ===================================================================== */
export function Panel() {
  const { ir, enLinea, ahora } = useApp();
  const { datos: p, error, cargando, recargar } = useCarga(() => rpc<TPanel>('pase_panel'), [], enLinea);
  useEffect(() => {
    if (!enLinea) return;
    const t = window.setInterval(() => void recargar(), 120_000);
    return () => window.clearInterval(t);
  }, [enLinea, recargar]);

  if (!enLinea) {
    return <main className="mx-auto grid max-w-[1280px] gap-6 px-4 py-7 sm:px-6"><Titular ojo="Gerencia" titulo="Panel" /><SoloEnLinea que="el panel" /></main>;
  }
  const pr = p?.programadas;
  const avance = pr && pr.total ? (pr.hechas / pr.total) * 100 : null;
  return (
    <main className="mx-auto grid max-w-[1280px] gap-9 px-4 py-7 sm:px-6">
      <Titular ojo={p ? fecha(Date.parse(p.ahora)) : 'Hoy'} titulo="Panel del día">
        {p && pr ? <>Van {pr.hechas} de {pr.total} planillas{pr.vencidas ? <>, <b className="font-semibold text-mal">{plural(pr.vencidas, 'vencida', 'vencidas')}</b></> : ''}.
          {' '}Actualizado {hace(Date.parse(p.ahora), ahora)}.</> : 'Cargando…'}
      </Titular>
      <Estado cargando={cargando && !p} error={error} onReintentar={recargar}>
        {p && pr && <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Cifra t="Planillas hechas" v={`${pr.hechas}/${pr.total}`} sub={avance !== null ? `${num(avance, 0)} % del día` : 'Sin programación'} />
            <Cifra t="Vencidas" v={String(pr.vencidas)} tono={pr.vencidas ? 'mal' : undefined} sub={`${pr.pendientes} pendientes`} />
            <Cifra t="Incidencias activas" v={String(p.incidencias.activas)} tono={p.incidencias.criticas ? 'mal' : undefined}
              sub={p.incidencias.criticas ? plural(p.incidencias.criticas, 'crítica', 'críticas') : 'ninguna crítica'} onClick={() => ir({ id: 'incidencias' })} />
            <Cifra t="No operar" v={String(p.incidencias.bloquean)} tono={p.incidencias.bloquean ? 'mal' : undefined} sub="equipos o áreas detenidos" onClick={() => ir({ id: 'incidencias' })} />
            <Cifra t="Por verificar" v={String(p.incidencias.por_verificar)} tono={p.incidencias.por_verificar ? 'aviso' : undefined}
              sub={p.incidencias.fuera_de_plazo ? `${p.incidencias.fuera_de_plazo} fuera de plazo` : 'todo en plazo'} onClick={() => ir({ id: 'incidencias' })} />
            <Cifra t="Alertas abiertas" v={String(p.alertas_abiertas)} tono={p.alertas_abiertas ? 'aviso' : undefined} sub="toca para verlas" onClick={() => ir({ id: 'alertas' })} />
          </div>

          <div className="grid gap-9 lg:grid-cols-2">
            <Seccion titulo="Vencidas sin hacer" extra={plural(p.vencidas.length, 'planilla', 'planillas')}>
              {!p.vencidas.length ? <p className="text-[15px] text-tenue">Ninguna. Todo lo que tocaba está hecho o en plazo.</p> : (
                <ul className="grid">
                  {p.vencidas.map((v) => (
                    <li key={v.id} className="grid grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-3 border-b border-linea/70 py-2.5">
                      <span className="num font-mono text-[13px] text-tenue">{v.horario || hora(Date.parse(v.vence_en))}</span>
                      <span className="min-w-0"><span className="block truncate text-[15px] font-semibold">{v.codigo} · {v.nombre}</span>
                        <span className="block text-[13px] text-tenue">{area(v.area)} · {ROL[v.rol_asignado]}{v.bloquea ? ' · bloquea la operación' : ''}</span></span>
                      <span className="text-[14px] font-semibold text-mal">Venció {hace(Date.parse(v.vence_en), ahora)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Seccion>

            <Seccion titulo="Por área" extra="hechas / programadas hoy">
              {!p.por_area.length ? <p className="text-[15px] text-tenue">Sin programación hoy.</p> : (
                <ul className="grid gap-2.5">
                  {p.por_area.map((a) => (
                    <li key={a.area} className="grid grid-cols-[120px_minmax(0,1fr)_72px] items-center gap-3 text-[15px]">
                      <span className="truncate font-semibold">{area(a.area)}</span>
                      <span className="h-3 overflow-hidden rounded-[2px] bg-hundido" aria-hidden="true">
                        <span className={cx('block h-full', (a.pct ?? 0) >= 90 ? 'bg-bien' : (a.pct ?? 0) >= 60 ? 'bg-aviso' : 'bg-mal')} style={{ width: `${a.pct ?? 0}%` }} />
                      </span>
                      <span className="num text-right font-mono text-[13px]">{a.hechas}/{a.total}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Seccion>
          </div>

          <div className="grid gap-9 lg:grid-cols-2">
            <Seccion titulo="Por revisar" extra={plural(p.por_revisar.length, 'planilla', 'planillas')}>
              {!p.por_revisar.length ? <p className="text-[15px] text-tenue">Nada por revisar.</p> : (
                <ul className="grid">
                  {p.por_revisar.map((e) => (
                    <li key={e.id}>
                      <button type="button" onClick={() => ir({ id: 'ejecucion', ejec: e.id })}
                        className="grid w-full grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-3 border-b border-linea/70 py-2.5 text-left hover:bg-hundido/50">
                        <span className="num font-mono text-[13px] text-tenue">{hora(Date.parse(e.completada_en))}</span>
                        <span className="min-w-0"><span className="block truncate text-[15px] font-semibold">{e.codigo} · {e.nombre}</span>
                          <span className="block text-[13px] text-tenue">{e.realizada_por_nombre}{e.propia ? ' (tú)' : ''}{e.sin_conexion ? ' · sin conexión' : ''}</span></span>
                        <span className={cx('text-[14px] font-semibold', e.criticos ? 'text-mal' : e.no_cumple ? 'text-aviso' : 'text-bien')}>
                          {e.criticos ? `${e.criticos} crítico` : e.no_cumple ? `${e.no_cumple} no cumple` : e.puntaje != null ? `${Math.round(e.puntaje)} %` : 'Cumple'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Seccion>
            <Seccion titulo="Últimos 14 días" extra="% hechas de las que ya tocaban">
              <Tendencia datos={p.tendencia} />
            </Seccion>
          </div>
        </>}
      </Estado>
    </main>
  );
}

function Cifra({ t, v, sub, tono, onClick }: { t: string; v: string; sub?: string; tono?: 'mal' | 'aviso'; onClick?: () => void }) {
  const cuerpo = <>
    <span className="block font-mono text-[11px] uppercase tracking-[0.14em] text-tenue">{t}</span>
    <span className={cx('num mt-1 block font-display text-[46px] font-black leading-none', tono === 'mal' ? 'text-mal' : tono === 'aviso' ? 'text-aviso' : '')}>{v}</span>
    {sub && <span className="mt-1 block text-[13px] text-tenue">{sub}</span>}
  </>;
  const cls = 'rounded-[8px] border border-linea bg-superficie p-4 text-left';
  return onClick
    ? <button type="button" onClick={onClick} className={cx(cls, 'hover:border-tinta focus-visible:outline focus-visible:outline-2 focus-visible:outline-mostaza')}>{cuerpo}</button>
    : <div className={cls}>{cuerpo}</div>;
}

function Tendencia({ datos }: { datos: TPanel['tendencia'] }) {
  if (!datos.length) return <p className="text-[15px] text-tenue">Todavía no hay días con planillas.</p>;
  return (
    <div className="grid gap-2">
      <div className="flex h-40 items-end gap-1.5 border-b border-linea" role="img"
        aria-label={`Cumplimiento diario: ${datos.map((d) => `${d.fecha} ${d.pct == null ? 'sin datos' : `${Math.round(d.pct)} %`}`).join(', ')}`}>
        {datos.map((d) => (
          <div key={d.fecha} className="flex h-full min-w-0 max-w-[44px] flex-1 flex-col justify-end" title={`${d.fecha}: ${d.pct == null ? 'sin datos' : `${num(d.pct, 0)} %`}`}>
            {d.pct != null && <span className="num mb-1 hidden text-center font-mono text-[10px] text-tenue sm:block">{Math.round(d.pct)}</span>}
            <span className={cx('block rounded-t-[2px]', d.pct == null ? 'bg-hundido' : d.pct >= 90 ? 'bg-bien' : d.pct >= 60 ? 'bg-aviso' : 'bg-mal')}
              style={{ height: `${d.pct == null ? 4 : Math.max(4, d.pct)}%` }} />
          </div>
        ))}
      </div>
      <div className="flex justify-between font-mono text-[11px] text-tenue">
        <span>{datos[0]!.fecha.slice(5).split('-').reverse().join('/')}</span>
        <span>{datos[datos.length - 1]!.fecha.slice(5).split('-').reverse().join('/')}</span>
      </div>
    </div>
  );
}

/* ===================================================================== */
/* Historial de planillas                                                   */
/* ===================================================================== */
export function Historial() {
  const { ir, enLinea, puede } = useApp();
  const veTodas = puede('checklists.ver_todos');
  const [dias, setDias] = useState(1);
  const [mias, setMias] = useState(!veTodas);
  const [texto, setTexto] = useState('');
  const desde = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (dias - 1)); return d.toISOString(); }, [dias]);
  const { datos, error, cargando, recargar } = useCarga(
    () => rpc<EjecucionResumen[]>('pase_ejecuciones', { p_desde: desde, p_solo_mias: mias, p_limite: 500 }), [desde, mias], enLinea);
  const q = texto.trim().toLowerCase();
  const lista = (datos ?? []).filter((e) => !q || `${e.codigo} ${e.nombre} ${e.realizada_por_nombre} ${area(e.area)}`.toLowerCase().includes(q));
  const grupos = useMemo(() => {
    const m = new Map<string, EjecucionResumen[]>();
    for (const e of lista) { const k = new Date(e.completada_en).toDateString(); m.set(k, [...(m.get(k) ?? []), e]); }
    return [...m.entries()];
  }, [lista]);

  return (
    <main className="mx-auto grid max-w-[1280px] gap-6 px-4 py-7 sm:px-6">
      <Titular ojo="Registros firmados" titulo="Historial">
        {veTodas ? 'Todas las planillas de la sucursal, con quién las firmó y cómo salieron.' : 'Las planillas que firmaste.'}
      </Titular>
      <div className="flex flex-wrap items-center gap-3">
        <Opciones etiqueta="Período" valor={dias} onCambio={setDias} opciones={[{ id: 1, t: 'Hoy' }, { id: 7, t: '7 días' }, { id: 30, t: '30 días' }]} />
        {veTodas && <Opciones etiqueta="De quién" valor={mias ? 'm' : 't'} onCambio={(v) => setMias(v === 'm')} opciones={[{ id: 't', t: 'Todas' }, { id: 'm', t: 'Mías' }]} />}
        <input type="search" value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Buscar código, planilla o persona"
          className={cx(claseEntrada, 'h-11 min-w-0 flex-1 sm:max-w-[360px]')} aria-label="Buscar" />
      </div>
      {!enLinea ? <SoloEnLinea que="el historial" /> : (
        <Estado cargando={cargando && !datos} error={error} onReintentar={recargar} vacio={!lista.length && 'No hay planillas en este período.'}>
          <div className="grid gap-7">
            {grupos.map(([k, es]) => (
              <section key={k} className="grid gap-1">
                <Ojo>{fecha(Date.parse(es[0]!.completada_en))} · {plural(es.length, 'planilla', 'planillas')}</Ojo>
                <ul className="grid">
                  {es.map((e) => (
                    <li key={e.id}>
                      <button type="button" onClick={() => ir({ id: 'ejecucion', ejec: e.id })}
                        className="grid w-full grid-cols-[56px_minmax(0,1fr)_auto] items-center gap-3 border-b border-linea/70 py-2.5 text-left hover:bg-hundido/50 sm:grid-cols-[56px_minmax(0,1fr)_200px_auto]">
                        <span className="num font-mono text-[13px] text-tenue">{hora(Date.parse(e.completada_en))}</span>
                        <span className="min-w-0"><span className="block truncate text-[15px] font-semibold">{e.codigo} · {e.nombre}</span>
                          <span className="block truncate text-[13px] text-tenue">{e.realizada_por_nombre}{e.horario ? ` · ${e.horario}` : ''}{e.sin_conexion ? ' · sin conexión' : ''}</span></span>
                        <span className={cx('hidden text-[13px] font-semibold sm:block', ESTADO_EJEC[e.estado].c)}>{ESTADO_EJEC[e.estado].t}</span>
                        <span className={cx('num text-[15px] font-bold', e.criticos ? 'text-mal' : e.no_cumple ? 'text-aviso' : 'text-bien')}>
                          {e.puntaje != null ? `${Math.round(e.puntaje)} %` : '—'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </Estado>
      )}
    </main>
  );
}

/* ===================================================================== */
/* Una planilla firmada, completa                                           */
/* ===================================================================== */
function valorDe(r: Respuesta) {
  if (r.no_aplica) return 'No aplica';
  switch (r.tipo) {
    case 'pass_fail': return r.valor_bool == null ? '—' : r.valor_bool ? 'Cumple' : 'No cumple';
    case 'number': return r.valor_num == null ? '—' : `${num(r.valor_num, 2)} ${r.unidad ?? ''}`.trim();
    case 'choice': return r.valor_opcion ?? '—';
    case 'time': return r.valor_hora?.slice(0, 5) ?? '—';
    case 'photo': return r.evidencia ? 'Foto' : '—';
    default: return r.valor_texto ?? '—';
  }
}
function limiteDe(r: Respuesta) {
  const u = r.unidad ? ` ${r.unidad}` : '';
  if (r.min != null && r.max != null) return `${num(r.min)} a ${num(r.max)}${u}`;
  if (r.max != null) return `≤ ${num(r.max)}${u}`;
  if (r.min != null) return `≥ ${num(r.min)}${u}`;
  return null;
}

export function DetalleEjecucion({ id }: { id: string }) {
  const { usuario, puede, enLinea, volver, firmar, avisar, ahora } = useApp();
  const { datos: e, error, cargando, recargar } = useCarga(() => rpc<Ejecucion | null>('pase_ejecucion', { p_id: id }), [id], enLinea);
  const [revision, setRevision] = useState<null | 'observada' | 'anulada'>(null);
  const [nota, setNota] = useState('');
  const [trabajando, setTrabajando] = useState(false);

  const secciones = useMemo(() => {
    const m = new Map<string, Respuesta[]>();
    for (const r of e?.respuestas ?? []) m.set(r.seccion, [...(m.get(r.seccion) ?? []), r]);
    return [...m.entries()];
  }, [e]);

  if (!enLinea) return <main className="mx-auto grid max-w-[980px] gap-6 px-4 py-7 sm:px-6"><div><Boton variante="fantasma" onClick={volver}><IcoFlecha className="h-5 w-5" />Volver</Boton></div><SoloEnLinea que="ver una planilla firmada" /></main>;

  const propia = e?.realizada_por === usuario.id;
  const esAdmin = usuario.rol === 'admin';
  const puedeRevisar = !!e && e.estado === 'completada' && puede('checklists.revisar') && (!propia || esAdmin);
  const puedeAnular = !!e && esAdmin && e.estado !== 'anulada';

  const revisar = async (estado: 'revisada' | 'observada' | 'anulada') => {
    if (!e) return;
    const texto = nota.trim();
    const cambios: CambioCampo[] = [
      { campo: 'Estado', antes: ESTADO_EJEC[e.estado].t, despues: ESTADO_EJEC[estado].t, falla: estado !== 'revisada' },
      ...(texto ? [{ campo: estado === 'anulada' ? 'Motivo' : 'Nota', despues: texto }] : []),
    ];
    const f = await firmar({
      titulo: estado === 'revisada' ? 'Dar por revisada' : estado === 'observada' ? 'Revisar con observaciones' : 'Anular planilla',
      accion: estado === 'revisada' ? 'aprobar' : estado === 'observada' ? 'rechazar' : 'anular',
      entidad: 'checklist_ejecuciones', entidadId: e.id, referencia: `${e.codigo} · ${e.nombre} · ${e.realizada_por_nombre}`,
      cambios, requiereConexion: true,
      advertencia: estado === 'anulada' ? 'La planilla queda en la bitácora marcada como anulada; no se borra.' : undefined,
    });
    if (!f) return;
    setTrabajando(true);
    try {
      await rpc('revisar_ejecucion', { p_id: e.id, p_estado: estado, p_nota: texto || null, p_firma: f.firmaId });
      avisar(estado === 'revisada' ? 'Planilla revisada.' : estado === 'observada' ? 'Revisada con observaciones.' : 'Planilla anulada.', 'bien');
      setRevision(null);
      setNota('');
      await recargar();
    } catch (err) {
      avisar(`No se pudo guardar: ${mensajeDe(err)}`, 'mal');
    } finally {
      setTrabajando(false);
    }
  };

  return (
    <main className="mx-auto grid max-w-[980px] gap-7 px-4 pb-16 pt-5 sm:px-6">
      <div><Boton variante="fantasma" onClick={volver}><IcoFlecha className="h-5 w-5" />Volver</Boton></div>
      <Estado cargando={cargando && !e} error={error} onReintentar={recargar} vacio={!cargando && !e && 'No se encontró esta planilla o no tienes acceso a ella.'}>
        {e && <>
          <header className="grid gap-3">
            <div className="flex items-end gap-4">
              <span className="font-display text-[76px] font-black leading-[0.78] sm:text-[96px]">{e.codigo}</span>
              <div className="min-w-0 pb-1">
                <Ojo>Planilla firmada · {area(e.area)}{e.horario ? ` · ${e.horario}` : ''} · versión {e.version}</Ojo>
                <h1 className="font-display text-[28px] font-extrabold uppercase leading-[0.95] sm:text-[34px]">{e.nombre}</h1>
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {([
                ['Puntaje', e.puntaje != null ? `${num(e.puntaje, 1)} %` : '—', e.criticos ? 'text-mal' : e.no_cumple ? 'text-aviso' : 'text-bien'],
                ['Cumple', `${e.cumple}/${e.total}`, ''],
                ['No cumple', String(e.no_cumple), e.no_cumple ? 'text-mal' : ''],
                ['Críticos', String(e.criticos), e.criticos ? 'text-mal' : ''],
              ] as const).map(([k, v, c]) => (
                <div key={k} className="rounded-[8px] border border-linea bg-superficie p-3">
                  <dt className="font-mono text-[11px] uppercase tracking-[0.14em] text-tenue">{k}</dt>
                  <dd className={cx('num mt-1 font-display text-[36px] font-black leading-none', c)}>{v}</dd>
                </div>
              ))}
            </dl>
            <div className="grid gap-1 rounded-[8px] border border-linea bg-superficie p-4 text-[15px]">
              <p><span className="text-tenue">Firmó </span><b className="font-semibold">{e.realizada_por_nombre}</b> el {fechaHora(e.completada_en)}
                {e.firma ? ` · ${e.firma.metodo === 'pin_sin_conexion' || e.firma.firmada_sin_conexion_en ? 'PIN sin conexión' : 'PIN'}` : ''}
                {e.dispositivo ? ` · ${e.dispositivo}` : ''}</p>
              {e.iniciada_en && <p className="text-tenue">La empezó a las {hora(Date.parse(e.iniciada_en))}; tardó {Math.max(1, Math.round((Date.parse(e.completada_en) - Date.parse(e.iniciada_en)) / 60_000))} min.</p>}
              {e.sin_conexion && <p className="text-aviso">Se firmó sin conexión y llegó al volver la señal.</p>}
              <p className={cx('font-semibold', ESTADO_EJEC[e.estado].c)}>{ESTADO_EJEC[e.estado].t}
                {e.revisada_por_nombre && e.revisada_en ? <span className="font-normal text-tenue"> · {e.revisada_por_nombre}, {cuando(e.revisada_en, ahora)}</span> : ''}</p>
              {e.nota_revision && <p className="border-l-[3px] border-aviso pl-2.5">{e.nota_revision}</p>}
            </div>
          </header>

          {(puedeRevisar || puedeAnular) && (
            <section className="grid gap-3 rounded-[8px] border-2 border-mostaza/60 bg-mostaza/[0.06] p-4">
              <h2 className="font-display text-[22px] font-extrabold uppercase leading-none">Revisión</h2>
              {revision === null ? (
                <div className="flex flex-wrap gap-2">
                  {puedeRevisar && <Boton variante="primario" onClick={() => void revisar('revisada')} disabled={trabajando}>{trabajando ? 'Guardando…' : 'Todo en orden: revisada'}</Boton>}
                  {puedeRevisar && <Boton onClick={() => setRevision('observada')} disabled={trabajando}>Con observaciones</Boton>}
                  {puedeAnular && <Boton variante="fantasma" className="ml-auto" onClick={() => setRevision('anulada')} disabled={trabajando}>Anular</Boton>}
                </div>
              ) : (
                <form className="grid gap-3" onSubmit={(ev) => { ev.preventDefault(); if (nota.trim().length >= 5) void revisar(revision); }}>
                  <Campo etiqueta={revision === 'observada' ? '¿Qué hay que corregir?' : 'Motivo de la anulación'}>
                    <textarea value={nota} onChange={(ev) => setNota(ev.target.value)} rows={2} required minLength={5}
                      className="rounded-[8px] border-2 border-linea bg-superficie p-3 text-[16px] outline-none focus:border-mostaza" />
                  </Campo>
                  <div className="flex gap-2">
                    <Boton type="submit" variante={revision === 'anulada' ? 'peligro' : 'primario'} disabled={trabajando || nota.trim().length < 5}>{trabajando ? 'Guardando…' : 'Firmar'}</Boton>
                    <Boton variante="fantasma" onClick={() => { setRevision(null); setNota(''); }}>Cancelar</Boton>
                  </div>
                </form>
              )}
              {propia && !esAdmin && <p className="text-[14px] text-tenue">La llenaste tú: la revisa otra persona.</p>}
            </section>
          )}

          {secciones.map(([titulo, rs]) => (
            <Seccion key={titulo} titulo={titulo}>
              <ul className="grid">
                {rs.map((r) => (
                  <li key={r.item_id} className={cx('grid gap-1.5 border-b border-linea/70 py-3', r.cumple === false && 'bg-mal/[0.04]')}>
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
                      <p className="text-[15px] leading-snug">
                        <span className="mr-2 font-mono text-[12px] text-tenue">{r.ref}</span>{r.texto}
                        {r.critico && <span className="ml-2 font-mono text-[11px] font-semibold uppercase text-mal">crítico</span>}
                        {limiteDe(r) && <span className="ml-2 font-mono text-[12px] text-tenue">({limiteDe(r)})</span>}
                      </p>
                      <b className={cx('num text-right text-[15px]', r.cumple === false ? 'text-mal' : r.cumple ? 'text-bien' : '')}>{valorDe(r)}</b>
                    </div>
                    {r.observacion && <p className="border-l-[3px] border-linea pl-2.5 text-[14px] text-tenue">{r.observacion}</p>}
                    {r.evidencia && <VerFoto ruta={r.evidencia.ruta} />}
                  </li>
                ))}
              </ul>
            </Seccion>
          ))}

          {e.incidencias.length > 0 && (
            <Seccion titulo="Incidencias que abrió" extra={String(e.incidencias.length)}>
              <div className="grid gap-3">{e.incidencias.map((i) => <TarjetaIncidencia key={i.id} i={i} alCambiar={recargar} />)}</div>
            </Seccion>
          )}
        </>}
      </Estado>
    </main>
  );
}

/* ===================================================================== */
/* Alertas                                                                   */
/* ===================================================================== */
const TIPOS_ALERTA: Record<string, string> = {
  incidencia: 'Incidencia', incidencia_escalada: 'Incidencia escalada', checklist_vencido: 'Planilla vencida',
  operacion_bloqueada: 'Operación bloqueada', pin_bloqueado: 'PIN bloqueado', dispositivo_bloqueado: 'Equipo bloqueado',
  aprobacion_pendiente: 'Aprobación pendiente', rechazada: 'Rechazada', stock_bajo: 'Stock bajo',
  lote_vencido: 'Lote vencido', vencimiento_proximo: 'Vence pronto', diferencia_recepcion: 'Diferencia en recepción',
};

export function Alertas() {
  const { usuario, enLinea, ahora, ir, refrescarAlertas, avisar } = useApp();
  const { datos, error, cargando, recargar, setDatos } = useCarga(() => rpc<Alerta[]>('pase_alertas', { p_limite: 100 }), [], enLinea);
  const [marcando, setMarcando] = useState(false);
  const abiertas = (datos ?? []).filter((a) => a.estado === 'abierta');

  const marcar = async (lista: Alerta[]) => {
    setMarcando(true);
    try {
      for (const a of lista) await rpc('marcar_alerta_vista', { p_id: a.id });
      const ids = new Set(lista.map((a) => a.id));
      setDatos((d) => d?.map((x) => ids.has(x.id) ? { ...x, estado: 'vista' as const, vista_por_nombre: usuario.nombreCompleto } : x) ?? null);
      void refrescarAlertas();
    } catch (e) {
      avisar(`No se pudo marcar: ${mensajeDe(e)}`, 'mal');
    } finally {
      setMarcando(false);
    }
  };

  return (
    <main className="mx-auto grid max-w-[980px] gap-6 px-4 py-7 sm:px-6">
      <Titular ojo="Avisos del sistema" titulo="Alertas">
        {datos ? (abiertas.length ? `${plural(abiertas.length, 'alerta sin ver', 'alertas sin ver')}.` : 'Estás al día.') : 'Planillas vencidas, incidencias y bloqueos.'}
      </Titular>
      {abiertas.length > 1 && <div><Boton onClick={() => void marcar(abiertas)} disabled={marcando}>{marcando ? 'Marcando…' : 'Marcar todas como vistas'}</Boton></div>}
      {!enLinea ? <SoloEnLinea que="ver las alertas" /> : (
        <Estado cargando={cargando && !datos} error={error} onReintentar={recargar} vacio={!datos?.length && 'No hay alertas.'}>
          <ul className="grid gap-2">
            {(datos ?? []).map((a) => (
              <li key={a.id} className={cx('grid gap-2 rounded-[8px] border bg-superficie p-4', a.estado === 'abierta' ? 'border-tinta/40' : 'border-linea opacity-75')}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <PildoraSeveridad s={a.severidad} />
                  <span className="font-mono text-[11.5px] uppercase tracking-[0.1em] text-tenue">{TIPOS_ALERTA[a.tipo] ?? a.tipo}</span>
                  <span className="ml-auto text-[13px] text-tenue">{hace(Date.parse(a.creada_en), ahora)}</span>
                </div>
                <p className="flex gap-2 text-[16px] font-semibold leading-snug">
                  {a.estado === 'abierta' && a.severidad === 'critica' && <IconoAlerta className="mt-0.5 h-5 w-5 shrink-0 text-mal" />}{a.titulo}
                </p>
                {a.detalle && <p className="text-[14px] leading-snug text-tenue">{a.detalle}</p>}
                <div className="flex flex-wrap items-center gap-2">
                  {a.estado === 'abierta' && <Boton onClick={() => void marcar([a])} disabled={marcando}>Marcar vista</Boton>}
                  {a.incidencia_id && <Boton variante="fantasma" onClick={() => ir({ id: 'incidencias' })}>Ver incidencias</Boton>}
                  {a.estado !== 'abierta' && <span className="text-[13px] text-tenue">{a.estado === 'resuelta' ? 'Resuelta' : `Vista${a.vista_por_nombre ? ` por ${a.vista_por_nombre}` : ''}`}</span>}
                </div>
              </li>
            ))}
          </ul>
        </Estado>
      )}
    </main>
  );
}
