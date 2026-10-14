import React from 'react';
import type { EstadoIncidencia, Rol, Severidad } from '../tipos';

export const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

const nf = (min: number, max: number) => new Intl.NumberFormat('es-VE', { minimumFractionDigits: min, maximumFractionDigits: max });
export const num = (v: number, dec = 1) => nf(0, dec).format(v);
export const usd = (v: number, dec = 0) => `USD ${nf(dec, dec).format(v)}`;
export const pct = (v: number, dec = 1) => `${nf(dec, dec).format(v)} %`;
export const hm = (minutos: number) => `${String(Math.floor(minutos / 60) % 24).padStart(2, '0')}:${String(minutos % 60).padStart(2, '0')}`;
export const hora = (t: number, seg = false) =>
  new Date(t).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', ...(seg ? { second: '2-digit' } : {}), hour12: false });
export const fecha = (t: number) =>
  new Date(t).toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long' });
export function hace(t: number, ahora: number) {
  const m = Math.round((ahora - t) / 60_000);
  if (m < 1) return 'ahora';
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h} h ${m % 60 ? `${m % 60} min` : ''}`.trim();
  return `hace ${Math.floor(h / 24)} d`;
}
export const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const ROL: Record<Rol, string> = { operativo: 'Operativo', supervisor: 'Supervisor', admin: 'Gerente' };


/* Etiquetas de día (Day Dots): el color del día de vencimiento, como en las cámaras */
const DIAS = [
  { color: '#1d1d1d', nombre: 'dom' }, { color: '#2463d1', nombre: 'lun' }, { color: '#f2c811', nombre: 'mar' },
  { color: '#d3362a', nombre: 'mié' }, { color: '#7a4a27', nombre: 'jue' }, { color: '#2b9a4b', nombre: 'vie' },
  { color: '#ee7b1b', nombre: 'sáb' },
];
export function PuntoDia({ t, conTexto = true }: { t: number; conTexto?: boolean }) {
  const d = new Date(t);
  const dia = DIAS[d.getDay()]!;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className="h-3.5 w-3.5 shrink-0 rounded-full ring-1 ring-tinta/30" style={{ background: dia.color }} aria-hidden="true" />
      {conTexto && <span className="num">{dia.nombre} {d.getDate()}</span>}
    </span>
  );
}

/* Píldoras de estado */
const SEV: Record<Severidad, { etiqueta: string; cls: string }> = {
  critica: { etiqueta: 'Crítica', cls: 'bg-mal text-superficie' },
  alta: { etiqueta: 'Alta', cls: 'border border-mal/60 text-mal' },
  media: { etiqueta: 'Media', cls: 'border border-aviso/60 text-aviso' },
  baja: { etiqueta: 'Baja', cls: 'border border-linea text-tenue' },
};
export const PildoraSeveridad = ({ s }: { s: Severidad }) => (
  <span className={cx('inline-flex h-6 items-center rounded-[3px] px-2 font-mono text-[11px] font-semibold uppercase tracking-[0.08em]', SEV[s].cls)}>
    {SEV[s].etiqueta}
  </span>
);
const EST: Record<EstadoIncidencia, { etiqueta: string; cls: string }> = {
  abierta: { etiqueta: 'Abierta', cls: 'text-mal' },
  en_proceso: { etiqueta: 'En proceso', cls: 'text-aviso' },
  resuelta: { etiqueta: 'Resuelta', cls: 'text-info' },
  verificada: { etiqueta: 'Verificada', cls: 'text-bien' },
  anulada: { etiqueta: 'Anulada', cls: 'text-tenue' },
};
export const TextoEstado = ({ e }: { e: EstadoIncidencia }) => (
  <span className={cx('inline-flex items-center gap-1.5 text-[14px] font-semibold', EST[e].cls)}>
    <span className="h-2 w-2 rounded-full bg-current" aria-hidden="true" />{EST[e].etiqueta}
  </span>
);

export const Ojo = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <p className={cx('font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-tenue', className)}>{children}</p>
);

/* Botones */
type BotonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variante?: 'primario' | 'secundario' | 'peligro' | 'fantasma'; alto?: 'md' | 'lg' };
export const Boton = React.forwardRef<HTMLButtonElement, BotonProps>(function Boton({ variante = 'secundario', alto = 'md', className, ...p }, ref) {
  return (
    <button ref={ref} type="button" {...p} className={cx(
      'inline-flex items-center justify-center gap-2 rounded-[7px] px-4 font-semibold transition-colors',
      'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mostaza disabled:cursor-not-allowed disabled:opacity-45',
      alto === 'lg' ? 'h-14 text-[17px]' : 'h-11 text-[15px]',
      variante === 'primario' && 'bg-mostaza text-mostaza-tinta shadow-[inset_0_-3px_0_rgb(0_0_0/0.18)] active:translate-y-px',
      variante === 'secundario' && 'tecla text-tinta',
      variante === 'peligro' && 'bg-mal text-superficie shadow-[inset_0_-3px_0_rgb(0_0_0/0.2)] active:translate-y-px',
      variante === 'fantasma' && 'text-tenue hover:bg-hundido hover:text-tinta',
      className,
    )} />
  );
});

/* Íconos */
type I = { className?: string };
const T = ({ className, children }: I & { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">{children}</svg>
);
export const IcoMerma = (p: I) => <T {...p}><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13" /><path d="M10 11v5M14 11v5" /></T>;
export const IcoCaja = (p: I) => <T {...p}><path d="M3.5 8L12 3.5 20.5 8v8L12 20.5 3.5 16z" /><path d="M3.5 8L12 12.5 20.5 8M12 12.5v8" /></T>;
export const IcoLlave = (p: I) => <T {...p}><path d="M14.5 3.5a4.5 4.5 0 00-4.3 5.8L3.5 16v4.5H8v-2h2v-2h2l1.7-1.7A4.5 4.5 0 1014.5 3.5z" /><circle cx="16" cy="8" r="1" fill="currentColor" /></T>;
export const IcoFlecha = (p: I) => <T {...p}><path d="M15 5l-7 7 7 7" /></T>;
export const IcoDerecha = (p: I) => <T {...p}><path d="M9 5l7 7-7 7" /></T>;
export const IcoCamara = (p: I) => <T {...p}><path d="M4 8h3l1.5-2.5h7L17 8h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></T>;
export const IcoTermometro = (p: I) => <T {...p}><path d="M10 14.5V5a2 2 0 014 0v9.5a4 4 0 11-4 0z" /><path d="M12 9v7" /></T>;
export const IcoReloj = (p: I) => <T {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></T>;
export const IcoDescargar = (p: I) => <T {...p}><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14" /></T>;
export const IcoSync = (p: I) => <T {...p}><path d="M19.5 8.5A8 8 0 006 6.3L4.5 8M4.5 15.5A8 8 0 0018 17.7l1.5-1.7" /><path d="M4.5 4v4h4M19.5 20v-4h-4" /></T>;
export const IcoSenal = (p: I) => <T {...p}><path d="M5 12.5a10 10 0 0114 0M2 9a15 15 0 0120 0M8.5 16a5 5 0 017 0" /><circle cx="12" cy="19.5" r=".6" fill="currentColor" /></T>;
export const IcoPersonas = (p: I) => <T {...p}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0113 0M16 4.8a3.5 3.5 0 010 6.4M18 14a6.5 6.5 0 013.5 6" /></T>;
export const IcoCampana = (p: I) => <T {...p}><path d="M6 16.5V11a6 6 0 0112 0v5.5l1.5 2h-15z" /><path d="M10 20.5a2 2 0 004 0" /></T>;
export const IcoPanel = (p: I) => <T {...p}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></T>;
export const IcoLista = (p: I) => <T {...p}><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r="1" fill="currentColor" /><circle cx="4.5" cy="12" r="1" fill="currentColor" /><circle cx="4.5" cy="18" r="1" fill="currentColor" /></T>;
export const IcoTablet = (p: I) => <T {...p}><rect x="4.5" y="3" width="15" height="18" rx="2" /><path d="M10.5 18h3" /></T>;
export const IcoInicio = (p: I) => <T {...p}><path d="M3.5 11L12 4l8.5 7M6 9.5V20h12V9.5" /></T>;
export const IcoMas = (p: I) => <T {...p}><path d="M12 5v14M5 12h14" /></T>;
export const IcoNube = (p: I) => <T {...p}><path d="M7 18.5a4.5 4.5 0 01-.5-9 6 6 0 0111.6 1.6A3.8 3.8 0 0117.5 18.5z" /><path d="M12 11v5M9.8 13.8L12 16l2.2-2.2" /></T>;

/** Espera, error y vacío de una carga */
export function Estado({ cargando, error, vacio, children, onReintentar }: {
  cargando?: boolean; error?: string | null; vacio?: React.ReactNode | false; children?: React.ReactNode; onReintentar?: () => void;
}) {
  if (error) return (
    <div className="flex flex-wrap items-center gap-3 rounded-[8px] border border-mal/40 bg-mal/[0.06] px-4 py-3 text-[15px]">
      <span className="flex-1 text-mal">{error}</span>
      {onReintentar && <Boton onClick={onReintentar}>Reintentar</Boton>}
    </div>
  );
  if (cargando) return <p className="py-6 text-[15px] text-tenue" role="status">Cargando…</p>;
  if (vacio) return <p className="text-[15px] text-tenue">{vacio}</p>;
  return <>{children}</>;
}

export function Titular({ ojo, titulo, children }: { ojo: string; titulo: string; children?: React.ReactNode }) {
  return (
    <section className="grid gap-2">
      <Ojo>{ojo}</Ojo>
      <h1 className="font-display text-[46px] font-black uppercase leading-[0.88] sm:text-[60px]">{titulo}</h1>
      {children && <div className="max-w-[68ch] text-[18px] leading-snug text-tenue">{children}</div>}
    </section>
  );
}

export function Seccion({ titulo, extra, children, className }: { titulo: string; extra?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cx('grid min-w-0 content-start gap-3', className)}>
      <div className="flex items-end justify-between gap-3 border-b border-linea pb-2">
        <h2 className="font-display text-[24px] font-extrabold uppercase leading-none tracking-[0.01em]">{titulo}</h2>
        {extra && <div className="text-[14px] text-tenue">{extra}</div>}
      </div>
      {children}
    </section>
  );
}

export const Campo = ({ etiqueta, children, ayuda }: { etiqueta: string; children: React.ReactNode; ayuda?: React.ReactNode }) => (
  <div className="grid gap-1.5">
    <label className="grid gap-1.5">
      <span className="text-[15px] font-semibold">{etiqueta}</span>
      {children}
    </label>
    {ayuda && <span className="text-[13px] text-tenue">{ayuda}</span>}
  </div>
);
export const claseEntrada = 'h-12 rounded-[8px] border-2 border-linea bg-superficie px-3.5 text-[17px] outline-none focus:border-mostaza disabled:opacity-60';

export const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;
export const corto = (s: string, n = 46) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
export const fechaHora = (iso: string) =>
  new Date(iso).toLocaleString('es-VE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

export const AREAS: Record<string, string> = {
  cocina: 'Cocina', linea: 'Línea', produccion: 'Producción', almacen: 'Almacén', salon: 'Salón', banos: 'Baños',
  caja: 'Caja', drive_thru: 'Drive-thru', delivery: 'Delivery', personal: 'Personal', mantenimiento: 'Mantenimiento',
  seguridad: 'Seguridad', general: 'General', exteriores: 'Exteriores',
};
export const area = (a: string | null | undefined) => (a ? AREAS[a] ?? a : '—');

/** Hora si es hoy; día y hora si no */
export const cuando = (iso: string, ahora = Date.now()) =>
  new Date(iso).toDateString() === new Date(ahora).toDateString() ? hora(Date.parse(iso)) : fechaHora(iso);

export const SoloEnLinea = ({ que }: { que: string }) => (
  <p className="rounded-[8px] border border-aviso/40 bg-aviso/10 px-4 py-3 text-[15px] text-aviso">
    Sin conexión: {que} necesita internet. Vuelve a intentarlo cuando regrese la señal.
  </p>
);

/** Botones de opción en fila (filtros y elecciones cortas) */
export function Opciones<T extends string | number>({ valor, opciones, onCambio, etiqueta }: {
  valor: T; opciones: { id: T; t: string }[]; onCambio: (v: T) => void; etiqueta: string;
}) {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-[8px] bg-hundido p-1" role="radiogroup" aria-label={etiqueta}>
      {opciones.map((o) => (
        <button key={String(o.id)} type="button" role="radio" aria-checked={valor === o.id} onClick={() => onCambio(o.id)}
          className={cx('h-9 rounded-[6px] px-3 text-[14px] font-semibold', valor === o.id ? 'bg-superficie text-tinta shadow-[0_1px_2px_rgb(0_0_0/0.15)]' : 'text-tenue hover:text-tinta')}>{o.t}</button>
      ))}
    </div>
  );
}
