/**
 * Medidas de la habitación. `ROOM` está en unidades locales del grupo de `Room`;
 * `ROOM_BOUNDS` ya está escalado a metros de mundo (lo usa el juego).
 * Abertura en z = 0; todo lo demás está detrás (z < 0).
 */
export const ROOM = {
  floorY: -0.22,
  ceilingY: 0.28,
  halfWidth: 0.7,
  backZ: -1.4,
} as const

/**
 * Escala de la habitación (metros reales). La abertura tiene el tamaño físico del
 * canvas (~0.30 m en una notebook), así que la escena se achica para conservar
 * proporciones parecidas a las del primer PoC. Ajustar a gusto.
 */
export const ROOM_SCALE = 0.7

export const ROOM_BOUNDS = {
  floorY: ROOM.floorY * ROOM_SCALE,
  ceilingY: ROOM.ceilingY * ROOM_SCALE,
  halfWidth: ROOM.halfWidth * ROOM_SCALE,
  backZ: ROOM.backZ * ROOM_SCALE,
} as const
