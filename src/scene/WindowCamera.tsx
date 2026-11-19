import { useFrame, useThree } from '@react-three/fiber'
import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import type { PerspectiveCamera } from 'three'
import type { Viewport } from './physical'
import { updateRoomBounds } from './roomBounds'
import { apertureHalf, applyOffAxis, clampEye, damp, DEFAULT_EYE_Z, type Vec2, type Vec3, type ViewTarget } from './windowMath'

/** Con la cámara el filtrado está en el tracker: acá solo se interpola entre muestras. */
const CAMERA_LAMBDA = 30
const MOUSE_LAMBDA = 8
const RECOVER_LAMBDA = 2

interface Props {
  /** Objetivo escrito por el mouse o el tracker (metros, relativo al centro del canvas). */
  targetRef: RefObject<ViewTarget>
  /** Tamaño físico de la abertura. */
  viewportRef: RefObject<Viewport | null>
  /** Salida: punto de vista suavizado aplicado este frame (para el panel debug). */
  appliedRef?: RefObject<Vec3>
}

export function WindowCamera({ targetRef, viewportRef, appliedRef }: Props) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera
  const eye = useRef<Vec3>({ x: 0, y: 0, z: DEFAULT_EYE_Z })
  const half = useMemo<Vec2>(() => ({ x: 0, y: 0 }), [])

  useLayoutEffect(() => {
    camera.quaternion.identity()
    camera.position.set(0, 0, DEFAULT_EYE_Z)
  }, [camera])

  // Prioridad negativa: corre antes que el resto de la escena, que lee el ojo y los
  // límites de la habitación de este mismo frame.
  useFrame((state, dt) => {
    const step = Math.min(dt, 0.1)
    const t = targetRef.current
    const target = clampEye(t)
    const lambda = t.recovering ? RECOVER_LAMBDA : t.source === 'camera' ? CAMERA_LAMBDA : MOUSE_LAMBDA
    const e = eye.current
    e.x = damp(e.x, target.x, lambda, step)
    e.y = damp(e.y, target.y, lambda, step)
    e.z = damp(e.z, target.z, lambda, step)

    // Siempre mirando hacia -Z; solo se traslada.
    camera.position.set(e.x, e.y, e.z)
    camera.quaternion.identity()
    camera.updateMatrixWorld()

    // Abertura = tamaño físico del canvas. Se recalcula cada frame con el tamaño
    // actual del canvas (cubre el resize sin depender de cuándo se actualiza el viewport).
    const { width, height } = state.size
    apertureHalf(width, height, viewportRef.current?.mpp, half)
    applyOffAxis(camera, e, half.x, half.y)
    updateRoomBounds(half.x, half.y)

    if (appliedRef) {
      appliedRef.current.x = e.x
      appliedRef.current.y = e.y
      appliedRef.current.z = e.z
    }
  }, -1)

  return null
}
