import { useFrame, useLoader } from '@react-three/fiber'
import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react'
import {
  AnimationMixer,
  Box3,
  CanvasTexture,
  LoopOnce,
  MathUtils,
  Vector3,
  type AnimationAction,
  type AnimationClip,
  type Group,
  type MeshStandardMaterial,
  type Object3D,
  type SkinnedMesh,
  type Texture,
} from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import type { GameRuntime } from '../game/useGame'
import type { Viewport } from '../scene/physical'
import { ROOM_BOUNDS } from '../scene/roomBounds'
import { clamp, damp, type Vec3 } from '../scene/windowMath'
import { THEME } from '../theme'
import {
  BLINK_DOUBLE_CHANCE,
  BLINK_WAIT_MAX,
  BLINK_WAIT_MIN,
  CLIP_NAMES,
  getClipMotionStart,
  getFaceClips,
  MASTER_CLIP_NAME,
  measureRigLeverage,
} from './duckClips'
import { createDuckMaterial, LIT_BRILLOS } from './litMaterial'
import { quack } from './quack'
import { createWalk, turnTowards, waddlePose } from './waddle'

const MODEL_URL = `${import.meta.env.BASE_URL}models/duck.glb`

/** Altura del pato en metros de mundo (la habitación mide lo que la abertura, ~0,17 m de alto). */
export const DUCK_HEIGHT = 0.075
/** Franja del fondo por donde camina. */
export const DUCK_Z = ROOM_BOUNDS.backZ + 0.1
const WALL_MARGIN = 0.06
/** Fracción de la media abertura (vista desde el ojo) dentro de la que elige destino. */
const VIEW_REACH = 0.6

const WALK_SPEED = 0.12 // m/s
/** Metros por media zancada. */
const STRIDE_LEN = 0.022
const TURN_RATE = 7 // rad/s
/** Al caminar no se pone de perfil del todo: tres cuartos, para que se le vea la cara. */
const WALK_YAW = Math.PI / 2 * 0.8

/** Mirada: la cabeza toma la mayor parte del giro y los ojos el resto. */
const LOOK_HEAD_SHARE = 0.75
const LOOK_HEAD_YAW = MathUtils.degToRad(40)
const LOOK_HEAD_UP = MathUtils.degToRad(22)
const LOOK_HEAD_DOWN = MathUtils.degToRad(12)
const LOOK_EYE_LIMIT = MathUtils.degToRad(18)

/** Rebote al soltar la bola. */
const RELEASE_S = 0.5
/** Sacudida tras un amague sin tiro. */
const FEINT_S = 0.5

/** Esquivas seguidas que lo marean ("stun"). */
const STUN_STREAK = 6

type FaceTarget = 'R_eye_AngryShape' | 'L_eye_AngryShape' | 'L_eye_happyShape' | 'R_eye_happyShape' | 'PicoUp_OpenShape' | 'PicoDown_OpenShape'

export interface DuckApi {
  /** Empieza el amague del tiro: la bola sale en `seconds`. */
  windup(seconds: number): void
  /** Suelta la bola: devuelve en `out` el punto del pico (mundo) y dispara el rebote. */
  throwBall(out: Vector3): Vector3
  /** Corta el amague sin tirar: sacude la cabeza, como burlándose. */
  feint(): void
  react(kind: 'hit' | 'dodge'): void
}

interface Props {
  apiRef: RefObject<DuckApi | null>
  gameRef: RefObject<GameRuntime>
  appliedRef: RefObject<Vec3>
  viewportRef: RefObject<Viewport | null>
}

function makeShadowTexture() {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(0,0,0,0.85)')
  g.addColorStop(0.55, 'rgba(0,0,0,0.45)')
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  return new CanvasTexture(canvas)
}

const smooth = (u: number) => u * u * (3 - 2 * u)

function useDuckModel() {
  const gltf = useLoader(GLTFLoader, MODEL_URL, (loader) => {
    loader.setMeshoptDecoder(MeshoptDecoder)
  })

  return useMemo(() => {
    const scene = gltf.scene

    let map = null as Texture | null
    scene.traverse((o) => {
      const m = (o as SkinnedMesh).material as MeshStandardMaterial | undefined
      if (!map && m?.map) map = m.map
    })
    const general = createDuckMaterial(map)
    const brillos = createDuckMaterial(map, LIT_BRILLOS)

    let face = null as SkinnedMesh | null
    scene.traverse((o) => {
      const mesh = o as SkinnedMesh
      if (!mesh.isMesh) return
      const isBrillos = (mesh.material as MeshStandardMaterial).name?.includes('Brillos')
      mesh.material = isBrillos ? brillos : general
      mesh.frustumCulled = false
      if (mesh.morphTargetDictionary?.PicoUp_OpenShape !== undefined) face = mesh
    })

    // Medido con el modelo todavía sin padre: su espacio de mundo es el propio.
    scene.updateMatrixWorld(true)
    measureRigLeverage(scene)
    const box = new Box3().setFromObject(scene)
    const size = box.getSize(new Vector3())
    const center = box.getCenter(new Vector3())
    const scale = DUCK_HEIGHT / size.y

    const find = (suffix: string) => {
      let found: Object3D | null = null
      scene.traverse((o) => {
        if (!found && o.name.endsWith(suffix)) found = o
      })
      if (!found) console.warn(`[duck] no hay nodo que termine en "${suffix}"`)
      return found as Object3D | null
    }
    const head = find('Head_Base')
    const eyes = [find('L_Eye_Joint'), find('R_Eye_Joint')].filter((e): e is Object3D => !!e)

    // El pico: la punta delantera del modelo, a media altura de la cabeza. Guardado en el
    // espacio del hueso de la cabeza para que siga sus giros.
    const beakLocal = new Vector3()
    if (head) {
      const headPos = head.getWorldPosition(new Vector3())
      const beak = new Vector3(center.x, headPos.y + (box.max.y - headPos.y) * 0.38, box.max.z - size.z * 0.04)
      beakLocal.copy(head.worldToLocal(beak))
    }

    const offset = new Vector3(-center.x * scale, -box.min.y * scale, -center.z * scale)
    return { scene, animations: gltf.animations, face, head, eyes, beakLocal, scale, offset, materials: [general, brillos] }
  }, [gltf])
}

export function Duck({ apiRef, gameRef, appliedRef, viewportRef }: Props) {
  const model = useDuckModel()
  const rootRef = useRef<Group>(null)
  const bodyRef = useRef<Group>(null)
  const squashRef = useRef<Group>(null)
  const shadowTex = useMemo(() => makeShadowTexture(), [])

  const rig = useMemo(() => {
    const mixer = new AnimationMixer(model.scene)
    const clips = new Map<string, AnimationClip>(model.animations.map((c) => [c.name, c]))
    const face = model.face
    const faceClips = getFaceClips(clips.get(MASTER_CLIP_NAME), face?.morphTargetDictionary)
    const blink = faceClips ? mixer.clipAction(faceClips.blink) : null
    if (blink) {
      blink.setLoop(LoopOnce, 1)
      blink.clampWhenFinished = false
    }
    return { mixer, clips, blink }
  }, [model])

  const st = useRef({
    walk: createWalk(0),
    targetX: 0,
    pause: 0.6,
    windup: { active: false, t: 0, dur: 0.4 },
    release: -1,
    feint: -1,
    beakOpen: 0,
    angry: 0,
    happy: 0,
    streak: 0,
    body: null as AnimationAction | null,
    look: { x: 0, y: 0 },
    blink: { wait: 2, chain: 0 },
    phase: '' as string,
    runId: -1,
  })

  useEffect(() => {
    const onFinished = (e: { action: AnimationAction }) => {
      if (e.action === st.current.body) {
        e.action.fadeOut(0.35)
        st.current.body = null
      }
    }
    rig.mixer.addEventListener('finished', onFinished)
    return () => {
      rig.mixer.removeEventListener('finished', onFinished)
      rig.mixer.stopAllAction()
    }
  }, [rig])

  useEffect(
    () => () => {
      shadowTex.dispose()
    },
    [shadowTex],
  )

  const playBody = useCallback((name: string) => {
    const clip = rig.clips.get(name)
    if (!clip) return
    const s = st.current
    s.body?.fadeOut(0.12)
    const action = rig.mixer.clipAction(clip)
    action.reset()
    action.setLoop(LoopOnce, 1)
    action.clampWhenFinished = true
    action.time = getClipMotionStart(clip)
    action.fadeIn(0.12).play()
    s.body = action
  }, [rig])

  const stopBody = () => {
    const s = st.current
    s.body?.fadeOut(0.25)
    s.body = null
  }

  const pickTarget = () => {
    const s = st.current
    const eye = appliedRef.current
    const vp = viewportRef.current
    const halfW = vp ? vp.apertureW / 2 : 0.17
    const k = (eye.z - DUCK_Z) / eye.z
    const lim = ROOM_BOUNDS.halfWidth - WALL_MARGIN
    const a = clamp(eye.x + k * (-VIEW_REACH * halfW - eye.x), -lim, lim)
    const b = clamp(eye.x + k * (VIEW_REACH * halfW - eye.x), -lim, lim)
    let x = a + Math.random() * (b - a)
    // Que valga la pena caminar.
    if (Math.abs(x - s.walk.x) < 0.06) x = clamp(s.walk.x + (x < s.walk.x ? -0.1 : 0.1), a, b)
    s.targetX = x
  }

  useEffect(() => {
    const tmp = new Vector3()
    apiRef.current = {
      windup(seconds) {
        const s = st.current
        s.windup.active = true
        s.windup.t = 0
        s.windup.dur = Math.max(0.12, seconds)
      },
      throwBall(out) {
        const s = st.current
        s.windup.active = false
        s.release = 0
        quack()
        const { head, beakLocal, scene } = model
        if (head) {
          head.updateWorldMatrix(true, false)
          return head.localToWorld(out.copy(beakLocal))
        }
        scene.updateWorldMatrix(true, false)
        return out.copy(scene.getWorldPosition(tmp)).setY(ROOM_BOUNDS.floorY + DUCK_HEIGHT * 0.7)
      },
      feint() {
        const s = st.current
        s.windup.active = false
        s.feint = 0
      },
      react(kind) {
        const s = st.current
        if (kind === 'hit') {
          s.streak = 0
          s.angry = 0
          s.happy = 1
          playBody(CLIP_NAMES.HAPPY)
        } else {
          s.streak++
          s.angry = Math.min(1, s.angry + 0.4)
          if (s.streak % STUN_STREAK === 0) playBody(CLIP_NAMES.STUN)
        }
      },
    }
    return () => {
      apiRef.current = null
    }
  }, [apiRef, model, playBody])

  const lookFrom = useMemo(() => new Vector3(), [])
  const lookAt = useMemo(() => new Vector3(), [])

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1)
    const s = st.current
    const g = gameRef.current
    const eye = appliedRef.current
    const root = rootRef.current
    const body = bodyRef.current
    const squash = squashRef.current
    if (!root || !body || !squash) return

    // Cambios de fase y de partida.
    if (g.runId !== s.runId) {
      s.runId = g.runId
      s.streak = 0
      s.angry = 0
      s.windup.active = false
      s.feint = -1
      stopBody()
    }
    if (g.phase !== s.phase) {
      if (g.phase === 'over') playBody(CLIP_NAMES.DANCE)
      s.phase = g.phase
    }

    // ---- Caminata ----
    const w = s.walk
    const busy = s.windup.active || (s.release >= 0 && s.release < RELEASE_S * 0.6) || s.feint >= 0
    const canWalk = !busy && !g.paused && g.phase !== 'over'
    const facePlayer = Math.atan2(eye.x - w.x, eye.z - DUCK_Z)
    let desiredYaw = facePlayer
    let wanted = 0
    const dx = s.targetX - w.x
    if (canWalk) {
      if (s.pause > 0) s.pause -= dt
      else if (Math.abs(dx) < 0.008) {
        s.pause = 0.3 + Math.random() * 1.1
        pickTarget()
      } else {
        desiredYaw = Math.sign(dx) * WALK_YAW
        const aligned = Math.max(0, Math.cos(w.yaw - desiredYaw))
        const brake = clamp(Math.abs(dx) / 0.05, 0.25, 1)
        wanted = WALK_SPEED * aligned * aligned * brake
      }
    }
    w.yaw = turnTowards(w.yaw, desiredYaw, TURN_RATE * dt)
    w.speed = damp(w.speed, wanted, 6, dt)
    const step = Math.min(Math.abs(dx), w.speed * dt)
    w.x += Math.sign(dx) * step
    w.pace = w.speed / WALK_SPEED
    w.stride += (w.speed * dt * Math.PI) / STRIDE_LEN

    const pose = waddlePose(w)
    root.position.set(w.x, ROOM_BOUNDS.floorY, DUCK_Z)
    body.position.y = pose.bob * DUCK_HEIGHT
    body.rotation.set(pose.lean, w.yaw, pose.roll, 'YXZ')

    // ---- Amague y tiro ----
    let sy = 1
    let tilt = 0
    let beak = 0
    if (s.windup.active) {
      s.windup.t += dt
      const e = smooth(Math.min(1, s.windup.t / s.windup.dur))
      sy = 1 - 0.14 * e
      tilt = -0.24 * e
      beak = e
    } else if (s.release >= 0) {
      const r = (s.release += dt)
      sy = 1 + 0.17 * Math.exp(-r * 7) * Math.cos(r * 18)
      tilt = 0.3 * Math.exp(-r * 6) * Math.cos(r * 12)
      beak = r < 0.15 ? 1 : 0
      if (r > RELEASE_S) s.release = -1
    } else if (s.feint >= 0) {
      // Se endereza de golpe con un temblor chico: el tiro no salió.
      const f = (s.feint += dt)
      sy = 1 + 0.07 * Math.exp(-f * 8) * Math.cos(f * 20)
      tilt = 0.1 * Math.exp(-f * 6) * Math.sin(f * 22)
      if (f > FEINT_S) s.feint = -1
    }
    // Sacudida de cabeza del amague (se suma a la mirada más abajo).
    const shake = s.feint >= 0 ? 0.45 * Math.exp(-s.feint * 5) * Math.sin(s.feint * 32) : 0
    squash.scale.set(1 / Math.sqrt(sy), sy, 1 / Math.sqrt(sy))
    squash.rotation.x = tilt

    // ---- Animación esqueletal ----
    rig.mixer.update(dt)

    if (rig.blink && !s.body) {
      s.blink.wait -= dt
      if (s.blink.wait <= 0) {
        rig.blink.reset().play()
        if (s.blink.chain === 0 && Math.random() < BLINK_DOUBLE_CHANCE) {
          s.blink.chain = 1
          s.blink.wait = 0.28
        } else {
          s.blink.chain = 0
          s.blink.wait = MathUtils.randFloat(BLINK_WAIT_MIN, BLINK_WAIT_MAX)
        }
      }
    }

    // ---- Mirada: te sigue con la cabeza (después del mixer, que no la pise) ----
    const { head, eyes, scene, face } = model
    const bodyWeight = s.body ? s.body.getEffectiveWeight() : 0
    if (head && bodyWeight < 0.01) {
      head.getWorldPosition(lookFrom)
      scene.worldToLocal(lookFrom)
      scene.worldToLocal(lookAt.set(eye.x, eye.y, eye.z)).sub(lookFrom)
      let ty = clamp(Math.atan2(lookAt.x, lookAt.z), -1.7, 1.7)
      let tx = -Math.atan2(lookAt.y, Math.hypot(lookAt.x, lookAt.z))
      if (!Number.isFinite(tx + ty)) {
        tx = s.look.x
        ty = s.look.y
      }
      s.look.x = damp(s.look.x, tx, 10, dt)
      s.look.y = damp(s.look.y, ty, 10, dt)
      let hx = s.look.x * LOOK_HEAD_SHARE
      let hy = s.look.y * LOOK_HEAD_SHARE
      const reach = Math.hypot(hy / LOOK_HEAD_YAW, hx / (hx < 0 ? LOOK_HEAD_UP : LOOK_HEAD_DOWN))
      if (reach > 1) {
        hx /= reach
        hy /= reach
      }
      head.rotation.order = 'YXZ'
      head.rotation.y = hy + shake
      head.rotation.x = hx
      for (const e of eyes) {
        e.rotation.y = clamp(s.look.y - hy, -LOOK_EYE_LIMIT, LOOK_EYE_LIMIT)
        e.rotation.x = clamp(s.look.x - hx, -LOOK_EYE_LIMIT, LOOK_EYE_LIMIT)
      }
    }

    // ---- Cara ----
    s.beakOpen = damp(s.beakOpen, beak, 30, dt)
    s.angry = damp(s.angry, 0, 0.5, dt)
    s.happy = damp(s.happy, 0, 0.8, dt)
    if (face?.morphTargetDictionary && face.morphTargetInfluences) {
      const dict = face.morphTargetDictionary
      const inf = face.morphTargetInfluences
      const set = (name: FaceTarget, v: number) => {
        const i = dict[name]
        if (i !== undefined) inf[i] = v
      }
      set('PicoUp_OpenShape', s.beakOpen)
      set('PicoDown_OpenShape', s.beakOpen)
      set('R_eye_AngryShape', s.angry * 0.9)
      set('L_eye_AngryShape', s.angry * 0.9)
      set('R_eye_happyShape', s.happy)
      set('L_eye_happyShape', s.happy)
    }
  })

  return (
    <group ref={rootRef}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.001, 0]} renderOrder={-1}>
        <planeGeometry args={[DUCK_HEIGHT * 0.95, DUCK_HEIGHT * 0.8]} />
        <meshBasicMaterial
          map={shadowTex}
          color={THEME.shadow}
          opacity={THEME.shadowOpacity * 1.4}
          transparent
          depthWrite={false}
          polygonOffset
          polygonOffsetFactor={-1}
        />
      </mesh>
      <group ref={bodyRef}>
        <group ref={squashRef}>
          <primitive object={model.scene} scale={model.scale} position={model.offset} />
        </group>
      </group>
    </group>
  )
}
