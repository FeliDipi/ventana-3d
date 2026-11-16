/**
 * Filtro One Euro (Casiez et al. 2012): suaviza fuerte cuando la señal está quieta
 * y deja pasar el movimiento rápido con poca latencia.
 */
export const ONE_EURO = {
  /** Hz. Más bajo = menos temblor en reposo, más lag lento. */
  minCutoff: 1.0,
  /** Cuánto sube el cutoff con la velocidad (m/s). Más alto = menos lag en movimiento. */
  beta: 20,
  dCutoff: 1,
}

const alpha = (cutoff: number, dt: number) => {
  const tau = 1 / (2 * Math.PI * cutoff)
  return 1 / (1 + tau / dt)
}

export class OneEuroFilter {
  private x: number | null = null
  private dx = 0
  private t = 0

  reset() {
    this.x = null
    this.dx = 0
  }

  /** `tMs` en milisegundos. */
  filter(value: number, tMs: number): number {
    if (this.x === null) {
      this.x = value
      this.t = tMs
      return value
    }
    const dt = Math.max((tMs - this.t) / 1000, 1e-3)
    this.t = tMs
    const rawDx = (value - this.x) / dt
    this.dx += alpha(ONE_EURO.dCutoff, dt) * (rawDx - this.dx)
    const cutoff = ONE_EURO.minCutoff + ONE_EURO.beta * Math.abs(this.dx)
    this.x += alpha(cutoff, dt) * (value - this.x)
    return this.x
  }
}
