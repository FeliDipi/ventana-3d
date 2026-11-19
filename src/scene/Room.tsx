import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import {
  CanvasTexture,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  PointLight,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
} from 'three'
import { THEME } from '../theme'
import { ROOM_BOUNDS } from './roomBounds'

/**
 * Habitación con la sección de la abertura y profundidad fija (ver `roomBounds.ts`):
 * las paredes nacen en los bordes del canvas. Todo se arma con planos unitarios que
 * se reescalan cuando cambia el tamaño del canvas; las texturas recalculan su
 * repetición para que la grilla siga midiendo lo mismo en metros.
 */
const C = THEME.room
const L = THEME.lights

/** Celda de la grilla de paredes y techo, y baldosa del piso (metros). */
const CELL = 0.05
const TILE = 0.1
/** Marcos de profundidad (z) y su ancho. El último coincide con la arista del fondo. */
const RING_Z = [-0.3, -0.6, -0.9]
const RING_BAND = 0.004
/** Separación de los marcos respecto de la superficie (evita z-fighting). */
const LIFT = 0.0015

function makeTexture(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void): Texture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  draw(ctx, size)
  const tex = new CanvasTexture(canvas)
  tex.colorSpace = SRGBColorSpace
  tex.wrapS = tex.wrapT = RepeatWrapping
  tex.anisotropy = 8
  return tex
}

/** Copia con su propia repetición (comparte la imagen). */
function cloneTex(t: Texture) {
  const c = t.clone()
  c.needsUpdate = true
  return c
}

function useTextures() {
  const textures = useMemo(() => {
    // Tablero 2×2 baldosas por repetición.
    const checker = makeTexture(128, (ctx, s) => {
      ctx.fillStyle = C.floorLight
      ctx.fillRect(0, 0, s, s)
      ctx.fillStyle = C.floorDark
      ctx.fillRect(0, 0, s / 2, s / 2)
      ctx.fillRect(s / 2, s / 2, s / 2, s / 2)
    })
    // Líneas blancas sobre negro: se usan como emissiveMap (el color lo pone el material).
    const lines = makeTexture(64, (ctx, s) => {
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, s, s)
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 2.5
      ctx.strokeRect(0, 0, s, s)
    })
    const t = {
      floor: checker,
      floorLines: lines,
      ceilingLines: cloneTex(lines),
      sideLines: cloneTex(lines),
      backLines: cloneTex(lines),
    }
    return t
  }, [])
  useEffect(() => () => Object.values(textures).forEach((t) => t.dispose()), [textures])
  return textures
}

const glow = new Color(C.gridLine).multiplyScalar(C.gridGlow)

export function Room() {
  const tex = useTextures()
  const floor = useRef<Mesh>(null)
  const ceiling = useRef<Mesh>(null)
  const left = useRef<Mesh>(null)
  const right = useRef<Mesh>(null)
  const back = useRef<Mesh>(null)
  const rings = useRef<Group>(null)
  const backLights = useRef<(PointLight | null)[]>([])
  const last = useRef({ w: -1, h: -1 })

  const ringParts = useMemo(() => {
    const geo = new PlaneGeometry(1, 1)
    const mat = new MeshBasicMaterial({ color: C.ring, toneMapped: false })
    return { geo, mat }
  }, [])
  useEffect(
    () => () => {
      ringParts.geo.dispose()
      ringParts.mat.dispose()
    },
    [ringParts],
  )

  useFrame(() => {
    const B = ROOM_BOUNDS
    const w = B.halfWidth
    const top = B.ceilingY
    const bottom = B.floorY
    if (Math.abs(w - last.current.w) < 1e-6 && Math.abs(top - last.current.h) < 1e-6) return
    last.current.w = w
    last.current.h = top
    const width = w * 2
    const height = top - bottom
    const depth = -B.backZ
    const midY = (top + bottom) / 2
    const midZ = B.backZ / 2

    floor.current?.position.set(0, bottom, midZ)
    floor.current?.scale.set(width, depth, 1)
    ceiling.current?.position.set(0, top, midZ)
    ceiling.current?.scale.set(width, depth, 1)
    left.current?.position.set(-w, midY, midZ)
    left.current?.scale.set(depth, height, 1)
    right.current?.position.set(w, midY, midZ)
    right.current?.scale.set(depth, height, 1)
    back.current?.position.set(0, midY, B.backZ)
    back.current?.scale.set(width, height, 1)

    tex.floor.repeat.set(width / (TILE * 2), depth / (TILE * 2))
    tex.floorLines.repeat.set(width / TILE, depth / TILE)
    tex.ceilingLines.repeat.set(width / CELL, depth / CELL)
    tex.sideLines.repeat.set(depth / CELL, height / CELL)
    tex.backLines.repeat.set(width / CELL, height / CELL)

    // Marcos: cuatro tiras por profundidad, apenas despegadas de cada superficie.
    const g = rings.current
    if (g) {
      g.children.forEach((child, i) => {
        const z = RING_Z[Math.floor(i / 4)]
        const side = i % 4
        const m = child as Mesh
        if (side === 0) {
          m.position.set(0, bottom + LIFT, z)
          m.rotation.set(-Math.PI / 2, 0, 0)
          m.scale.set(width, RING_BAND, 1)
        } else if (side === 1) {
          m.position.set(0, top - LIFT, z)
          m.rotation.set(Math.PI / 2, 0, 0)
          m.scale.set(width, RING_BAND, 1)
        } else {
          const sx = side === 2 ? -1 : 1
          m.position.set(sx * (w - LIFT), midY, z)
          m.rotation.set(0, -sx * (Math.PI / 2), 0)
          m.scale.set(RING_BAND, height, 1)
        }
      })
    }

    backLights.current.forEach((l, i) => {
      // Esquinas altas del fondo, detrás del pato: tiñen las paredes sin teñirlo a él.
      l?.position.set((i === 0 ? -1 : 1) * w * 0.9, top * 0.85, B.backZ + 0.02)
    })
  })

  return (
    <group>
      <hemisphereLight args={[L.hemisphere.sky, L.hemisphere.ground, L.hemisphere.intensity]} />
      <directionalLight color={L.directional.color} position={L.directional.position} intensity={L.directional.intensity} />
      {[0, 1].map((i) => (
        <pointLight
          key={i}
          ref={(l) => {
            backLights.current[i] = l
          }}
          color={L.back.color}
          intensity={L.back.intensity}
          distance={L.back.distance}
          decay={2}
        />
      ))}

      {/* Piso: tablero con grilla neón. */}
      <mesh ref={floor} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[1, 1]} />
        <meshLambertMaterial map={tex.floor} emissive={glow} emissiveMap={tex.floorLines} />
      </mesh>
      <mesh ref={ceiling} rotation={[Math.PI / 2, 0, 0]}>
        <planeGeometry args={[1, 1]} />
        <meshLambertMaterial color={C.ceiling} emissive={glow} emissiveMap={tex.ceilingLines} />
      </mesh>
      <mesh ref={left} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[1, 1]} />
        <meshLambertMaterial color={C.wallLeft} emissive={glow} emissiveMap={tex.sideLines} />
      </mesh>
      <mesh ref={right} rotation={[0, -Math.PI / 2, 0]}>
        <planeGeometry args={[1, 1]} />
        <meshLambertMaterial color={C.wallRight} emissive={glow} emissiveMap={tex.sideLines} />
      </mesh>
      <mesh ref={back}>
        <planeGeometry args={[1, 1]} />
        <meshLambertMaterial color={C.gridFill} emissive={glow} emissiveMap={tex.backLines} />
      </mesh>

      <group ref={rings}>
        {RING_Z.flatMap((z) =>
          [0, 1, 2, 3].map((side) => (
            <mesh key={`${z}-${side}`} geometry={ringParts.geo} material={ringParts.mat} />
          )),
        )}
      </group>
    </group>
  )
}

/** Marca en el centro del plano z = 0: debe quedar en el mismo píxel al mover la cámara. */
export function CenterMarker() {
  return (
    <mesh position={[0, 0, 0]} renderOrder={999}>
      <ringGeometry args={[0.004, 0.007, 32]} />
      <meshBasicMaterial color="#00e676" depthTest={false} transparent />
    </mesh>
  )
}
