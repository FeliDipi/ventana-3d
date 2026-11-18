import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef, type RefObject } from 'react'
import {
  CanvasTexture,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three'
import type { DuckApi } from '../duck/Duck'
import { fresnelRim, RIM_CACHE_KEY } from '../duck/fresnelRim'
import { THEME } from '../theme'
import type { Viewport } from '../scene/physical'
import { ROOM_BOUNDS } from '../scene/roomBounds'
import { clamp, damp, type Vec3 } from '../scene/windowMath'
import {
  AIM_JITTER,
  BALL_RADIUS,
  ballSpeed,
  DOUBLE_GAP_S,
  doubleChance,
  LEAD_MAX,
  LEAD_MIN,
  FIRST_BALL_DELAY_S,
  HIT_RADIUS,
  INVULNERABLE_S,
  MAX_BALLS,
  WINDUP_MAX_S,
  WINDUP_SHARE,
  progress,
  spawnInterval,
} from './difficulty'
import type { GameRuntime } from './useGame'

/** Las bolas nacen justo delante de la pared del fondo. */
const SPAWN_Z = ROOM_BOUNDS.backZ + 0.03
/** Fracción de la media abertura donde puede aparecer una bola (vista desde el ojo). */
const SPAWN_REACH = 0.7
/** Margen a paredes, piso y techo al nacer. */
const WALL_MARGIN = 0.01
/** Tras cruzar el plano del ojo, la bola sigue un poco más (sale por el borde) y se libera. */
const DESPAWN_PAST_EYE = 0.15
/** Suavizado de la velocidad del ojo usada para anticipar. */
const EYE_VEL_LAMBDA = 6

const TRAIL = 5
/** Separación temporal entre fantasmas de la estela. */
const TRAIL_STEP_S = 0.022

const COLORS = THEME.balls
/** Halo additivo alrededor del orbe (no hay bloom): diámetro en radios de bola. */
const HALO_SCALE = 4.2
/** La bola sale chica del pico y se infla en vuelo (solo visual: el golpe usa HIT_RADIUS). */
const BIRTH_SCALE = 0.3
const GROW_S = 0.3

interface Slot {
  active: boolean
  /** Ya se decidió golpe o esquiva. */
  judged: boolean
  age: number
  pos: Vector3
  prev: Vector3
  vel: Vector3
  ball: Mesh
  ballMat: MeshStandardMaterial
  halo: Sprite
  haloMat: SpriteMaterial
  ghosts: Mesh[]
  ghostMats: MeshBasicMaterial[]
  shadow: Mesh
  shadowMat: MeshBasicMaterial
}

function makeGlowTexture() {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(255,255,255,0.9)')
  g.addColorStop(0.25, 'rgba(255,255,255,0.35)')
  g.addColorStop(0.6, 'rgba(255,255,255,0.08)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  return new CanvasTexture(canvas)
}

function makeShadowTexture() {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(0,0,0,1)')
  g.addColorStop(0.5, 'rgba(0,0,0,0.6)')
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  return new CanvasTexture(canvas)
}

/** Pool fijo de bolas: se crea una vez y solo se muestran/ocultan. */
function createPool() {
  const group = new Group()
  const sphere = new SphereGeometry(BALL_RADIUS, 32, 20)
  const plane = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2)
  const shadowTex = makeShadowTexture()
  const glowTex = makeGlowTexture()
  const slots: Slot[] = []

  for (let i = 0; i < MAX_BALLS; i++) {
    const ballMat = new MeshStandardMaterial({ roughness: 0.18, metalness: 0 })
    // El mismo borde violeta del pato: los orbes son de la misma familia.
    ballMat.onBeforeCompile = fresnelRim
    ballMat.customProgramCacheKey = () => RIM_CACHE_KEY
    const ball = new Mesh(sphere, ballMat)
    ball.visible = false
    group.add(ball)

    const haloMat = new SpriteMaterial({
      map: glowTex,
      transparent: true,
      depthWrite: false,
      opacity: 0.35,
    })
    const halo = new Sprite(haloMat)
    halo.scale.setScalar(BALL_RADIUS * HALO_SCALE)
    ball.add(halo)

    const ghosts: Mesh[] = []
    const ghostMats: MeshBasicMaterial[] = []
    for (let k = 0; k < TRAIL; k++) {
      const m = new MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        opacity: 0.3 * (1 - k / TRAIL),
      })
      const g = new Mesh(sphere, m)
      g.scale.setScalar(1 - (k + 1) * 0.13)
      g.visible = false
      ghostMats.push(m)
      ghosts.push(g)
      group.add(g)
    }

    const shadowMat = new MeshBasicMaterial({
      map: shadowTex,
      transparent: true,
      depthWrite: false,
      color: THEME.shadow,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    })
    const shadow = new Mesh(plane, shadowMat)
    shadow.visible = false
    shadow.renderOrder = -1
    group.add(shadow)

    slots.push({
      active: false,
      judged: false,
      age: 0,
      pos: new Vector3(),
      prev: new Vector3(),
      vel: new Vector3(),
      ball,
      ballMat,
      halo,
      haloMat,
      ghosts,
      ghostMats,
      shadow,
      shadowMat,
    })
  }

  const dispose = () => {
    sphere.dispose()
    plane.dispose()
    shadowTex.dispose()
    glowTex.dispose()
    for (const s of slots) {
      s.ballMat.dispose()
      s.haloMat.dispose()
      s.shadowMat.dispose()
      s.ghostMats.forEach((m) => m.dispose())
    }
  }
  return { group, slots, dispose }
}

function hide(s: Slot) {
  s.active = false
  s.ball.visible = false
  s.shadow.visible = false
  s.ghosts.forEach((g) => (g.visible = false))
}

interface Props {
  gameRef: RefObject<GameRuntime>
  /** Ojo aplicado a la cámara este frame (el que ves): blanco y referencia de colisión. */
  appliedRef: RefObject<Vec3>
  viewportRef: RefObject<Viewport | null>
  /** El pato que lanza: si todavía no cargó, las bolas nacen al azar en el fondo. */
  duckRef: RefObject<DuckApi | null>
  onDodge: () => void
  onHit: () => void
}

export function Balls({ gameRef, appliedRef, viewportRef, duckRef, onDodge, onHit }: Props) {
  const pool = useMemo(() => createPool(), [])
  const sim = useRef({
    runId: -1,
    /** Tiempo de juego (solo avanza jugando y sin pausa). */
    t: 0,
    nextSpawn: FIRST_BALL_DELAY_S,
    /** Duración del amague del próximo tiro y si ya se le avisó al pato. */
    windup: WINDUP_MAX_S,
    windupFired: false,
    /** Segundo tiro agendado (tiempo de juego), o -1. */
    followUp: -1,
    invulnerableUntil: 0,
    colorIndex: 0,
    lastEye: { x: 0, y: 0 },
    eyeVel: { x: 0, y: 0 },
  })
  const tmpColor = useMemo(() => new Color(), [])
  const origin = useMemo(() => new Vector3(), [])

  useEffect(() => () => pool.dispose(), [pool])

  /** Sin pato: punto al azar de la abertura, prolongado desde el ojo hasta el fondo. */
  const randomOrigin = (eye: Vec3, out: Vector3) => {
    const vp = viewportRef.current
    const halfW = vp ? vp.apertureW / 2 : 0.17
    const halfH = vp ? vp.apertureH / 2 : 0.1
    const ax = (Math.random() * 2 - 1) * SPAWN_REACH * halfW
    const ay = (Math.random() * 2 - 1) * SPAWN_REACH * halfH
    const k = (eye.z - SPAWN_Z) / eye.z
    return out.set(eye.x + k * (ax - eye.x), eye.y + k * (ay - eye.y), SPAWN_Z)
  }

  const spawn = (eye: Vec3, from: Vector3) => {
    const s = pool.slots.find((x) => !x.active)
    if (!s) return
    const st = sim.current

    const r = BALL_RADIUS + WALL_MARGIN
    const sx = clamp(from.x, -ROOM_BOUNDS.halfWidth + r, ROOM_BOUNDS.halfWidth - r)
    const sy = clamp(from.y, ROOM_BOUNDS.floorY + r, ROOM_BOUNDS.ceilingY - r)
    const sz = clamp(from.z, ROOM_BOUNDS.backZ + r, -r)
    s.pos.set(sx, sy, sz)
    s.prev.copy(s.pos)

    // Blanco: donde va a estar tu cabeza (anticipación creciente) más un error menor al radio de golpe.
    const speed = ballSpeed(st.t)
    const travel = Math.hypot(eye.x - sx, eye.y - sy, eye.z - sz) / speed
    const lead = (LEAD_MIN + (LEAD_MAX - LEAD_MIN) * progress(st.t)) * travel
    const ang = Math.random() * Math.PI * 2
    const jit = Math.sqrt(Math.random()) * AIM_JITTER
    const tx = eye.x + st.eyeVel.x * lead + Math.cos(ang) * jit
    const ty = eye.y + st.eyeVel.y * lead + Math.sin(ang) * jit
    s.vel.set(tx - sx, ty - sy, eye.z - sz).setLength(speed)

    const color = COLORS[st.colorIndex++ % COLORS.length]
    s.ballMat.color.set(color)
    s.ballMat.emissive.copy(tmpColor.set(color)).multiplyScalar(THEME.ballEmissive)
    s.haloMat.color.set(color)
    s.ghostMats.forEach((m) => m.color.set(color))
    s.active = true
    s.judged = false
    s.age = 0
  }

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1)
    const g = gameRef.current
    const st = sim.current
    const eye = appliedRef.current

    // Velocidad suavizada del ojo (para anticipar).
    if (dt > 0) {
      st.eyeVel.x = damp(st.eyeVel.x, (eye.x - st.lastEye.x) / dt, EYE_VEL_LAMBDA, dt)
      st.eyeVel.y = damp(st.eyeVel.y, (eye.y - st.lastEye.y) / dt, EYE_VEL_LAMBDA, dt)
    }
    st.lastEye.x = eye.x
    st.lastEye.y = eye.y

    if (g.runId !== st.runId) {
      st.runId = g.runId
      st.t = 0
      st.nextSpawn = FIRST_BALL_DELAY_S
      st.windup = WINDUP_MAX_S
      st.windupFired = false
      st.followUp = -1
      st.invulnerableUntil = 0
      pool.slots.forEach(hide)
    }

    const playing = g.phase === 'playing' && !g.paused
    // Tras perder, las bolas que quedaban siguen de largo sin colisionar.
    const moving = playing || g.phase === 'over'
    if (!moving) return

    if (playing) {
      st.t += dt
      const duck = duckRef.current
      // El pato amaga antes de soltar: avisa el tiro.
      if (duck && !st.windupFired && st.t >= st.nextSpawn - st.windup) {
        st.windupFired = true
        duck.windup(st.nextSpawn - st.t)
      }
      const shoot = () => spawn(eye, duck ? duck.throwBall(origin) : randomOrigin(eye, origin))
      if (st.followUp >= 0 && st.t >= st.followUp) {
        st.followUp = -1
        shoot()
      }
      while (st.t >= st.nextSpawn) {
        shoot()
        if (Math.random() < doubleChance(st.t)) st.followUp = st.t + DOUBLE_GAP_S
        const interval = spawnInterval(st.t)
        st.nextSpawn += interval
        st.windup = Math.min(WINDUP_MAX_S, interval * WINDUP_SHARE)
        st.windupFired = false
      }
    }

    for (const s of pool.slots) {
      if (!s.active) continue
      s.prev.copy(s.pos)
      s.pos.addScaledVector(s.vel, dt)
      s.age += dt

      // Juicio al cruzar el plano del ojo: se interpola el XY del cruce.
      if (!s.judged && s.prev.z < eye.z && s.pos.z >= eye.z) {
        s.judged = true
        const f = (eye.z - s.prev.z) / (s.pos.z - s.prev.z)
        const cx = s.prev.x + (s.pos.x - s.prev.x) * f
        const cy = s.prev.y + (s.pos.y - s.prev.y) * f
        const hitNow = Math.hypot(cx - eye.x, cy - eye.y) < HIT_RADIUS
        if (playing && hitNow) {
          if (st.t >= st.invulnerableUntil) {
            st.invulnerableUntil = st.t + INVULNERABLE_S
            onHit()
          }
          hide(s)
          continue
        }
        if (playing) onDodge()
      }
      if (s.pos.z > eye.z + DESPAWN_PAST_EYE) {
        hide(s)
        continue
      }

      const grow = BIRTH_SCALE + (1 - BIRTH_SCALE) * Math.min(1, s.age / GROW_S)
      s.ball.position.copy(s.pos)
      s.ball.scale.setScalar(grow)
      s.ball.visible = true
      for (let k = 0; k < TRAIL; k++) {
        const back = (k + 1) * TRAIL_STEP_S
        const ghost = s.ghosts[k]
        ghost.visible = s.age > back
        if (ghost.visible) {
          ghost.position.copy(s.pos).addScaledVector(s.vel, -back)
          ghost.scale.setScalar((1 - (k + 1) * 0.13) * grow)
        }
      }

      // Sombra en el piso: solo dentro de la habitación. Más chica y oscura cuanto más baja.
      const inRoom = s.pos.z < 0 && Math.abs(s.pos.x) < ROOM_BOUNDS.halfWidth
      s.shadow.visible = inRoom
      if (inRoom) {
        const h = Math.max(0, s.pos.y - ROOM_BOUNDS.floorY - BALL_RADIUS)
        s.shadow.position.set(s.pos.x, ROOM_BOUNDS.floorY + 0.001, s.pos.z)
        s.shadow.scale.setScalar(BALL_RADIUS * 2.6 * (1 + h * 2.5))
        s.shadowMat.opacity = THEME.shadowOpacity * clamp(1 - h / 0.4, 0.2, 1)
      }
    }
  })

  return <primitive object={pool.group} />
}
