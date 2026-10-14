import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';

createRoot(document.getElementById('raiz')!).render(<StrictMode><App /></StrictMode>);

// El service worker guarda la app para abrirla sin internet. Una versión nueva espera
// y se activa en la pantalla de bloqueo, nunca a mitad de una planilla.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  window.addEventListener('load', () => {
    navigator.serviceWorker?.register('/sw.js').catch(() => { /* sin caché: la app igual funciona en línea */ });
  });
}
