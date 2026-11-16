import { useFrame, useThree } from '@react-three/fiber'
import { useLayoutEffect, useRef, type RefObject } from 'react'
import type { PerspectiveCamera } from 'three'
import type { Viewport } from './physical'
import { applyOffAxis, clampEye, damp, DEFAULT_EYE_Z, type Vec3, type ViewTarget } from './windowMath'

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

  useLayoutEffect(() => {
    camera.quaternion.identity()
    camera.position.set(0, 0, DEFAULT_EYE_Z)
  }, [camera])

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
    const mpp = viewportRef.current?.mpp ?? 0.3 / 1000
    const { width, height } = state.size
    applyOffAxis(camera, e, (width * mpp) / 2, (height * mpp) / 2)

    if (appliedRef) {
      appliedRef.current.x = e.x
      appliedRef.current.y = e.y
      appliedRef.current.z = e.z
    }
  })

  return null
}
