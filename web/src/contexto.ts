import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { CambioCampo, FirmaValida } from './ui/PinConfirmModal';
import type { EquipoLocal } from './local';
import type { EnvioPendiente } from './cola';
import type { AccionFirma, Contexto, Hoy, Plantilla, Rol } from './tipos';
import { ErrorApi } from './api';

export type Ruta =
  | { id: 'inicio' } | { id: 'panel' } | { id: 'falla' } | { id: 'incidencias' } | { id: 'alertas' }
  | { id: 'historial' } | { id: 'personal' } | { id: 'equipos' } | { id: 'bitacora' } | { id: 'cola' }
  | { id: 'planilla'; prog?: string; plantilla?: string }
  | { id: 'ejecucion'; ejec: string };

export interface SolicitudFirma {
  titulo: string; accion: AccionFirma; entidad: string; entidadId: string; referencia?: string;
  cambios: CambioCampo[]; advertencia?: string; requiereConexion?: boolean;
}
export type Firma = FirmaValida;

export interface Recibo {
  titulo: string;
  lineas: [string, string][];
  firma: Firma;
  aviso?: { tono: 'bien' | 'mal' | 'aviso'; texto: string };
}

export type Tono = 'bien' | 'mal' | 'aviso' | 'info';

export interface Usuario {
  id: string; nombre: string; nombreCompleto: string; rol: Rol; nivel: number; cargo: string | null;
  turno: string | null; sucursal: string; pinLongitud: number;
}

export interface Ctx {
  ahora: number;
  equipo: EquipoLocal;
  contexto: Contexto;
  usuario: Usuario;
  /** Hay servidor y la sesión tiene token: se puede leer y firmar en línea */
  enLinea: boolean;
  /** Se entró sin internet: todo lo firmado va a la cola */
  sinSesionEnLinea: boolean;
  puede: (permiso: string) => boolean;
  ruta: Ruta;
  ir: (r: Ruta) => void;
  volver: () => void;
  firmar: (s: SolicitudFirma) => Promise<Firma | null>;
  recibo: (r: Recibo) => Promise<void>;
  avisar: (texto: string, tono?: Tono) => void;
  catalogo: Plantilla[];
  hoy: Hoy | null;
  recargarHoy: () => Promise<void>;
  cola: EnvioPendiente[];
  refrescarCola: () => Promise<void>;
  sincronizarAhora: () => Promise<void>;
  alertasAbiertas: number;
  refrescarAlertas: () => Promise<void>;
  /** Avisa que una llamada falló por red: la app pasa a trabajar sin conexión */
  redCaida: () => void;
  parametro: <T = unknown>(clave: string, porDefecto: T) => T;
}

export const AppCtx = createContext<Ctx | null>(null);
export const useApp = () => {
  const c = useContext(AppCtx);
  if (!c) throw new Error('Sin contexto de la app');
  return c;
};

export const metodo = (f: Firma) => (f.sinConexion ? 'PIN sin conexión' : 'PIN en línea');

export const mensajeDe = (e: unknown) =>
  e instanceof ErrorApi ? (e.red ? 'Sin conexión con el servidor. Inténtalo cuando vuelva la señal.' : e.message)
    : e instanceof Error ? e.message : 'Algo salió mal';

/** Carga datos de la API con estado de espera y error */
export function useCarga<T>(cargar: () => Promise<T>, deps: unknown[], activo = true) {
  const [datos, setDatos] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(activo);
  const vigente = useRef(0);
  const { redCaida } = useApp();
  const recargar = useCallback(async () => {
    const n = ++vigente.current;
    setCargando(true);
    setError(null);
    try {
      const d = await cargar();
      if (n === vigente.current) setDatos(d);
    } catch (e) {
      if (n === vigente.current) setError(mensajeDe(e));
      if (e instanceof ErrorApi && e.red) redCaida();
    } finally {
      if (n === vigente.current) setCargando(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { if (activo) void recargar(); else setCargando(false); }, [recargar, activo]);
  return { datos, error, cargando, recargar, setDatos };
}
