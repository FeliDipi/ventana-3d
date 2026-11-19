import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef, type RefObject } from 'react'
import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  RingGeometry,
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
  bounceChance,
  BOUNCE_MAX_Z,
  BURST_COUNT,
  BURST_GAP_S,
  burstChance,
  CURVE_OFFSET,
  curveChance,
  DOUBLE_GAP_S,
  doubleChance,
  FAN_SPREAD,
  fanChance,
  FEINT_DELAY_S,
  FEINT_WINDUP_S,
  feintChance,
  FIRST_BALL_DELAY_S,
  HIT_RADIUS,
  INVULNERABLE_S,
  LEAD_MAX,
  LEAD_MIN,
  MAX_BALLS,
  progress,
  spawnInterval,
  WINDUP_MAX_S,
  WINDUP_SHARE,
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

const TRAIL = 7
/** Separación temporal entre fantasmas de la estela. */
const TRAIL_STEP_S = 0.02

const COLORS = THEME.balls
/** Halo aditivo alrededor del orbe (no hay bloom): diámetro en radios de bola. */
const HALO_SCALE = 5.5
/** La bola sale chica del pico y se infla en vuelo (solo visual: el golpe usa HIT_RADIUS). */
const BIRTH_SCALE = 0.3
const GROW_S = 0.3

/** Anillos que deja un rebote. */
const RINGS = 8
const RING_S = 0.45
const RING_GROW = 7
/** Despegue del anillo respecto de la superficie (evita z-fighting). */
const RING_LIFT = 0.002

type BallKind = 'straight' | 'curve' | 'bounce'

/** Superficie de rebote: plano `axis = plane`, con el interior hacia `sign`. */
interface Bounce {
  axis: 0 | 1
  plane: number
  sign: 1 | -1
  done: boolean
}

interface Slot {
  active: boolean
  /** Ya se decidió golpe o esquiva. */
  judged: boolean
  age: number
  kind: BallKind
  pos: Vector3
  prev: Vector3
  vel: Vector3
  /** Aceleración constante (efecto); cero en las demás. */
  acc: Vector3
  bounce: Bounce
  ball: Mesh
  ballMat: MeshStandardMaterial
  halo: Sprite
  haloMat: SpriteMaterial
  ghosts: Mesh[]
  ghostMats: MeshBasicMaterial[]
  shadow: Mesh
  shadowMat: MeshBasicMaterial
}

interface RingSlot {
  age: number
  mesh: Mesh
  mat: MeshBasicMaterial
}

interface Shot {
  /** Desvío lateral del blanco (abanico). */
  offsetX: number
  /** Error de puntería ya sorteado (el abanico comparte uno para no cerrar el hueco). */
  jitter?: { x: number; y: number }
  /** Tipo forzado; si no, se sortea. */
  kind?: BallKind
}

function radialTexture(stops: [number, string][]) {
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

/** Pool fijo de bolas: se crea una vez y solo se muestran/ocultan. */
function createPool() {
  const group = new Group()
  const sphere = new SphereGeometry(BALL_RADIUS, 32, 20)
  const plane = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2)
  const ringGeo = new RingGeometry(0.75, 1, 40)
  const shadowTex = radialTexture([
    [0, 'rgba(0,0,0,1)'],
    [0.5, 'rgba(0,0,0,0.6)'],
    [1, 'rgba(0,0,0,0)'],
  ])
  const glowTex = radialTexture([
    [0, 'rgba(255,255,255,0.95)'],
    [0.2, 'rgba(255,255,255,0.45)'],
    [0.55, 'rgba(255,255,255,0.1)'],
    [1, 'rgba(255,255,255,0)'],
  ])
  const slots: Slot[] = []

  for (let i = 0; i < MAX_BALLS; i++) {
    // Las bolas no se lavan con la niebla: son lo que hay que mirar.
    const ballMat = new MeshStandardMaterial({ roughness: 0.18, metalness: 0, fog: false })
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
      blending: AdditiveBlending,
      opacity: 0.6,
      fog: false,
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
        blending: AdditiveBlending,
        opacity: 0.45 * (1 - k / TRAIL),
        fog: false,
      })
      const g = new Mesh(sphere, m)
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
      kind: 'straight',
      pos: new Vector3(),
      prev: new Vector3(),
      vel: new Vector3(),
      acc: new Vector3(),
      bounce: { axis: 1, plane: 0, sign: 1, done: true },
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

  const rings: RingSlot[] = []
  for (let i = 0; i < RINGS; i++) {
    const mat = new MeshBasicMaterial({
      color: THEME.bounceRing,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
    })
    const mesh = new Mesh(ringGeo, mat)
    mesh.visible = false
    group.add(mesh)
    rings.push({ age: RING_S, mesh, mat })
  }

  const dispose = () => {
    sphere.dispose()
    plane.dispose()
    ringGeo.dispose()
    shadowTex.dispose()
    glowTex.dispose()
    for (const s of slots) {
      s.ballMat.dispose()
      s.haloMat.dispose()
      s.shadowMat.dispose()
      s.ghostMats.forEach((m) => m.dispose())
    }
    rings.forEach((r) => r.mat.dispose())
  }
  return { group, slots, rings, dispose }
}

function hide(s: Slot) {
  s.active = false
  s.ball.visible = false
  s.shadow.visible = false
  s.ghosts.forEach((g) => (g.visible = false))
}

/** Del lado exterior del plano de rebote, lo refleja al interior. */
function keepInside(v: Vector3, b: Bounce) {
  const c = v.getComponent(b.axis)
  if (b.sign * (c - b.plane) < 0) v.setComponent(b.axis, 2 * b.plane - c)
}

/** Superficies de rebote con su peso: piso más que paredes, techo lo menos. */
const BOUNCE_SURFACES = [
  { axis: 1, side: 'floor', weight: 3 },
  { axis: 0, side: 'left', weight: 1.5 },
  { axis: 0, side: 'right', weight: 1.5 },
  { axis: 1, side: 'ceiling', weight: 1 },
] as const

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
    /** El último tiro programado fue un amague (no se encadenan dos). */
    afterFeint: false,
    /** Tiros sin amague agendados (doble, ráfaga), en tiempo de juego. */
    queue: [] as number[],
    invulnerableUntil: 0,
    colorIndex: 0,
    lastEye: { x: 0, y: 0 },
    eyeVel: { x: 0, y: 0 },
  })
  const tmpColor = useMemo(() => new Color(), [])
  const origin = useMemo(() => new Vector3(), [])
  const target = useMemo(() => new Vector3(), [])
  const aux = useMemo(() => new Vector3(), [])

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

  const pickKind = (t: number): BallKind => {
    const r = Math.random()
    const c = curveChance(t)
    if (r < c) return 'curve'
    if (r < c + bounceChance(t)) return 'bounce'
    return 'straight'
  }

  /**
   * Rebote: se apunta a la imagen especular del blanco respecto de una superficie.
   * Devuelve false si ninguna superficie da un rebote dentro de la habitación.
   * No modifica `tgt` (usa `aux`).
   */
  const aimBounce = (s: Slot, tgt: Vector3, speed: number) => {
    const r = BALL_RADIUS
    const B = ROOM_BOUNDS
    const candidates: { axis: 0 | 1; plane: number; sign: 1 | -1; weight: number }[] = []
    for (const surf of BOUNCE_SURFACES) {
      const plane =
        surf.side === 'floor'
          ? B.floorY + r
          : surf.side === 'ceiling'
            ? B.ceilingY - r
            : surf.side === 'left'
              ? -B.halfWidth + r
              : B.halfWidth - r
      const sign: 1 | -1 = surf.side === 'floor' || surf.side === 'left' ? 1 : -1
      const a = s.pos.getComponent(surf.axis)
      const b = tgt.getComponent(surf.axis)
      // Inicio y blanco del lado de adentro.
      if (sign * (a - plane) <= 0 || sign * (b - plane) <= 0) continue
      const mirrored = 2 * plane - b
      const u = (a - plane) / (a - mirrored)
      const zCross = s.pos.z + u * (tgt.z - s.pos.z)
      if (zCross > BOUNCE_MAX_Z || zCross < s.pos.z + 0.1) continue
      candidates.push({ axis: surf.axis, plane, sign, weight: surf.weight })
    }
    if (!candidates.length) return false
    let pick = Math.random() * candidates.reduce((sum, c) => sum + c.weight, 0)
    const c = candidates.find((x) => (pick -= x.weight) < 0) ?? candidates[candidates.length - 1]
    const aim = aux.copy(tgt)
    aim.setComponent(c.axis, 2 * c.plane - tgt.getComponent(c.axis))
    s.vel.copy(aim).sub(s.pos).setLength(speed)
    s.bounce.axis = c.axis
    s.bounce.plane = c.plane
    s.bounce.sign = c.sign
    s.bounce.done = false
    return true
  }

  const spawn = (eye: Vec3, from: Vector3, shot: Shot) => {
    const s = pool.slots.find((x) => !x.active)
    if (!s) return
    const st = sim.current

    const r = BALL_RADIUS + WALL_MARGIN
    const sx = clamp(from.x, -ROOM_BOUNDS.halfWidth + r, ROOM_BOUNDS.halfWidth - r)
    const sy = clamp(from.y, ROOM_BOUNDS.floorY + r, ROOM_BOUNDS.ceilingY - r)
    const sz = clamp(from.z, ROOM_BOUNDS.backZ + r, -r)
    s.pos.set(sx, sy, sz)
    s.prev.copy(s.pos)
    s.acc.set(0, 0, 0)
    s.bounce.done = true

    // Blanco: donde va a estar tu cabeza (anticipación creciente) más un error menor al radio de golpe.
    const speed = ballSpeed(st.t)
    const travel = Math.hypot(eye.x - sx, eye.y - sy, eye.z - sz) / speed
    const lead = (LEAD_MIN + (LEAD_MAX - LEAD_MIN) * progress(st.t)) * travel
    let jx: number
    let jy: number
    if (shot.jitter) {
      jx = shot.jitter.x
      jy = shot.jitter.y
    } else {
      const ang = Math.random() * Math.PI * 2
      const jit = Math.sqrt(Math.random()) * AIM_JITTER
      jx = Math.cos(ang) * jit
      jy = Math.sin(ang) * jit
    }
    const tgt = target.set(
      eye.x + st.eyeVel.x * lead + jx + shot.offsetX,
      eye.y + st.eyeVel.y * lead + jy,
      eye.z,
    )

    let kind = shot.kind ?? pickKind(st.t)
    if (kind === 'curve') {
      // Aceleración lateral constante: sale apuntando a un costado y se cierra sobre el blanco.
      // Con vz constante cruza el plano del ojo en T exacto: v = (blanco − inicio − ½·a·T²)/T.
      const T = Math.hypot(tgt.x - sx, tgt.y - sy, tgt.z - sz) / speed
      // Mayormente horizontal, a veces en diagonal.
      const ang = (Math.random() < 0.5 ? 0 : Math.PI) + (Math.random() * 2 - 1) * 0.6
      const off = CURVE_OFFSET.min + Math.random() * (CURVE_OFFSET.max - CURVE_OFFSET.min)
      const dx = Math.cos(ang) * off
      const dy = Math.sin(ang) * off
      s.acc.set((2 * dx) / (T * T), (2 * dy) / (T * T), 0)
      s.vel.set((tgt.x - sx - dx) / T, (tgt.y - sy - dy) / T, (tgt.z - sz) / T)
    } else if (kind === 'bounce' && !aimBounce(s, tgt, speed)) {
      kind = 'straight'
    }
    if (kind === 'straight') s.vel.set(tgt.x - sx, tgt.y - sy, tgt.z - sz).setLength(speed)

    const color = COLORS[st.colorIndex++ % COLORS.length]
    s.ballMat.color.set(color)
    s.ballMat.emissive.copy(tmpColor.set(color)).multiplyScalar(THEME.ballEmissive)
    s.haloMat.color.set(color)
    s.ghostMats.forEach((m) => m.color.set(color))
    s.kind = kind
    s.active = true
    s.judged = false
    s.age = 0
  }

  const spawnRing = (s: Slot) => {
    const ring = pool.rings.reduce((oldest, r) => (r.age > oldest.age ? r : oldest), pool.rings[0])
    const b = s.bounce
    const m = ring.mesh
    m.position.copy(s.pos)
    m.position.setComponent(b.axis, b.plane - b.sign * (BALL_RADIUS - RING_LIFT))
    // El anillo nace en el plano XY (normal +Z): se gira hacia la normal de la superficie.
    if (b.axis === 1) m.rotation.set(b.sign > 0 ? -Math.PI / 2 : Math.PI / 2, 0, 0)
    else m.rotation.set(0, b.sign > 0 ? Math.PI / 2 : -Math.PI / 2, 0)
    ring.mat.color.copy(s.ballMat.color)
    ring.age = 0
    m.visible = true
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
      st.afterFeint = false
      st.queue.length = 0
      st.invulnerableUntil = 0
      pool.slots.forEach(hide)
    }

    // Los anillos de rebote se apagan solos, también en pausa visual.
    for (const ring of pool.rings) {
      if (ring.age >= RING_S) continue
      ring.age += dt
      const u = Math.min(1, ring.age / RING_S)
      ring.mesh.scale.setScalar(BALL_RADIUS * (1 + RING_GROW * (1 - (1 - u) * (1 - u))))
      ring.mat.opacity = (1 - u) * (1 - u)
      if (u >= 1) ring.mesh.visible = false
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
      const release = () => (duck ? duck.throwBall(origin) : randomOrigin(eye, origin))

      // Tiros sin amague agendados (doble, ráfaga).
      for (let i = st.queue.length - 1; i >= 0; i--) {
        if (st.t < st.queue[i]) continue
        st.queue.splice(i, 1)
        spawn(eye, release(), { offsetX: 0, kind: 'straight' })
      }

      while (st.t >= st.nextSpawn) {
        // Amague: el pato hace todo el gesto y no tira; el tiro de verdad llega enseguida.
        if (duck && !st.afterFeint && Math.random() < feintChance(st.t)) {
          duck.feint()
          st.afterFeint = true
          st.nextSpawn += FEINT_DELAY_S
          st.windup = FEINT_WINDUP_S
          st.windupFired = false
          continue
        }
        st.afterFeint = false

        const at = st.nextSpawn
        const r = Math.random()
        const fan = fanChance(st.t)
        let extra = 0
        if (r < fan) {
          // Abanico: tres bolas a la vez; el hueco queda entre la del medio y una del costado.
          const from = release()
          const ang = Math.random() * Math.PI * 2
          const jit = Math.sqrt(Math.random()) * AIM_JITTER * 0.5
          const jitter = { x: Math.cos(ang) * jit, y: Math.sin(ang) * jit }
          for (const offsetX of [-FAN_SPREAD, 0, FAN_SPREAD]) spawn(eye, from, { offsetX, jitter, kind: 'straight' })
        } else if (r < fan + burstChance(st.t)) {
          spawn(eye, release(), { offsetX: 0, kind: 'straight' })
          for (let k = 1; k < BURST_COUNT; k++) st.queue.push(at + k * BURST_GAP_S)
          extra = (BURST_COUNT - 1) * BURST_GAP_S
        } else {
          spawn(eye, release(), { offsetX: 0 })
          if (Math.random() < doubleChance(st.t)) st.queue.push(at + DOUBLE_GAP_S)
        }

        const interval = spawnInterval(st.t)
        st.nextSpawn += interval + extra
        st.windup = Math.min(WINDUP_MAX_S, interval * WINDUP_SHARE)
        st.windupFired = false
      }
    }

    for (const s of pool.slots) {
      if (!s.active) continue
      s.prev.copy(s.pos)
      s.pos.addScaledVector(s.vel, dt).addScaledVector(s.acc, 0.5 * dt * dt)
      s.vel.addScaledVector(s.acc, dt)
      s.age += dt

      // Rebote: al cruzar la superficie se refleja la posición y la velocidad.
      const b = s.bounce
      if (!b.done && b.sign * (s.pos.getComponent(b.axis) - b.plane) < 0) {
        b.done = true
        keepInside(s.pos, b)
        s.vel.setComponent(b.axis, -s.vel.getComponent(b.axis))
        spawnRing(s)
      }

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
          // Hacia atrás en la parábola exacta; tras el rebote, lo que cae afuera se refleja.
          ghost.position.copy(s.pos).addScaledVector(s.vel, -back).addScaledVector(s.acc, 0.5 * back * back)
          if (b.done && s.kind === 'bounce') keepInside(ghost.position, b)
          ghost.scale.setScalar((1 - (k + 1) * 0.1) * grow)
        }
      }

      // Sombra en el piso: solo dentro de la habitación. Más chica y oscura cuanto más baja.
      const inRoom = s.pos.z < 0 && Math.abs(s.pos.x) < ROOM_BOUNDS.halfWidth
      s.shadow.visible = inRoom
      if (inRoom) {
        const h = Math.max(0, s.pos.y - ROOM_BOUNDS.floorY - BALL_RADIUS)
        s.shadow.position.set(s.pos.x, ROOM_BOUNDS.floorY + 0.001, s.pos.z)
        s.shadow.scale.setScalar(BALL_RADIUS * 2.6 * (1 + h * 4))
        s.shadowMat.opacity = THEME.shadowOpacity * clamp(1 - h / 0.3, 0.2, 1)
      }
    }
  })

  return <primitive object={pool.group} />
}
