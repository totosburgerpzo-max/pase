import { useCallback, useEffect, useState } from 'react';
import { rpc } from '../api';
import type { EquipoLocal } from '../local';
import { mensajeDe } from '../contexto';
import type { Contexto, Hoy } from '../tipos';
import { PuntosPin, TecladoPin, IconoSinSenal, IconoAlerta } from '../ui/PinConfirmModal';
import { Boton, IcoSenal, IcoNube, cx, fecha, hora } from '../ui/comun';

export const Marca = ({ chica }: { chica?: boolean }) => (
  <span className="flex items-center gap-2" aria-label="Pase">
    <span className={cx('grid place-items-center rounded-[5px] bg-mostaza font-display font-black text-mostaza-tinta', chica ? 'h-8 w-8 text-[20px]' : 'h-10 w-10 text-[26px]')} aria-hidden="true">P</span>
    <span className={cx('font-display font-black uppercase tracking-[0.06em]', chica ? 'text-[24px]' : 'text-[30px]')} aria-hidden="true">Pase</span>
  </span>
);

const turnoDe = (t: number) => {
  const h = new Date(t).getHours();
  return h < 11 ? 'Antes de abrir' : h < 18 ? 'Turno mediodía · 11:00 a 18:00' : 'Turno noche · 18:00 a 00:00';
};

const TIPO: Record<string, string> = { tablet_cocina: 'Tablet de cocina', tablet_caja: 'Tablet de caja', telefono: 'Teléfono', pc_gerencia: 'PC de gerencia' };

/* ===================================================================== */
export function Bloqueo({ equipo, enLinea, porEnviar, hoy, onPin }: {
  equipo: EquipoLocal; enLinea: boolean; porEnviar: number; hoy: Hoy | null;
  onPin: (pin: string) => Promise<{ mensaje: string; hasta?: number } | null>;
}) {
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setAhora(Date.now()), 5000); return () => window.clearInterval(t); }, []);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [hasta, setHasta] = useState<number | null>(null);
  const [sacudida, setSacudida] = useState(0);
  const [verificando, setVerificando] = useState(false);
  const bloqueada = hasta && hasta > ahora ? hasta : null;

  const entrar = useCallback(async (valor: string) => {
    if (valor.length < 4 || verificando || bloqueada) return;
    setVerificando(true);
    try {
      const r = await onPin(valor);
      if (r) {
        setPin('');
        setSacudida((s) => s + 1);
        setError(r.mensaje);
        if (r.hasta) setHasta(r.hasta);
      }
    } catch (e) {
      setPin('');
      setError(mensajeDe(e));
    } finally {
      setVerificando(false);
    }
  }, [verificando, bloqueada, onPin]);

  const teclear = (d: string) => { if (pin.length < 6 && !verificando) { setPin(pin + d); setError(null); } };
  const borrar = () => setPin((p) => p.slice(0, -1));
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^\d$/.test(e.key)) { e.preventDefault(); setPin((p) => (p.length < 6 ? p + e.key : p)); setError(null); }
      else if (e.key === 'Backspace') { e.preventDefault(); setPin((p) => p.slice(0, -1)); }
      else if (e.key === 'Enter') { e.preventDefault(); void entrar(pin); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [entrar, pin]);

  const d = new Date(ahora);
  const pendientes = (hoy?.programadas ?? []).filter((p) => !p.ejecucion_id && Date.parse(p.desde) - 3600_000 <= ahora)
    .sort((a, b) => a.vence_en.localeCompare(b.vence_en));
  const vencidas = pendientes.filter((p) => Date.parse(p.vence_en) < ahora).length;
  const esHoy = hoy && hoy.fecha === new Date(ahora - 4 * 3600_000).toISOString().slice(0, 10);

  return (
    <main className="acero grid flex-1 md:grid-cols-[minmax(0,1fr)_460px]">
      <section className="flex flex-col justify-between gap-10 px-6 py-8 sm:px-10 sm:py-12">
        <div className="flex items-center gap-3">
          <Marca />
          <span className="h-6 w-px bg-linea" aria-hidden="true" />
          <p className="text-[15px] leading-tight text-tenue">Totos Burger<br />Alta Vista</p>
        </div>
        <div>
          <p className="num font-display text-[min(30vw,184px)] font-black leading-[0.8] tracking-[-0.01em]">
            {String(d.getHours()).padStart(2, '0')}<span className="text-mostaza">:</span>{String(d.getMinutes()).padStart(2, '0')}
          </p>
          <p className="mt-4 text-[22px] font-medium first-letter:uppercase">{fecha(ahora)}</p>
          <p className="text-[17px] text-tenue">{turnoDe(ahora)}</p>
        </div>
        <dl className="grid max-w-[560px] grid-cols-2 gap-x-6 gap-y-3 border-t border-linea pt-5 text-[15px]">
          <div><dt className="font-mono text-[11px] uppercase tracking-[0.14em] text-tenue">Equipo</dt><dd className="font-semibold">{equipo.nombre}<span className="block text-[13px] font-normal text-tenue">{TIPO[equipo.tipo] ?? equipo.tipo}</span></dd></div>
          <div><dt className="font-mono text-[11px] uppercase tracking-[0.14em] text-tenue">Conexión</dt>
            <dd className={cx('flex items-center gap-1.5 font-semibold', !enLinea && 'text-aviso')}>
              {enLinea ? <IcoSenal className="h-4 w-4" /> : <IconoSinSenal className="h-4 w-4" />}{enLinea ? 'En línea' : 'Sin conexión'}
            </dd>
            {porEnviar > 0 && <dd className="flex items-center gap-1.5 text-[13px] text-tenue"><IcoNube className="h-4 w-4" />{porEnviar} por enviar</dd>}
          </div>
          {esHoy && (
            <div className="col-span-2"><dt className="font-mono text-[11px] uppercase tracking-[0.14em] text-tenue">En el riel</dt>
              <dd className="font-semibold">
                {pendientes.length ? `${pendientes.length} planillas abiertas` : 'Nada pendiente por ahora'}
                {vencidas ? <span className="text-mal"> · {vencidas} vencidas</span> : pendientes[0] ? `; la próxima vence a las ${hora(Date.parse(pendientes[0].vence_en))}` : ''}
              </dd></div>
          )}
        </dl>
      </section>

      <section className="flex flex-col justify-center border-t border-linea bg-superficie px-6 py-8 sm:px-10 md:border-l md:border-t-0">
        <div className="mx-auto w-full max-w-[360px]">
          <h1 className="font-display text-[42px] font-black uppercase leading-[0.9]">Teclea tu PIN</h1>
          <p className="mt-2 text-[16px] text-tenue">Tu PIN te identifica: no hace falta buscar tu nombre. Al terminar, toca el candado y la tablet queda lista para el siguiente.</p>
          <div key={sacudida} className={cx('mt-6 rounded-[8px] border border-linea bg-fondo px-4 py-6', sacudida > 0 && 'motion-safe:animate-pin-sacudir')}>
            <PuntosPin largo={pin.length} total={Math.min(6, Math.max(4, pin.length))} error={!!error} />
          </div>
          <p aria-live="assertive" className={cx('mt-3 min-h-[44px] text-[14px] leading-snug', error || bloqueada ? 'text-mal' : 'text-tenue')}>
            {bloqueada ? `Tablet bloqueada hasta las ${hora(bloqueada)} por intentos fallidos.` : verificando ? 'Verificando…' : error ?? 'De 4 a 6 dígitos. Nadie más debe verlo.'}
          </p>
          <TecladoPin onDigito={teclear} onBorrar={borrar} onConfirmar={() => void entrar(pin)}
            puedeConfirmar={pin.length >= 4} deshabilitado={verificando || !!bloqueada} etiquetaConfirmar="Entrar" />
          <p className="mt-6 text-[13px] leading-relaxed text-tenue">
            Tras unos segundos sin uso la tablet vuelve a esta pantalla. Diez PIN equivocados seguidos bloquean la tablet y avisan al supervisor.
          </p>
        </div>
      </section>
    </main>
  );
}

/* ===================================================================== */
/* Primer ingreso: el PIN provisional se cambia por uno que solo conoce la persona */
export function CambioPin({ contexto, pinProvisional, onListo, onCancelar }: {
  contexto: Contexto; pinProvisional: string; onListo: (pin: string, ctx: Contexto) => Promise<void>; onCancelar: () => void;
}) {
  const [nuevo, setNuevo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trabajando, setTrabajando] = useState(false);
  const [confirma, setConfirma] = useState('');
  const [sacudida, setSacudida] = useState(0);
  const generar = async () => {
    setTrabajando(true);
    setError(null);
    try {
      const r = await rpc<{ ok: boolean; pin?: string; motivo?: string }>('regenerar_mi_pin', { p_pin_actual: pinProvisional });
      if (!r.ok || !r.pin) throw new Error('No se pudo generar el PIN. Vuelve a entrar con el provisional.');
      setNuevo(r.pin);
    } catch (e) {
      setError(mensajeDe(e));
    } finally {
      setTrabajando(false);
    }
  };
  const confirmar = async (valor: string) => {
    if (!nuevo) return;
    if (valor !== nuevo) { setConfirma(''); setSacudida((s) => s + 1); setError('No coincide. Míralo otra vez y escríbelo.'); return; }
    setTrabajando(true);
    await onListo(nuevo, { ...contexto, pin: { longitud: nuevo.length, debe_cambiar: false } });
  };
  const nombre = contexto.usuario.nombre;
  return (
    <main className="acero grid flex-1 place-items-center px-4 py-10">
      <div className="w-full max-w-[520px] rounded-[10px] border border-linea bg-superficie p-6 shadow-[0_20px_50px_-30px_rgb(0_0_0/0.5)] sm:p-8">
        <Marca chica />
        {!nuevo ? (
          <>
            <h1 className="mt-6 font-display text-[40px] font-black uppercase leading-[0.9]">Hola, {nombre}</h1>
            <p className="mt-3 text-[17px] leading-snug text-tenue">
              Entraste con un PIN provisional. Ahora vas a recibir tu PIN personal: solo lo verás tú, en esta pantalla, una vez.
              Con él entras y firmas todo lo que hagas.
            </p>
            {error && <p className="mt-4 flex gap-2 text-[15px] font-semibold text-mal"><IconoAlerta className="mt-0.5 h-5 w-5 shrink-0" />{error}</p>}
            <div className="mt-6 flex flex-wrap gap-3">
              <Boton variante="primario" alto="lg" onClick={generar} disabled={trabajando}>{trabajando ? 'Generando…' : 'Ver mi PIN personal'}</Boton>
              <Boton variante="fantasma" alto="lg" onClick={onCancelar}>Ahora no</Boton>
            </div>
          </>
        ) : (
          <>
            <h1 className="mt-6 font-display text-[36px] font-black uppercase leading-[0.9]">Tu PIN personal</h1>
            <p className="num mt-4 rounded-[8px] bg-tinta py-5 text-center font-display text-[64px] font-black tracking-[0.3em] text-mostaza">{nuevo}</p>
            <p className="mt-4 text-[16px] leading-snug text-tenue">
              Apréndetelo. No lo anotes donde otros lo vean y no se lo digas a nadie: lo que se firme con él queda a tu nombre.
              Para seguir, escríbelo abajo.
            </p>
            <div key={sacudida} className={cx('mt-5 rounded-[8px] border border-linea bg-fondo px-4 py-5', sacudida > 0 && 'motion-safe:animate-pin-sacudir')}>
              <PuntosPin largo={confirma.length} total={nuevo.length} error={!!error} />
            </div>
            <p aria-live="assertive" className={cx('mt-2 min-h-[22px] text-[14px]', error ? 'text-mal' : 'text-tenue')}>{error ?? 'Escríbelo de memoria'}</p>
            <div className="mt-2">
              <TecladoPin
                onDigito={(d) => { if (confirma.length < nuevo.length) { const v = confirma + d; setConfirma(v); setError(null); if (v.length === nuevo.length) void confirmar(v); } }}
                onBorrar={() => setConfirma((c) => c.slice(0, -1))} onConfirmar={() => void confirmar(confirma)}
                puedeConfirmar={confirma.length === nuevo.length} deshabilitado={trabajando} etiquetaConfirmar="Listo" />
            </div>
          </>
        )}
      </div>
    </main>
  );
}

/* ===================================================================== */
export function EquipoDadoDeBaja({ onRegistrar }: { onRegistrar: () => void }) {
  const [seguro, setSeguro] = useState(false);
  return (
    <main className="acero grid flex-1 place-items-center px-4 py-10">
      <div className="w-full max-w-[520px] rounded-[10px] border border-linea bg-superficie p-6 sm:p-8">
        <Marca chica />
        <h1 className="mt-6 font-display text-[38px] font-black uppercase leading-[0.9]">Este equipo ya no está habilitado</h1>
        <p className="mt-3 text-[17px] leading-snug text-tenue">
          La gerencia lo dio de baja, o el servidor no lo reconoce. Para volver a usarlo, la gerente debe registrarlo de nuevo con su correo y su código de verificación.
        </p>
        {!seguro ? (
          <Boton variante="primario" alto="lg" className="mt-6" onClick={() => setSeguro(true)}>Registrar de nuevo</Boton>
        ) : (
          <div className="mt-6 grid gap-3 rounded-[8px] border border-aviso/40 bg-aviso/10 p-4">
            <p className="text-[15px]">Se borran de esta tablet los datos guardados del equipo y los PIN recordados. Lo que esté por enviar se conserva.</p>
            <div className="flex gap-2">
              <Boton variante="peligro" onClick={onRegistrar}>Borrar y registrar</Boton>
              <Boton variante="fantasma" onClick={() => setSeguro(false)}>Cancelar</Boton>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
