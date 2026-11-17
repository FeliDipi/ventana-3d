/**
 * Parámetros del juego y curva de dificultad. Unidades: metros y segundos.
 *
 * La dificultad sigue `progress(t) = 1 − e^(−t/τ)`: sube rápido al principio de forma
 * apenas perceptible y se va saturando, sin escalones. Con τ = 150 s llega al 63 % a
 * los 2,5 min y al 86 % a los 5 min.
 */
export const DIFFICULTY_TAU_S = 150

const SPEED = { start: 0.45, end: 1.5 } // m/s
const INTERVAL = { start: 2.6, end: 0.55 } // s entre bolas
/** Variación aleatoria del intervalo (±). */
const INTERVAL_JITTER = 0.2

/** Espera antes de la primera bola. */
export const FIRST_BALL_DELAY_S = 1.5
export const BALL_RADIUS = 0.035
/** Distancia XY bola ↔ ojo (incluye el radio de la bola) por debajo de la cual hay golpe. */
export const HIT_RADIUS = 0.09
/** Error de puntería: siempre menor que HIT_RADIUS, así quedarse quieto implica recibir el golpe. */
export const AIM_JITTER = 0.025
export const INVULNERABLE_S = 1.2
export const MAX_BALLS = 24
export const LIVES = 3
export const COUNTDOWN_S = 3
export const AUTO_RESTART_S = 5

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

export const progress = (t: number) => 1 - Math.exp(-Math.max(0, t) / DIFFICULTY_TAU_S)

export const ballSpeed = (t: number) => lerp(SPEED.start, SPEED.end, progress(t))

/** Intervalo hasta la próxima bola; `rand` en [0, 1). */
export const spawnInterval = (t: number, rand = Math.random()) =>
  lerp(INTERVAL.start, INTERVAL.end, progress(t)) * (1 + (rand * 2 - 1) * INTERVAL_JITTER)
