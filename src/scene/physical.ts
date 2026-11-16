import type { Vec2 } from './windowMath'

/** Datos físicos del equipo. Editables en el panel de ajustes. */
export interface PhysicalSettings {
  /** Diagonal de la pantalla, en pulgadas. */
  diagonalIn: number
  /** Campo visual horizontal de la webcam, en grados. */
  webcamHfovDeg: number
  /** Distancia interpupilar, en milímetros. */
  ipdMm: number
  /** Altura del lente de la webcam sobre el borde superior del área visible, en cm. */
  webcamAboveCm: number
  /**
   * Cuánto influye la distancia de la cabeza: 1 = físicamente correcto,
   * 0 = distancia fija, negativo = invertido (para comparar la percepción).
   */
  depthFactor: number
}

/** Ajustes que admiten cero o negativos. */
export const SIGNED_SETTINGS: (keyof PhysicalSettings)[] = ['depthFactor']

export const DEFAULT_SETTINGS: PhysicalSettings = {
  diagonalIn: 15.6,
  webcamHfovDeg: 62,
  ipdMm: 63,
  webcamAboveCm: 0.8,
  depthFactor: 1,
}

const STORAGE_KEY = 'ventana-3d:settings'

export function loadSettings(): PhysicalSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<PhysicalSettings>
    const out = { ...DEFAULT_SETTINGS }
    for (const k of Object.keys(out) as (keyof PhysicalSettings)[]) {
      const v = parsed[k]
      if (typeof v === 'number' && Number.isFinite(v) && (v > 0 || SIGNED_SETTINGS.includes(k))) out[k] = v
    }
    return out
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(s: PhysicalSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    // Sin almacenamiento: los ajustes duran solo esta sesión.
  }
}

/** Geometría física del canvas, en metros. */
export interface Viewport {
  /** Metros por píxel CSS. */
  mpp: number
  apertureW: number
  apertureH: number
  /** Centro del canvas respecto del lente de la webcam (X derecha, Y arriba). */
  canvasFromCam: Vec2
}

export function computeViewport(settings: PhysicalSettings, canvasEl: Element): Viewport {
  const sw = window.screen.width
  const sh = window.screen.height
  const screenWidthM = (settings.diagonalIn * 0.0254 * sw) / Math.hypot(sw, sh)
  const mpp = screenWidthM / sw

  const rect = canvasEl.getBoundingClientRect()
  const fullscreen = !!document.fullscreenElement
  // Posición del viewport dentro de la pantalla. En ventana es aproximada (bordes del SO).
  const chromeX = fullscreen ? 0 : (window.outerWidth - window.innerWidth) / 2
  const chromeY = fullscreen ? 0 : window.outerHeight - window.innerHeight
  // screenX/Y son globales (multi-monitor): se pasan a coordenadas del monitor actual.
  const scr = window.screen as Screen & { availLeft?: number; availTop?: number }
  const originX = fullscreen ? 0 : window.screenX - (scr.availLeft ?? 0)
  const originY = fullscreen ? 0 : window.screenY - (scr.availTop ?? 0)
  const cx = originX + chromeX + rect.left + rect.width / 2
  const cy = originY + chromeY + rect.top + rect.height / 2

  return {
    mpp,
    apertureW: rect.width * mpp,
    apertureH: rect.height * mpp,
    canvasFromCam: {
      x: (cx - sw / 2) * mpp,
      y: -(cy * mpp + settings.webcamAboveCm / 100),
    },
  }
}
