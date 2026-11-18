/**
 * Parámetros del juego y curva de dificultad. Unidades: metros y segundos.
 *
 * La dificultad sigue `progress(t) = 1 − e^(−t/τ)`: sube rápido al principio de forma
 * apenas perceptible y se va saturando, sin escalones. Con τ = 75 s llega al 63 % a
 * los 75 s y al 86 % a los 2,5 min.
 */
export const DIFFICULTY_TAU_S = 75

const SPEED = { start: 0.65, end: 1.8 } // m/s
const INTERVAL = { start: 1.6, end: 0.45 } // s entre bolas
/** Variación aleatoria del intervalo (±). */
const INTERVAL_JITTER = 0.2

/** Espera antes de la primera bola. */
export const FIRST_BALL_DELAY_S = 1.0
export const BALL_RADIUS = 0.035
/** Distancia XY bola ↔ ojo (incluye el radio de la bola) por debajo de la cual hay golpe. */
export const HIT_RADIUS = 0.09
/** Error de puntería: siempre menor que HIT_RADIUS, así quedarse quieto implica recibir el golpe. */
export const AIM_JITTER = 0.025
export const INVULNERABLE_S = 1.2
/** Amague del pato antes de cada tiro: tope y fracción del intervalo que puede ocupar. */
export const WINDUP_MAX_S = 0.38
export const WINDUP_SHARE = 0.6
/** Anticipación a tu movimiento (fracción del recorrido): ya apunta adelante desde el inicio. */
export const LEAD_MIN = 0.3
export const LEAD_MAX = 0.6
/** Doble tiro: una segunda bola sin amague, poco después de la primera. */
export const DOUBLE_GAP_S = 0.22
export const MAX_BALLS = 24
export const LIVES = 3
export const COUNTDOWN_S = 3
export const AUTO_RESTART_S = 5

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

export const progress = (t: number) => 1 - Math.exp(-Math.max(0, t) / DIFFICULTY_TAU_S)

export const doubleChance = (t: number) => 0.15 + 0.25 * progress(t)

export const ballSpeed = (t: number) => lerp(SPEED.start, SPEED.end, progress(t))

/** Intervalo hasta la próxima bola; `rand` en [0, 1). */
export const spawnInterval = (t: number, rand = Math.random()) =>
  lerp(INTERVAL.start, INTERVAL.end, progress(t)) * (1 + (rand * 2 - 1) * INTERVAL_JITTER)
