import { useCallback, useEffect, useRef, useState } from 'react'
import { AUTO_RESTART_S, COUNTDOWN_S, LIVES } from './difficulty'

export type GamePhase = 'ready' | 'countdown' | 'playing' | 'over'

/** Estado que lee el loop de R3F cada frame (sin pasar por React). */
export interface GameRuntime {
  phase: GamePhase
  /** Simulación congelada (cara perdida). */
  paused: boolean
  /** Cambia en cada partida nueva: las bolas en vuelo se descartan. */
  runId: number
}

const BEST_KEY = 'ventana-3d:best'

function loadBest(): number {
  try {
    const v = Number(localStorage.getItem(BEST_KEY))
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
  } catch {
    return 0
  }
}

function saveBest(v: number) {
  try {
    localStorage.setItem(BEST_KEY, String(v))
  } catch {
    // Sin almacenamiento: el récord dura solo esta sesión.
  }
}

export function useGame(paused: boolean) {
  const gameRef = useRef<GameRuntime>({ phase: 'ready', paused, runId: 0 })
  const [phase, setPhaseState] = useState<GamePhase>('ready')
  const [score, setScore] = useState(0)
  const [lives, setLives] = useState(LIVES)
  const [best, setBest] = useState(loadBest)
  const [newRecord, setNewRecord] = useState(false)
  /** Segundos restantes de la cuenta 3-2-1 o del reinicio automático. */
  const [counter, setCounter] = useState(0)
  /** Cantidad de golpes recibidos: sirve de key para reiniciar el flash. */
  const [hits, setHits] = useState(0)
  const scoreRef = useRef(0)
  const livesRef = useRef(LIVES)
  const bestRef = useRef(best)

  useEffect(() => {
    gameRef.current.paused = paused
  }, [paused])

  const setPhase = useCallback((p: GamePhase) => {
    gameRef.current.phase = p
    setPhaseState(p)
    if (p === 'countdown') setCounter(COUNTDOWN_S)
    else if (p === 'over') setCounter(AUTO_RESTART_S)
  }, [])

  const start = useCallback(() => {
    const g = gameRef.current
    if (g.phase === 'countdown' || g.phase === 'playing') return
    scoreRef.current = 0
    livesRef.current = LIVES
    setScore(0)
    setLives(LIVES)
    setNewRecord(false)
    g.runId++
    setPhase('countdown')
  }, [setPhase])

  const dodge = useCallback(() => {
    if (gameRef.current.phase !== 'playing') return
    scoreRef.current++
    setScore(scoreRef.current)
  }, [])

  const hit = useCallback(() => {
    if (gameRef.current.phase !== 'playing') return
    livesRef.current = Math.max(0, livesRef.current - 1)
    setLives(livesRef.current)
    setHits((n) => n + 1)
    if (livesRef.current > 0) return
    const s = scoreRef.current
    if (s > bestRef.current) {
      bestRef.current = s
      setBest(s)
      saveBest(s)
      setNewRecord(true)
    }
    setPhase('over')
  }, [setPhase])

  // Cuenta 3-2-1 antes de jugar y reinicio automático tras perder.
  useEffect(() => {
    if (phase !== 'countdown' && phase !== 'over') return
    let n = phase === 'countdown' ? COUNTDOWN_S : AUTO_RESTART_S
    const id = setInterval(() => {
      n--
      if (n > 0) return setCounter(n)
      clearInterval(id)
      if (phase === 'countdown') setPhase('playing')
      else start()
    }, 1000)
    return () => clearInterval(id)
  }, [phase, setPhase, start])

  return { gameRef, phase, score, lives, best, newRecord, counter, hits, start, dodge, hit }
}
