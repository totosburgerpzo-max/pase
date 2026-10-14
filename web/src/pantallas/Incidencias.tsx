import { useEffect, useState } from 'react';
import { ErrorApi, rpc, storage } from '../api';
import { borrar } from '../local';
import { encolar } from '../cola';
import { evidenciaDe, leerFoto, rutaDe } from '../fotos';
import { mensajeDe, useApp, useCarga, type Firma } from '../contexto';
import type { AccionFirma, Incidencia, Persona, Severidad } from '../tipos';
import { IconoAlerta, type CambioCampo } from '../ui/PinConfirmModal';
import {
  AREAS, Boton, Campo, Estado, IcoCamara, IcoFlecha, Opciones, PildoraSeveridad, SoloEnLinea, TextoEstado, Titular,
  area, claseEntrada, corto, cuando, cx, hace, plural,
} from '../ui/comun';
import { Foto } from './Planilla';

const SEVERIDADES: { id: Severidad; t: string; d: string }[] = [
  { id: 'critica', t: 'Crítica', d: 'Riesgo para la salud o la seguridad. Hay que parar ya.' },
  { id: 'alta', t: 'Alta', d: 'Afecta el servicio de hoy.' },
  { id: 'media', t: 'Media', d: 'Hay que arreglarla, pero se puede seguir trabajando.' },
  { id: 'baja', t: 'Baja', d: 'Un detalle o una mejora.' },
];
const nombreSev = (s: Severidad) => SEVERIDADES.find((x) => x.id === s)!.t;

/* ---------- Foto guardada en el servidor (se descarga solo si se pide) ---------- */
export function VerFoto({ ruta, etiqueta = 'Ver foto' }: { ruta: string; etiqueta?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [estado, setEstado] = useState<'nada' | 'cargando' | 'error'>('nada');
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const cargar = async () => {
    setEstado('cargando');
    try {
      const b = await storage.ver(ruta);
      setUrl(URL.createObjectURL(b));
      setEstado('nada');
    } catch {
      setEstado('error');
    }
  };
  if (url) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="block w-fit">
        <img src={url} alt="Foto de evidencia" className="max-h-72 w-auto rounded-[6px] border border-linea" />
      </a>
    );
  }
  return (
    <button type="button" onClick={() => void cargar()} disabled={estado === 'cargando'}
      className={cx('tecla flex h-10 w-fit items-center gap-2 rounded-[6px] px-3 text-[14px] font-semibold', estado === 'error' && 'text-mal')}>
      <IcoCamara className="h-5 w-5" />
      {estado === 'cargando' ? 'Cargando foto…' : estado === 'error' ? 'No se pudo cargar · reintentar' : etiqueta}
    </button>
  );
}

/* ===================================================================== */
/* Reportar una falla                                                       */
/* ===================================================================== */
export function Falla() {
  const { usuario, equipo, volver, ir, firmar, recibo, avisar, refrescarCola, enLinea, redCaida, puede, ahora } = useApp();
  const [id] = useState(() => crypto.randomUUID());
  const [titulo, setTitulo] = useState('');
  const [desc, setDesc] = useState('');
  const [ar, setAr] = useState('');
  const [sev, setSev] = useState<Severidad | null>(null);
  const [bloquea, setBloquea] = useState(false);
  const [foto, setFoto] = useState<string | undefined>();
  const [errores, setErrores] = useState(false);
  const [enviando, setEnviando] = useState(false);

  const faltan = [
    titulo.trim().length < 5 && 'qué pasó', !ar && 'el área', !sev && 'la gravedad', sev === 'critica' && !foto && 'la foto',
  ].filter((x): x is string => !!x);
  const marca = () => [`Falla · ${new Date().toLocaleString('es-VE', { hour12: false })}`, `${equipo.nombre} · ${usuario.nombreCompleto}`];

  const salir = async () => {
    if (foto) await borrar('fotos', foto);
    volver();
  };

  const enviar = async () => {
    if (enviando) return;
    if (faltan.length || !sev) { setErrores(true); return; }
    const cambios: CambioCampo[] = [
      { campo: 'Qué pasó', despues: titulo.trim() },
      { campo: 'Área', despues: area(ar) },
      { campo: 'Gravedad', despues: nombreSev(sev), falla: sev === 'critica' },
      ...(desc.trim() ? [{ campo: 'Detalle', despues: desc.trim() }] : []),
      { campo: 'Dejar de usar el equipo', despues: bloquea ? 'Sí' : 'No', falla: bloquea },
      { campo: 'Foto', despues: foto ? 'Adjunta' : 'Sin foto' },
    ];
    const f = await firmar({
      titulo: 'Reportar una falla', accion: 'crear', entidad: 'incidencias', entidadId: id, referencia: area(ar), cambios,
      advertencia: sev === 'critica' ? 'Es crítica: el supervisor de turno recibe el aviso de inmediato.' : undefined,
    });
    if (!f) return;
    setEnviando(true);
    const ft = foto ? await leerFoto(foto) : null;
    const evidencia = ft ? evidenciaDe(ft, usuario.sucursal) : null;
    const incidencia = { id, titulo: titulo.trim(), descripcion: desc.trim() || null, area: ar, severidad: sev, bloquea };
    const lineas: [string, string][] = [['Área', area(ar)], ['Gravedad', nombreSev(sev)], ['Foto', ft ? 'Sí' : 'No']];
    const tituloRecibo = `Falla: ${corto(titulo.trim(), 60)}`;

    const aLaCola = async (firma: Firma) => {
      await encolar({
        id, tipo: 'incidencia', titulo: tituloRecibo, usuario_id: usuario.id, usuario_nombre: usuario.nombreCompleto,
        firmada_en: firma.firmadoEn, incidencia: { incidencia, evidencia }, fotos: ft ? [ft.id] : [],
      });
      await refrescarCola();
      await recibo({
        titulo: tituloRecibo, lineas, firma: { ...firma, sinConexion: true },
        aviso: { tono: 'aviso', texto: 'Guardada en la tablet; se envía sola al volver la conexión. Avisa al supervisor en persona.' },
      });
      ir({ id: 'inicio' });
    };

    try {
      if (f.sinConexion) { await aLaCola(f); return; }
      if (ft) await storage.subir(rutaDe(ft, usuario.sucursal), ft.blob);
      const r = await rpc<{ ok: boolean; vence_en: string | null }>('reportar_incidencia',
        { p_incidencia: incidencia, p_evidencia: evidencia, p_firma: f.firmaId });
      if (ft) await borrar('fotos', ft.id);
      await recibo({
        titulo: tituloRecibo,
        lineas: [...lineas, ...(r.vence_en ? [['Resolver antes de', cuando(r.vence_en, ahora)] as [string, string]] : [])],
        firma: f,
        aviso: sev === 'critica' || bloquea
          ? { tono: 'mal', texto: 'El supervisor ya tiene el aviso. No uses el equipo hasta que lo revise.' }
          : { tono: 'bien', texto: 'Reportada. El supervisor ya la ve en su lista.' },
      });
      ir({ id: puede('incidencias.gestionar') ? 'incidencias' : 'inicio' });
    } catch (e) {
      if (e instanceof ErrorApi && e.red) {
        redCaida();
        await aLaCola({ ...f, sinConexion: true });
        return;
      }
      avisar(`No se pudo reportar: ${mensajeDe(e)}`, 'mal');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <main className="mx-auto grid max-w-[860px] gap-6 px-4 pb-16 pt-5 sm:px-6">
      <div><Boton variante="fantasma" onClick={() => void salir()}><IcoFlecha className="h-5 w-5" />Volver</Boton></div>
      <Titular ojo="Incidencia" titulo="Reportar una falla">
        Un equipo dañado, algo sucio, plagas, un riesgo para alguien. Firmas con tu PIN y el supervisor recibe el aviso.
        {!enLinea && ' Sin conexión: queda guardada en la tablet y se envía sola al volver la señal.'}
      </Titular>

      <form className="grid gap-6" onSubmit={(e) => { e.preventDefault(); void enviar(); }}>
        <Campo etiqueta="¿Qué pasó?" ayuda="En pocas palabras, p. ej. «La cava 2 marca 9 °C» o «Fuga de agua en el baño de damas».">
          <input value={titulo} onChange={(e) => setTitulo(e.target.value)} maxLength={180} autoComplete="off"
            className={cx(claseEntrada, errores && titulo.trim().length < 5 && 'border-mal')} />
        </Campo>

        <div className="grid gap-2">
          <span className="text-[15px] font-semibold">Área</span>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Área">
            {Object.entries(AREAS).map(([k, v]) => (
              <button key={k} type="button" role="radio" aria-checked={ar === k} onClick={() => setAr(k)}
                className={cx('h-11 rounded-[8px] border-2 px-3.5 text-[15px] font-semibold',
                  ar === k ? 'border-mostaza bg-mostaza/15' : errores && !ar ? 'border-mal/60 bg-superficie' : 'border-linea bg-superficie hover:border-tenue')}>{v}</button>
            ))}
          </div>
        </div>

        <div className="grid gap-2">
          <span className="text-[15px] font-semibold">¿Qué tan grave es?</span>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Gravedad">
            {SEVERIDADES.map((s) => (
              <button key={s.id} type="button" role="radio" aria-checked={sev === s.id} onClick={() => setSev(s.id)}
                className={cx('grid justify-items-start gap-1.5 rounded-[8px] border-2 px-4 py-3 text-left',
                  sev === s.id ? (s.id === 'critica' ? 'border-mal bg-mal/10' : 'border-mostaza bg-mostaza/15')
                    : errores && !sev ? 'border-mal/60 bg-superficie' : 'border-linea bg-superficie hover:border-tenue')}>
                <PildoraSeveridad s={s.id} />
                <span className="text-[15px] leading-snug">{s.d}</span>
              </button>
            ))}
          </div>
        </div>

        <label className="flex cursor-pointer items-start gap-3 rounded-[8px] border border-linea bg-superficie p-4">
          <input type="checkbox" checked={bloquea} onChange={(e) => setBloquea(e.target.checked)} className="mt-1 h-5 w-5 accent-[#b3261e]" />
          <span><span className="block text-[16px] font-semibold">Hay que dejar de usar el equipo o el área</span>
            <span className="block text-[14px] text-tenue">Queda marcado «No operar» hasta que el supervisor lo libere.</span></span>
        </label>

        <Campo etiqueta="Detalle (opcional)">
          <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3}
            className="rounded-[8px] border-2 border-linea bg-superficie p-3 text-[17px] outline-none focus:border-mostaza" />
        </Campo>

        <div className="grid gap-2">
          <span className="text-[15px] font-semibold">Foto{sev === 'critica' ? ' (obligatoria si es crítica)' : ' (recomendada)'}</span>
          <Foto id={`falla-${id}`} valor={foto} onCambio={setFoto} obligatoria={sev === 'critica'} error={errores} marca={marca} />
        </div>

        {errores && faltan.length > 0 && (
          <p className="flex gap-2 text-[15px] font-semibold text-mal" role="alert">
            <IconoAlerta className="mt-0.5 h-5 w-5 shrink-0" />Falta {faltan.join(', ').replace(/, ([^,]*)$/, ' y $1')}.
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <Boton type="submit" variante="primario" alto="lg" className="min-w-[240px]" disabled={enviando}>{enviando ? 'Enviando…' : 'Firmar y reportar'}</Boton>
          <Boton alto="lg" variante="fantasma" onClick={() => void salir()}>Cancelar</Boton>
        </div>
      </form>
    </main>
  );
}

/* ===================================================================== */
/* Lista de incidencias (supervisores y gerente)                            */
/* ===================================================================== */
export function Incidencias() {
  const { ir, enLinea } = useApp();
  const [activas, setActivas] = useState(true);
  const [sev, setSev] = useState<Severidad | 'todas'>('todas');
  const { datos, error, cargando, recargar } = useCarga(
    () => rpc<Incidencia[]>('pase_incidencias', { p_activas: activas, p_limite: 200 }), [activas], enLinea);
  const lista = (datos ?? []).filter((i) => sev === 'todas' || i.severidad === sev);
  const criticas = (datos ?? []).filter((i) => i.severidad === 'critica' && ['abierta', 'en_proceso'].includes(i.estado)).length;
  const porVerificar = (datos ?? []).filter((i) => i.estado === 'resuelta').length;

  return (
    <main className="mx-auto grid max-w-[1280px] gap-6 px-4 py-7 sm:px-6">
      <Titular ojo="Calidad · seguimiento" titulo="Incidencias">
        {datos && activas
          ? <>{plural(datos.length, 'activa', 'activas')}{criticas ? <>, <b className="font-semibold text-mal">{plural(criticas, 'crítica', 'críticas')}</b></> : ''}{porVerificar ? `; ${porVerificar} por verificar` : ''}.</>
          : 'Lo reportado a mano y lo que abrieron las planillas.'}
      </Titular>
      <div className="flex flex-wrap items-center gap-3">
        <Opciones etiqueta="Mostrar" valor={activas ? 'a' : 't'} onCambio={(v) => setActivas(v === 'a')}
          opciones={[{ id: 'a', t: 'Activas' }, { id: 't', t: 'Todas' }]} />
        <Opciones etiqueta="Gravedad" valor={sev} onCambio={setSev}
          opciones={[{ id: 'todas', t: 'Todas' }, ...SEVERIDADES.map((s) => ({ id: s.id, t: s.t }))]} />
        <Boton variante="primario" className="ml-auto" onClick={() => ir({ id: 'falla' })}>Reportar una falla</Boton>
      </div>
      {!enLinea ? <SoloEnLinea que="ver y gestionar incidencias" /> : (
        <Estado cargando={cargando && !datos} error={error} onReintentar={recargar}
          vacio={!lista.length && (activas ? 'No hay incidencias activas.' : 'No hay incidencias con ese filtro.')}>
          <div className="grid items-start gap-3 lg:grid-cols-2">
            {lista.map((i) => <TarjetaIncidencia key={i.id} i={i} alCambiar={recargar} />)}
          </div>
        </Estado>
      )}
    </main>
  );
}

/* ===================================================================== */
/* Una incidencia, con sus pasos: atender → resolver → verificar           */
/* ===================================================================== */
type Paso = null | 'atender' | 'resolver' | 'anular';

export function TarjetaIncidencia({ i, alCambiar }: { i: Incidencia; alCambiar: () => void }) {
  const { usuario, puede, enLinea, ahora, firmar, avisar, refrescarAlertas } = useApp();
  const [paso, setPaso] = useState<Paso>(null);
  const [accion, setAccion] = useState(i.accion_correctiva ?? '');
  const [causa, setCausa] = useState(i.causa_raiz ?? '');
  const [motivo, setMotivo] = useState('');
  const [responsable, setResponsable] = useState(i.asignada_a ?? usuario.id);
  const [trabajando, setTrabajando] = useState(false);
  const personal = useCarga(() => rpc<Persona[]>('pase_personal'), [], paso === 'atender');

  const pendiente = i.estado === 'abierta' || i.estado === 'en_proceso';
  const vence = i.vence_en ? Date.parse(i.vence_en) : null;
  const tarde = pendiente && vence !== null && vence < ahora;
  const gestiona = puede('incidencias.gestionar') && enLinea;
  const puedeVerificar = i.estado === 'resuelta' && i.resuelta_por !== usuario.id && (i.severidad !== 'critica' || puede('incidencias.verificar'));
  const puedeAnular = usuario.rol === 'admin' && (pendiente || i.estado === 'resuelta');

  const cambiar = async (cambios: Record<string, unknown>, accionFirma: AccionFirma, titulo: string, filas: CambioCampo[], exito: string) => {
    const f = await firmar({ titulo, accion: accionFirma, entidad: 'incidencias', entidadId: i.id, referencia: corto(i.titulo, 60), cambios: filas, requiereConexion: true });
    if (!f) return;
    setTrabajando(true);
    try {
      await rpc('actualizar_incidencia', { p_id: i.id, p_cambios: cambios, p_firma: f.firmaId });
      avisar(exito, 'bien');
      setPaso(null);
      alCambiar();
      void refrescarAlertas();
    } catch (e) {
      avisar(`No se pudo guardar: ${mensajeDe(e)}`, 'mal');
    } finally {
      setTrabajando(false);
    }
  };

  const nombreDe = (id: string) => {
    if (id === usuario.id) return usuario.nombreCompleto;
    const p = personal.datos?.find((x) => x.id === id);
    return p ? `${p.nombre} ${p.apellido}` : '—';
  };
  const atender = () => cambiar({ estado: 'en_proceso', asignada_a: responsable }, 'modificar', 'Atender incidencia',
    [{ campo: 'Estado', antes: 'Abierta', despues: 'En proceso' }, { campo: 'Responsable', antes: i.asignada_a_nombre, despues: nombreDe(responsable) }],
    'Incidencia en proceso.');
  const resolver = () => cambiar({ estado: 'resuelta', accion_correctiva: accion.trim(), causa_raiz: causa.trim() }, 'modificar', 'Resolver incidencia',
    [{ campo: 'Estado', antes: i.estado === 'abierta' ? 'Abierta' : 'En proceso', despues: 'Resuelta' }, { campo: 'Acción correctiva', antes: i.accion_correctiva, despues: accion.trim() },
      ...(causa.trim() ? [{ campo: 'Causa raíz', antes: i.causa_raiz, despues: causa.trim() }] : [])],
    i.severidad === 'critica' ? 'Resuelta. La gerente debe verificarla.' : 'Resuelta. Otra persona debe verificarla.');
  const verificar = () => cambiar({ estado: 'verificada' }, 'aprobar', 'Verificar incidencia',
    [{ campo: 'Estado', antes: 'Resuelta', despues: 'Verificada' }, { campo: 'Acción correctiva', despues: i.accion_correctiva }],
    'Incidencia verificada y cerrada.');
  const anular = () => cambiar({ estado: 'anulada', causa_raiz: `Anulada: ${motivo.trim()}` }, 'anular', 'Anular incidencia',
    [{ campo: 'Estado', antes: i.estado, despues: 'Anulada', falla: true }, { campo: 'Motivo', despues: motivo.trim() }],
    'Incidencia anulada.');

  return (
    <article className={cx('grid min-w-0 gap-3 rounded-[8px] border bg-superficie p-4',
      i.severidad === 'critica' && pendiente ? 'border-mal/70 shadow-[inset_4px_0_0_#b3261e]' : 'border-linea')}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <PildoraSeveridad s={i.severidad} />
        <TextoEstado e={i.estado} />
        {i.bloquea && pendiente && <span className="rounded-[3px] bg-mal px-2 py-0.5 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-superficie">No operar</span>}
        {i.escalada && pendiente && <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-mal">Escalada</span>}
        <span className="ml-auto font-mono text-[12px] uppercase tracking-[0.1em] text-tenue">{area(i.area)}</span>
      </div>
      <h3 className="text-[18px] font-semibold leading-snug">{i.titulo}</h3>
      {i.descripcion && <p className="-mt-1 text-[15px] leading-snug text-tenue">{i.descripcion}</p>}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[14px]">
        <dt className="text-tenue">Origen</dt>
        <dd>{i.codigo_plantilla ? `Planilla ${i.codigo_plantilla}${i.ref_item ? ` · punto ${i.ref_item}` : ''}` : 'Reporte manual'}
          {' · '}{i.reportada_por_nombre ?? 'sistema'} · {hace(Date.parse(i.reportada_en), ahora)}</dd>
        {pendiente && vence !== null && <>
          <dt className="text-tenue">Plazo</dt>
          <dd className={cx(tarde && 'font-semibold text-mal')}>{tarde ? `Venció ${hace(vence, ahora)}` : `Hasta ${cuando(i.vence_en!, ahora)}`}</dd>
        </>}
        {i.asignada_a_nombre && <><dt className="text-tenue">Responsable</dt><dd>{i.asignada_a_nombre}</dd></>}
        {i.accion_correctiva && <><dt className="text-tenue">Acción</dt><dd>{i.accion_correctiva}</dd></>}
        {i.causa_raiz && <><dt className="text-tenue">Causa</dt><dd>{i.causa_raiz}</dd></>}
        {i.resuelta_por_nombre && i.resuelta_en && <><dt className="text-tenue">Resolvió</dt><dd>{i.resuelta_por_nombre} · {cuando(i.resuelta_en, ahora)}</dd></>}
        {i.verificada_por_nombre && i.verificada_en && <><dt className="text-tenue">Verificó</dt><dd>{i.verificada_por_nombre} · {cuando(i.verificada_en, ahora)}</dd></>}
      </dl>
      {i.evidencia && (enLinea ? <VerFoto ruta={i.evidencia.ruta} /> : <p className="text-[14px] text-tenue">Tiene foto (se ve con conexión).</p>)}

      {gestiona && paso === null && (pendiente || i.estado === 'resuelta') && (
        <div className="flex flex-wrap gap-2 border-t border-linea pt-3">
          {i.estado === 'abierta' && <Boton onClick={() => setPaso('atender')} disabled={trabajando}>Atender</Boton>}
          {pendiente && <Boton variante="primario" onClick={() => setPaso('resolver')} disabled={trabajando}>Resolver</Boton>}
          {puedeVerificar && <Boton variante="primario" onClick={() => void verificar()} disabled={trabajando}>{trabajando ? 'Guardando…' : 'Verificar y cerrar'}</Boton>}
          {i.estado === 'resuelta' && !puedeVerificar && (
            <p className="self-center text-[14px] text-tenue">{i.resuelta_por === usuario.id ? 'La resolviste tú: la verifica otra persona.' : 'Las críticas las verifica la gerente.'}</p>
          )}
          {puedeAnular && <Boton variante="fantasma" className="ml-auto" onClick={() => setPaso('anular')} disabled={trabajando}>Anular</Boton>}
        </div>
      )}

      {paso === 'atender' && (
        <form className="grid gap-3 border-t border-linea pt-3" onSubmit={(e) => { e.preventDefault(); void atender(); }}>
          <Campo etiqueta="Responsable">
            <select value={responsable} onChange={(e) => setResponsable(e.target.value)} className={claseEntrada}>
              <option value={usuario.id}>Yo ({usuario.nombreCompleto})</option>
              {(personal.datos ?? []).filter((p) => p.activo && p.id !== usuario.id).map((p) => (
                <option key={p.id} value={p.id}>{p.nombre} {p.apellido}{p.cargo ? ` · ${p.cargo}` : ''}</option>
              ))}
            </select>
          </Campo>
          <div className="flex gap-2">
            <Boton type="submit" variante="primario" disabled={trabajando}>{trabajando ? 'Guardando…' : 'Firmar'}</Boton>
            <Boton variante="fantasma" onClick={() => setPaso(null)}>Cancelar</Boton>
          </div>
        </form>
      )}

      {paso === 'resolver' && (
        <form className="grid gap-3 border-t border-linea pt-3" onSubmit={(e) => { e.preventDefault(); if (accion.trim().length >= 5) void resolver(); }}>
          <Campo etiqueta="¿Qué se hizo? (acción correctiva)">
            <textarea value={accion} onChange={(e) => setAccion(e.target.value)} rows={2} required minLength={5}
              className="rounded-[8px] border-2 border-linea bg-superficie p-3 text-[16px] outline-none focus:border-mostaza" />
          </Campo>
          <Campo etiqueta="¿Por qué pasó? (causa raíz, opcional)">
            <textarea value={causa} onChange={(e) => setCausa(e.target.value)} rows={2}
              className="rounded-[8px] border-2 border-linea bg-superficie p-3 text-[16px] outline-none focus:border-mostaza" />
          </Campo>
          <div className="flex gap-2">
            <Boton type="submit" variante="primario" disabled={trabajando || accion.trim().length < 5}>{trabajando ? 'Guardando…' : 'Firmar como resuelta'}</Boton>
            <Boton variante="fantasma" onClick={() => setPaso(null)}>Cancelar</Boton>
          </div>
        </form>
      )}

      {paso === 'anular' && (
        <form className="grid gap-3 border-t border-linea pt-3" onSubmit={(e) => { e.preventDefault(); if (motivo.trim().length >= 5) void anular(); }}>
          <Campo etiqueta="Motivo de la anulación" ayuda="Queda en la bitácora. Úsalo solo para reportes duplicados o equivocados.">
            <input value={motivo} onChange={(e) => setMotivo(e.target.value)} required minLength={5} className={claseEntrada} />
          </Campo>
          <div className="flex gap-2">
            <Boton type="submit" variante="peligro" disabled={trabajando || motivo.trim().length < 5}>{trabajando ? 'Guardando…' : 'Firmar y anular'}</Boton>
            <Boton variante="fantasma" onClick={() => setPaso(null)}>Cancelar</Boton>
          </div>
        </form>
      )}
    </article>
  );
}
