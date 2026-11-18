/*
 * Un solo AudioContext y un solo buffer decodificado para todos los quacks.
 * Adaptado de tuxdi-site-webapp/utils/useQuack.ts.
 */
const SOUND_URL = `${import.meta.env.BASE_URL}sounds/duck.mp3`

let context: AudioContext | null = null
let buffer: Promise<AudioBuffer> | null = null

function getContext() {
  if (context) return context
  try {
    context = new AudioContext()
  } catch {
    return null
  }
  return context
}

function getBuffer(ctx: AudioContext) {
  buffer ??= fetch(SOUND_URL)
    .then((r) => r.arrayBuffer())
    .then((data) => ctx.decodeAudioData(data))
    .catch((err) => {
      buffer = null
      throw err
    })
  return buffer
}

/** El navegador solo deja arrancar el audio tras un gesto: llamar desde "Jugar". */
export function unlockQuack() {
  const ctx = getContext()
  if (!ctx) return
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  getBuffer(ctx).catch(() => {})
}

export function quack(volume = 0.35, rate = 0.85 + Math.random() * 0.3) {
  const ctx = getContext()
  if (!ctx || ctx.state !== 'running') return
  getBuffer(ctx)
    .then((buf) => {
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.playbackRate.value = rate
      const gain = ctx.createGain()
      gain.gain.value = volume
      src.connect(gain).connect(ctx.destination)
      src.start()
    })
    .catch(() => {})
}
