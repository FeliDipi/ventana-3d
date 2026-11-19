/**
 * Medidas de la habitación, en metros de mundo. Abertura en z = 0; todo lo demás
 * está detrás (z < 0).
 *
 * La sección (ancho y alto) sigue a la abertura física: las cuatro paredes nacen en
 * los bordes del canvas y convergen hacia el fondo, que es lo que vende la "caja"
 * detrás del vidrio. La profundidad es fija. `WindowCamera` la actualiza cada frame,
 * así que quien lea `ROOM_BOUNDS` dentro de `useFrame` siempre ve los límites vivos.
 */
export const ROOM_DEPTH = 1.2

/** Mínimos de la sección: en una ventana muy chica el pato tiene que seguir entrando. */
const MIN_HALF_WIDTH = 0.12
const MIN_HALF_HEIGHT = 0.09

export const ROOM_BOUNDS = {
  floorY: -0.1,
  ceilingY: 0.1,
  halfWidth: 0.17,
  backZ: -ROOM_DEPTH,
}

/** Ajusta la sección a la media abertura (metros). Devuelve true si cambió. */
export function updateRoomBounds(halfW: number, halfH: number) {
  const w = Math.max(MIN_HALF_WIDTH, halfW)
  const h = Math.max(MIN_HALF_HEIGHT, halfH)
  if (Math.abs(w - ROOM_BOUNDS.halfWidth) < 1e-5 && Math.abs(h - ROOM_BOUNDS.ceilingY) < 1e-5) return false
  ROOM_BOUNDS.halfWidth = w
  ROOM_BOUNDS.floorY = -h
  ROOM_BOUNDS.ceilingY = h
  return true
}
