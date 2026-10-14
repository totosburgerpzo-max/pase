import { useMemo, useState } from 'react';
import { rpc } from '../api';
import { mensajeDe, useApp, useCarga } from '../contexto';
import type { RegistroBitacora } from '../tipos';
import { IconoAlerta, IconoEscudo } from '../ui/PinConfirmModal';
import { Boton, Estado, Ojo, Opciones, SoloEnLinea, Titular, claseEntrada, cx, fecha, hora, num } from '../ui/comun';

const TABLAS: Record<string, string> = {
  checklist_ejecuciones: 'Planillas', checklist_respuestas: 'Respuestas', incidencias: 'Incidencias', usuarios: 'Personal',
  dispositivos: 'Equipos', firmas: 'Firmas', evidencias: 'Fotos', alertas: 'Alertas', plantillas: 'Plantillas',
  checklist_programacion: 'Programación', parametros: 'Parámetros', sesiones: 'Sesiones',
};
const ACCIONES: Record<string, string> = {
  INSERT: 'creó', UPDATE: 'modificó', DELETE: 'borró', PIN_ASIGNADO: 'asignó un PIN', PIN_REGENERADO: 'cambió su PIN',
  PIN_BLOQUEADO: 'quedó con el PIN bloqueado', PIN_FALLIDO: 'escribió un PIN equivocado', SESION_CORREO: 'entró con correo',
  SESION_PIN: 'entró con PIN', EXPORTAR: 'exportó datos',
};
const METODOS: Record<string, string> = { pin_en_linea: 'PIN', pin_sin_conexion: 'PIN sin conexión', pin_autorizacion: 'PIN de autorización' };
const POR_PAGINA = 200;

function texto(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'sí' : 'no';
  if (typeof v === 'number') return num(v, 2);
  if (typeof v === 'string') return /^\d{4}-\d{2}-\d{2}T/.test(v) ? new Date(v).toLocaleString('es-VE', { hour12: false }) : v;
  return JSON.stringify(v);
}

export function Bitacora() {
  const { enLinea, avisar } = useApp();
  const [dias, setDias] = useState(1);
  const [tabla, setTabla] = useState('');
  const [extra, setExtra] = useState<RegistroBitacora[]>([]);
  const [masCargando, setMasCargando] = useState(false);
  const [sinMas, setSinMas] = useState(false);
  const [abierto, setAbierto] = useState<number | null>(null);
  const [integridad, setIntegridad] = useState<{ integra: boolean; primer_registro_alterado: number | null; registros: number } | null>(null);
  const [verificando, setVerificando] = useState(false);
  const desde = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (dias - 1)); return d.toISOString(); }, [dias]);
  const args = { p_desde: desde, p_tabla: tabla || null, p_limite: POR_PAGINA };
  const { datos, error, cargando, recargar } = useCarga(async () => {
    setExtra([]);
    const r = await rpc<RegistroBitacora[]>('pase_bitacora', args);
    setSinMas(r.length < POR_PAGINA);
    return r;
  }, [desde, tabla], enLinea);
  const todas = [...(datos ?? []), ...extra];
  // El «último uso» de un equipo se anota solo y no aporta a la lectura: se oculta (sigue en la cadena)
  const filas = todas.filter((r) => !(r.campos?.length === 1 && r.campos[0] === 'ultimo_uso'));

  const cargarMas = async () => {
    const ultimo = todas[todas.length - 1];
    if (!ultimo) return;
    setMasCargando(true);
    try {
      const r = await rpc<RegistroBitacora[]>('pase_bitacora', { ...args, p_antes_de: ultimo.id });
      setExtra((x) => [...x, ...r]);
      setSinMas(r.length < POR_PAGINA);
    } finally {
      setMasCargando(false);
    }
  };
  const verificar = async () => {
    setVerificando(true);
    try { setIntegridad(await rpc('pase_verificar_bitacora')); } catch (e) { setIntegridad(null); avisar(mensajeDe(e), 'mal'); } finally { setVerificando(false); }
  };

  const grupos = useMemo(() => {
    const m = new Map<string, RegistroBitacora[]>();
    for (const r of filas) { const k = new Date(r.ocurrido_en).toDateString(); m.set(k, [...(m.get(k) ?? []), r]); }
    return [...m.entries()];
  }, [filas]);

  return (
    <main className="mx-auto grid max-w-[1280px] gap-6 px-4 py-7 sm:px-6">
      <Titular ojo="Auditoría" titulo="Bitácora">
        Cada cambio queda aquí con quién lo hizo, desde qué equipo y con qué firma. Los registros no se pueden borrar ni editar:
        cada uno está encadenado al anterior, y la verificación detecta cualquier alteración.
      </Titular>
      {!enLinea ? <SoloEnLinea que="la bitácora" /> : <>
        <div className="flex flex-wrap items-center gap-3">
          <Opciones etiqueta="Período" valor={dias} onCambio={setDias} opciones={[{ id: 1, t: 'Hoy' }, { id: 7, t: '7 días' }, { id: 30, t: '30 días' }]} />
          <select value={tabla} onChange={(e) => setTabla(e.target.value)} className={cx(claseEntrada, 'h-11')} aria-label="Qué registros">
            <option value="">Todo</option>
            {Object.entries(TABLAS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <Boton className="ml-auto" onClick={() => void verificar()} disabled={verificando}><IconoEscudo className="h-5 w-5" />{verificando ? 'Verificando…' : 'Verificar integridad'}</Boton>
        </div>
        {integridad && (
          <p className={cx('flex items-start gap-2 rounded-[8px] px-4 py-3 text-[15px] font-semibold', integridad.integra ? 'bg-bien/10 text-bien' : 'bg-mal text-superficie')} role="status">
            {integridad.integra ? <IconoEscudo className="mt-0.5 h-5 w-5 shrink-0" /> : <IconoAlerta className="mt-0.5 h-5 w-5 shrink-0" />}
            {integridad.integra
              ? `Bitácora íntegra: los ${num(integridad.registros, 0)} registros están completos y sin alterar.`
              : `Alerta: la cadena se rompe en el registro #${integridad.primer_registro_alterado}. Alguien alteró la base de datos por fuera de Pase.`}
          </p>
        )}
        <Estado cargando={cargando && !datos} error={error} onReintentar={recargar} vacio={!filas.length && 'Sin registros en este período.'}>
          <div className="grid gap-6">
            {grupos.map(([k, rs]) => (
              <section key={k} className="grid gap-1">
                <Ojo>{fecha(Date.parse(rs[0]!.ocurrido_en))}</Ojo>
                <ul className="grid">
                  {rs.map((r) => (
                    <li key={r.id} className="border-b border-linea/70">
                      <button type="button" onClick={() => setAbierto(abierto === r.id ? null : r.id)} aria-expanded={abierto === r.id}
                        className="grid w-full grid-cols-[64px_minmax(0,1fr)] gap-3 py-2.5 text-left hover:bg-hundido/50 sm:grid-cols-[64px_minmax(0,1fr)_220px]">
                        <span className="num font-mono text-[13px] text-tenue">{hora(Date.parse(r.ocurrido_en), true)}</span>
                        <span className="min-w-0">
                          <span className="block text-[15px]"><b className="font-semibold">{r.usuario ?? r.sesion ?? 'Sistema'}</b> {ACCIONES[r.accion] ?? r.accion} · {TABLAS[r.tabla] ?? r.tabla}</span>
                          <span className="block truncate text-[13px] text-tenue">
                            {r.campos?.length ? `Campos: ${r.campos.join(', ')}` : r.registro_id ? `Registro ${r.registro_id.slice(0, 8)}` : ''}
                          </span>
                        </span>
                        <span className="col-start-2 text-[13px] text-tenue sm:col-start-auto sm:text-right">
                          {[r.dispositivo, r.metodo ? METODOS[r.metodo] ?? r.metodo : null].filter(Boolean).join(' · ') || '—'}
                        </span>
                      </button>
                      {abierto === r.id && <Detalle r={r} />}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {!sinMas && todas.length > 0 && <div><Boton onClick={() => void cargarMas()} disabled={masCargando}>{masCargando ? 'Cargando…' : 'Cargar más antiguos'}</Boton></div>}
          </div>
        </Estado>
      </>}
    </main>
  );
}

function Detalle({ r }: { r: RegistroBitacora }) {
  const campos = r.campos?.length ? r.campos : Object.keys({ ...(r.antes ?? {}), ...(r.despues ?? {}) }).filter((k) => !['firma_id', 'actualizado_en'].includes(k));
  return (
    <div className="grid gap-3 bg-hundido/40 px-3 py-3 text-[14px]">
      {campos.length > 0 && (
        <table className="w-full table-fixed border-collapse">
          <thead><tr className="text-left font-mono text-[11px] uppercase tracking-[0.1em] text-tenue"><th className="w-1/4 pb-1">Campo</th><th className="pb-1">Antes</th><th className="pb-1">Después</th></tr></thead>
          <tbody>
            {campos.map((c) => (
              <tr key={c} className="border-t border-linea/60 align-top">
                <td className="py-1 pr-2 font-mono text-[12px]">{c}</td>
                <td className="break-words py-1 pr-2 text-tenue">{texto(r.antes?.[c])}</td>
                <td className="break-words py-1">{texto(r.despues?.[c])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-0.5 font-mono text-[12px] text-tenue">
        <dt>Registro</dt><dd>#{r.id}{r.registro_id ? ` · ${r.registro_id}` : ''}</dd>
        {r.rol && <><dt>Rol</dt><dd>{r.rol}</dd></>}
        {r.ip && <><dt>IP</dt><dd>{r.ip}</dd></>}
        <dt>Huella</dt><dd className="break-all">{r.hash}</dd>
      </dl>
    </div>
  );
}
