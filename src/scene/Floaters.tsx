import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  CapsuleGeometry,
  Color,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  OctahedronGeometry,
  PlaneGeometry,
  TorusGeometry,
} from 'three'
import { fresnelRim, RIM_CACHE_KEY } from '../duck/fresnelRim'
import { THEME } from '../theme'
import { ROOM_BOUNDS } from './roomBounds'
import { clamp, DEFAULT_EYE_Z } from './windowMath'

/**
 * Formas geométricas flotando alrededor del juego: dan parallax a todas las
 * profundidades, incluso delante de la pantalla (z > 0). Las posiciones son relativas
 * (u, v ∈ [-1, 1] de la sección visible a esa profundidad) y se mapean cada frame, así
 * se adaptan al tamaño del canvas. Nada entra en el carril central pato → ojo
 * (|u| < 0,5 con v < 0,5), para no tapar las bolas.
 */

type Shape = 'box' | 'torus' | 'ico' | 'oct' | 'capsule' | 'ring'

interface FloaterDef {
  shape: Shape
  u: number
  v: number
  z: number
  /** Tamaño aproximado (metros). */
  size: number
  color: number
}

const FLOATERS: FloaterDef[] = [
  // Delante de la pantalla, en las esquinas y chicos.
  { shape: 'box', u: -0.86, v: 0.74, z: 0.08, size: 0.02, color: 0 },
  { shape: 'torus', u: 0.84, v: -0.72, z: 0.12, size: 0.024, color: 1 },
  { shape: 'oct', u: 0.88, v: 0.78, z: 0.05, size: 0.018, color: 2 },
  { shape: 'ico', u: -0.88, v: -0.76, z: 0.1, size: 0.018, color: 3 },
  // Dentro de la habitación, cerca de paredes y techo.
  { shape: 'torus', u: -0.78, v: 0.55, z: -0.18, size: 0.045, color: 2 },
  { shape: 'box', u: 0.8, v: -0.35, z: -0.22, size: 0.035, color: 3 },
  { shape: 'ico', u: 0.72, v: 0.62, z: -0.32, size: 0.04, color: 0 },
  { shape: 'oct', u: 0.08, v: 0.82, z: -0.36, size: 0.03, color: 1 },
  { shape: 'capsule', u: -0.8, v: -0.4, z: -0.42, size: 0.05, color: 4 },
  { shape: 'ring', u: -0.55, v: 0.8, z: -0.55, size: 0.055, color: 1 },
  { shape: 'ico', u: 0.78, v: 0.05, z: -0.6, size: 0.045, color: 2 },
  { shape: 'box', u: -0.74, v: 0.08, z: -0.7, size: 0.04, color: 1 },
  { shape: 'torus', u: 0.5, v: 0.82, z: -0.76, size: 0.05, color: 4 },
  { shape: 'capsule', u: 0.82, v: -0.62, z: -0.84, size: 0.045, color: 0 },
]

/** Media sección visible a la profundidad z: dentro de la habitación es la pared; delante se achica hacia el ojo. */
const reachAt = (z: number) => (z <= 0 ? 1 : Math.max(0.05, (DEFAULT_EYE_Z - z) / DEFAULT_EYE_Z))

function radial(stops: [number, string][]) {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  for (const [at, c] of stops) g.addColorStop(at, c)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  return new CanvasTexture(canvas)
}

/** Generador pseudoaleatorio con semilla: las formas arrancan igual entre recargas. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function build() {
  const group = new Group()
  const rand = mulberry32(7)

  const geos: Record<Shape, BufferGeometry> = {
    box: new BoxGeometry(0.62, 0.62, 0.62),
    torus: new TorusGeometry(0.36, 0.14, 16, 40),
    ico: new IcosahedronGeometry(0.5, 0),
    oct: new OctahedronGeometry(0.5, 0),
    capsule: new CapsuleGeometry(0.2, 0.5, 6, 16),
    ring: new TorusGeometry(0.45, 0.035, 8, 56),
  }
  const faceted = (s: Shape) => s === 'ico' || s === 'oct' || s === 'box'

  // Un material por color y sombreado; todos con el mismo borde violeta del pato.
  const mats = new Map<string, MeshPhysicalMaterial>()
  const matFor = (color: number, flat: boolean) => {
    const key = `${color}:${flat}`
    let m = mats.get(key)
    if (!m) {
      const c = THEME.floaters[color % THEME.floaters.length]
      m = new MeshPhysicalMaterial({
        color: c,
        emissive: new Color(c).multiplyScalar(0.18),
        roughness: 0.28,
        metalness: 0,
        clearcoat: 0.8,
        clearcoatRoughness: 0.2,
        flatShading: flat,
      })
      m.onBeforeCompile = fresnelRim
      m.customProgramCacheKey = () => RIM_CACHE_KEY
      mats.set(key, m)
    }
    return m
  }

  const shadowTex = radial([
    [0, 'rgba(0,0,0,1)'],
    [0.5, 'rgba(0,0,0,0.55)'],
    [1, 'rgba(0,0,0,0)'],
  ])
  const shadowGeo = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2)
  const shadowMats: MeshBasicMaterial[] = []

  const items = FLOATERS.map((def) => {
    const mesh = new Mesh(geos[def.shape], matFor(def.color, faceted(def.shape)))
    mesh.scale.setScalar(def.size)
    mesh.rotation.set(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI)
    group.add(mesh)
    let shadow: Mesh | null = null
    let shadowMat: MeshBasicMaterial | null = null
    if (def.z < 0) {
      shadowMat = new MeshBasicMaterial({
        map: shadowTex,
        color: THEME.shadow,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
      })
      shadowMats.push(shadowMat)
      shadow = new Mesh(shadowGeo, shadowMat)
      shadow.renderOrder = -1
      group.add(shadow)
    }
    return {
      def,
      mesh,
      shadow,
      shadowMat,
      phase: rand() * Math.PI * 2,
      bob: 0.005 + rand() * 0.008,
      bobRate: 0.6 + rand() * 0.7,
      spin: [(rand() - 0.5) * 0.9, (rand() - 0.5) * 0.9, (rand() - 0.5) * 0.5] as const,
    }
  })

  const dispose = () => {
    Object.values(geos).forEach((g) => g.dispose())
    mats.forEach((m) => m.dispose())
    shadowTex.dispose()
    shadowGeo.dispose()
    shadowMats.forEach((m) => m.dispose())
  }
  return { group, items, dispose }
}

export function Floaters() {
  const built = useMemo(() => build(), [])
  useEffect(() => () => built.dispose(), [built])

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.1)
    const t = state.clock.elapsedTime
    const B = ROOM_BOUNDS
    const hw = B.halfWidth
    const hh = B.ceilingY

    for (const it of built.items) {
      const { def, mesh } = it
      const half = def.size * 0.6
      const k = reachAt(def.z)
      const limX = Math.max(0, hw * k - half)
      const limY = Math.max(0, hh * k - half)
      const x = clamp(def.u * hw * k + Math.sin(t * it.bobRate * 0.6 + it.phase) * it.bob * 0.6, -limX, limX)
      const y = clamp(def.v * hh * k + Math.sin(t * it.bobRate + it.phase) * it.bob, -limY, limY)
      mesh.position.set(x, y, def.z)
      mesh.rotation.x += it.spin[0] * dt
      mesh.rotation.y += it.spin[1] * dt
      mesh.rotation.z += it.spin[2] * dt

      if (it.shadow && it.shadowMat) {
        const h = Math.max(0, y - half - B.floorY)
        it.shadow.position.set(x, B.floorY + 0.001, def.z)
        it.shadow.scale.setScalar(def.size * (1.1 + h * 5))
        it.shadowMat.opacity = THEME.shadowOpacity * 0.7 * clamp(1 - h / 0.22, 0.12, 1)
      }
    }
  })

  return <primitive object={built.group} />
}
