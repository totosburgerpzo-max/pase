/** Pase · Totos Burger — tokens de Tailwind. Los colores salen de variables CSS
 *  (src/estilos.css): el modo claro y el oscuro cambian sin duplicar clases. */
const token = (nombre) => `rgb(var(--${nombre}) / <alpha-value>)`;

module.exports = {
  content: [__dirname + '/src/**/*.{ts,tsx}', __dirname + '/index.html'],
  theme: {
    extend: {
      colors: {
        fondo: token('fondo'),
        superficie: token('superficie'),
        hundido: token('hundido'),
        tinta: token('tinta'),
        tenue: token('tenue'),
        linea: token('linea'),
        mostaza: token('mostaza'),
        'mostaza-tinta': token('mostaza-tinta'),
        'mostaza-texto': token('mostaza-texto'),
        papel: token('papel'),
        'papel-tinta': token('papel-tinta'),
        bien: token('bien'),
        mal: token('mal'),
        aviso: token('aviso'),
        info: token('info'),
      },
      fontFamily: {
        display: ['"Big Shoulders Display"', '"Arial Narrow"', '"Roboto Condensed"', 'sans-serif'],
        sans: ['Barlow', '"Segoe UI"', 'Roboto', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'Menlo', 'Consolas', 'monospace'],
      },
      keyframes: {
        'pin-sacudir': {
          '0%, 100%': { transform: 'translateX(0)' },
          '20%': { transform: 'translateX(-9px)' },
          '40%': { transform: 'translateX(8px)' },
          '60%': { transform: 'translateX(-5px)' },
          '80%': { transform: 'translateX(3px)' },
        },
        'ticket-sale': {
          '0%': { transform: 'translateY(-38%)', clipPath: 'inset(38% 0 0 0)' },
          '100%': { transform: 'translateY(0)', clipPath: 'inset(0 0 0 0)' },
        },
        subir: {
          '0%': { transform: 'translateY(12px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
      },
      animation: {
        'pin-sacudir': 'pin-sacudir .34s ease-in-out',
        'ticket-sale': 'ticket-sale .7s cubic-bezier(.2,.8,.2,1) both',
        subir: 'subir .22s ease-out both',
      },
    },
  },
};
