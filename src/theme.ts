/**
 * Dirección artística "Violeta profundo": la habitación es una caja violeta oscura con
 * grilla neón, y los orbes y las formas flotantes brillan encima. Todos los colores de
 * la escena 3D están acá; los de la HUD, en las variables de `index.css`.
 */
export const THEME = {
  /** Fondo del canvas (fuera de la habitación) y color de la niebla. */
  background: '#12052a',

  room: {
    /** Relleno de las celdas de la grilla (pared del fondo). */
    gridFill: '#24104a',
    /** Líneas neón: brillan aunque no les dé la luz. */
    gridLine: '#b44dff',
    gridGlow: 0.65,
    /** Piso: el tablero del prototipo (baldosas de 10 cm) con la grilla encima. */
    floorLight: '#3a1a72',
    floorDark: '#271052',
    wallLeft: '#321566',
    wallRight: '#2a1258',
    ceiling: '#1c0a3c',
    /** Marcos de profundidad pegados a las paredes. */
    ring: '#c77dff',
  },

  lights: {
    hemisphere: { sky: '#e2c8ff', ground: '#2a0f52', intensity: 1.5 },
    directional: { color: '#ffffff', intensity: 1.8, position: [0.3, 0.8, 0.6] as [number, number, number] },
    /** Luz magenta al fondo, detrás del pato: gradiente de luz con la profundidad. */
    back: { color: '#ff4fd8', intensity: 0.06, distance: 0.6 },
  },

  /** Niebla lineal (distancia desde el ojo, metros): el fondo se apaga con la profundidad. */
  fog: { color: '#12052a', near: 0.85, far: 2.4 },

  /** Orbes: amarillo pato, cian, rosa y verde. Nada violeta: sobre violeta no se ve. */
  balls: ['#ffd600', '#2fd9ff', '#ff4fb0', '#7dff8a'],
  ballEmissive: 0.55,
  /** Anillo que deja una bola al rebotar. */
  bounceRing: '#ffffff',

  /** Formas flotantes. */
  floaters: ['#ffd600', '#2fd9ff', '#ff4fb0', '#c77dff', '#f2e6ff'],

  shadow: '#05010d',
  shadowOpacity: 0.55,
} as const
