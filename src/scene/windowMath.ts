import type { PerspectiveCamera } from 'three'

/**
 * Todas las unidades están en metros. El plano de la abertura (el canvas) está en
 * z = 0, centrado en el origen; la escena queda detrás (z < 0) y el ojo delante (z > 0).
 */
export const DEFAULT_EYE_Z = 0.55
/** Límites de seguridad del punto de vista (no son el rango de uso normal). */
export const EYE_LIMITS = { x: 0.6, y: 0.4, zMin: 0.2, zMax: 1.5 } as const
export const NEAR = 0.01
/** Diorama a escala real: el terreno llega a ~250 m y el cielo está a 1800 m. */
export const FAR = 2500

export interface Vec2 {
  x: number
  y: number
}

export interface Vec3 extends Vec2 {
  z: number
}

/**
 * Objetivo de punto de vista compartido entre el mouse y el tracker.
 * `recovering` pide una vuelta al centro más lenta (cara perdida).
 */
export interface ViewTarget extends Vec3 {
  recovering: boolean
  source: 'mouse' | 'camera'
}

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

export const clampEye = (v: Vec3): Vec3 => ({
  x: clamp(v.x, -EYE_LIMITS.x, EYE_LIMITS.x),
  y: clamp(v.y, -EYE_LIMITS.y, EYE_LIMITS.y),
  z: clamp(v.z, EYE_LIMITS.zMin, EYE_LIMITS.zMax),
})

/** Suavizado exponencial independiente del frame rate. */
export const damp = (current: number, target: number, lambda: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-lambda * dt))

/**
 * Proyección off-axis: frustum asimétrico desde el ojo hacia los cuatro bordes
 * de la abertura en z = 0. La cámara debe estar en `eye` mirando -Z.
 */
export function applyOffAxis(camera: PerspectiveCamera, eye: Vec3, halfW: number, halfH: number) {
  const s = NEAR / eye.z
  const left = (-halfW - eye.x) * s
  const right = (halfW - eye.x) * s
  const bottom = (-halfH - eye.y) * s
  const top = (halfH - eye.y) * s
  camera.near = NEAR
  camera.far = FAR
  camera.projectionMatrix.makePerspective(left, right, top, bottom, NEAR, FAR)
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()
}
