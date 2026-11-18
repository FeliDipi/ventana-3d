import { useEffect, useMemo } from 'react'
import { CanvasTexture, RepeatWrapping, SRGBColorSpace, type Texture } from 'three'
import { THEME } from '../theme'
import { ROOM, ROOM_SCALE } from './roomBounds'

/**
 * Habitación de tamaño fijo en unidades de mundo. No depende del aspect ratio
 * del canvas, así que conserva sus proporciones al redimensionar.
 * La grilla y el tablero del prototipo, en colores Tuxdi (ver `theme.ts`).
 */
const FLOOR_Y = ROOM.floorY
const CEILING_Y = ROOM.ceilingY
const HALF_WIDTH = ROOM.halfWidth
const BACK_Z = ROOM.backZ
const DEPTH = -BACK_Z
const HEIGHT = CEILING_Y - FLOOR_Y
/** Espesor de piso y techo: rellena el frente si la abertura es más alta que la habitación. */
const SLAB = 1

const C = THEME.room
const L = THEME.lights

function makeTexture(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void, repeatX: number, repeatY: number): Texture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  draw(ctx, size)
  const tex = new CanvasTexture(canvas)
  tex.colorSpace = SRGBColorSpace
  tex.wrapS = tex.wrapT = RepeatWrapping
  tex.repeat.set(repeatX, repeatY)
  tex.anisotropy = 8
  return tex
}

function useTextures() {
  const textures = useMemo(() => {
    const TILE = 0.1 // baldosa de 10 cm virtuales
    // Tablero 2×2 baldosas por repetición.
    const floor = makeTexture(
      128,
      (ctx, s) => {
        ctx.fillStyle = C.floorLight
        ctx.fillRect(0, 0, s, s)
        ctx.fillStyle = C.floorDark
        ctx.fillRect(0, 0, s / 2, s / 2)
        ctx.fillRect(s / 2, s / 2, s / 2, s / 2)
      },
      (HALF_WIDTH * 2) / (TILE * 2),
      DEPTH / (TILE * 2),
    )

    const CELL = 0.05
    const grid = makeTexture(
      64,
      (ctx, s) => {
        ctx.fillStyle = C.gridFill
        ctx.fillRect(0, 0, s, s)
        ctx.strokeStyle = C.gridLine
        ctx.lineWidth = 4
        ctx.strokeRect(0, 0, s, s)
      },
      (HALF_WIDTH * 2) / CELL,
      HEIGHT / CELL,
    )
    return { floor, grid }
  }, [])
  useEffect(
    () => () => {
      textures.floor.dispose()
      textures.grid.dispose()
    },
    [textures],
  )
  return textures
}

export function Room() {
  const { floor, grid } = useTextures()

  return (
    <group scale={ROOM_SCALE}>
      <hemisphereLight args={[L.hemisphere.sky, L.hemisphere.ground, L.hemisphere.intensity]} />
      <directionalLight color={L.directional.color} position={L.directional.position} intensity={L.directional.intensity} />

      {/* Piso con baldosas. */}
      <mesh position={[0, FLOOR_Y, BACK_Z / 2]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[HALF_WIDTH * 2, DEPTH]} />
        <meshLambertMaterial map={floor} />
      </mesh>
      {/* Bloque bajo el piso: tapa el vacío si la abertura es más alta que la habitación. */}
      <mesh position={[0, FLOOR_Y - 0.002 - SLAB / 2, BACK_Z / 2]}>
        <boxGeometry args={[HALF_WIDTH * 2, SLAB, DEPTH]} />
        <meshLambertMaterial color={C.slab} />
      </mesh>

      {/* Techo. */}
      <mesh position={[0, CEILING_Y + SLAB / 2, BACK_Z / 2]}>
        <boxGeometry args={[HALF_WIDTH * 2, SLAB, DEPTH]} />
        <meshLambertMaterial color={C.ceiling} />
      </mesh>

      {/* Paredes laterales. */}
      <mesh position={[-HALF_WIDTH, (FLOOR_Y + CEILING_Y) / 2, BACK_Z / 2]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[DEPTH, HEIGHT]} />
        <meshLambertMaterial color={C.wallLeft} />
      </mesh>
      <mesh position={[HALF_WIDTH, (FLOOR_Y + CEILING_Y) / 2, BACK_Z / 2]} rotation={[0, -Math.PI / 2, 0]}>
        <planeGeometry args={[DEPTH, HEIGHT]} />
        <meshLambertMaterial color={C.wallRight} />
      </mesh>

      {/* Pared del fondo con cuadrícula. */}
      <mesh position={[0, (FLOOR_Y + CEILING_Y) / 2, BACK_Z]}>
        <planeGeometry args={[HALF_WIDTH * 2, HEIGHT]} />
        <meshLambertMaterial map={grid} />
      </mesh>
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
