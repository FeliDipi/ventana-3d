/**
 * Parámetros del juego y curva de dificultad. Unidades: metros y segundos.
 *
 * La dificultad sigue `progress(t) = 1 − e^(−t/τ)`: sube rápido al principio y se va
 * saturando, sin escalones. Con τ = 45 s llega al 63 % a los 45 s y al 86 % a los 90 s.
 * Los tiros especiales (efecto, rebote, ráfaga, abanico, amague) se habilitan a medida
 * que sube el progreso, cada uno con una rampa suave.
 */
export const DIFFICULTY_TAU_S = 45

const SPEED = { start: 0.95, end: 2.5 } // m/s
const INTERVAL = { start: 1.3, end: 0.38 } // s entre tiros
/** Variación aleatoria del intervalo (±). */
const INTERVAL_JITTER = 0.2

/** Espera antes de la primera bola. */
export const FIRST_BALL_DELAY_S = 1.0
export const BALL_RADIUS = 0.02
/** Distancia XY bola ↔ ojo (incluye el radio de la bola) por debajo de la cual hay golpe. */
export const HIT_RADIUS = 0.08
/** Error de puntería: siempre menor que HIT_RADIUS, así quedarse quieto implica recibir el golpe. */
export const AIM_JITTER = 0.025
export const INVULNERABLE_S = 0.8
/** Amague del pato antes de cada tiro: tope y fracción del intervalo que puede ocupar. */
export const WINDUP_MAX_S = 0.34
export const WINDUP_SHARE = 0.6
/** Anticipación a tu movimiento (fracción del recorrido): ya apunta adelante desde el inicio. */
export const LEAD_MIN = 0.4
export const LEAD_MAX = 0.75
/** Doble tiro: una segunda bola sin amague, poco después de la primera. */
export const DOUBLE_GAP_S = 0.2

/**
 * Efecto: hacia dónde parece ir la bola al salir, medido en el plano del ojo desde el
 * blanco real. Es mayor que HIT_RADIUS: al principio parece que pasa de largo.
 */
export const CURVE_OFFSET = { min: 0.1, max: 0.16 }
/** Ráfaga: tiros seguidos, cada uno re-apuntado. */
export const BURST_COUNT = 3
export const BURST_GAP_S = 0.15
/** Abanico: separación lateral de las bolas de los costados (el hueco queda fuera de HIT_RADIUS). */
export const FAN_SPREAD = 0.2
/** Amague sin tiro: el tiro real llega después, con un aviso corto. */
export const FEINT_DELAY_S = 0.3
export const FEINT_WINDUP_S = 0.18
/** El rebote tiene que caer dentro de la habitación, no pegado a la abertura. */
export const BOUNCE_MAX_Z = -0.05

export const MAX_BALLS = 32
export const LIVES = 3
export const COUNTDOWN_S = 3
export const AUTO_RESTART_S = 5

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
/** 0 hasta `from`, sube lineal y llega a 1 en `from + 0.3` de progreso. */
const ramp = (p: number, from: number) => Math.min(1, Math.max(0, (p - from) / 0.3))

export const progress = (t: number) => 1 - Math.exp(-Math.max(0, t) / DIFFICULTY_TAU_S)

export const doubleChance = (t: number) => 0.2 + 0.3 * progress(t)
/** Probabilidad de que una bola tenga efecto / rebote (excluyentes). */
export const curveChance = (t: number) => 0.35 * ramp(progress(t), 0.05)
export const bounceChance = (t: number) => 0.25 * ramp(progress(t), 0.15)
/** Probabilidad de que un tiro programado sea ráfaga / abanico / amague. */
export const burstChance = (t: number) => 0.18 * ramp(progress(t), 0.25)
export const fanChance = (t: number) => 0.15 * ramp(progress(t), 0.45)
export const feintChance = (t: number) => 0.15 * ramp(progress(t), 0.2)

export const ballSpeed = (t: number) => lerp(SPEED.start, SPEED.end, progress(t))

/** Intervalo hasta la próxima bola; `rand` en [0, 1). */
export const spawnInterval = (t: number, rand = Math.random()) =>
  lerp(INTERVAL.start, INTERVAL.end, progress(t)) * (1 + (rand * 2 - 1) * INTERVAL_JITTER)
