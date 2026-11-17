import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import {
  BoxGeometry,
  CatmullRomCurve3,
  DoubleSide,
  Group,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  Shape,
  ShapeGeometry,
  Vector3,
} from 'three'
import { mulberry32 } from './random'

/**
 * Mariposa ocasional: llega desde el jardín, cruza el hueco de la ventana, revolotea
 * unos centímetros delante de la pantalla (sale del monitor) y se vuelve a ir.
 *
 * La trayectoria delantera queda cerca del centro de la abertura; si igual se acerca
 * al borde de la imagen (cabeza muy desplazada), se desvanece en lugar de cortarse.
 */

const v = (x: number, y: number, z: number) => new Vector3(x, y, z)

// Coordenadas de la escena: pantalla en z = 0, afuera z < 0, delante z > 0 (metros).
const APPROACH = new CatmullRomCurve3([v(-0.9, 0.3, -3.2), v(-0.3, 0.1, -1.1), v(-0.02, 0.035, -0.3), v(0.0, 0.025, -0.03)])
const LEAVE = new CatmullRomCurve3([v(0.03, 0.03, -0.03), v(0.08, 0.05, -0.35), v(0.35, 0.14, -1.0), v(1.3, 0.45, -3.6)])

const T_APPROACH = 4.5
const T_HOVER = 6.5
const T_LEAVE = 4.0
const FLIGHT = T_APPROACH + T_HOVER + T_LEAVE
const FIRST_DELAY = 6
const GAP = [40, 80] as const

const easeOut = (t: number) => 1 - (1 - t) ** 2
const easeIn = (t: number) => t * t

function wingGeometry() {
  // Ala derecha en el plano XY (x = hacia afuera, y = hacia adelante), en metros.
  const s = new Shape()
  s.moveTo(0, 0.004)
  s.bezierCurveTo(0.006, 0.016, 0.02, 0.016, 0.022, 0.008)
  s.bezierCurveTo(0.023, 0.002, 0.016, 0.0, 0.012, -0.002)
  s.bezierCurveTo(0.018, -0.008, 0.012, -0.016, 0.004, -0.013)
  s.lineTo(0, -0.006)
  const g = new ShapeGeometry(s, 6)
  g.rotateX(Math.PI / 2) // ala horizontal, adelante = +Z
  return g
}

/** Posición en el instante `t` (s) desde el inicio del vuelo. */
function flightPosition(t: number, out: Vector3) {
  if (t < T_APPROACH) return APPROACH.getPointAt(easeOut(t / T_APPROACH), out)
  if (t < T_APPROACH + T_HOVER) {
    const h = (t - T_APPROACH) / T_HOVER
    const a = APPROACH.points[APPROACH.points.length - 1]
    const b = LEAVE.points[0]
    const bump = Math.sin(Math.PI * h)
    out.lerpVectors(a, b, h)
    out.x += bump * (0.028 * Math.sin(t * 1.9) + 0.012 * Math.sin(t * 4.3))
    out.y += bump * (0.016 * Math.sin(t * 2.6 + 1.0) + 0.006 * Math.sin(t * 5.1))
    out.z += bump * (0.075 + 0.015 * Math.sin(t * 1.3))
    return out
  }
  return LEAVE.getPointAt(easeIn(Math.min((t - T_APPROACH - T_HOVER) / T_LEAVE, 1)), out)
}

export function Butterfly() {
  const group = useRef<Group>(null)
  const left = useRef<Mesh>(null)
  const right = useRef<Mesh>(null)
  const bodyMesh = useRef<Mesh>(null)
  const state = useRef({ start: FIRST_DELAY, rand: mulberry32(7) })
  const tmp = useMemo(() => ({ pos: new Vector3(), next: new Vector3(), ndc: new Vector3() }), [])

  const { wing, body, wingMat, bodyMat } = useMemo(
    () => ({
      wing: wingGeometry(),
      body: new BoxGeometry(0.0022, 0.0022, 0.015),
      wingMat: new MeshBasicMaterial({ color: '#f6e4a0', side: DoubleSide, toneMapped: false, transparent: true }),
      bodyMat: new MeshBasicMaterial({ color: '#3a2c1e', toneMapped: false, transparent: true }),
    }),
    [],
  )

  useFrame(({ clock, camera }) => {
    const g = group.current
    if (!g || !left.current || !right.current || !bodyMesh.current) return
    const now = clock.elapsedTime
    const s = state.current
    let t = now - s.start
    if (t > FLIGHT) {
      s.start = now + MathUtils.lerp(GAP[0], GAP[1], s.rand())
      t = now - s.start
    }
    if (t < 0) {
      g.visible = false
      return
    }
    g.visible = true

    flightPosition(t, tmp.pos)
    flightPosition(t + 0.05, tmp.next)
    g.position.copy(tmp.pos)
    if (tmp.next.distanceToSquared(tmp.pos) > 1e-10) g.lookAt(tmp.next)

    // Aleteo rápido, con planeos cortos mientras revolotea.
    const glide = t > T_APPROACH && t < T_APPROACH + T_HOVER ? 0.5 + 0.5 * Math.sin(t * 0.9) : 1
    const flap = 0.15 + 1.1 * Math.abs(Math.sin(t * 13)) * glide
    // Misma rotación en ambas: el grupo espejado de la izquierda invierte el sentido.
    left.current.rotation.z = flap
    right.current.rotation.z = flap

    // Delante de la pantalla: desvanecer cerca del borde de la imagen.
    let opacity = 1
    if (tmp.pos.z > 0) {
      tmp.ndc.copy(tmp.pos).project(camera)
      opacity = 1 - MathUtils.smoothstep(Math.max(Math.abs(tmp.ndc.x), Math.abs(tmp.ndc.y)), 0.7, 0.9)
    }
    // (vía refs: el material compartido de las alas y el del cuerpo)
    ;(right.current.material as MeshBasicMaterial).opacity = opacity
    ;(bodyMesh.current.material as MeshBasicMaterial).opacity = opacity
  })

  return (
    <group ref={group} visible={false}>
      <mesh ref={bodyMesh} geometry={body} material={bodyMat} />
      <mesh ref={right} geometry={wing} material={wingMat} />
      {/* Ala izquierda: espejo de la derecha. */}
      <group scale={[-1, 1, 1]}>
        <mesh ref={left} geometry={wing} material={wingMat} />
      </group>
    </group>
  )
}
