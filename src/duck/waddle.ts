/*
 * Caminata del pato. El modelo no trae ciclo de caminar (sus clips son jump, happy,
 * dance, wings, stun y kick), así que se dibuja sobre el grupo que lo contiene: gira
 * hacia donde va, se inclina en la zancada y rola de una pata a la otra.
 * Adaptado de tuxdi-site-webapp/components/About/AboutHero/bigDuckWalk.ts.
 */

export interface Walk {
  x: number
  /** Rumbo en radianes; 0 = mirando a +Z (hacia la ventana). */
  yaw: number
  speed: number
  /** 0..1: fracción de la velocidad máxima; maneja el bamboleo. */
  pace: number
  /** Fase de la zancada, en radianes. */
  stride: number
}

export const createWalk = (x = 0): Walk => ({ x, yaw: 0, speed: 0, pace: 0, stride: 0 })

/** Bamboleo para el grupo del modelo, escalado por el ritmo: quieto es quieto. */
export const waddlePose = (walk: Walk) => {
  const p = walk.pace
  return {
    roll: Math.sin(walk.stride) * 0.075 * p,
    /** Fracción de la altura del pato. */
    bob: Math.abs(Math.sin(walk.stride)) * 0.035 * p,
    lean: 0.07 * p,
  }
}

/** Gira `from` hacia `to` como máximo `maxStep` radianes, por el lado corto. */
export function turnTowards(from: number, to: number, maxStep: number) {
  let d = to - from
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return from + Math.max(-maxStep, Math.min(maxStep, d))
}
