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
const LOST_MS = 500
/** Si la cara estuvo ausente más que esto, el filtro arranca de cero. */
const FILTER_RESET_MS = 200
/** Centros de iris (topología Face Mesh de 478 puntos): ojo izquierdo y derecho del usuario. */
const IRIS_LEFT = 468
const IRIS_RIGHT = 473

export type TrackingStatus = 'off' | 'loading' | 'tracking' | 'no-face' | 'denied' | 'error'

export interface TrackingDebug {
  /** Cabeza (punto medio entre pupilas) respecto del lente de la webcam, en metros. */
  head: Vec3 | null
  /** Distancia interpupilar medida en píxeles de la imagen. */
  ipdPx: number
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

/**
 * Posición métrica de la cabeza respecto del lente (modelo pinhole).
 * X a la derecha del usuario, Y hacia arriba, Z = distancia hacia el usuario.
 */
function headFromLandmarks(
  lm: NormalizedLandmark[],
  w: number,
  h: number,
  settings: PhysicalSettings,
): { head: Vec3; ipdPx: number } | null {
  const a = lm[IRIS_LEFT]
  const b = lm[IRIS_RIGHT]
  if (!a || !b) return null
  // La z de MediaPipe usa aproximadamente la misma escala que x: la distancia 3D
  // entre pupilas es casi insensible al giro de la cabeza.
  const ipdPx = Math.hypot((a.x - b.x) * w, (a.y - b.y) * h, (a.z - b.z) * w)
  if (ipdPx < 1) return null
  const f = w / 2 / Math.tan(((settings.webcamHfovDeg * Math.PI) / 180) / 2)
  const z = (f * settings.ipdMm) / 1000 / ipdPx
  const u = ((a.x + b.x) / 2) * w
  const v = ((a.y + b.y) / 2) * h
  return {
    // La imagen no está espejada: moverse a la derecha del usuario baja u.
    head: { x: (-(u - w / 2) * z) / f, y: (-(v - h / 2) * z) / f, z },
    ipdPx,
  }
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
      try {
        landmarks = s.landmarker.detectForVideo(s.video, now).faceLandmarks[0]
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
      const measured = landmarks && w && h ? headFromLandmarks(landmarks, w, h, settingsRef.current) : null
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

      if (now - s.lastSeen > FILTER_RESET_MS) s.filters.forEach((f) => f.reset())
      s.lastSeen = now

      const [fx, fy, fz] = s.filters
      const head: Vec3 = {
        x: fx.filter(measured.head.x, now),
        y: fy.filter(measured.head.y, now),
        z: fz.filter(measured.head.z, now),
      }

      // Del lente de la webcam al centro del canvas (la webcam está en el plano de la pantalla).
      const fromCam = viewportRef.current?.canvasFromCam ?? { x: 0, y: 0 }
      const uncorrected = { x: head.x - fromCam.x, y: head.y - fromCam.y }
      lastUncorrectedRef.current = uncorrected
      const off = centerOffsetRef.current
      // depthFactor = 1 usa la distancia real; otros valores escalan la variación alrededor de la distancia por defecto.
      const z = DEFAULT_EYE_Z + settingsRef.current.depthFactor * (head.z - DEFAULT_EYE_Z)
      const eye = clampEye({ x: uncorrected.x + off.x, y: uncorrected.y + off.y, z })

      debug.face = true
      debug.head = measured.head
      debug.ipdPx = measured.ipdPx
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
