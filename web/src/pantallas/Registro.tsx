import { useEffect, useRef, useState } from 'react';
import { auth, reclamos, type Factor } from '../api';
import { guardarEquipo, type EquipoLocal } from '../local';
import { mensajeDe } from '../contexto';
import type { Contexto, TipoEquipo } from '../tipos';
import { IconoAlerta, IconoEscudo } from '../ui/PinConfirmModal';
import { Boton, Campo, Ojo, claseEntrada, cx } from '../ui/comun';
import { Marca } from './Bloqueo';

/*
 * Registro de este equipo. Solo la gerente, en el propio equipo:
 *   1. correo y contraseña  2. código de su app autenticadora (la primera vez, la activa con un QR)
 *   3. nombre del equipo y su PIN (si aún no tiene, o lo olvidó, lo genera aquí y lo ve una sola vez).
 * Si llega desde el link de su invitación, ya trae la sesión y empieza en el paso 2.
 * El servidor devuelve un secreto que se guarda cifrado aquí y nunca se vuelve a mostrar.
 */
type Paso =
  | { id: 'inicio' } | { id: 'cargando' }
  | { id: 'correo' }
  | { id: 'activar'; token: string; factor: string; qr: string; secreto: string }
  | { id: 'codigo'; token: string; factor: string }
  | { id: 'pin'; token: string; primera: boolean }
  | { id: 'equipo'; token: string };

const TIPOS: { id: TipoEquipo; t: string }[] = [
  { id: 'tablet_cocina', t: 'Tablet de cocina' }, { id: 'tablet_caja', t: 'Tablet de caja o salón' },
  { id: 'pc_gerencia', t: 'PC de gerencia' }, { id: 'telefono', t: 'Teléfono' },
];

export function Registro({ onRegistrado, sesionInicial }: { onRegistrado: (e: EquipoLocal) => void; sesionInicial?: string }) {
  const [paso, setPaso] = useState<Paso>(sesionInicial ? { id: 'cargando' } : { id: 'inicio' });
  const [correo, setCorreo] = useState(() => (sesionInicial ? String(reclamos(sesionInicial).email ?? '') : ''));
  const [clave, setClave] = useState('');
  const [codigo, setCodigo] = useState('');
  const [nombre, setNombre] = useState('');
  const [tipo, setTipo] = useState<TipoEquipo>('tablet_cocina');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [trabajando, setTrabajando] = useState(false);
  const [pinNuevo, setPinNuevo] = useState<{ pin: string; visto: boolean } | null>(null);
  const [confirmacion, setConfirmacion] = useState('');

  const hacer = async (f: () => Promise<void>) => {
    setError(null);
    setInfo(null);
    setTrabajando(true);
    try { await f(); } catch (e) { setError(mensajeDe(e)); } finally { setTrabajando(false); }
  };

  // Con la sesión de correo y contraseña: pide el código de la app, o la activa la primera vez
  const seguirCon = async (token: string) => {
    if (reclamos(token).aal === 'aal2') return conSegundoFactor(token);
    const u = await auth.usuario(token);
    const totp = (u.factors ?? []).filter((f: Factor) => f.factor_type === 'totp');
    const listo = totp.find((f) => f.status === 'verified');
    if (listo) { setPaso({ id: 'codigo', token, factor: listo.id }); return; }
    for (const f of totp) await auth.borrarFactor(token, f.id).catch(() => {});
    const n = await auth.inscribirTotp(token);
    // GoTrue entrega el QR como SVG; se muestra como data URI
    const qr = n.totp.qr_code.startsWith('data:') ? n.totp.qr_code : `data:image/svg+xml;utf-8,${encodeURIComponent(n.totp.qr_code)}`;
    setPaso({ id: 'activar', token, factor: n.id, qr, secreto: n.totp.secret });
  };

  // Ya con el segundo factor: si todavía no tiene PIN, lo genera antes de registrar el equipo
  const conSegundoFactor = async (token: string) => {
    const ctx = await auth.rpcCon<Contexto | null>(token, 'pase_contexto');
    if (!ctx) { await auth.salir(token); throw new Error('Esta cuenta no tiene acceso a Pase.'); }
    if (ctx.usuario.rol !== 'admin') { await auth.salir(token); throw new Error('Solo la gerente registra equipos.'); }
    setPaso(ctx.pin ? { id: 'equipo', token } : { id: 'pin', token, primera: true });
  };

  const iniciado = useRef(false);
  useEffect(() => {
    if (!sesionInicial || iniciado.current) return;
    iniciado.current = true;
    void hacer(async () => {
      try { await seguirCon(sesionInicial); } catch (e) { setPaso({ id: 'correo' }); throw e; }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const entrar = () => hacer(async () => {
    const s = await auth.entrar(correo.trim(), clave);
    setClave('');
    await seguirCon(s.access_token);
  });

  const olvide = () => hacer(async () => {
    if (!/^\S+@\S+\.\S+$/.test(correo.trim())) throw new Error('Escribe tu correo arriba y vuelve a tocar «¿Olvidaste tu contraseña?».');
    await auth.recuperar(correo.trim());
    setInfo(`Si ${correo.trim()} es la cuenta de una gerente de Pase, le llegó un correo con un link para crear una contraseña nueva. Ábrelo en este equipo.`);
  });

  const verificar = (token: string, factor: string) => hacer(async () => {
    const s = await auth.verificarTotp(token, factor, codigo.trim());
    setCodigo('');
    if (reclamos(s.access_token).aal !== 'aal2') throw new Error('No se completó la verificación en dos pasos');
    await conSegundoFactor(s.access_token);
  });

  const generarPin = (token: string) => hacer(async () => {
    const r = await auth.rpcCon<{ ok: boolean; motivo?: string; pin?: string }>(token, 'nuevo_pin_gerente');
    if (!r.ok || !r.pin) {
      throw new Error(r.motivo === 'requiere_2fa' ? 'Falta el código de verificación.' : r.motivo === 'sin_permiso'
        ? 'Solo la gerente genera su PIN aquí.' : `No se pudo generar el PIN (${r.motivo ?? 'error'})`);
    }
    setConfirmacion('');
    setPinNuevo({ pin: r.pin, visto: false });
  });

  const registrar = (token: string) => hacer(async () => {
    const id = crypto.randomUUID();
    const r = await auth.rpcCon<{ ok: boolean; motivo?: string; secreto?: string; dispositivo?: { sucursal_id?: string } }>(token,
      'registrar_este_dispositivo', { p_id: id, p_nombre: nombre.trim(), p_tipo: tipo, p_pin: pin });
    setPin('');
    if (!r.ok || !r.secreto) {
      throw new Error(r.motivo === 'pin_incorrecto' ? 'Ese PIN no es el tuyo.' : r.motivo === 'sin_permiso' ? 'Esta cuenta no puede registrar equipos.'
        : r.motivo === 'requiere_2fa' ? 'Falta el código de verificación.' : r.motivo === 'bloqueado' ? 'Tu PIN quedó bloqueado por intentos. Espera 15 minutos.'
        : `No se pudo registrar (${r.motivo ?? 'error'})`);
    }
    const e: EquipoLocal = {
      id, nombre: nombre.trim(), tipo, secreto: r.secreto, sucursal: r.dispositivo?.sucursal_id ?? '', registrado_en: new Date().toISOString(),
    };
    await guardarEquipo(e);
    await auth.salir(token);
    onRegistrado(e);
  });

  return (
    <main className="acero grid flex-1 place-items-center px-4 py-10">
      <div className="w-full max-w-[560px] rounded-[10px] border border-linea bg-superficie p-6 shadow-[0_20px_50px_-30px_rgb(0_0_0/0.5)] sm:p-8">
        <div className="flex items-center justify-between gap-3">
          <Marca chica />
          {paso.id !== 'inicio' && paso.id !== 'cargando' && <Ojo>Paso {paso.id === 'correo' ? 1 : paso.id === 'equipo' || paso.id === 'pin' ? 3 : 2} de 3</Ojo>}
        </div>

        {paso.id === 'inicio' && (
          <>
            <h1 className="mt-6 font-display text-[42px] font-black uppercase leading-[0.9]">Registrar este equipo</h1>
            <p className="mt-3 text-[17px] leading-snug text-tenue">
              Antes de usar Pase en esta tablet o computadora, la gerente la registra una sola vez. Necesita su correo, su contraseña,
              la app autenticadora del teléfono (Google Authenticator, Microsoft Authenticator o similar) y su PIN. Si todavía no
              tiene PIN, lo crea aquí mismo.
            </p>
            <p className="mt-3 text-[15px] leading-snug text-tenue">Abrir este link en un equipo no registrado no da acceso a nada.</p>
            <Boton variante="primario" alto="lg" className="mt-6" onClick={() => setPaso({ id: 'correo' })}>Soy la gerente: empezar</Boton>
          </>
        )}

        {paso.id === 'correo' && (
          <form className="mt-6 grid gap-4" onSubmit={(e) => { e.preventDefault(); void entrar(); }}>
            <h1 className="font-display text-[34px] font-black uppercase leading-[0.9]">Tu cuenta de gerente</h1>
            <Campo etiqueta="Correo">
              <input type="email" autoComplete="username" required value={correo} onChange={(e) => setCorreo(e.target.value)} className={claseEntrada} />
            </Campo>
            <Campo etiqueta="Contraseña">
              <input type="password" autoComplete="current-password" required value={clave} onChange={(e) => setClave(e.target.value)} className={claseEntrada} />
            </Campo>
            <MensajeError texto={error} />
            {info && <p className="text-[15px] font-semibold leading-snug text-bien" role="status">{info}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <Boton type="submit" variante="primario" alto="lg" disabled={trabajando || !correo || !clave}>{trabajando ? 'Entrando…' : 'Continuar'}</Boton>
              <Boton variante="fantasma" alto="lg" onClick={() => setPaso({ id: 'inicio' })}>Volver</Boton>
              <button type="button" onClick={() => void olvide()} disabled={trabajando}
                className="ml-auto text-[15px] font-semibold text-tenue underline underline-offset-4 hover:text-tinta">¿Olvidaste tu contraseña?</button>
            </div>
          </form>
        )}

        {paso.id === 'cargando' && (
          <p className="mt-6 text-[16px] text-tenue" role="status">{trabajando ? 'Abriendo tu cuenta…' : ''}</p>
        )}

        {paso.id === 'pin' && (
          <div className="mt-6 grid gap-4">
            <h1 className="font-display text-[34px] font-black uppercase leading-[0.9]">{paso.primera ? 'Tu PIN de gerente' : 'Un PIN nuevo'}</h1>
            {!pinNuevo && <>
              <p className="text-[16px] leading-snug text-tenue">
                Con el PIN entras en las tablets y firmas todo lo que haces en Pase. Lo crea el sistema al azar y lo verás una sola vez:
                apréndetelo y no lo anotes donde otros lo vean.{paso.primera ? '' : ' El PIN anterior deja de servir.'}
              </p>
              <MensajeError texto={error} />
              <div className="flex flex-wrap gap-2">
                <Boton variante="primario" alto="lg" onClick={() => void generarPin(paso.token)} disabled={trabajando}>{trabajando ? 'Generando…' : 'Generar mi PIN'}</Boton>
                {!paso.primera && <Boton variante="fantasma" alto="lg" onClick={() => setPaso({ id: 'equipo', token: paso.token })}>Volver</Boton>}
              </div>
            </>}
            {pinNuevo && !pinNuevo.visto && <>
              <p className="text-[16px] leading-snug text-tenue">Este es tu PIN. Míralo con calma y apréndetelo: al seguir, no se vuelve a mostrar.</p>
              <p className="num rounded-[8px] bg-hundido py-5 text-center font-display text-[64px] font-black leading-none tracking-[0.3em]" aria-label="Tu PIN nuevo">{pinNuevo.pin}</p>
              <Boton variante="primario" alto="lg" onClick={() => setPinNuevo({ ...pinNuevo, visto: true })}>Ya me lo aprendí</Boton>
            </>}
            {pinNuevo?.visto && (
              <form className="grid gap-4" onSubmit={(e) => {
                e.preventDefault();
                if (confirmacion !== pinNuevo.pin) { setError('No coincide. Toca «Verlo otra vez» y vuelve a intentarlo.'); return; }
                setError(null);
                setPin(pinNuevo.pin);
                setPinNuevo(null);
                setConfirmacion('');
                setPaso({ id: 'equipo', token: paso.token });
              }}>
                <Campo etiqueta="Escríbelo de memoria">
                  <input type="password" inputMode="numeric" autoComplete="off" value={confirmacion} autoFocus
                    onChange={(e) => setConfirmacion(e.target.value.replace(/\D/g, '').slice(0, 6))} className={cx(claseEntrada, 'num tracking-[0.4em]')} />
                </Campo>
                <MensajeError texto={error} />
                <div className="flex flex-wrap gap-2">
                  <Boton type="submit" variante="primario" alto="lg" disabled={confirmacion.length !== pinNuevo.pin.length}>Continuar</Boton>
                  <Boton variante="fantasma" alto="lg" onClick={() => { setError(null); setPinNuevo({ ...pinNuevo, visto: false }); }}>Verlo otra vez</Boton>
                </div>
              </form>
            )}
          </div>
        )}

        {paso.id === 'activar' && (
          <form className="mt-6 grid gap-4" onSubmit={(e) => { e.preventDefault(); void verificar(paso.token, paso.factor); }}>
            <h1 className="font-display text-[34px] font-black uppercase leading-[0.9]">Activa la verificación en dos pasos</h1>
            <ol className="grid list-decimal gap-1.5 pl-5 text-[16px] leading-snug">
              <li>Abre tu app autenticadora y toca «Agregar» o «+».</li>
              <li>Escanea este código. Si no puedes, escribe la clave que está debajo.</li>
              <li>Escribe aquí los 6 números que muestra la app.</li>
            </ol>
            <div className="grid justify-items-center gap-2 rounded-[8px] bg-white p-4">
              <img src={paso.qr} alt="Código QR para la app autenticadora" className="h-52 w-52" />
              <code className="break-all text-center font-mono text-[13px] text-black">{paso.secreto.replace(/(.{4})/g, '$1 ').trim()}</code>
            </div>
            <CodigoTotp valor={codigo} onCambio={setCodigo} />
            <MensajeError texto={error} />
            <Boton type="submit" variante="primario" alto="lg" disabled={trabajando || codigo.length !== 6}>{trabajando ? 'Verificando…' : 'Verificar'}</Boton>
          </form>
        )}

        {paso.id === 'codigo' && (
          <form className="mt-6 grid gap-4" onSubmit={(e) => { e.preventDefault(); void verificar(paso.token, paso.factor); }}>
            <h1 className="flex items-center gap-3 font-display text-[34px] font-black uppercase leading-[0.9]"><IconoEscudo className="h-9 w-9 shrink-0" />Código de verificación</h1>
            <p className="text-[16px] text-tenue">Escribe los 6 números que muestra ahora tu app autenticadora.</p>
            <CodigoTotp valor={codigo} onCambio={setCodigo} />
            <MensajeError texto={error} />
            <Boton type="submit" variante="primario" alto="lg" disabled={trabajando || codigo.length !== 6}>{trabajando ? 'Verificando…' : 'Verificar'}</Boton>
          </form>
        )}

        {paso.id === 'equipo' && (
          <form className="mt-6 grid gap-4" onSubmit={(e) => { e.preventDefault(); void registrar(paso.token); }}>
            <h1 className="font-display text-[34px] font-black uppercase leading-[0.9]">Este equipo</h1>
            <Campo etiqueta="Nombre" ayuda="Como lo reconocerá el equipo, p. ej. «Tablet línea caliente».">
              <input required minLength={3} maxLength={60} value={nombre} onChange={(e) => setNombre(e.target.value)} className={claseEntrada} />
            </Campo>
            <div className="grid gap-1.5">
              <span className="text-[15px] font-semibold">Tipo</span>
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Tipo de equipo">
                {TIPOS.map((t) => (
                  <button key={t.id} type="button" role="radio" aria-checked={tipo === t.id} onClick={() => setTipo(t.id)}
                    className={cx('h-12 rounded-[8px] border-2 px-3 text-[15px] font-semibold', tipo === t.id ? 'border-mostaza bg-mostaza/15' : 'border-linea bg-superficie hover:border-tenue')}>{t.t}</button>
                ))}
              </div>
            </div>
            <Campo etiqueta="Tu PIN" ayuda="Firma el registro: queda en la bitácora a tu nombre.">
              <input type="password" inputMode="numeric" autoComplete="off" pattern="[0-9]{4,6}" required value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} className={cx(claseEntrada, 'num tracking-[0.4em]')} />
            </Campo>
            <button type="button" onClick={() => { setPin(''); setError(null); setPaso({ id: 'pin', token: paso.token, primera: false }); }}
              className="justify-self-start text-[15px] font-semibold text-tenue underline underline-offset-4 hover:text-tinta">Olvidé mi PIN</button>
            <MensajeError texto={error} />
            <Boton type="submit" variante="primario" alto="lg" disabled={trabajando || nombre.trim().length < 3 || pin.length < 4}>{trabajando ? 'Registrando…' : 'Registrar este equipo'}</Boton>
          </form>
        )}
      </div>
    </main>
  );
}

export const CodigoTotp = ({ valor, onCambio }: { valor: string; onCambio: (v: string) => void }) => (
  <input inputMode="numeric" autoComplete="one-time-code" aria-label="Código de 6 números" placeholder="000000" value={valor}
    onChange={(e) => onCambio(e.target.value.replace(/\D/g, '').slice(0, 6))}
    className="num h-16 rounded-[8px] border-2 border-linea bg-superficie px-4 text-center font-display text-[40px] font-bold tracking-[0.4em] outline-none focus:border-mostaza" />
);

export const MensajeError = ({ texto }: { texto: string | null }) => texto
  ? <p className="flex gap-2 text-[15px] font-semibold leading-snug text-mal" role="alert"><IconoAlerta className="mt-0.5 h-5 w-5 shrink-0" />{texto}</p>
  : null;
