// Fotos de evidencia: se reducen (máx. 1280 px), se les imprime abajo la fecha, la hora, el
// equipo y quién la tomó, y se guardan como WebP (JPEG si el navegador no sabe hacer WebP).
// Se guardan en IndexedDB hasta que la planilla o la incidencia se envía.
import { guardar, leer, sha256 } from './local';

export interface FotoLocal { id: string; blob: Blob; mime: string; bytes: number; sha256: string; tomada_en: string }

const LADO = 1280;

async function cargar(archivo: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(archivo, { imageOrientation: 'from-image' } as ImageBitmapOptions); } catch { /* abajo */ }
  }
  const url = URL.createObjectURL(archivo);
  try {
    return await new Promise((ok, mal) => { const i = new Image(); i.onload = () => ok(i); i.onerror = mal; i.src = url; });
  } finally {
    URL.revokeObjectURL(url);
  }
}

const aBlob = (c: HTMLCanvasElement, tipo: string, calidad: number) =>
  new Promise<Blob | null>((ok) => c.toBlob(ok, tipo, calidad));

export async function prepararFoto(archivo: Blob, marca: string[]): Promise<FotoLocal> {
  const img = await cargar(archivo);
  const k = Math.min(1, LADO / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k);
  c.height = Math.round(img.height * k);
  const g = c.getContext('2d')!;
  g.drawImage(img, 0, 0, c.width, c.height);
  // Marca de agua: franja oscura abajo con los datos
  const alto = Math.max(18, Math.round(c.width / 48));
  const franja = alto * (marca.length + 0.8);
  g.fillStyle = 'rgba(0,0,0,0.62)';
  g.fillRect(0, c.height - franja, c.width, franja);
  g.fillStyle = '#ffffff';
  g.font = `600 ${alto}px "IBM Plex Mono", ui-monospace, monospace`;
  g.textBaseline = 'top';
  marca.forEach((t, i) => g.fillText(t, alto * 0.6, c.height - franja + alto * (0.4 + i)));
  g.fillStyle = '#f2b705';
  g.fillRect(0, c.height - franja, Math.max(4, alto / 3), franja);

  let blob = await aBlob(c, 'image/webp', 0.72);
  if (!blob || blob.type !== 'image/webp') blob = await aBlob(c, 'image/jpeg', 0.78);
  if (!blob) throw new Error('No se pudo procesar la foto');
  const tomada = new Date().toISOString();
  return {
    id: crypto.randomUUID(), blob, mime: blob.type, bytes: blob.size,
    sha256: await sha256(await blob.arrayBuffer()), tomada_en: tomada,
  };
}

export const guardarFoto = (f: FotoLocal) => guardar('fotos', f.id, f);
export const leerFoto = (id: string) => leer<FotoLocal>('fotos', id);

/** Ruta en Storage: <sucursal>/<año>/<mes>/<id>.webp — la base solo acepta la carpeta de su sucursal */
export function rutaDe(f: FotoLocal, sucursal: string) {
  const d = new Date(f.tomada_en);
  return `${sucursal}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${f.id}.${f.mime === 'image/webp' ? 'webp' : 'jpg'}`;
}
export const evidenciaDe = (f: FotoLocal, sucursal: string) =>
  ({ id: f.id, ruta: rutaDe(f, sucursal), sha256: f.sha256, bytes: f.bytes, mime: f.mime, tomada_en: f.tomada_en });
