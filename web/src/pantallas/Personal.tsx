import { useState } from 'react';
import { funcion, rpc } from '../api';
import { mensajeDe, useApp, useCarga } from '../contexto';
import type { Persona, Rol } from '../tipos';
import { IconoAlerta, type CambioCampo } from '../ui/PinConfirmModal';
import {
  Boton, Campo, Estado, IcoMas, Opciones, ROL, SoloEnLinea, Titular, claseEntrada, cuando, cx, hace, plural,
} from '../ui/comun';

const TURNOS: Record<string, string> = { mediodia: 'Mediodía', noche: 'Noche', polivalente: 'Polivalente', gerencia: 'Gerencia' };
const ROLES: Rol[] = ['operativo', 'supervisor', 'admin'];

interface Ficha { nombre: string; apellido: string; cedula: string; cargo: string; rol: Rol; turno: string; longitud: number }
const vacia: Ficha = { nombre: '', apellido: '', cedula: '', cargo: '', rol: 'operativo', turno: 'mediodia', longitud: 4 };

/* ===================================================================== */
export function Personal() {
  const { usuario, puede, enLinea, firmar, avisar, ahora } = useApp();
  const gestiona = puede('usuarios.gestionar');
  const { datos, error, cargando, recargar } = useCarga(() => rpc<Persona[]>('pase_personal'), [], enLinea);
  const [ver, setVer] = useState<'activos' | 'todos'>('activos');
  const [alta, setAlta] = useState(false);
  const [editando, setEditando] = useState<string | null>(null);
  const [pinNuevo, setPinNuevo] = useState<{ nombre: string; pin: string } | null>(null);
  const lista = (datos ?? []).filter((p) => ver === 'todos' || p.activo);
  const activos = (datos ?? []).filter((p) => p.activo).length;

  const darDeAlta = async (f: Ficha) => {
    const id = crypto.randomUUID();
    const rolAlto = f.rol !== 'operativo';
    const firma = await firmar({
      titulo: 'Agregar persona', accion: 'crear', entidad: 'usuarios', entidadId: id, referencia: `${f.nombre} ${f.apellido}`,
      cambios: [
        { campo: 'Nombre', despues: `${f.nombre.trim()} ${f.apellido.trim()}` }, { campo: 'Cédula', despues: f.cedula.trim() || '—' },
        { campo: 'Cargo', despues: f.cargo.trim() || '—' }, { campo: 'Rol', despues: ROL[f.rol] }, { campo: 'Turno', despues: TURNOS[f.turno] ?? '—' },
        { campo: 'PIN', despues: `${rolAlto ? 6 : f.longitud} dígitos, provisional` },
      ],
      requiereConexion: true,
    });
    if (!firma) return false;
    try {
      const r = await funcion<{ ok: boolean; pin_provisional: string }>('personal', {
        usuario: { id, nombre: f.nombre.trim(), apellido: f.apellido.trim(), cedula: f.cedula.trim(), cargo: f.cargo.trim(), rol: f.rol, turno: f.turno },
        longitud: rolAlto ? 6 : f.longitud, firma: firma.firmaId,
      }, true);
      setPinNuevo({ nombre: `${f.nombre.trim()} ${f.apellido.trim()}`, pin: r.pin_provisional });
      await recargar();
      return true;
    } catch (e) {
      avisar(`No se pudo agregar: ${mensajeDe(e)}`, 'mal');
      return false;
    }
  };

  const modificar = async (p: Persona, cambios: Record<string, unknown>, filas: CambioCampo[], titulo: string) => {
    const f = await firmar({ titulo, accion: 'modificar', entidad: 'usuarios', entidadId: p.id, referencia: `${p.nombre} ${p.apellido}`, cambios: filas, requiereConexion: true });
    if (!f) return false;
    try {
      await rpc('modificar_usuario', { p_id: p.id, p_cambios: cambios, p_firma: f.firmaId });
      avisar('Cambios guardados.', 'bien');
      await recargar();
      return true;
    } catch (e) {
      avisar(`No se pudo guardar: ${mensajeDe(e)}`, 'mal');
      return false;
    }
  };

  const nuevoPin = async (p: Persona) => {
    const longitud = p.rol === 'operativo' ? (p.pin_longitud ?? 4) : 6;
    const f = await firmar({
      titulo: 'Dar un PIN nuevo', accion: 'modificar', entidad: 'usuarios', entidadId: p.id, referencia: `${p.nombre} ${p.apellido}`,
      cambios: [{ campo: 'PIN', antes: p.tiene_pin ? 'El actual' : 'Sin PIN', despues: `Nuevo, ${longitud} dígitos, provisional` }],
      advertencia: 'El PIN anterior deja de servir ahora mismo. Si estaba bloqueado, queda desbloqueado.', requiereConexion: true,
    });
    if (!f) return;
    try {
      const r = await rpc<{ ok: boolean; pin_provisional: string }>('asignar_pin', { p_usuario: p.id, p_longitud: longitud, p_firma: f.firmaId });
      setPinNuevo({ nombre: `${p.nombre} ${p.apellido}`, pin: r.pin_provisional });
      await recargar();
    } catch (e) {
      avisar(`No se pudo cambiar el PIN: ${mensajeDe(e)}`, 'mal');
    }
  };

  return (
    <main className="mx-auto grid max-w-[1280px] gap-6 px-4 py-7 sm:px-6">
      <Titular ojo="Gerencia" titulo="Personal">
        {datos ? `${plural(activos, 'persona activa', 'personas activas')}. Cada una entra y firma con su propio PIN.` : 'Quién puede entrar a Pase y con qué rol.'}
      </Titular>
      {!enLinea ? <SoloEnLinea que="administrar el personal" /> : <>
        <div className="flex flex-wrap items-center gap-3">
          <Opciones etiqueta="Mostrar" valor={ver} onCambio={setVer} opciones={[{ id: 'activos', t: 'Activos' }, { id: 'todos', t: 'Todos' }]} />
          {gestiona && !alta && <Boton variante="primario" className="ml-auto" onClick={() => { setAlta(true); setEditando(null); }}><IcoMas className="h-5 w-5" />Agregar persona</Boton>}
        </div>
        {alta && <FormFicha titulo="Agregar persona" inicial={vacia} conPin onCancelar={() => setAlta(false)}
          onGuardar={async (f) => { if (await darDeAlta(f)) setAlta(false); }} />}
        <Estado cargando={cargando && !datos} error={error} onReintentar={recargar} vacio={!lista.length && 'No hay personas registradas.'}>
          <ul className="grid gap-2">
            {lista.map((p) => (
              <li key={p.id} className={cx('grid gap-3 rounded-[8px] border border-linea bg-superficie p-4', !p.activo && 'opacity-60')}>
                <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[6px] bg-tinta font-display text-[19px] font-bold text-fondo">
                    {`${p.nombre[0] ?? ''}${p.apellido[0] ?? ''}`.toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[17px] font-semibold leading-tight">{p.nombre} {p.apellido}{p.id === usuario.id ? ' (tú)' : ''}</p>
                    <p className="text-[14px] text-tenue">
                      {ROL[p.rol]}{p.cargo ? ` · ${p.cargo}` : ''}{p.turno ? ` · ${TURNOS[p.turno] ?? p.turno}` : ''}{p.cedula ? ` · C.I. ${p.cedula}` : ''}
                    </p>
                    {p.correo && <p className="text-[13px] text-tenue">{p.correo}</p>}
                  </div>
                  <div className="grid justify-items-end gap-1 text-right text-[13px]">
                    {!p.activo ? <span className="font-semibold text-mal">Inactiva</span>
                      : !p.tiene_pin ? <span className="font-semibold text-mal">Sin PIN</span>
                      : p.pin_bloqueado_hasta ? <span className="font-semibold text-mal">PIN bloqueado hasta {cuando(p.pin_bloqueado_hasta, ahora)}</span>
                      : p.debe_cambiar_pin ? <span className="font-semibold text-aviso">PIN provisional: lo cambia al entrar</span>
                      : <span className="text-bien">PIN de {p.pin_longitud} dígitos</span>}
                    <span className="text-tenue">{p.ultimo_ingreso ? `Último ingreso ${hace(Date.parse(p.ultimo_ingreso), ahora)}` : 'Nunca ha entrado'}</span>
                  </div>
                </div>
                {gestiona && editando !== p.id && (
                  <div className="flex flex-wrap gap-2 border-t border-linea pt-3">
                    <Boton onClick={() => { setEditando(p.id); setAlta(false); }}>Editar</Boton>
                    {p.activo && <Boton onClick={() => void nuevoPin(p)}>{p.tiene_pin ? 'Dar un PIN nuevo' : 'Dar PIN'}</Boton>}
                    {p.id !== usuario.id && (p.activo
                      ? <Boton variante="fantasma" className="ml-auto" onClick={() => void modificar(p, { activo: false },
                          [{ campo: 'Estado', antes: 'Activa', despues: 'Inactiva', falla: true }], 'Desactivar persona')}>Desactivar</Boton>
                      : <Boton variante="fantasma" className="ml-auto" onClick={() => void modificar(p, { activo: true },
                          [{ campo: 'Estado', antes: 'Inactiva', despues: 'Activa' }], 'Reactivar persona')}>Reactivar</Boton>)}
                  </div>
                )}
                {editando === p.id && (
                  <FormFicha titulo={`Editar a ${p.nombre}`} propia={p.id === usuario.id}
                    inicial={{ nombre: p.nombre, apellido: p.apellido, cedula: p.cedula ?? '', cargo: p.cargo ?? '', rol: p.rol, turno: p.turno ?? '', longitud: p.pin_longitud ?? 4 }}
                    onCancelar={() => setEditando(null)}
                    onGuardar={async (f) => {
                      const cambios: Record<string, unknown> = {};
                      const filas: CambioCampo[] = [];
                      const comparar = (k: keyof Ficha, etiqueta: string, antes: string, despues: string, mostrar = (v: string) => v || '—') => {
                        if (antes.trim() !== despues.trim()) { cambios[k] = despues.trim(); filas.push({ campo: etiqueta, antes: mostrar(antes), despues: mostrar(despues.trim()) }); }
                      };
                      comparar('nombre', 'Nombre', p.nombre, f.nombre);
                      comparar('apellido', 'Apellido', p.apellido, f.apellido);
                      comparar('cedula', 'Cédula', p.cedula ?? '', f.cedula);
                      comparar('cargo', 'Cargo', p.cargo ?? '', f.cargo);
                      comparar('turno', 'Turno', p.turno ?? '', f.turno, (v) => TURNOS[v] ?? '—');
                      if (p.id !== usuario.id) comparar('rol', 'Rol', p.rol, f.rol, (v) => ROL[v as Rol] ?? v);
                      if (!filas.length) { setEditando(null); return; }
                      if (await modificar(p, cambios, filas, 'Editar persona')) setEditando(null);
                    }} />
                )}
              </li>
            ))}
          </ul>
        </Estado>
      </>}

      {pinNuevo && <PinProvisional {...pinNuevo} onListo={() => setPinNuevo(null)} />}
    </main>
  );
}

function FormFicha({ titulo, inicial, conPin, propia, onGuardar, onCancelar }: {
  titulo: string; inicial: Ficha; conPin?: boolean; propia?: boolean; onGuardar: (f: Ficha) => Promise<void>; onCancelar: () => void;
}) {
  const [f, setF] = useState<Ficha>(inicial);
  const [guardando, setGuardando] = useState(false);
  const set = <K extends keyof Ficha>(k: K, v: Ficha[K]) => setF((x) => ({ ...x, [k]: v }));
  const valido = f.nombre.trim().length >= 2 && f.apellido.trim().length >= 2;
  return (
    <form className="grid gap-4 rounded-[8px] border-2 border-mostaza/60 bg-superficie p-4 sm:p-5"
      onSubmit={async (e) => { e.preventDefault(); if (!valido) return; setGuardando(true); try { await onGuardar(f); } finally { setGuardando(false); } }}>
      <h2 className="font-display text-[24px] font-extrabold uppercase leading-none">{titulo}</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <Campo etiqueta="Nombre"><input required minLength={2} value={f.nombre} onChange={(e) => set('nombre', e.target.value)} className={claseEntrada} autoComplete="off" /></Campo>
        <Campo etiqueta="Apellido"><input required minLength={2} value={f.apellido} onChange={(e) => set('apellido', e.target.value)} className={claseEntrada} autoComplete="off" /></Campo>
        <Campo etiqueta="Cédula (opcional)"><input value={f.cedula} onChange={(e) => set('cedula', e.target.value.replace(/[^\dVvEe.-]/g, ''))} className={claseEntrada} autoComplete="off" /></Campo>
        <Campo etiqueta="Cargo" ayuda="P. ej. parrillero, cajero de autoservicio, supervisor de turno."><input value={f.cargo} onChange={(e) => set('cargo', e.target.value)} className={claseEntrada} autoComplete="off" /></Campo>
        <Campo etiqueta="Turno">
          <select value={f.turno} onChange={(e) => set('turno', e.target.value)} className={claseEntrada}>
            <option value="">Sin turno fijo</option>
            {Object.entries(TURNOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Campo>
        <div className="grid gap-1.5">
          <span className="text-[15px] font-semibold">Rol</span>
          {propia ? <p className="text-[15px] text-tenue">{ROL[f.rol]} (no puedes cambiar tu propio rol)</p> : (
            <Opciones etiqueta="Rol" valor={f.rol} onCambio={(v) => set('rol', v)} opciones={ROLES.map((r) => ({ id: r, t: ROL[r] }))} />
          )}
          <span className="text-[13px] text-tenue">
            {f.rol === 'operativo' ? 'Llena sus planillas y reporta fallas.' : f.rol === 'supervisor' ? 'Además revisa planillas y gestiona incidencias. PIN de 6 dígitos.' : 'Acceso completo: personal, equipos y bitácora. PIN de 6 dígitos.'}
          </span>
        </div>
        {conPin && f.rol === 'operativo' && (
          <div className="grid gap-1.5">
            <span className="text-[15px] font-semibold">Largo del PIN</span>
            <Opciones etiqueta="Largo del PIN" valor={f.longitud} onCambio={(v) => set('longitud', v)} opciones={[{ id: 4, t: '4 dígitos' }, { id: 6, t: '6 dígitos' }]} />
          </div>
        )}
      </div>
      {!conPin && inicial.rol === 'operativo' && f.rol !== 'operativo' && inicial.longitud < 6 && (
        <p className="flex gap-2 text-[14px] font-semibold text-aviso"><IconoAlerta className="mt-0.5 h-5 w-5 shrink-0" />Primero dale un PIN nuevo: supervisores y gerentes usan 6 dígitos.</p>
      )}
      <div className="flex gap-2">
        <Boton type="submit" variante="primario" disabled={guardando || !valido}>{guardando ? 'Guardando…' : conPin ? 'Firmar y agregar' : 'Firmar cambios'}</Boton>
        <Boton variante="fantasma" onClick={onCancelar}>Cancelar</Boton>
      </div>
    </form>
  );
}

function PinProvisional({ nombre, pin, onListo }: { nombre: string; pin: string; onListo: () => void }) {
  const [visto, setVisto] = useState(false);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-[rgb(8_10_12/0.6)] p-4 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-label="PIN provisional">
      <div className="grid w-full max-w-[440px] gap-4 rounded-[10px] bg-superficie p-6 shadow-[0_20px_50px_-20px_rgb(0_0_0/0.6)]">
        <h2 className="font-display text-[30px] font-black uppercase leading-[0.9]">PIN provisional</h2>
        <p className="text-[16px] leading-snug">Entrégale este PIN a <b className="font-semibold">{nombre}</b>, en persona. Se muestra una sola vez.</p>
        <p className="num rounded-[8px] bg-hundido py-5 text-center font-display text-[64px] font-black leading-none tracking-[0.25em]" aria-live="polite">{pin}</p>
        <p className="text-[14px] leading-snug text-tenue">La primera vez que entre, Pase le pide cambiarlo por uno que solo esa persona conoce.</p>
        <label className="flex items-center gap-3 text-[15px] font-semibold">
          <input type="checkbox" checked={visto} onChange={(e) => setVisto(e.target.checked)} className="h-5 w-5" />Ya se lo entregué
        </label>
        <Boton variante="primario" alto="lg" disabled={!visto} onClick={onListo}>Listo</Boton>
      </div>
    </div>
  );
}
