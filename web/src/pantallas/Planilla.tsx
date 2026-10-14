import { useEffect, useMemo, useRef, useState } from 'react';
import { ErrorApi, rpc, storage } from '../api';
import { borrar, guardar, leer } from '../local';
import { encolar } from '../cola';
import { evidenciaDe, guardarFoto, leerFoto, prepararFoto, rutaDe } from '../fotos';
import { mensajeDe, useApp, type Firma } from '../contexto';
import type { Item, Plantilla as TPlantilla, Programada, Severidad } from '../tipos';
import { IconoAlerta, IconoCheck, type CambioCampo } from '../ui/PinConfirmModal';
import { Boton, IcoCamara, IcoDerecha, IcoFlecha, Ojo, PildoraSeveridad, area, corto, cx, hora, num } from '../ui/comun';

/* ---------- Respuestas ---------- */
interface Resp { pf?: 'cumple' | 'no_cumple'; na?: boolean; valor?: string; opcion?: string; foto?: string; nota?: string }
interface Borrador { ejecucionId: string; iniciada_en: string; resp: Record<string, Resp>; sec: number; guardado: number }

const aNumero = (v?: string) => {
  if (v === undefined || v.trim() === '' || v.trim() === '-') return null;
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/** null: sin responder · true: cumple o no aplica · false: no cumple */
function evaluar(i: Item, r?: Resp): boolean | null {
  if (r?.na) return true;
  switch (i.tipo) {
    case 'pass_fail': return r?.pf ? r.pf === 'cumple' : null;
    case 'number': {
      const v = aNumero(r?.valor);
      if (v === null) return null;
      return (i.min === null || v >= i.min) && (i.max === null || v <= i.max);
    }
    case 'choice': return r?.opcion ? true : null;
    case 'time': return r?.valor ? true : null;
    case 'photo': return r?.foto ? true : null;
    default: return true;
  }
}
const respondido = (i: Item, r?: Resp) => i.tipo === 'text' ? !!r?.valor?.trim() : evaluar(i, r) !== null;
const faltaFoto = (i: Item, r?: Resp) => evaluar(i, r) === false && i.foto_si_falla && !r?.foto;
const faltaNota = (i: Item, r?: Resp) => evaluar(i, r) === false && i.critico && !r?.nota?.trim();
const incompleto = (i: Item, r?: Resp) => (i.tipo !== 'text' && evaluar(i, r) === null) || faltaFoto(i, r) || faltaNota(i, r);

function limite(i: Item) {
  const u = i.unidad ? ` ${i.unidad}` : '';
  if (i.min !== null && i.max !== null) return `${num(i.min)} a ${num(i.max)}${u}`;
  if (i.max !== null) return `≤ ${num(i.max)}${u}`;
  if (i.min !== null) return `≥ ${num(i.min)}${u}`;
  return null;
}
const sevDe = (i: Item): Severidad => (i.critico ? 'critica' : i.tipo === 'number' ? 'alta' : 'media');
function textoValor(i: Item, r?: Resp) {
  if (r?.na) return 'No aplica';
  switch (i.tipo) {
    case 'pass_fail': return r?.pf === 'cumple' ? 'Cumple' : r?.pf === 'no_cumple' ? 'No cumple' : '—';
    case 'number': { const v = aNumero(r?.valor); return v === null ? '—' : `${num(v, 2)} ${i.unidad ?? ''}`.trim(); }
    case 'choice': return r?.opcion ?? '—';
    case 'photo': return r?.foto ? 'Foto' : '—';
    default: return r?.valor?.trim() || '—';
  }
}
function respuestaDe(i: Item, r?: Resp) {
  const base = { item_id: i.id, no_aplica: !!r?.na, observacion: r?.nota?.trim() || null, evidencia_id: r?.foto ?? null };
  if (r?.na) return base;
  switch (i.tipo) {
    case 'pass_fail': return { ...base, valor_bool: r?.pf ? r.pf === 'cumple' : null };
    case 'number': return { ...base, valor_num: aNumero(r?.valor) };
    case 'choice': return { ...base, valor_opcion: r?.opcion ?? null };
    case 'time': return { ...base, valor_hora: r?.valor || null };
    case 'text': return { ...base, valor_texto: r?.valor?.trim() || null };
    default: return base;
  }
}
function correctivas(i: Item) {
  if (i.unidad === '°C' && i.min !== null && i.max === null) return ['Volví a cocinar hasta el límite', 'Descarté el producto', 'Avisé al supervisor'];
  if (i.unidad === '°C') return ['Pasé el producto a otro equipo', 'Revisé la puerta y el empaque', 'Ajusté el termostato', 'Avisé a mantenimiento'];
  if (i.unidad === '%') return ['Cambié el aceite', 'Dejé la freidora fuera de servicio', 'Avisé al supervisor'];
  return ['Lo corregí en el momento', 'Avisé al supervisor', 'Necesita mantenimiento'];
}

/* ---------- Foto ---------- */
function useVistaPrevia(id?: string) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!id) { setUrl(null); return; }
    let u: string | null = null;
    void leerFoto(id).then((f) => { if (f) { u = URL.createObjectURL(f.blob); setUrl(u); } });
    return () => { if (u) URL.revokeObjectURL(u); };
  }, [id]);
  return url;
}

export function Foto({ id, valor, onCambio, obligatoria, error, marca }: {
  id: string; valor?: string; onCambio: (v?: string) => void; obligatoria: boolean; error?: boolean; marca: () => string[];
}) {
  const [cargando, setCargando] = useState(false);
  const [falla, setFalla] = useState<string | null>(null);
  const vista = useVistaPrevia(valor);
  const elegir = async (archivo?: File) => {
    if (!archivo) return;
    setCargando(true);
    setFalla(null);
    try {
      const f = await prepararFoto(archivo, marca());
      await guardarFoto(f);
      if (valor) await borrar('fotos', valor);
      onCambio(f.id);
    } catch {
      setFalla('No se pudo leer la foto. Inténtalo otra vez.');
    } finally {
      setCargando(false);
    }
  };
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor={id} className={cx('tecla flex h-14 cursor-pointer items-center gap-3 rounded-[7px] px-4 text-[16px] font-semibold focus-within:outline focus-within:outline-2 focus-within:outline-mostaza',
          error && !valor && 'border-mal text-mal')}>
          <IcoCamara className="h-6 w-6" />
          {cargando ? 'Procesando…' : valor ? 'Cambiar foto' : obligatoria ? 'Tomar foto (obligatoria)' : 'Agregar foto'}
          <input id={id} type="file" accept="image/*" capture="environment" className="sr-only"
            onChange={(e) => { void elegir(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        {valor && vista && (
          <span className="flex items-center gap-2">
            <img src={vista} alt="Foto adjunta" className="h-14 w-20 rounded-[6px] border border-linea object-cover" />
            <button type="button" onClick={() => { void borrar('fotos', valor); onCambio(undefined); }} className="text-[14px] text-tenue underline underline-offset-4 hover:text-tinta">Quitar</button>
          </span>
        )}
      </div>
      {falla && <p className="text-[14px] font-semibold text-mal">{falla}</p>}
      {error && !valor && obligatoria && <p className="text-[14px] font-semibold text-mal">Falta la foto.</p>}
    </div>
  );
}

/* ---------- Un punto de la planilla ---------- */
function CampoItem({ i, r, onR, mostrarErrores, bloquea, marca }: {
  i: Item; r?: Resp; onR: (r: Resp) => void; mostrarErrores: boolean; bloquea: boolean; marca: () => string[];
}) {
  const ok = evaluar(i, r);
  const lim = limite(i);
  const falta = mostrarErrores && incompleto(i, r);
  const permiteNegativo = (i.min !== null && i.min < 0) || (i.max !== null && i.max < 0);
  return (
    <li className={cx('grid gap-3 border-b border-linea py-5 last:border-b-0', falta && 'rounded-[8px] bg-mal/[0.05] px-3')}
      data-item={i.ref} data-tipo={i.tipo} data-min={i.min ?? undefined} data-max={i.max ?? undefined}>
      <div className="flex flex-wrap items-center gap-2 font-mono text-[11.5px] uppercase tracking-[0.1em]">
        <span className="text-tenue">{i.ref}</span>
        {i.critico && <span className="rounded-[3px] border border-mal/60 px-1.5 py-0.5 font-semibold text-mal">Crítico</span>}
        {lim && <span className="rounded-[3px] bg-hundido px-1.5 py-0.5 font-semibold text-tinta">{lim}</span>}
      </div>
      <p id={`t-${i.id}`} className="max-w-[60ch] text-[19px] font-medium leading-snug">{i.texto}</p>
      {i.ayuda && <p className="-mt-1 max-w-[60ch] text-[15px] leading-snug text-tenue">{i.ayuda}</p>}

      {r?.na ? null : <>
        {i.tipo === 'number' && (
          <div className="flex flex-wrap items-center gap-3">
            <label className={cx('flex h-[76px] w-[220px] items-center gap-2 rounded-[8px] border-2 bg-superficie px-4 focus-within:border-mostaza',
              ok === false ? 'border-mal' : ok === true ? 'border-bien' : falta ? 'border-mal/60' : 'border-linea')}>
              <input inputMode="decimal" autoComplete="off" value={r?.valor ?? ''} placeholder="—" aria-labelledby={`t-${i.id}`}
                onChange={(e) => onR({ ...r, valor: e.target.value.replace(/[^\d.,-]/g, '') })}
                className="num w-full min-w-0 bg-transparent font-display text-[48px] font-bold leading-none outline-none placeholder:text-linea" />
              <span className="font-display text-[26px] font-bold text-tenue">{i.unidad}</span>
            </label>
            {permiteNegativo && (
              <Boton onClick={() => { const v = r?.valor ?? ''; onR({ ...r, valor: v.startsWith('-') ? v.slice(1) : `-${v}` }); }} aria-label="Cambiar el signo">±</Boton>
            )}
            <Veredicto ok={i.min === null && i.max === null ? null : ok} />
          </div>
        )}
        {i.tipo === 'pass_fail' && (
          <div className="grid w-full max-w-[460px] grid-cols-2 gap-2" role="radiogroup" aria-labelledby={`t-${i.id}`}>
            {(['cumple', 'no_cumple'] as const).map((v) => (
              <button key={v} type="button" role="radio" aria-checked={r?.pf === v} onClick={() => onR({ ...r, pf: v })}
                className={cx('flex h-16 items-center justify-center gap-2 rounded-[8px] text-[18px] font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mostaza',
                  r?.pf === v ? (v === 'cumple' ? 'bg-bien text-superficie' : 'bg-mal text-superficie') : 'tecla')}>
                {v === 'cumple' ? <><IconoCheck className="h-5 w-5" />Cumple</> : <><span aria-hidden="true" className="text-[22px] leading-none">×</span>No cumple</>}
              </button>
            ))}
          </div>
        )}
        {i.tipo === 'choice' && (
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-labelledby={`t-${i.id}`}>
            {(i.opciones ?? []).map((o) => (
              <button key={o} type="button" role="radio" aria-checked={r?.opcion === o} onClick={() => onR({ ...r, opcion: o })}
                className={cx('min-h-12 rounded-[8px] border-2 px-4 py-2 text-left text-[16px] font-semibold', r?.opcion === o ? 'border-mostaza bg-mostaza/15' : 'border-linea bg-superficie hover:border-tenue', falta && !r?.opcion && 'border-mal/60')}>{o}</button>
            ))}
          </div>
        )}
        {i.tipo === 'time' && (
          <div className="flex flex-wrap items-center gap-3">
            <input type="time" value={r?.valor ?? ''} onChange={(e) => onR({ ...r, valor: e.target.value })} aria-labelledby={`t-${i.id}`}
              className={cx('num h-16 rounded-[8px] border-2 bg-superficie px-4 font-display text-[34px] font-bold outline-none focus:border-mostaza', falta ? 'border-mal/60' : 'border-linea')} />
            <Boton onClick={() => { const d = new Date(); onR({ ...r, valor: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }); }}>Ahora</Boton>
          </div>
        )}
        {i.tipo === 'text' && (
          <textarea value={r?.valor ?? ''} onChange={(e) => onR({ ...r, valor: e.target.value })} rows={2} aria-labelledby={`t-${i.id}`}
            className="max-w-[640px] rounded-[8px] border-2 border-linea bg-superficie p-3 text-[17px] outline-none focus:border-mostaza" placeholder="Escribe aquí (opcional)" />
        )}
        {i.tipo === 'photo' && <Foto id={`f-${i.id}`} valor={r?.foto} onCambio={(foto) => onR({ ...r, foto })} obligatoria error={mostrarErrores} marca={marca} />}
      </>}

      {i.admite_na && (
        <button type="button" onClick={() => onR(r?.na ? { ...r, na: false } : { na: true, nota: r?.nota })} aria-pressed={!!r?.na}
          className={cx('h-10 w-fit rounded-[6px] px-3 text-[15px] font-medium', r?.na ? 'bg-tinta text-fondo' : 'text-tenue underline underline-offset-4')}>
          {r?.na ? 'No aplica · tocar para responder' : 'No aplica'}
        </button>
      )}
      {falta && !faltaFoto(i, r) && !faltaNota(i, r) && <p className="text-[14px] font-semibold text-mal">Falta responder este punto.</p>}

      {ok === false && (
        <div className="grid gap-3 rounded-[8px] border border-mal/40 bg-mal/[0.07] p-4">
          <p className="flex gap-2 text-[15px] font-semibold leading-snug text-mal">
            <IconoAlerta className="mt-0.5 h-5 w-5 shrink-0" />
            {i.critico ? 'Se abrirá una incidencia crítica y se avisará al supervisor de turno.' : `Se abrirá una incidencia ${sevDe(i)} para el supervisor.`}
          </p>
          {bloquea && i.critico && <p className="text-[15px] font-semibold">No uses este equipo hasta que el supervisor lo libere.</p>}
          {i.foto_si_falla && <Foto id={`f-${i.id}`} valor={r?.foto} onCambio={(foto) => onR({ ...r, foto })} obligatoria error={mostrarErrores} marca={marca} />}
          <div className="grid gap-2">
            <p className="text-[15px] font-semibold">¿Qué hiciste?{i.critico ? ' (obligatorio)' : ''}</p>
            <div className="flex flex-wrap gap-2">
              {correctivas(i).map((c) => (
                <button key={c} type="button" onClick={() => onR({ ...r, nota: r?.nota?.includes(c) ? r.nota : [r?.nota, c].filter(Boolean).join('. ') })}
                  className="rounded-[6px] border border-linea bg-superficie px-3 py-2 text-[14px] font-medium hover:border-tinta">{c}</button>
              ))}
            </div>
            <textarea value={r?.nota ?? ''} onChange={(e) => onR({ ...r, nota: e.target.value })} rows={2} aria-label="Acción correctiva"
              className={cx('rounded-[6px] border bg-superficie p-2.5 text-[16px] outline-none focus:border-mostaza', mostrarErrores && faltaNota(i, r) ? 'border-mal' : 'border-linea')} placeholder="Acción correctiva" />
            {mostrarErrores && faltaNota(i, r) && <p className="text-[14px] font-semibold text-mal">Escribe qué hiciste: es un punto crítico.</p>}
          </div>
        </div>
      )}
    </li>
  );
}

const Veredicto = ({ ok }: { ok: boolean | null }) => ok === null ? null : (
  <span className={cx('inline-flex h-10 items-center gap-1.5 rounded-[6px] px-3 text-[16px] font-bold', ok ? 'bg-bien/10 text-bien' : 'bg-mal text-superficie')}>
    {ok ? <><IconoCheck className="h-5 w-5" />Cumple</> : 'No cumple'}
  </span>
);

/* ===================================================================== */
export function Planilla({ progId, plantillaId }: { progId?: string; plantillaId?: string }) {
  const { usuario, equipo, hoy, catalogo, ahora, ir, volver, firmar, recibo, avisar, recargarHoy, refrescarCola, enLinea, redCaida } = useApp();
  const prog: Programada | undefined = progId ? hoy?.programadas.find((p) => p.id === progId) : undefined;
  const pl: TPlantilla | undefined = catalogo.find((p) => p.id === (prog?.plantilla_id ?? plantillaId));
  const clave = `${usuario.id}:${progId ?? plantillaId}`;

  const [b, setB] = useState<Borrador | null>(null);
  const [errores, setErrores] = useState(false);
  const [revision, setRevision] = useState(false);
  const [saliendo, setSaliendo] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const recuperado = useRef(false);

  useEffect(() => {
    void leer<Borrador>('borradores', clave).then((g) => {
      if (g && Object.keys(g.resp).length) { recuperado.current = true; setB(g); }
      else setB({ ejecucionId: crypto.randomUUID(), iniciada_en: new Date().toISOString(), resp: {}, sec: 0, guardado: Date.now() });
    });
  }, [clave]);
  useEffect(() => { if (b && recuperado.current) { recuperado.current = false; avisar('Seguimos donde quedaste: tus respuestas estaban guardadas en la tablet.', 'info'); } }, [b, avisar]);
  useEffect(() => {
    if (!b || !Object.keys(b.resp).length) return;
    const t = window.setTimeout(() => void guardar('borradores', clave, { ...b, guardado: Date.now() }), 400);
    return () => window.clearTimeout(t);
  }, [b, clave]);

  const todos = useMemo(() => pl?.secciones.flatMap((s) => s.items) ?? [], [pl]);
  if (!pl || !b) {
    return (
      <main className="mx-auto grid max-w-[980px] gap-4 px-4 py-8 sm:px-6">
        <div><Boton variante="fantasma" onClick={volver}><IcoFlecha className="h-5 w-5" />Volver</Boton></div>
        <p className="text-[17px] text-tenue">{!catalogo.length || (progId && !hoy) ? 'Cargando la planilla…' : 'No se encontró esta planilla. Puede que ya no esté vigente.'}</p>
      </main>
    );
  }
  const resp = b.resp;
  const sec = Math.min(b.sec, pl.secciones.length - 1);
  const seccion = pl.secciones[sec]!;
  const set = (id: string, r: Resp) => setB((x) => x && ({ ...x, resp: { ...x.resp, [id]: r } }));
  const setSec = (n: number) => setB((x) => x && ({ ...x, sec: n }));
  const hechos = todos.filter((i) => respondido(i, resp[i.id])).length;
  const fallas = todos.filter((i) => evaluar(i, resp[i.id]) === false);
  const nas = todos.filter((i) => resp[i.id]?.na).length;
  const marca = () => [`${pl.codigo} · ${new Date().toLocaleString('es-VE', { hour12: false })}`, `${equipo.nombre} · ${usuario.nombreCompleto}`];

  const avanzar = () => {
    if (seccion.items.some((i) => incompleto(i, resp[i.id]))) { setErrores(true); return; }
    setErrores(false);
    if (sec < pl.secciones.length - 1) setSec(sec + 1); else setRevision(true);
    window.scrollTo({ top: 0 });
  };
  const descartar = async () => {
    for (const r of Object.values(resp)) if (r.foto) await borrar('fotos', r.foto);
    await borrar('borradores', clave);
    volver();
  };

  const enviar = async () => {
    if (enviando) return;
    const pendientes = todos.filter((i) => incompleto(i, resp[i.id]));
    if (pendientes.length) {
      setErrores(true); setRevision(false);
      setSec(pl.secciones.findIndex((s) => s.items.includes(pendientes[0]!)));
      return;
    }
    const criticas = fallas.filter((i) => i.critico).length;
    const cambios: CambioCampo[] = todos.map((i) => ({ campo: `${i.ref} · ${corto(i.texto, 40)}`, despues: textoValor(i, resp[i.id]), falla: evaluar(i, resp[i.id]) === false }));
    const f = await firmar({
      titulo: `Enviar planilla ${pl.codigo}`, accion: 'crear', entidad: 'checklist_ejecuciones', entidadId: b.ejecucionId,
      referencia: `${pl.nombre}${prog?.horario ? ` · ${prog.horario}` : ''}`, cambios,
      advertencia: fallas.length
        ? `${fallas.length === 1 ? 'Un punto no cumple' : `${fallas.length} puntos no cumplen`}: se ${fallas.length === 1 ? 'abrirá una incidencia' : `abrirán ${fallas.length} incidencias`}${criticas ? ' y el supervisor recibe el aviso de inmediato' : ''}.`
        : undefined,
    });
    if (!f) return;
    setEnviando(true);
    const respuestas = todos.map((i) => respuestaDe(i, resp[i.id]));
    const fotos = [...new Set(Object.values(resp).map((r) => r.foto).filter((x): x is string => !!x))];
    const evidencias: ReturnType<typeof evidenciaDe>[] = [];
    for (const id of fotos) { const ft = await leerFoto(id); if (ft) evidencias.push(evidenciaDe(ft, usuario.sucursal)); }
    const ejecucion = {
      id: b.ejecucionId, plantilla_id: pl.id, iniciada_en: b.iniciada_en,
      ...(prog ? { programacion_id: prog.id, horario: prog.horario } : {}),
    };
    const lineasBase: [string, string][] = [['Puntos', `${hechos} de ${todos.length}`], ['No cumple', String(fallas.length)], ...(nas ? [['No aplica', String(nas)] as [string, string]] : [])];

    const aLaCola = async (firma: Firma) => {
      await encolar({
        id: b.ejecucionId, tipo: 'planilla', titulo: `${pl.codigo} · ${pl.nombre}`, usuario_id: usuario.id, usuario_nombre: usuario.nombreCompleto,
        firmada_en: firma.firmadoEn,
        planilla: { ejecucion: { ...ejecucion, completada_en: firma.firmadoEn }, respuestas, evidencias },
        fotos,
      });
      await borrar('borradores', clave);
      await refrescarCola();
      await recibo({ titulo: `Planilla ${pl.codigo} · ${pl.nombre}`, lineas: lineasBase, firma: { ...firma, sinConexion: true },
        aviso: { tono: 'aviso', texto: fallas.length ? 'Guardada en la tablet. Al volver la conexión se envía y se abren las incidencias. Avisa al supervisor en persona.' : 'Guardada en la tablet; se envía sola al volver la conexión.' } });
      ir({ id: 'inicio' });
    };

    try {
      if (f.sinConexion) { await aLaCola(f); return; }
      for (const id of fotos) {
        const ft = await leerFoto(id);
        if (ft) await storage.subir(rutaDe(ft, usuario.sucursal), ft.blob);
      }
      const r = await rpc<{ ok: boolean; puntaje: number | null; no_cumple: number; criticos_no_cumple: number; incidencias: number; operacion_bloqueada?: boolean }>(
        'enviar_planilla', { p_ejecucion: ejecucion, p_respuestas: respuestas, p_evidencias: evidencias, p_firma: f.firmaId });
      for (const id of fotos) await borrar('fotos', id);
      await borrar('borradores', clave);
      void recargarHoy();
      await recibo({
        titulo: `Planilla ${pl.codigo} · ${pl.nombre}`,
        lineas: [...lineasBase, ['Puntaje', r.puntaje != null ? `${num(r.puntaje, 1)} %` : '—'], ...(r.incidencias ? [['Incidencias', String(r.incidencias)] as [string, string]] : [])],
        firma: f,
        aviso: r.operacion_bloqueada ? { tono: 'mal', texto: 'Operación bloqueada: no usar el equipo hasta que el supervisor cierre la incidencia.' }
          : r.incidencias ? { tono: 'aviso', texto: `Se ${r.incidencias === 1 ? 'abrió 1 incidencia' : `abrieron ${r.incidencias} incidencias`} y el supervisor ya tiene el aviso.` }
          : { tono: 'bien', texto: 'Planilla completa y enviada.' },
      });
      ir({ id: 'inicio' });
    } catch (e) {
      if (e instanceof ErrorApi && e.red) {
        redCaida();
        await aLaCola({ ...f, sinConexion: true });
        return;
      }
      avisar(`No se pudo enviar: ${mensajeDe(e)}`, 'mal');
    } finally {
      setEnviando(false);
    }
  };

  const vence = prog ? Date.parse(prog.vence_en) : null;
  return (
    <main className="mx-auto grid max-w-[980px] gap-6 px-4 pb-32 pt-5 sm:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <Boton variante="fantasma" onClick={() => (hechos && !saliendo ? setSaliendo(true) : volver())}><IcoFlecha className="h-5 w-5" />Salir</Boton>
        {saliendo && (
          <span className="flex flex-wrap items-center gap-2 text-[15px]">
            <span className="text-tenue">Tus respuestas quedan guardadas en la tablet.</span>
            <Boton onClick={volver}>Salir y seguir luego</Boton>
            <Boton variante="peligro" onClick={() => void descartar()}>Borrar respuestas</Boton>
            <Boton variante="fantasma" onClick={() => setSaliendo(false)}>Seguir</Boton>
          </span>
        )}
        <span className="ml-auto font-mono text-[12px] uppercase tracking-[0.12em] text-tenue">
          {vence ? `${vence < ahora ? 'Venció' : 'Vence'} ${hora(vence)} · ` : ''}{pl.minutos ? `${pl.minutos} min aprox.` : ''}
        </span>
      </div>

      <header className="grid gap-3">
        <div className="flex items-end gap-4">
          <span className="font-display text-[76px] font-black leading-[0.78] sm:text-[96px]">{pl.codigo}</span>
          <div className="min-w-0 pb-1">
            <Ojo>Planilla · {area(pl.area)}{prog?.horario ? ` · ${prog.horario}` : ''}</Ojo>
            <h1 className="font-display text-[28px] font-extrabold uppercase leading-[0.95] sm:text-[34px]">{pl.nombre}</h1>
          </div>
        </div>
        {pl.objetivo && sec === 0 && !revision && <p className="max-w-[70ch] text-[16px] leading-snug text-tenue">{pl.objetivo}</p>}
        <ol className="flex gap-1.5" aria-label="Avance por sección">
          {pl.secciones.map((s, k) => {
            const n = s.items.filter((i) => respondido(i, resp[i.id])).length;
            return (
              <li key={s.id} className="min-w-0 flex-1">
                <button type="button" onClick={() => { if (!revision && k <= sec) setSec(k); }} disabled={revision || k > sec}
                  className="block w-full text-left disabled:cursor-default" aria-current={!revision && k === sec ? 'step' : undefined}>
                  <span className={cx('block h-2 rounded-[2px]', revision || k < sec ? 'bg-tinta' : k === sec ? 'bg-mostaza' : 'bg-hundido')} />
                  <span className="mt-1.5 hidden truncate font-mono text-[11px] uppercase tracking-[0.08em] text-tenue sm:block">{corto(s.titulo, 28)} · {n}/{s.items.length}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </header>

      {!revision ? (
        <section className="animate-subir" key={sec}>
          <Ojo>Sección {sec + 1} de {pl.secciones.length}{seccion.hora ? ` · ${seccion.hora}` : ''}</Ojo>
          <h2 className="mt-1 font-display text-[32px] font-extrabold uppercase leading-none">{seccion.titulo}</h2>
          <ul className="mt-2">
            {seccion.items.map((i) => <CampoItem key={i.id} i={i} r={resp[i.id]} onR={(r) => set(i.id, r)} mostrarErrores={errores} bloquea={pl.bloquea} marca={marca} />)}
          </ul>
        </section>
      ) : (
        <section className="grid animate-subir gap-5">
          <h2 className="font-display text-[34px] font-extrabold uppercase leading-none">Revisa y firma</h2>
          <dl className="grid grid-cols-3 gap-3">
            {([['Respondidos', `${hechos}/${todos.length}`, ''], ['Cumple', String(todos.length - fallas.length - nas), 'text-bien'], ['No cumple', String(fallas.length), fallas.length ? 'text-mal' : '']] as const).map(([k, v, c]) => (
              <div key={k} className="rounded-[8px] border border-linea bg-superficie p-4">
                <dt className="font-mono text-[11px] uppercase tracking-[0.14em] text-tenue">{k}</dt>
                <dd className={cx('num mt-1 font-display text-[44px] font-black leading-none', c)}>{v}</dd>
              </div>
            ))}
          </dl>
          {fallas.length > 0 && (
            <div className="grid gap-2">
              {fallas.some((i) => i.critico && pl.bloquea) && (
                <p className="flex items-start gap-2 rounded-[8px] bg-mal px-4 py-3 text-[16px] font-semibold text-superficie"><IconoAlerta className="mt-0.5 h-5 w-5 shrink-0" />No operar: al enviar, el equipo queda bloqueado hasta que el supervisor cierre la incidencia.</p>
              )}
              <ul className="grid gap-2">
                {fallas.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center gap-3 rounded-[8px] border border-linea bg-superficie px-4 py-3">
                    <PildoraSeveridad s={sevDe(i)} />
                    <span className="min-w-0 flex-1 text-[15px] font-medium">{i.ref} · {corto(i.texto, 70)}</span>
                    <b className="num text-mal">{textoValor(i, resp[i.id])}</b>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-[15px] text-tenue">
            Firmas tú, {usuario.nombreCompleto}, con tu PIN. La planilla se guarda completa con la hora exacta y el equipo.
            {!enLinea && ' Sin conexión: queda en la tablet y se envía sola al volver la señal.'}
          </p>
        </section>
      )}

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-linea bg-superficie/95 backdrop-blur" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
        <div className="mx-auto flex max-w-[980px] items-center gap-3 px-4 py-3 sm:px-6">
          {revision
            ? <Boton alto="lg" onClick={() => { setRevision(false); setSec(pl.secciones.length - 1); }}><IcoFlecha className="h-5 w-5" />Corregir</Boton>
            : sec > 0 && <Boton alto="lg" onClick={() => { setSec(sec - 1); setErrores(false); }}><IcoFlecha className="h-5 w-5" />Anterior</Boton>}
          <span className="hidden text-[14px] text-tenue sm:block">{hechos} de {todos.length} puntos</span>
          {revision
            ? <Boton variante="primario" alto="lg" className="ml-auto min-w-[220px]" onClick={() => void enviar()} disabled={enviando}>{enviando ? 'Enviando…' : 'Firmar y enviar'}</Boton>
            : <Boton variante="primario" alto="lg" className="ml-auto min-w-[220px]" onClick={avanzar}>
                {sec < pl.secciones.length - 1 ? 'Siguiente sección' : 'Revisar'}<IcoDerecha className="h-5 w-5" />
              </Boton>}
        </div>
      </div>
    </main>
  );
}
