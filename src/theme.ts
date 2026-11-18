/**
 * Dirección artística "Lavanda clara": el hero claro de tuxdi.com sobre la grilla del
 * prototipo. Todos los colores de la escena 3D están acá; los de la HUD, en las
 * variables de `index.css` (mismos valores).
 */
export const THEME = {
  /** Fondo del canvas (fuera de la habitación). */
  background: '#fbf5ff',

  room: {
    /** Pared del fondo: la grilla del prototipo (celdas de 5 cm). */
    gridFill: '#fbf5ff',
    gridLine: '#d8a6ff',
    /** Piso: el tablero del prototipo (baldosas de 10 cm). */
    floorLight: '#eac7ff',
    floorDark: '#d8a6ff',
    wallLeft: '#e9d7ff',
    wallRight: '#f1e6ff',
    ceiling: '#f7f1ff',
    /** Bloque bajo el piso. */
    slab: '#c9a7ff',
  },

  lights: {
    /** Cielo blanco y rebote lila: el pato toma un poco de violeta desde abajo. */
    hemisphere: { sky: '#ffffff', ground: '#e9d7ff', intensity: 2.1 },
    directional: { color: '#ffffff', intensity: 1.3, position: [0.3, 0.8, 0.6] as [number, number, number] },
  },

  /** Orbes: amarillo pato, violeta, cian y rosa del sitio. */
  balls: ['#ffd600', '#af2eff', '#2fd9ff', '#e467a8'],
  ballEmissive: 0.2,
  /** Sombras violetas, como las contact shadows de tuxdi.com. */
  shadow: '#4c2882',
  shadowOpacity: 0.35,
} as const
