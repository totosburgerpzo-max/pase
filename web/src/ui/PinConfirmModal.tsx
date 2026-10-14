/**
 * Confirmación de cambios con PIN único de usuario · Pase (Totos Burger)
 *
 * Modal que firma una acción (crear, modificar, anular, aprobar, rechazar) con el PIN
 * personal de quien la hace. No guarda ni compara el PIN: lo entrega a `verificarPin`,
 * que en producción llama a la función `public.firmar()` de Supabase y devuelve una firma
 * de un solo uso válida por 120 s. Con esa firma la app hace el cambio; el trigger
 * `app.exigir_firma` la consume y la bitácora registra usuario, tabla, valores y equipo.
 *
 * Modos:
 *  - "propio": firma quien tiene la sesión (se conoce su nombre y el largo de su PIN).
 *  - "autorizacion": un supervisor o gerente teclea su PIN en la tablet de otro; el PIN
 *    lo identifica y la firma queda a su nombre (método pin_autorizacion).
 *
 * Requiere React 18 y Tailwind con los tokens de tailwind.config.cjs.
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { AccionFirma, Rol } from '../tipos';

export type { AccionFirma, Rol };

export interface CambioCampo {
  campo: string;
  /** Valor anterior; omítalo al crear. */
  antes?: string | null;
  despues: string | null;
  /** Marca la fila en rojo (p. ej., una respuesta "No cumple"). */
  falla?: boolean;
}

export interface Firmante {
  nombre: string;
  rol: Rol;
  iniciales?: string;
}

export interface FirmaValida {
  ok: true;
  firmaId: string;
  firmante: Firmante;
  /** ISO 8601 */
  firmadoEn: string;
  sinConexion?: boolean;
}

export type ResultadoFirma =
  | FirmaValida
  | { ok: false; motivo: 'pin_incorrecto'; intentosRestantes: number }
  | { ok: false; motivo: 'pin_bloqueado'; bloqueadoHasta: string }
  | { ok: false; motivo: 'dispositivo_bloqueado'; bloqueadoHasta: string }
  | { ok: false; motivo: 'sin_permiso'; mensaje?: string }
  | { ok: false; motivo: 'requiere_conexion' }
  | { ok: false; motivo: 'error'; mensaje: string };

export interface PinConfirmModalProps {
  abierto: boolean;
  modo?: 'propio' | 'autorizacion';
  /** Lo que se firma, en palabras del usuario: "Enviar planilla 14B". */
  titulo: string;
  accion: AccionFirma;
  /** Tabla afectada, tal como queda en la bitácora. */
  tabla: string;
  referencia?: string;
  cambios: CambioCampo[];
  /** Consecuencia que conviene ver antes de firmar. */
  advertencia?: string;
  /** Quién firma en modo "propio". */
  firmante?: Firmante;
  /** En modo "autorizacion": rol mínimo que puede autorizar. */
  rolRequerido?: Exclude<Rol, 'operativo'>;
  /** Si se conoce, la firma se envía sola al completar los dígitos. */
  longitudPin?: number;
  sinConexion?: boolean;
  dispositivo: string;
  verificarPin: (pin: string) => Promise<ResultadoFirma>;
  onFirmado: (firma: FirmaValida) => void;
  onCancelar: () => void;
}

const ROL: Record<Rol, string> = { operativo: 'Operativo', supervisor: 'Supervisor', admin: 'Gerente' };
const ACCION: Record<AccionFirma, string> = {
  crear: 'Crear', modificar: 'Modificar', anular: 'Anular', aprobar: 'Aprobar', rechazar: 'Rechazar',
};

type Estado =
  | { fase: 'escribiendo' }
  | { fase: 'verificando' }
  | { fase: 'error'; mensaje: string }
  | { fase: 'bloqueado'; hasta: number; mensaje: string }
  | { fase: 'firmado'; firma: FirmaValida };

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

export const iniciales = (nombre: string) =>
  nombre.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');

const hora = (d: Date) =>
  d.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

function cuentaRegresiva(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* ---------- Íconos (trazo, 24×24) ---------- */
type IconoProps = { className?: string };
const Trazo = ({ className, children }: IconoProps & { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"
    strokeLinejoin="round" className={className} aria-hidden="true">{children}</svg>
);
export const IconoCheck = (p: IconoProps) => <Trazo {...p}><path d="M4.5 12.5l5 5 10-11" /></Trazo>;
export const IconoBorrar = (p: IconoProps) => (
  <Trazo {...p}><path d="M9 5h11v14H9l-6-7z" /><path d="M12.5 9.5l5 5M17.5 9.5l-5 5" /></Trazo>
);
export const IconoCandado = (p: IconoProps) => (
  <Trazo {...p}><rect x="4.5" y="10.5" width="15" height="10" rx="1.5" /><path d="M8 10.5V7a4 4 0 018 0v3.5" /></Trazo>
);
export const IconoEscudo = (p: IconoProps) => (
  <Trazo {...p}><path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z" /><path d="M8.5 12l2.5 2.5 4.5-5" /></Trazo>
);
export const IconoSinSenal = (p: IconoProps) => (
  <Trazo {...p}><path d="M3 3l18 18" /><path d="M8.5 16.5a5 5 0 017 0M5 13a10 10 0 015.5-2.8M19 13a10 10 0 00-3-2.1M2 9.5a15 15 0 014.2-2.6M22 9.5A15 15 0 0011 6" /><circle cx="12" cy="20" r=".6" fill="currentColor" /></Trazo>
);
export const IconoAlerta = (p: IconoProps) => (
  <Trazo {...p}><path d="M12 3.5l9.5 16.5h-19z" /><path d="M12 10v4.5" /><circle cx="12" cy="17.3" r=".6" fill="currentColor" /></Trazo>
);

/* ---------- Puntos y teclado (también los usa la pantalla de bloqueo) ---------- */
export function PuntosPin({ largo, total, error }: { largo: number; total: number; error?: boolean }) {
  return (
    <div className="flex justify-center gap-3" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={cx(
          'h-[15px] w-[15px] rounded-full border-2 transition-colors duration-100',
          i < largo ? (error ? 'border-mal bg-mal' : 'border-tinta bg-tinta') : error ? 'border-mal/70' : 'border-tenue/45',
        )} />
      ))}
    </div>
  );
}

export interface TecladoPinProps {
  onDigito: (d: string) => void;
  onBorrar: () => void;
  onConfirmar: () => void;
  puedeConfirmar: boolean;
  deshabilitado?: boolean;
  etiquetaConfirmar?: string;
  compacto?: boolean;
}

export function TecladoPin({
  onDigito, onBorrar, onConfirmar, puedeConfirmar, deshabilitado, etiquetaConfirmar = 'Firmar', compacto,
}: TecladoPinProps) {
  const alto = compacto ? 'h-14' : 'h-14 sm:h-16';
  const digito = (d: string) => (
    <button key={d} type="button" disabled={deshabilitado} onClick={() => onDigito(d)}
      className={cx('tecla num rounded-[7px] font-display text-[32px] font-bold leading-none', alto,
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mostaza disabled:opacity-40')}>
      {d}
    </button>
  );
  return (
    <div className="grid grid-cols-3 gap-2" role="group" aria-label="Teclado numérico">
      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(digito)}
      <button type="button" disabled={deshabilitado} onClick={onBorrar} aria-label="Borrar último dígito"
        className={cx('tecla grid place-items-center rounded-[7px] text-tenue', alto,
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mostaza disabled:opacity-40')}>
        <IconoBorrar className="h-7 w-7" />
      </button>
      {digito('0')}
      <button type="button" disabled={deshabilitado || !puedeConfirmar} onClick={onConfirmar}
        className={cx('flex items-center justify-center gap-1.5 rounded-[7px] font-semibold uppercase tracking-[0.06em] text-[15px]', alto,
          'bg-mostaza text-mostaza-tinta shadow-[inset_0_-3px_0_rgb(0_0_0/0.18)] active:translate-y-[2px] active:shadow-[inset_0_-1px_0_rgb(0_0_0/0.18)]',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tinta',
          'disabled:bg-hundido disabled:text-tenue disabled:shadow-none')}>
        <IconoCheck className="h-5 w-5" />{etiquetaConfirmar}
      </button>
    </div>
  );
}

/* ---------- Modal ---------- */
export function PinConfirmModal(props: PinConfirmModalProps) {
  const {
    abierto, modo = 'propio', titulo, accion, tabla, referencia, cambios, advertencia, firmante,
    rolRequerido = 'supervisor', longitudPin, sinConexion, dispositivo, verificarPin, onFirmado, onCancelar,
  } = props;

  const [pin, setPin] = useState('');
  const [estado, setEstado] = useState<Estado>({ fase: 'escribiendo' });
  const [sacudida, setSacudida] = useState(0);
  const [ahora, setAhora] = useState(() => Date.now());
  const [verDetalle, setVerDetalle] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const focoPrevio = useRef<HTMLElement | null>(null);
  const idTitulo = useId();
  const idDesc = useId();

  const largoMin = longitudPin ?? 4;
  const largoMax = longitudPin ?? 6;
  const casillas = longitudPin ?? Math.min(6, Math.max(4, pin.length));
  const ocupado = estado.fase === 'verificando' || estado.fase === 'bloqueado' || estado.fase === 'firmado';

  useEffect(() => {
    if (!abierto) return;
    focoPrevio.current = document.activeElement as HTMLElement | null;
    setPin('');
    setEstado({ fase: 'escribiendo' });
    const id = requestAnimationFrame(() => panel.current?.focus());
    return () => {
      cancelAnimationFrame(id);
      focoPrevio.current?.focus?.();
    };
  }, [abierto]);

  useEffect(() => {
    if (estado.fase !== 'bloqueado') return;
    const t = window.setInterval(() => {
      const n = Date.now();
      setAhora(n);
      if (n >= estado.hasta) setEstado({ fase: 'escribiendo' });
    }, 1000);
    return () => window.clearInterval(t);
  }, [estado]);

  const enviar = useCallback(async (valor: string) => {
    if (valor.length < largoMin || ocupado) return;
    setEstado({ fase: 'verificando' });
    let r: ResultadoFirma;
    try {
      r = await verificarPin(valor);
    } catch {
      r = { ok: false, motivo: 'error', mensaje: 'No pudimos verificar el PIN. Revisa la conexión e inténtalo otra vez.' };
    }
    if (r.ok) {
      setEstado({ fase: 'firmado', firma: r });
      window.setTimeout(() => onFirmado(r as FirmaValida), 1100);
      return;
    }
    setPin('');
    setSacudida((s) => s + 1);
    setAhora(Date.now());
    switch (r.motivo) {
      case 'pin_incorrecto':
        setEstado({ fase: 'error', mensaje: r.intentosRestantes > 0
          ? `PIN incorrecto. Te ${r.intentosRestantes === 1 ? 'queda 1 intento' : `quedan ${r.intentosRestantes} intentos`} antes del bloqueo.`
          : 'PIN incorrecto.' });
        break;
      case 'pin_bloqueado':
        setEstado({ fase: 'bloqueado', hasta: Date.parse(r.bloqueadoHasta),
          mensaje: 'Demasiados intentos. El PIN quedó bloqueado y avisamos al supervisor.' });
        break;
      case 'dispositivo_bloqueado':
        setEstado({ fase: 'bloqueado', hasta: Date.parse(r.bloqueadoHasta),
          mensaje: 'Esta tablet quedó bloqueada por intentos fallidos.' });
        break;
      case 'sin_permiso':
        setEstado({ fase: 'error', mensaje: r.mensaje ?? 'Ese PIN no tiene permiso para esta acción.' });
        break;
      case 'requiere_conexion':
        setEstado({ fase: 'error', mensaje: 'Esta firma necesita internet. Inténtalo cuando vuelva la conexión.' });
        break;
      default:
        setEstado({ fase: 'error', mensaje: r.mensaje });
    }
  }, [largoMin, ocupado, verificarPin, onFirmado]);

  const teclear = (d: string) => {
    if (ocupado || pin.length >= largoMax) return;
    if (estado.fase === 'error') setEstado({ fase: 'escribiendo' });
    const nuevo = pin + d;
    setPin(nuevo);
    // Se envía sola al llegar al largo conocido, o a 6 dígitos (el máximo) si no se conoce.
    if (nuevo.length === largoMax) void enviar(nuevo);
  };
  const borrar = () => { if (!ocupado) setPin((p) => p.slice(0, -1)); };

  // El teclado físico funciona aunque el foco aún no esté dentro del panel.
  const alTeclado = useRef<(e: KeyboardEvent) => void>(() => {});
  alTeclado.current = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^\d$/.test(e.key)) { e.preventDefault(); teclear(e.key); return; }
    if (e.key === 'Backspace') { e.preventDefault(); borrar(); return; }
    if (e.key === 'Enter' && (e.target as HTMLElement | null)?.tagName !== 'BUTTON') { e.preventDefault(); void enviar(pin); return; }
    if (e.key === 'Escape' && estado.fase !== 'verificando' && estado.fase !== 'firmado') { e.preventDefault(); onCancelar(); return; }
    if (e.key === 'Tab' && panel.current) {
      const focos = panel.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input, [tabindex]:not([tabindex="-1"])');
      if (!focos.length) return;
      const primero = focos[0]!, ultimo = focos[focos.length - 1]!;
      const dentro = panel.current.contains(document.activeElement);
      if (e.shiftKey && (!dentro || document.activeElement === primero || document.activeElement === panel.current)) { e.preventDefault(); ultimo.focus(); }
      else if (!e.shiftKey && (!dentro || document.activeElement === ultimo)) { e.preventDefault(); primero.focus(); }
    }
  };
  useEffect(() => {
    if (!abierto) return;
    const f = (e: KeyboardEvent) => alTeclado.current(e);
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [abierto]);

  if (!abierto) return null;

  const quien = modo === 'propio' && firmante ? firmante : null;
  const mostrarAntes = cambios.some((c) => c.antes !== undefined);
  const mensaje =
    estado.fase === 'error' || estado.fase === 'bloqueado' ? estado.mensaje
    : estado.fase === 'verificando' ? 'Verificando…'
    : sinConexion ? 'Sin conexión: el PIN se verifica en esta tablet y la firma se envía al volver la señal.'
    : null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[rgb(8_10_12/0.6)] backdrop-blur-[2px] sm:items-center sm:p-6"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !ocupado) onCancelar(); }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={idTitulo} aria-describedby={idDesc}
        tabIndex={-1}
        className="grid max-h-[100dvh] w-full animate-subir overflow-y-auto rounded-t-[14px] bg-superficie text-tinta shadow-[0_30px_70px_-25px_rgb(0_0_0/0.55)] outline-none sm:max-w-[900px] sm:rounded-[10px] md:grid-cols-[minmax(0,1fr)_340px]">

        {/* Lo que se firma */}
        <section className="min-w-0 border-b border-linea p-4 sm:p-7 md:border-b-0 md:border-r">
          <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em]">
            <span className="rounded-[3px] bg-tinta px-2 py-1 font-semibold text-fondo">{ACCION[accion]}</span>
            <span className="text-tenue">tabla · {tabla}</span>
          </div>
          <h2 id={idTitulo} className="mt-3 font-display text-[34px] font-extrabold uppercase leading-[0.95] tracking-[0.005em] sm:text-[40px]">
            {titulo}
          </h2>
          {referencia && <p className="mt-1.5 text-[17px] text-tenue">{referencia}</p>}

          {cambios.length > 0 && (
            <button type="button" onClick={() => setVerDetalle((v) => !v)} aria-expanded={verDetalle}
              className="mt-3 text-[15px] font-semibold underline underline-offset-4 md:hidden">
              {verDetalle ? 'Ocultar los valores' : `Ver ${cambios.length === 1 ? 'el valor' : `los ${cambios.length} valores`} que firmas`}
            </button>
          )}
          {cambios.length > 0 && (
            <div className={cx('mt-4 overflow-x-auto md:mt-5 md:block', !verDetalle && 'hidden')}>
              <table className="w-full border-collapse text-left text-[15px]">
                <thead>
                  <tr className="border-b border-linea font-mono text-[11px] uppercase tracking-[0.12em] text-tenue">
                    <th scope="col" className="py-2 pr-3 font-medium">Campo</th>
                    {mostrarAntes && <th scope="col" className="py-2 pr-3 font-medium">Antes</th>}
                    <th scope="col" className="py-2 font-medium">{mostrarAntes ? 'Ahora' : 'Valor'}</th>
                  </tr>
                </thead>
                <tbody>
                  {cambios.map((c, i) => (
                    <tr key={i} className="border-b border-linea/70 align-top last:border-b-0">
                      <td className="py-2 pr-3 text-tenue">{c.campo}</td>
                      {mostrarAntes && <td className="num py-2 pr-3 text-tenue line-through decoration-tenue/50">{c.antes ?? '—'}</td>}
                      <td className={cx('num py-2 font-semibold', c.falla && 'text-mal')}>{c.despues ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {advertencia && (
            <div className="mt-5 flex gap-3 rounded-[6px] border border-mal/35 bg-mal/[0.08] px-3.5 py-3 text-[15px] leading-snug">
              <IconoAlerta className="mt-px h-5 w-5 shrink-0 text-mal" />
              <p>{advertencia}</p>
            </div>
          )}

          <p id={idDesc} className="mt-4 text-[13px] leading-relaxed text-tenue md:mt-5">
            La firma queda en la bitácora con tu nombre, la fecha y hora exactas y el equipo ({dispositivo}).
            {sinConexion ? ' Sin internet, la firma se guarda en este equipo y se envía al volver la señal.' : ' Sirve una sola vez y vence a los 2 minutos.'}
          </p>
        </section>

        {/* PIN */}
        <section className="flex flex-col gap-3 bg-hundido/55 p-4 sm:gap-4 sm:p-6">
          {estado.fase === 'firmado' ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-8 text-center" role="status">
              <span className="grid h-16 w-16 place-items-center rounded-full bg-bien text-superficie">
                <IconoCheck className="h-9 w-9" />
              </span>
              <p className="font-display text-[34px] font-extrabold uppercase leading-none">Firmado</p>
              <p className="text-[17px]">
                {estado.firma.firmante.nombre}
                <span className="text-tenue"> · {ROL[estado.firma.firmante.rol]}</span>
              </p>
              <p className="font-mono text-[12px] uppercase tracking-[0.1em] text-tenue">
                {hora(new Date(estado.firma.firmadoEn))} · firma {estado.firma.firmaId.slice(0, 8)}
                {estado.firma.sinConexion ? ' · sin conexión' : ''}
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3">
                {quien ? (
                  <span className="grid h-12 w-12 shrink-0 place-items-center rounded-[6px] bg-tinta font-display text-[22px] font-bold text-fondo">
                    {quien.iniciales ?? iniciales(quien.nombre)}
                  </span>
                ) : (
                  <span className="grid h-12 w-12 shrink-0 place-items-center rounded-[6px] bg-mostaza text-mostaza-tinta">
                    <IconoEscudo className="h-7 w-7" />
                  </span>
                )}
                <div className="min-w-0">
                  <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-tenue">
                    {quien ? 'Firma' : 'Autoriza'}
                  </p>
                  <p className="truncate text-[19px] font-semibold leading-tight">
                    {quien ? quien.nombre : `Un ${ROL[rolRequerido].toLowerCase()}`}
                  </p>
                  <p className="text-[14px] text-tenue">
                    {quien
                      ? `${ROL[quien.rol]} · teclea tu PIN${longitudPin ? ` de ${longitudPin} dígitos` : ''}`
                      : 'Teclea tu PIN; la firma queda a tu nombre.'}
                  </p>
                </div>
              </div>

              <div key={sacudida} className={cx('rounded-[8px] border border-linea bg-superficie px-4 py-4 sm:py-5', sacudida > 0 && 'motion-safe:animate-pin-sacudir')}>
                <PuntosPin largo={pin.length} total={casillas} error={estado.fase === 'error' || estado.fase === 'bloqueado'} />
                <p className="sr-only" aria-live="polite">{pin.length} dígitos escritos</p>
              </div>

              <div aria-live="assertive" className="min-h-[24px] sm:min-h-[44px]">
                {mensaje && (
                  <p className={cx('flex items-start gap-2 text-[14px] leading-snug',
                    estado.fase === 'error' || estado.fase === 'bloqueado' ? 'text-mal' : sinConexion ? 'text-aviso' : 'text-tenue')}>
                    {estado.fase === 'bloqueado' ? <IconoCandado className="mt-px h-4 w-4 shrink-0" />
                      : sinConexion && estado.fase !== 'error' ? <IconoSinSenal className="mt-px h-4 w-4 shrink-0" /> : null}
                    <span>
                      {mensaje}
                      {estado.fase === 'bloqueado' && (
                        <span className="num mt-0.5 block font-mono text-[13px]">Se libera en {cuentaRegresiva(estado.hasta - ahora)}</span>
                      )}
                    </span>
                  </p>
                )}
              </div>

              <TecladoPin onDigito={teclear} onBorrar={borrar} onConfirmar={() => void enviar(pin)}
                puedeConfirmar={pin.length >= largoMin} deshabilitado={ocupado} />

              <button type="button" onClick={onCancelar} disabled={estado.fase === 'verificando'}
                className="mx-auto rounded-[6px] px-4 py-2 text-[15px] font-medium text-tenue underline-offset-4 hover:text-tinta hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-mostaza disabled:opacity-40">
                Cancelar sin firmar
              </button>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

export default PinConfirmModal;
