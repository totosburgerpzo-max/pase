import { useState } from 'react';
import { descartar } from '../cola';
import { useApp } from '../contexto';
import { IconoAlerta } from '../ui/PinConfirmModal';
import { Boton, IcoNube, IcoSync, Titular, cx, fechaHora, hace, plural } from '../ui/comun';

/* Lo firmado sin internet que espera para enviarse */
export function Cola() {
  const { cola, sincronizarAhora, refrescarCola, usuario, ahora, avisar } = useApp();
  const [enviando, setEnviando] = useState(false);
  const [confirmar, setConfirmar] = useState<string | null>(null);
  const pendientes = cola.filter((c) => c.estado === 'pendiente');
  const rechazados = cola.filter((c) => c.estado === 'rechazado');
  const supervisa = usuario.nivel >= 20;

  const enviar = async () => {
    setEnviando(true);
    try { await sincronizarAhora(); } finally { setEnviando(false); }
  };
  const quitar = async (id: string) => {
    await descartar(id);
    setConfirmar(null);
    await refrescarCola();
    avisar('Quitado de la tablet.', 'info');
  };

  return (
    <main className="mx-auto grid max-w-[980px] gap-6 px-4 py-7 sm:px-6">
      <Titular ojo="Sin conexión" titulo="Por enviar">
        {!cola.length ? 'Todo lo firmado en esta tablet ya llegó al servidor.'
          : <>Hay {plural(pendientes.length, 'registro firmado', 'registros firmados')} esperando la conexión{rechazados.length ? <> y <b className="font-semibold text-mal">{plural(rechazados.length, 'rechazado', 'rechazados')}</b></> : ''}. {pendientes.length === 1 ? 'Se envía solo' : 'Se envían solos'} cuando vuelve la señal.</>}
      </Titular>

      {pendientes.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <Boton variante="primario" onClick={() => void enviar()} disabled={enviando}>
            <IcoSync className={cx('h-5 w-5', enviando && 'animate-spin')} />{enviando ? 'Enviando…' : 'Enviar ahora'}
          </Boton>
          <span className="text-[14px] text-tenue">{!navigator.onLine ? 'Sin conexión: se intentará al volver la señal.' : 'Lo firmado se envía uno por uno, con la hora real de la firma.'}</span>
        </div>
      )}

      {rechazados.length > 0 && (
        <section className="grid gap-2">
          <p className="flex gap-2 rounded-[8px] bg-mal/10 px-4 py-3 text-[15px] font-semibold text-mal">
            <IconoAlerta className="mt-0.5 h-5 w-5 shrink-0" />
            El servidor no aceptó {rechazados.length === 1 ? 'este registro' : 'estos registros'}. Anótalo en papel y avísale al supervisor{supervisa ? '; después puedes quitarlo de la tablet' : ''}.
          </p>
        </section>
      )}

      <ul className="grid gap-2">
        {cola.map((c) => (
          <li key={c.id} className={cx('grid gap-2 rounded-[8px] border bg-superficie p-4', c.estado === 'rechazado' ? 'border-mal/60' : 'border-linea')}>
            <div className="flex flex-wrap items-start gap-3">
              <IcoNube className={cx('mt-0.5 h-6 w-6 shrink-0', c.estado === 'rechazado' ? 'text-mal' : 'text-tenue')} />
              <div className="min-w-0 flex-1">
                <p className="text-[16px] font-semibold leading-snug">{c.titulo}</p>
                <p className="text-[14px] text-tenue">{c.tipo === 'planilla' ? 'Planilla' : 'Falla'} · firmó {c.usuario_nombre} · {fechaHora(c.firmada_en)} ({hace(Date.parse(c.firmada_en), ahora)})
                  {c.fotos.length ? ` · ${plural(c.fotos.length, 'foto', 'fotos')}` : ''}</p>
                {c.estado === 'rechazado'
                  ? <p className="text-[14px] font-semibold text-mal">Rechazado: {c.motivo ?? 'sin motivo'}</p>
                  : c.intentos > 0 && <p className="text-[13px] text-tenue">{plural(c.intentos, 'intento', 'intentos')}{c.ultimo_intento ? `, el último ${hace(Date.parse(c.ultimo_intento), ahora)}` : ''}</p>}
              </div>
              {c.estado === 'rechazado' && supervisa && (confirmar === c.id
                ? <span className="flex gap-2"><Boton variante="peligro" onClick={() => void quitar(c.id)}>Sí, quitar</Boton><Boton variante="fantasma" onClick={() => setConfirmar(null)}>No</Boton></span>
                : <Boton variante="fantasma" onClick={() => setConfirmar(c.id)}>Quitar de la tablet</Boton>)}
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
