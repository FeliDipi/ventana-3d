import { Canvas } from '@react-three/fiber'
import {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
  type WheelEvent,
} from 'react'
import {
  computeViewport,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  SIGNED_SETTINGS,
  type PhysicalSettings,
  type Viewport,
} from './scene/physical'
import { Duck, type DuckApi } from './duck/Duck'
import { unlockQuack } from './duck/quack'
import { Balls } from './game/Balls'
import { Hud } from './game/Hud'
import { useGame } from './game/useGame'
import { Floaters } from './scene/Floaters'
import { CenterMarker, Room } from './scene/Room'
import { WindowCamera } from './scene/WindowCamera'
import { clamp, DEFAULT_EYE_Z, FAR, NEAR, type Vec3, type ViewTarget } from './scene/windowMath'
import { THEME } from './theme'
import { useHeadTracking, type TrackingDebug, type TrackingStatus } from './tracking/useHeadTracking'

const STATUS_LABEL: Record<TrackingStatus, string> = {
  off: 'Mouse · rueda = distancia',
  loading: 'Iniciando cámara…',
  tracking: 'Siguiendo cara',
  'no-face': 'El pato no te ve',
  denied: 'Permiso denegado · usando mouse',
  error: 'Cámara no disponible · usando mouse',
}

/** Recorrido del mouse como fracción de media abertura (todo el ancho: hay que poder esquivar). */
const MOUSE_REACH = 1
const MOUSE_Z = { min: 0.25, max: 1.2 }

const isCameraDriven = (s: TrackingStatus) => s === 'tracking' || s === 'no-face'

export default function App() {
  const targetRef = useRef<ViewTarget>({ x: 0, y: 0, z: DEFAULT_EYE_Z, recovering: false, source: 'mouse' })
  const appliedRef = useRef<Vec3>({ x: 0, y: 0, z: DEFAULT_EYE_Z })
  const mouseZRef = useRef(DEFAULT_EYE_Z)
  const stageRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<Viewport | null>(null)
  const duckRef = useRef<DuckApi | null>(null)
  const [settings, setSettings] = useState<PhysicalSettings>(loadSettings)
  const settingsRef = useRef(settings)
  const [debug, setDebug] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const { status, enable, recenter, resetCenter, centerOffsetRef, debugRef } = useHeadTracking(
    targetRef,
    settingsRef,
    viewportRef,
  )

  const cameraOn = isCameraDriven(status)
  const mouseActive = !cameraOn
  const game = useGame(status === 'no-face')
  const { start: startGame, hit, dodge } = game

  /** Toma la posición actual de la cabeza como centro (solo con cámara). El key reinicia el aviso. */
  const [centeredKey, setCenteredKey] = useState(0)
  const centerView = useCallback(() => {
    if (!cameraOn) return
    recenter()
    setCenteredKey((n) => n + 1)
  }, [cameraOn, recenter])

  // "Jugar" es el gesto que habilita el audio del quack; además arranca con la vista centrada.
  const start = useCallback(() => {
    const phase = game.gameRef.current.phase
    if (phase === 'countdown' || phase === 'playing') return
    unlockQuack()
    centerView()
    startGame()
  }, [centerView, game.gameRef, startGame])
  const onHit = useCallback(() => {
    hit()
    duckRef.current?.react('hit')
  }, [hit])
  const onDodge = useCallback(() => {
    dodge()
    duckRef.current?.react('dodge')
  }, [dodge])

  // La cámara se pide al cargar. Si se deniega o no hay webcam, queda el mouse.
  useEffect(() => {
    enable()
  }, [enable])

  // Espacio / Enter = jugar, C = centrar vista. Atajos de desarrollo (sin UI visible): D = debug, A = ajustes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.ctrlKey || e.metaKey || e.altKey) return
      const k = e.key.toLowerCase()
      if (k === ' ' || k === 'enter') {
        // Evita que un botón con foco vuelva a dispararse.
        e.preventDefault()
        start()
      } else if (k === 'd') setDebug((v) => !v)
      else if (k === 'a') setShowSettings((v) => !v)
      else if (k === 'c') centerView()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [centerView, start])

  // Geometría física del canvas: al redimensionar, al cambiar ajustes, al entrar/salir de
  // pantalla completa y periódicamente (mover la ventana no dispara eventos).
  const updateViewport = useCallback(() => {
    const el = stageRef.current
    if (el) viewportRef.current = computeViewport(settingsRef.current, el)
  }, [])

  useEffect(() => {
    settingsRef.current = settings
    saveSettings(settings)
    updateViewport()
  }, [settings, updateViewport])

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(updateViewport)
    ro.observe(el)
    const id = setInterval(updateViewport, 500)
    const onFs = () => {
      setFullscreen(!!document.fullscreenElement)
      updateViewport()
    }
    document.addEventListener('fullscreenchange', onFs)
    return () => {
      ro.disconnect()
      clearInterval(id)
      document.removeEventListener('fullscreenchange', onFs)
    }
  }, [updateViewport])

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!mouseActive) return
    const vp = viewportRef.current
    if (!vp) return
    const r = e.currentTarget.getBoundingClientRect()
    const nx = clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1)
    const ny = clamp(((e.clientY - r.top) / r.height) * 2 - 1, -1, 1)
    const t = targetRef.current
    t.x = nx * MOUSE_REACH * (vp.apertureW / 2)
    t.y = -ny * MOUSE_REACH * (vp.apertureH / 2)
    t.z = mouseZRef.current
    t.recovering = false
    t.source = 'mouse'
  }

  const onPointerLeave = () => {
    if (!mouseActive) return
    const t = targetRef.current
    t.x = 0
    t.y = 0
    t.recovering = true
  }

  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (!mouseActive) return
    mouseZRef.current = clamp(mouseZRef.current * Math.exp(e.deltaY * 0.001), MOUSE_Z.min, MOUSE_Z.max)
    const t = targetRef.current
    t.z = mouseZRef.current
    t.source = 'mouse'
  }

  const enterFullscreen = () => {
    document.documentElement.requestFullscreen().catch(() => {})
  }

  return (
    <div className="app">
      <div
        ref={stageRef}
        className="stage"
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onWheel={onWheel}
      >
        <Canvas
          dpr={[1, 2]}
          camera={{ manual: true, position: [0, 0, DEFAULT_EYE_Z], near: NEAR, far: FAR }}
          gl={{ antialias: true }}
        >
          <color attach="background" args={[THEME.background]} />
          <fog attach="fog" args={[THEME.fog.color, THEME.fog.near, THEME.fog.far]} />
          <WindowCamera targetRef={targetRef} viewportRef={viewportRef} appliedRef={appliedRef} />
          <Room />
          <Floaters />
          <Suspense fallback={null}>
            <Duck apiRef={duckRef} gameRef={game.gameRef} appliedRef={appliedRef} viewportRef={viewportRef} />
          </Suspense>
          <Balls
            gameRef={game.gameRef}
            appliedRef={appliedRef}
            viewportRef={viewportRef}
            duckRef={duckRef}
            onDodge={onDodge}
            onHit={onHit}
          />
          {debug && <CenterMarker />}
        </Canvas>
      </div>

      <Hud
        phase={game.phase}
        score={game.score}
        lives={game.lives}
        best={game.best}
        newRecord={game.newRecord}
        counter={game.counter}
        hits={game.hits}
        paused={status === 'no-face'}
        camera={cameraOn}
        onStart={start}
      />

      {centeredKey > 0 && (
        <div key={centeredKey} className="view-toast">
          Vista centrada
        </div>
      )}

      <div className="view-buttons">
        {cameraOn && (
          <button onClick={centerView}>
            Centrar vista <kbd>C</kbd>
          </button>
        )}
        {!fullscreen && <button onClick={enterFullscreen}>Pantalla completa</button>}
      </div>

      {debug && (
        <DebugPanel status={status} debugRef={debugRef} appliedRef={appliedRef} viewportRef={viewportRef} />
      )}
      {showSettings && (
        <SettingsPanel
          settings={settings}
          onChange={setSettings}
          onResetCenter={resetCenter}
          centerOffsetRef={centerOffsetRef}
        />
      )}
    </div>
  )
}

const cm = (v: number) => (v >= 0 ? '+' : '') + (v * 100).toFixed(1)

function DebugPanel({
  status,
  debugRef,
  appliedRef,
  viewportRef,
}: {
  status: TrackingStatus
  debugRef: RefObject<TrackingDebug>
  appliedRef: RefObject<Vec3>
  viewportRef: RefObject<Viewport | null>
}) {
  const [, tick] = useState(0)
  // Refresco a ~10 Hz leyendo refs: no hay render de React por detección.
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 100)
    return () => clearInterval(id)
  }, [])

  const d = debugRef.current
  const a = appliedRef.current
  const vp = viewportRef.current
  const tracking = isCameraDriven(status)
  return (
    <div className="debug">
      <div className="debug__title">{STATUS_LABEL[status]}</div>
      <div className="debug__title">cm · X der · Y arriba · Z distancia</div>
      <div>
        <span>Cabeza/cám</span>
        {tracking && d.head ? `${cm(d.head.x)}  ${cm(d.head.y)}  ${(d.head.z * 100).toFixed(1)}` : '—'}
      </div>
      <div>
        <span>Ojo/canvas</span>
        {`${cm(a.x)}  ${cm(a.y)}  ${(a.z * 100).toFixed(1)}`}
      </div>
      <div>
        <span>Abertura</span>
        {vp ? `${(vp.apertureW * 100).toFixed(1)} × ${(vp.apertureH * 100).toFixed(1)}` : '—'}
      </div>
      <div>
        <span>Canvas/cám</span>
        {vp ? `${cm(vp.canvasFromCam.x)}  ${cm(vp.canvasFromCam.y)}` : '—'}
      </div>
      <div>
        <span>IPD</span>
        {tracking && d.face ? `${d.ipdPx.toFixed(1)} px · video ${d.videoSize.x}×${d.videoSize.y}` : '—'}
      </div>
      <div>
        <span>Giro</span>
        {tracking && d.face
          ? `yaw ${d.yawDeg.toFixed(0)}° · pitch ${d.pitchDeg.toFixed(0)}° · k ${
              d.poseScale === null ? 'sin pose' : `${d.poseScale.toFixed(3)}${d.poseCalibrated ? '' : ' (inicial)'}`
            }`
          : '—'}
      </div>
      <div>
        <span>Cara</span>
        {tracking ? `${d.face ? 'sí' : 'no'} · ${d.rate.toFixed(0)} Hz` : '—'}
      </div>
    </div>
  )
}

const FIELDS: { key: keyof PhysicalSettings; label: string; step: number; unit: string; min?: number }[] = [
  { key: 'diagonalIn', label: 'Diagonal de pantalla', step: 0.1, unit: 'pulg' },
  { key: 'webcamHfovDeg', label: 'FOV horizontal webcam', step: 1, unit: '°' },
  { key: 'ipdMm', label: 'Distancia interpupilar', step: 0.5, unit: 'mm' },
  { key: 'webcamAboveCm', label: 'Webcam sobre la pantalla', step: 0.1, unit: 'cm' },
  { key: 'depthFactor', label: 'Factor de profundidad (1 = físico)', step: 0.1, unit: '×', min: -1 },
  { key: 'headDepthCm', label: 'Ojos → centro de la cabeza', step: 0.5, unit: 'cm' },
]

function SettingsPanel({
  settings,
  onChange,
  onResetCenter,
  centerOffsetRef,
}: {
  settings: PhysicalSettings
  onChange: (s: PhysicalSettings) => void
  onResetCenter: () => void
  centerOffsetRef: RefObject<{ x: number; y: number }>
}) {
  const [, tick] = useState(0)
  // El offset vive en un ref (lo cambia "Centrar vista"): refresco liviano.
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 250)
    return () => clearInterval(id)
  }, [])
  const offset = centerOffsetRef.current
  return (
    <div className="settings">
      {FIELDS.map((f) => (
        <label key={f.key}>
          <span>{f.label}</span>
          <input
            type="number"
            step={f.step}
            min={f.min ?? 0}
            value={settings[f.key]}
            onChange={(e) => {
              const v = parseFloat(e.target.value)
              if (Number.isFinite(v) && (v > 0 || SIGNED_SETTINGS.includes(f.key))) onChange({ ...settings, [f.key]: v })
            }}
          />
          <em>{f.unit}</em>
        </label>
      ))}
      <div className="settings__row">
        <span>
          Centrado manual: {cm(offset.x)} / {cm(offset.y)} cm
        </span>
        <button
          onClick={onResetCenter}
        >
          Restablecer
        </button>
      </div>
      <div className="settings__row">
        <button onClick={() => onChange({ ...DEFAULT_SETTINGS })}>Valores por defecto</button>
      </div>
    </div>
  )
}
