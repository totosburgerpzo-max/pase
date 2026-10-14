import { useState } from 'react';
import { auth, reclamos, type Factor } from '../api';
import { guardarEquipo, type EquipoLocal } from '../local';
import { mensajeDe } from '../contexto';
import type { TipoEquipo } from '../tipos';
import { IconoAlerta, IconoEscudo } from '../ui/PinConfirmModal';
import { Boton, Campo, Ojo, claseEntrada, cx } from '../ui/comun';
import { Marca } from './Bloqueo';

/*
 * Registro de este equipo. Solo la gerente, en el propio equipo:
 *   1. correo y contraseña  2. código de su app autenticadora (la primera vez, la activa con un QR)
 *   3. nombre del equipo y su PIN.
 * El servidor devuelve un secreto que se guarda cifrado aquí y nunca se vuelve a mostrar.
 */
type Paso =
  | { id: 'inicio' }
  | { id: 'correo' }
  | { id: 'activar'; token: string; factor: string; qr: string; secreto: string }
  | { id: 'codigo'; token: string; factor: string }
  | { id: 'equipo'; token: string };

const TIPOS: { id: TipoEquipo; t: string }[] = [
  { id: 'tablet_cocina', t: 'Tablet de cocina' }, { id: 'tablet_caja', t: 'Tablet de caja o salón' },
  { id: 'pc_gerencia', t: 'PC de gerencia' }, { id: 'telefono', t: 'Teléfono' },
];

export function Registro({ onRegistrado }: { onRegistrado: (e: EquipoLocal) => void }) {
  const [paso, setPaso] = useState<Paso>({ id: 'inicio' });
  const [correo, setCorreo] = useState('');
  const [clave, setClave] = useState('');
  const [codigo, setCodigo] = useState('');
  const [nombre, setNombre] = useState('');
  const [tipo, setTipo] = useState<TipoEquipo>('tablet_cocina');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [trabajando, setTrabajando] = useState(false);

  const hacer = async (f: () => Promise<void>) => {
    setError(null);
    setTrabajando(true);
    try { await f(); } catch (e) { setError(mensajeDe(e)); } finally { setTrabajando(false); }
  };

  const entrar = () => hacer(async () => {
    const s = await auth.entrar(correo.trim(), clave);
    setClave('');
    const u = await auth.usuario(s.access_token);
    const totp = (u.factors ?? []).filter((f: Factor) => f.factor_type === 'totp');
    const listo = totp.find((f) => f.status === 'verified');
    if (listo) { setPaso({ id: 'codigo', token: s.access_token, factor: listo.id }); return; }
    for (const f of totp) await auth.borrarFactor(s.access_token, f.id).catch(() => {});
    const n = await auth.inscribirTotp(s.access_token);
    // GoTrue entrega el QR como SVG; se muestra como data URI
    const qr = n.totp.qr_code.startsWith('data:') ? n.totp.qr_code : `data:image/svg+xml;utf-8,${encodeURIComponent(n.totp.qr_code)}`;
    setPaso({ id: 'activar', token: s.access_token, factor: n.id, qr, secreto: n.totp.secret });
  });

  const verificar = (token: string, factor: string) => hacer(async () => {
    const s = await auth.verificarTotp(token, factor, codigo.trim());
    setCodigo('');
    if (reclamos(s.access_token).aal !== 'aal2') throw new Error('No se completó la verificación en dos pasos');
    setPaso({ id: 'equipo', token: s.access_token });
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
          {paso.id !== 'inicio' && <Ojo>Paso {paso.id === 'correo' ? 1 : paso.id === 'equipo' ? 3 : 2} de 3</Ojo>}
        </div>

        {paso.id === 'inicio' && (
          <>
            <h1 className="mt-6 font-display text-[42px] font-black uppercase leading-[0.9]">Registrar este equipo</h1>
            <p className="mt-3 text-[17px] leading-snug text-tenue">
              Antes de usar Pase en esta tablet o computadora, la gerente la registra una sola vez. Necesita su correo, su contraseña,
              la app autenticadora del teléfono (Google Authenticator, Microsoft Authenticator o similar) y su PIN.
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
            <div className="flex gap-2">
              <Boton type="submit" variante="primario" alto="lg" disabled={trabajando || !correo || !clave}>{trabajando ? 'Entrando…' : 'Continuar'}</Boton>
              <Boton variante="fantasma" alto="lg" onClick={() => setPaso({ id: 'inicio' })}>Volver</Boton>
            </div>
          </form>
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
            <MensajeError texto={error} />
            <Boton type="submit" variante="primario" alto="lg" disabled={trabajando || nombre.trim().length < 3 || pin.length < 4}>{trabajando ? 'Registrando…' : 'Registrar este equipo'}</Boton>
          </form>
        )}
      </div>
    </main>
  );
}

const CodigoTotp = ({ valor, onCambio }: { valor: string; onCambio: (v: string) => void }) => (
  <input inputMode="numeric" autoComplete="one-time-code" aria-label="Código de 6 números" placeholder="000000" value={valor}
    onChange={(e) => onCambio(e.target.value.replace(/\D/g, '').slice(0, 6))}
    className="num h-16 rounded-[8px] border-2 border-linea bg-superficie px-4 text-center font-display text-[40px] font-bold tracking-[0.4em] outline-none focus:border-mostaza" />
);

const MensajeError = ({ texto }: { texto: string | null }) => texto
  ? <p className="flex gap-2 text-[15px] font-semibold leading-snug text-mal" role="alert"><IconoAlerta className="mt-0.5 h-5 w-5 shrink-0" />{texto}</p>
  : null;
