import { FaceLandmarker, FilesetResolver, type NormalizedLandmark } from '@mediapipe/tasks-vision'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { PhysicalSettings, Viewport } from '../scene/physical'
import { clampEye, DEFAULT_EYE_Z, type Vec2, type Vec3, type ViewTarget } from '../scene/windowMath'
import { OneEuroFilter } from './oneEuro'

// La versión del wasm debe coincidir con la de @mediapipe/tasks-vision en package.json.
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm'
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

const DETECT_HZ = 60
const LOST_MS = 800
/** Si la cara estuvo ausente más que esto, el filtro arranca de cero. */
const FILTER_RESET_MS = 200
/** Umbrales más permisivos que el 0.5 por defecto: sostienen la cara en giros grandes. */
const MIN_CONFIDENCE = 0.3
/** Centros de iris (topología Face Mesh de 478 puntos): ojo izquierdo y derecho del usuario. */
const IRIS_LEFT = 468
const IRIS_RIGHT = 473
/** FOV vertical que asume el pipeline de geometría de MediaPipe para la matriz de pose. */
const MP_VFOV_DEG = 63
/** IPD aproximada de la cara canónica de MediaPipe, en mm. */
const MP_CANONICAL_IPD_MM = 63
/** Solo se calibra la escala de profundidad con la cara casi de frente. */
const CALIB_MAX_ANGLE_DEG = 15
const CALIB_EMA = 0.03

export type TrackingStatus = 'off' | 'loading' | 'tracking' | 'no-face' | 'denied' | 'error'

export interface TrackingDebug {
  /** Centro de la cabeza (a la altura de los ojos) respecto del lente de la webcam, en metros. */
  head: Vec3 | null
  /** Distancia interpupilar medida en píxeles de la imagen. */
  ipdPx: number
  /** Giro de la cabeza: + = mirando hacia la derecha del usuario / hacia arriba. */
  yawDeg: number
  pitchDeg: number
  /** Escala que convierte la profundidad de la pose de MediaPipe a la nuestra (null = sin pose). */
  poseScale: number | null
  /** La escala ya se calibró con al menos un cuadro frontal. */
  poseCalibrated: boolean
  /** Punto de vista enviado a la cámara 3D (relativo al centro del canvas). */
  eye: Vec3
  face: boolean
  /** Detecciones por segundo medidas. */
  rate: number
  /** Resolución real del video. */
  videoSize: Vec2
}

interface Session {
  cancelled: boolean
  video: HTMLVideoElement
  stream: MediaStream | null
  landmarker: FaceLandmarker | null
  raf: number
  lastDetect: number
  lastVideoTime: number
  lastSeen: number
  filters: [OneEuroFilter, OneEuroFilter, OneEuroFilter]
  rateCount: number
  rateStart: number
  /** Escala de profundidad pose → metros (auto-calibrada con el método IPD). */
  poseScale: number | null
  poseCalibrated: boolean
}

function release(s: Session) {
  s.cancelled = true
  cancelAnimationFrame(s.raf)
  s.stream?.getTracks().forEach((t) => t.stop())
  s.stream = null
  s.video.pause()
  s.video.srcObject = null
  s.landmarker?.close()
  s.landmarker = null
}

const DEG = 180 / Math.PI

/**
 * Cámara de MediaPipe (estilo OpenGL: X derecha de la imagen, Y arriba, Z hacia la cámara)
 * a nuestro marco (X derecha del usuario, Y arriba, Z = distancia). La imagen no está espejada.
 */
const mpToOurs = (x: number, y: number, z: number): Vec3 => ({ x: -x, y, z: -z })

interface PoseMeasurement {
  /** Centro de la cabeza a la altura de los ojos, respecto del lente. */
  head: Vec3
  ipdPx: number
  yawDeg: number
  pitchDeg: number
  /** Profundidad cruda de la pose de MediaPipe (m, su escala), o null si no hubo matriz. */
  poseDepth: number | null
  /** Profundidad por IPD (fiable solo de frente). */
  ipdDepth: number
}

/**
 * Posición métrica del centro de la cabeza respecto del lente (modelo pinhole).
 * Se parte del punto medio entre pupilas y se retrocede `headDepthCm` a lo largo del
 * eje anteroposterior de la cabeza, así el punto no se mueve al girarla.
 * `poseScale` convierte la profundidad de la pose a metros reales; null = usar IPD.
 */
function headFromPose(
  lm: NormalizedLandmark[],
  matrix: number[] | undefined,
  w: number,
  h: number,
  settings: PhysicalSettings,
  poseScale: number | null,
): PoseMeasurement | null {
  const a = lm[IRIS_LEFT]
  const b = lm[IRIS_RIGHT]
  if (!a || !b) return null
  // La z de MediaPipe usa aproximadamente la misma escala que x.
  const ipdPx = Math.hypot((a.x - b.x) * w, (a.y - b.y) * h, (a.z - b.z) * w)
  if (ipdPx < 1) return null
  const f = w / 2 / Math.tan(((settings.webcamHfovDeg * Math.PI) / 180) / 2)
  const ipdDepth = (f * settings.ipdMm) / 1000 / ipdPx

  // Eje "hacia delante" de la cabeza (de la nuca a la nariz) en nuestro marco.
  let forward: Vec3 = { x: 0, y: 0, z: -1 }
  let poseDepth: number | null = null
  if (matrix && matrix.length === 16) {
    // Column-major: la tercera columna es el eje Z de la cara canónica (hacia la nariz).
    const len = Math.hypot(matrix[8], matrix[9], matrix[10])
    const tz = matrix[14]
    if (len > 1e-6 && tz < 0) {
      forward = mpToOurs(matrix[8] / len, matrix[9] / len, matrix[10] / len)
      poseDepth = -tz / 100 // cm → m (en la escala de MediaPipe)
    }
  }
  const yawDeg = Math.atan2(forward.x, -forward.z) * DEG
  const pitchDeg = Math.atan2(forward.y, Math.hypot(forward.x, forward.z)) * DEG

  const z = poseDepth !== null && poseScale !== null ? poseDepth * poseScale : ipdDepth
  const u = ((a.x + b.x) / 2) * w
  const v = ((a.y + b.y) / 2) * h
  // La imagen no está espejada: moverse a la derecha del usuario baja u.
  const eyes: Vec3 = { x: (-(u - w / 2) * z) / f, y: (-(v - h / 2) * z) / f, z }
  const d = settings.headDepthCm / 100
  return {
    head: { x: eyes.x - forward.x * d, y: eyes.y - forward.y * d, z: eyes.z - forward.z * d },
    ipdPx,
    yawDeg,
    pitchDeg,
    poseDepth,
    ipdDepth,
  }
}

/** Escala inicial pose → metros antes de calibrar: corrige FOV supuesto y tamaño de cara. */
function initialPoseScale(w: number, h: number, settings: PhysicalSettings) {
  const fOurs = w / 2 / Math.tan(((settings.webcamHfovDeg * Math.PI) / 180) / 2)
  const fMp = h / 2 / Math.tan(((MP_VFOV_DEG * Math.PI) / 180) / 2)
  return (fOurs / fMp) * (settings.ipdMm / MP_CANONICAL_IPD_MM)
}

export function useHeadTracking(
  targetRef: RefObject<ViewTarget>,
  settingsRef: RefObject<PhysicalSettings>,
  viewportRef: RefObject<Viewport | null>,
) {
  const [status, setStatusState] = useState<TrackingStatus>('off')
  const statusRef = useRef<TrackingStatus>('off')
  const sessionRef = useRef<Session | null>(null)
  /** Corrección manual X/Y de "Centrar vista" (persiste entre activaciones). */
  const centerOffsetRef = useRef<Vec2>({ x: 0, y: 0 })
  /** Último punto de vista sin corrección manual, para poder centrar. */
  const lastUncorrectedRef = useRef<Vec2 | null>(null)
  const debugRef = useRef<TrackingDebug>({
    head: null,
    ipdPx: 0,
    yawDeg: 0,
    pitchDeg: 0,
    poseScale: null,
    poseCalibrated: false,
    eye: { x: 0, y: 0, z: DEFAULT_EYE_Z },
    face: false,
    rate: 0,
    videoSize: { x: 0, y: 0 },
  })

  // Solo re-renderiza en transiciones de estado, nunca por detección.
  const setStatus = useCallback((s: TrackingStatus) => {
    if (statusRef.current === s) return
    statusRef.current = s
    setStatusState(s)
  }, [])

  const stop = useCallback(() => {
    const s = sessionRef.current
    sessionRef.current = null
    if (s) release(s)
    const t = targetRef.current
    t.x = 0
    t.y = 0
    t.z = DEFAULT_EYE_Z
    t.recovering = true
    lastUncorrectedRef.current = null
    const d = debugRef.current
    d.face = false
    d.head = null
    d.rate = 0
  }, [targetRef])

  const disable = useCallback(() => {
    stop()
    setStatus('off')
  }, [stop, setStatus])

  const enable = useCallback(async () => {
    if (sessionRef.current) return
    const s: Session = {
      cancelled: false,
      video: document.createElement('video'),
      stream: null,
      landmarker: null,
      raf: 0,
      lastDetect: 0,
      lastVideoTime: -1,
      lastSeen: 0,
      filters: [new OneEuroFilter(), new OneEuroFilter(), new OneEuroFilter()],
      rateCount: 0,
      rateStart: performance.now(),
      poseScale: null,
      poseCalibrated: false,
    }
    s.video.muted = true
    s.video.playsInline = true
    sessionRef.current = s
    setStatus('loading')

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 }, facingMode: 'user' },
        audio: false,
      })
      s.stream = stream
      if (s.cancelled) return release(s)
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (sessionRef.current !== s) return
        stop()
        setStatus('error')
      })
      s.video.srcObject = stream
      await s.video.play()
      if (s.cancelled) return release(s)

      const fileset = await FilesetResolver.forVisionTasks(WASM_URL)
      if (s.cancelled) return release(s)
      const landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFacialTransformationMatrixes: true,
        minFaceDetectionConfidence: MIN_CONFIDENCE,
        minFacePresenceConfidence: MIN_CONFIDENCE,
        minTrackingConfidence: MIN_CONFIDENCE,
      })
      if (s.cancelled) {
        landmarker.close()
        return release(s)
      }
      s.landmarker = landmarker
    } catch (err) {
      console.error('[tracking]', err)
      if (sessionRef.current === s) {
        stop()
        const name = err instanceof DOMException ? err.name : ''
        setStatus(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'error')
      } else {
        release(s)
      }
      return
    }

    s.lastSeen = performance.now()
    s.rateStart = s.lastSeen
    const debug = debugRef.current

    const loop = () => {
      if (s.cancelled || !s.landmarker) return
      s.raf = requestAnimationFrame(loop)
      const now = performance.now()
      if (now - s.lastDetect < 1000 / DETECT_HZ - 1) return
      if (s.video.readyState < 2 || s.video.currentTime === s.lastVideoTime) return
      s.lastDetect = now
      s.lastVideoTime = s.video.currentTime

      let landmarks: NormalizedLandmark[] | undefined
      let matrix: number[] | undefined
      try {
        const result = s.landmarker.detectForVideo(s.video, now)
        landmarks = result.faceLandmarks[0]
        matrix = result.facialTransformationMatrixes?.[0]?.data
      } catch (err) {
        console.error('[tracking] detectForVideo', err)
        return
      }

      s.rateCount++
      if (now - s.rateStart >= 1000) {
        debug.rate = (s.rateCount * 1000) / (now - s.rateStart)
        s.rateCount = 0
        s.rateStart = now
      }

      const w = s.video.videoWidth
      const h = s.video.videoHeight
      debug.videoSize = { x: w, y: h }
      const settings = settingsRef.current
      if (s.poseScale === null && w && h) s.poseScale = initialPoseScale(w, h, settings)
      const measured =
        landmarks && w && h ? headFromPose(landmarks, matrix, w, h, settings, s.poseScale) : null
      const target = targetRef.current

      if (!measured) {
        debug.face = false
        // Pérdida breve: se mantiene la última posición. Larga: vuelta suave al centro.
        if (now - s.lastSeen > LOST_MS) {
          target.x = 0
          target.y = 0
          target.z = DEFAULT_EYE_Z
          target.recovering = true
          lastUncorrectedRef.current = null
          setStatus('no-face')
        }
        return
      }

      // Calibración de la escala de profundidad: de frente, la IPD es fiable y la pose
      // de toda la malla aporta estabilidad cuando se gira (un ojo oculto no la arruina).
      if (
        measured.poseDepth !== null &&
        Math.abs(measured.yawDeg) < CALIB_MAX_ANGLE_DEG &&
        Math.abs(measured.pitchDeg) < CALIB_MAX_ANGLE_DEG
      ) {
        const sample = measured.ipdDepth / measured.poseDepth
        s.poseScale =
          s.poseCalibrated && s.poseScale !== null ? s.poseScale + (sample - s.poseScale) * CALIB_EMA : sample
        s.poseCalibrated = true
      }

      if (now - s.lastSeen > FILTER_RESET_MS) s.filters.forEach((f) => f.reset())
      s.lastSeen = now

      // Se filtra el centro de la cabeza: es el punto que no se mueve al girarla.
      const [fx, fy, fz] = s.filters
      const head: Vec3 = {
        x: fx.filter(measured.head.x, now),
        y: fy.filter(measured.head.y, now),
        z: fz.filter(measured.head.z, now),
      }
      // Punto de vista: donde estarían los ojos mirando de frente a la pantalla.
      const viewZ = head.z - settings.headDepthCm / 100

      // Del lente de la webcam al centro del canvas (la webcam está en el plano de la pantalla).
      const fromCam = viewportRef.current?.canvasFromCam ?? { x: 0, y: 0 }
      const uncorrected = { x: head.x - fromCam.x, y: head.y - fromCam.y }
      lastUncorrectedRef.current = uncorrected
      const off = centerOffsetRef.current
      // depthFactor = 1 usa la distancia real; otros valores escalan la variación alrededor de la distancia por defecto.
      const z = DEFAULT_EYE_Z + settings.depthFactor * (viewZ - DEFAULT_EYE_Z)
      const eye = clampEye({ x: uncorrected.x + off.x, y: uncorrected.y + off.y, z })

      debug.face = true
      debug.head = measured.head
      debug.ipdPx = measured.ipdPx
      debug.yawDeg = measured.yawDeg
      debug.pitchDeg = measured.pitchDeg
      debug.poseScale = measured.poseDepth !== null ? s.poseScale : null
      debug.poseCalibrated = s.poseCalibrated
      debug.eye = eye

      target.x = eye.x
      target.y = eye.y
      target.z = eye.z
      target.recovering = false
      target.source = 'camera'
      setStatus('tracking')
    }
    s.raf = requestAnimationFrame(loop)
  }, [setStatus, stop, targetRef, settingsRef, viewportRef])

  /** Toma la posición X/Y actual como centro (compensa una webcam descentrada). Z no cambia. */
  const recenter = useCallback(() => {
    const u = lastUncorrectedRef.current
    if (!u) return
    centerOffsetRef.current = { x: -u.x, y: -u.y }
  }, [])

  /** Vuelve al modelo geométrico puro (webcam arriba al centro). */
  const resetCenter = useCallback(() => {
    centerOffsetRef.current = { x: 0, y: 0 }
  }, [])

  // Al desmontar: frenar inferencia y cerrar la webcam.
  useEffect(() => () => stop(), [stop])

  return { status, enable, disable, recenter, resetCenter, centerOffsetRef, debugRef }
}
