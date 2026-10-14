import { useState } from 'react';
import { rpc } from '../api';
import { mensajeDe, useApp, useCarga } from '../contexto';
import type { Equipo, TipoEquipo } from '../tipos';
import type { CambioCampo } from '../ui/PinConfirmModal';
import { Boton, Estado, IcoTablet, Opciones, Seccion, SoloEnLinea, Titular, claseEntrada, cuando, cx, hace, plural } from '../ui/comun';

const TIPO: Record<TipoEquipo, string> = { tablet_cocina: 'Tablet de cocina', tablet_caja: 'Tablet de caja o salón', pc_gerencia: 'PC de gerencia', telefono: 'Teléfono' };

export function Equipos() {
  const { enLinea, firmar, avisar, ahora } = useApp();
  const { datos, error, cargando, recargar } = useCarga(() => rpc<Equipo[]>('pase_dispositivos'), [], enLinea);
  const [ver, setVer] = useState<'activos' | 'todos'>('activos');
  const [renombrando, setRenombrando] = useState<string | null>(null);
  const [nombre, setNombre] = useState('');
  const [trabajando, setTrabajando] = useState(false);
  const lista = (datos ?? []).filter((d) => ver === 'todos' || d.activo);
  const activos = (datos ?? []).filter((d) => d.activo).length;

  const cambiar = async (d: Equipo, cambios: Record<string, unknown>, filas: CambioCampo[], titulo: string, exito: string, advertencia?: string) => {
    const f = await firmar({ titulo, accion: 'modificar', entidad: 'dispositivos', entidadId: d.id, referencia: d.nombre, cambios: filas, advertencia, requiereConexion: true });
    if (!f) return;
    setTrabajando(true);
    try {
      await rpc('modificar_dispositivo', { p_id: d.id, p_cambios: cambios, p_firma: f.firmaId });
      avisar(exito, 'bien');
      setRenombrando(null);
      await recargar();
    } catch (e) {
      avisar(`No se pudo guardar: ${mensajeDe(e)}`, 'mal');
    } finally {
      setTrabajando(false);
    }
  };

  return (
    <main className="mx-auto grid max-w-[1280px] gap-6 px-4 py-7 sm:px-6">
      <Titular ojo="Gerencia" titulo="Equipos">
        {datos ? `${plural(activos, 'equipo registrado', 'equipos registrados')}. Solo estos pueden abrir Pase.` : 'Las tablets y computadoras que pueden abrir Pase.'}
      </Titular>
      {!enLinea ? <SoloEnLinea que="administrar los equipos" /> : <>
        <div className="flex flex-wrap items-center gap-3">
          <Opciones etiqueta="Mostrar" valor={ver} onCambio={setVer} opciones={[{ id: 'activos', t: 'Activos' }, { id: 'todos', t: 'Todos' }]} />
        </div>
        <Estado cargando={cargando && !datos} error={error} onReintentar={recargar} vacio={!lista.length && 'No hay equipos.'}>
          <ul className="grid gap-2 lg:grid-cols-2">
            {lista.map((d) => (
              <li key={d.id} className={cx('grid gap-3 rounded-[8px] border bg-superficie p-4', d.este ? 'border-mostaza' : 'border-linea', !d.activo && 'opacity-60')}>
                <div className="flex items-start gap-3">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[6px] bg-tinta text-fondo"><IcoTablet className="h-6 w-6" /></span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[17px] font-semibold leading-tight">{d.nombre}{d.este ? <span className="ml-2 rounded-[3px] bg-mostaza px-1.5 py-0.5 align-middle font-mono text-[11px] font-bold uppercase text-mostaza-tinta">Este equipo</span> : ''}</p>
                    <p className="text-[14px] text-tenue">{TIPO[d.tipo] ?? d.tipo} · registrado {cuando(d.registrado_en, ahora)}{d.registrado_por_nombre ? ` por ${d.registrado_por_nombre}` : ''}</p>
                    <p className="text-[14px] text-tenue">{d.ultimo_uso ? `Usado ${hace(Date.parse(d.ultimo_uso), ahora)}` : 'Sin uso todavía'}</p>
                    {!d.activo && <p className="text-[14px] font-semibold text-mal">Dado de baja</p>}
                    {d.bloqueado_hasta && <p className="text-[14px] font-semibold text-mal">Bloqueado por PIN equivocados hasta {cuando(d.bloqueado_hasta, ahora)}</p>}
                  </div>
                </div>
                {renombrando === d.id ? (
                  <form className="flex flex-wrap gap-2 border-t border-linea pt-3" onSubmit={(e) => {
                    e.preventDefault();
                    if (nombre.trim().length >= 3 && nombre.trim() !== d.nombre) {
                      void cambiar(d, { nombre: nombre.trim() }, [{ campo: 'Nombre', antes: d.nombre, despues: nombre.trim() }], 'Renombrar equipo', 'Nombre cambiado.');
                    }
                  }}>
                    <input value={nombre} onChange={(e) => setNombre(e.target.value)} minLength={3} maxLength={60} required autoFocus
                      className={cx(claseEntrada, 'h-11 min-w-0 flex-1')} aria-label="Nombre del equipo" />
                    <Boton type="submit" variante="primario" disabled={trabajando}>Firmar</Boton>
                    <Boton variante="fantasma" onClick={() => setRenombrando(null)}>Cancelar</Boton>
                  </form>
                ) : (
                  <div className="flex flex-wrap gap-2 border-t border-linea pt-3">
                    <Boton onClick={() => { setRenombrando(d.id); setNombre(d.nombre); }} disabled={trabajando}>Renombrar</Boton>
                    {d.bloqueado_hasta && <Boton variante="primario" disabled={trabajando}
                      onClick={() => void cambiar(d, { desbloquear: true }, [{ campo: 'Bloqueo', antes: `Hasta ${cuando(d.bloqueado_hasta!, ahora)}`, despues: 'Desbloqueado' }], 'Desbloquear equipo', 'Equipo desbloqueado.')}>Desbloquear</Boton>}
                    {!d.este && (d.activo
                      ? <Boton variante="fantasma" className="ml-auto" disabled={trabajando}
                          onClick={() => void cambiar(d, { activo: false }, [{ campo: 'Estado', antes: 'Activo', despues: 'Dado de baja', falla: true }], 'Dar de baja el equipo', 'Equipo dado de baja.',
                            'Ese equipo deja de abrir Pase de inmediato. Lo que tenga firmado sin enviar ya no se podrá sincronizar.')}>Dar de baja</Boton>
                      : <Boton variante="fantasma" className="ml-auto" disabled={trabajando}
                          onClick={() => void cambiar(d, { activo: true }, [{ campo: 'Estado', antes: 'Dado de baja', despues: 'Activo' }], 'Reactivar equipo', 'Equipo reactivado.')}>Reactivar</Boton>)}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Estado>
        <Seccion titulo="Registrar otro equipo">
          <ol className="grid max-w-[70ch] list-decimal gap-1.5 pl-5 text-[16px] leading-snug">
            <li>En la tablet o computadora nueva, abre el link de Pase.</li>
            <li>Toca «Soy la gerente: empezar» y entra con tu correo, tu contraseña y el código de tu app autenticadora.</li>
            <li>Ponle un nombre (p. ej. «Tablet línea caliente») y firma con tu PIN.</li>
          </ol>
          <p className="text-[14px] text-tenue">Si una tablet se pierde o se daña, dala de baja aquí: deja de abrir Pase al instante.</p>
        </Seccion>
      </>}
    </main>
  );
}
