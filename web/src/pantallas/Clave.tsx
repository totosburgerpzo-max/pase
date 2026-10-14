import { useEffect, useRef, useState } from 'react';
import { ErrorApi, auth, reclamos, type Factor } from '../api';
import { mensajeDe } from '../contexto';
import { IconoEscudo } from '../ui/PinConfirmModal';
import { Boton, Campo, Ojo, claseEntrada } from '../ui/comun';
import { Marca } from './Bloqueo';
import { CodigoTotp, MensajeError } from './Registro';

/*
 * Los links de los correos de Supabase Auth (invitación de una gerente, o contraseña olvidada)
 * vuelven a la app con la sesión en el fragmento: #access_token=…&type=invite|recovery.
 * Se leen al abrir y se borran de la barra de direcciones en el acto.
 */
export type LinkCorreo = { token: string; tipo: 'invite' | 'recovery'; correo: string } | { error: string };

export function leerLinkDeCorreo(): LinkCorreo | null {
  const h = new URLSearchParams(location.hash.replace(/^#\/?/, ''));
  const tipo = h.get('type');
  const token = h.get('access_token');
  if (h.get('error_code') || (h.get('error') && !token)) {
    return { error: h.get('error_code') === 'otp_expired' ? 'El link venció o ya se usó.' : 'El link no es válido.' };
  }
  if (!token || (tipo !== 'invite' && tipo !== 'recovery')) return null;
  try {
    return { token, tipo, correo: String(reclamos(token).email ?? '') };
  } catch {
    return { error: 'El link no es válido.' };
  }
}

const MINIMO = 10;

export function Clave({ link, onListo, onSalir }: {
  link: LinkCorreo; onListo: (token: string) => void; onSalir: () => void;
}) {
  const valido = 'token' in link;
  const [token, setToken] = useState(valido ? link.token : '');
  const [paso, setPaso] = useState<'cargando' | 'codigo' | 'clave'>('cargando');
  const [factor, setFactor] = useState('');
  const [codigo, setCodigo] = useState('');
  const [clave, setClave] = useState('');
  const [repetida, setRepetida] = useState('');
  const [error, setError] = useState<string | null>(valido ? null : link.error);
  const [trabajando, setTrabajando] = useState(false);
  const iniciado = useRef(false);

  const hacer = async (f: () => Promise<void>) => {
    setError(null);
    setTrabajando(true);
    try { await f(); } catch (e) {
      setError(e instanceof ErrorApi && (e.estado === 401 || e.estado === 403) && !/AAL2|código/i.test(e.message)
        ? 'El link venció. Pide uno nuevo con «¿Olvidaste tu contraseña?».' : mensajeDe(e));
    } finally { setTrabajando(false); }
  };

  // Si la cuenta ya tiene la app autenticadora, Supabase pide su código antes de cambiar la contraseña
  useEffect(() => {
    if (!valido || iniciado.current) return;
    iniciado.current = true;
    void hacer(async () => {
      const u = await auth.usuario(link.token);
      const f = (u.factors ?? []).find((x: Factor) => x.factor_type === 'totp' && x.status === 'verified');
      if (f) { setFactor(f.id); setPaso('codigo'); } else setPaso('clave');
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const verificar = () => hacer(async () => {
    const s = await auth.verificarTotp(token, factor, codigo.trim());
    setCodigo('');
    if (reclamos(s.access_token).aal !== 'aal2') throw new Error('No se completó la verificación en dos pasos');
    setToken(s.access_token);
    setPaso('clave');
  });

  const guardar = () => hacer(async () => {
    if (clave.length < MINIMO) throw new Error(`Usa al menos ${MINIMO} caracteres.`);
    if (clave !== repetida) throw new Error('Las dos contraseñas no coinciden.');
    await auth.cambiarClave(token, clave);
    setClave('');
    setRepetida('');
    onListo(token);
  });

  const nueva = valido && link.tipo === 'invite';
  return (
    <main className="acero grid flex-1 place-items-center px-4 py-10">
      <div className="w-full max-w-[560px] rounded-[10px] border border-linea bg-superficie p-6 shadow-[0_20px_50px_-30px_rgb(0_0_0/0.5)] sm:p-8">
        <div className="flex items-center justify-between gap-3">
          <Marca chica />
          {valido && <Ojo>{nueva ? 'Invitación' : 'Contraseña olvidada'}</Ojo>}
        </div>

        {!valido && (
          <div className="mt-6 grid gap-4">
            <h1 className="font-display text-[34px] font-black uppercase leading-[0.9]">Este link ya no sirve</h1>
            <MensajeError texto={error} />
            <p className="text-[16px] leading-snug text-tenue">
              Los links de los correos sirven una sola vez y por poco tiempo. En la pantalla de entrada escribe tu correo
              y toca «¿Olvidaste tu contraseña?» para recibir uno nuevo.
            </p>
            <Boton variante="primario" alto="lg" onClick={onSalir}>Ir a la entrada</Boton>
          </div>
        )}

        {valido && paso === 'cargando' && (
          <div className="mt-6 grid gap-4">
            <p className="text-[16px] text-tenue">{trabajando ? 'Abriendo tu cuenta…' : ''}</p>
            <MensajeError texto={error} />
            {error && <Boton alto="lg" onClick={onSalir}>Ir a la entrada</Boton>}
          </div>
        )}

        {valido && paso === 'codigo' && (
          <form className="mt-6 grid gap-4" onSubmit={(e) => { e.preventDefault(); void verificar(); }}>
            <h1 className="flex items-center gap-3 font-display text-[34px] font-black uppercase leading-[0.9]"><IconoEscudo className="h-9 w-9 shrink-0" />Código de verificación</h1>
            <p className="text-[16px] leading-snug text-tenue">Para cambiar la contraseña de {link.correo}, escribe los 6 números que muestra ahora tu app autenticadora.</p>
            <CodigoTotp valor={codigo} onCambio={setCodigo} />
            <MensajeError texto={error} />
            <Boton type="submit" variante="primario" alto="lg" disabled={trabajando || codigo.length !== 6}>{trabajando ? 'Verificando…' : 'Verificar'}</Boton>
          </form>
        )}

        {valido && paso === 'clave' && (
          <form className="mt-6 grid gap-4" onSubmit={(e) => { e.preventDefault(); void guardar(); }}>
            <h1 className="font-display text-[34px] font-black uppercase leading-[0.9]">{nueva ? 'Crea tu contraseña' : 'Contraseña nueva'}</h1>
            <p className="text-[16px] leading-snug text-tenue">
              {nueva
                ? <>Es la de tu cuenta de gerente, <b className="font-semibold text-tinta">{link.correo}</b>. Con ella y con la app autenticadora del teléfono registras los equipos de la tienda.</>
                : <>Para <b className="font-semibold text-tinta">{link.correo}</b>. La anterior deja de servir.</>}
            </p>
            <input type="email" autoComplete="username" value={link.correo} readOnly hidden />
            <Campo etiqueta="Contraseña nueva" ayuda={`Al menos ${MINIMO} caracteres. Que no la uses en otro sitio.`}>
              <input type="password" autoComplete="new-password" required minLength={MINIMO} maxLength={72} value={clave}
                onChange={(e) => setClave(e.target.value)} className={claseEntrada} />
            </Campo>
            <Campo etiqueta="Repítela">
              <input type="password" autoComplete="new-password" required value={repetida} onChange={(e) => setRepetida(e.target.value)} className={claseEntrada} />
            </Campo>
            <MensajeError texto={error} />
            <Boton type="submit" variante="primario" alto="lg" disabled={trabajando || clave.length < MINIMO || !repetida}>
              {trabajando ? 'Guardando…' : 'Guardar contraseña'}
            </Boton>
          </form>
        )}
      </div>
    </main>
  );
}
