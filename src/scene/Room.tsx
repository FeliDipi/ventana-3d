import { useMemo } from 'react'
import { CanvasTexture, RepeatWrapping, SRGBColorSpace, type Texture } from 'three'

/**
 * Habitación de tamaño fijo en unidades de mundo. No depende del aspect ratio
 * del canvas, así que conserva sus proporciones al redimensionar.
 *
 * Abertura en z = 0. Todo lo demás está detrás (z < 0).
 */
const FLOOR_Y = -0.22
const CEILING_Y = 0.28
const HALF_WIDTH = 0.7
const BACK_Z = -1.4
const DEPTH = -BACK_Z
const HEIGHT = CEILING_Y - FLOOR_Y
/** Espesor de piso y techo: rellena el frente si la abertura es más alta que la habitación. */
const SLAB = 1

const COLUMN = { x: 0, z: -0.15, size: 0.05 }
const SPHERE = { x: 0.05, y: -0.02, z: -0.55, r: 0.07 }

/**
 * Escala de la habitación (metros reales). La abertura ahora tiene el tamaño físico
 * del canvas (~0.30 m en una notebook), así que la escena se achica para conservar
 * proporciones parecidas a las del primer PoC. Ajustar a gusto.
 */
const ROOM_SCALE = 0.7

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
  return useMemo(() => {
    const TILE = 0.1 // baldosa de 10 cm virtuales
    // Tablero 2×2 baldosas por repetición.
    const floor = makeTexture(
      128,
      (ctx, s) => {
        ctx.fillStyle = '#d9cbb3'
        ctx.fillRect(0, 0, s, s)
        ctx.fillStyle = '#8a6f52'
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
        ctx.fillStyle = '#eef2f6'
        ctx.fillRect(0, 0, s, s)
        ctx.strokeStyle = '#3d6fa8'
        ctx.lineWidth = 4
        ctx.strokeRect(0, 0, s, s)
      },
      (HALF_WIDTH * 2) / CELL,
      HEIGHT / CELL,
    )
    return { floor, grid }
  }, [])
}

export function Room() {
  const { floor, grid } = useTextures()

  return (
    <group scale={ROOM_SCALE}>
      <ambientLight intensity={1.4} />
      <directionalLight position={[0.3, 0.8, 0.6]} intensity={1.6} />

      {/* Piso con baldosas. */}
      <mesh position={[0, FLOOR_Y, BACK_Z / 2]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[HALF_WIDTH * 2, DEPTH]} />
        <meshLambertMaterial map={floor} />
      </mesh>
      {/* Bloque oscuro bajo el piso: tapa el vacío si la abertura es más alta que la habitación. */}
      <mesh position={[0, FLOOR_Y - 0.002 - SLAB / 2, BACK_Z / 2]}>
        <boxGeometry args={[HALF_WIDTH * 2, SLAB, DEPTH]} />
        <meshLambertMaterial color="#3a3530" />
      </mesh>

      {/* Techo. */}
      <mesh position={[0, CEILING_Y + SLAB / 2, BACK_Z / 2]}>
        <boxGeometry args={[HALF_WIDTH * 2, SLAB, DEPTH]} />
        <meshLambertMaterial color="#c9ced6" />
      </mesh>

      {/* Paredes laterales. */}
      <mesh position={[-HALF_WIDTH, (FLOOR_Y + CEILING_Y) / 2, BACK_Z / 2]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[DEPTH, HEIGHT]} />
        <meshLambertMaterial color="#9fb3c8" />
      </mesh>
      <mesh position={[HALF_WIDTH, (FLOOR_Y + CEILING_Y) / 2, BACK_Z / 2]} rotation={[0, -Math.PI / 2, 0]}>
        <planeGeometry args={[DEPTH, HEIGHT]} />
        <meshLambertMaterial color="#b4c4d4" />
      </mesh>

      {/* Pared del fondo con cuadrícula. */}
      <mesh position={[0, (FLOOR_Y + CEILING_Y) / 2, BACK_Z]}>
        <planeGeometry args={[HALF_WIDTH * 2, HEIGHT]} />
        <meshLambertMaterial map={grid} />
      </mesh>

      {/* Columna angosta cerca del plano de pantalla. */}
      <mesh position={[COLUMN.x, (FLOOR_Y + CEILING_Y) / 2, COLUMN.z]}>
        <boxGeometry args={[COLUMN.size, HEIGHT, COLUMN.size]} />
        <meshLambertMaterial color="#2b2f36" />
      </mesh>

      {/* Esfera parcialmente oculta detrás de la columna. */}
      <mesh position={[SPHERE.x, SPHERE.y, SPHERE.z]}>
        <sphereGeometry args={[SPHERE.r, 48, 32]} />
        <meshLambertMaterial color="#e8432e" />
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
