import { LIVES } from './difficulty'
import type { GamePhase } from './useGame'

interface Props {
  phase: GamePhase
  score: number
  lives: number
  best: number
  newRecord: boolean
  counter: number
  hits: number
  paused: boolean
  /** La partida se controla con la cabeza (si no, con el mouse). */
  camera: boolean
  onStart: () => void
}

export function Hud({ phase, score, lives, best, newRecord, counter, hits, paused, camera, onStart }: Props) {
  const inGame = phase === 'countdown' || phase === 'playing'
  return (
    <div className="hud">
      {/* El key reinicia la animación en cada golpe. */}
      {hits > 0 && <div key={`hit-${hits}`} className="hud__flash" />}

      <div className="hud__bar">
        <div className="hud__lives" aria-label={`${lives} vidas`}>
          {Array.from({ length: LIVES }, (_, i) => (
            <span key={i} className={i < lives ? 'heart' : 'heart heart--lost'}>
              ♥
            </span>
          ))}
        </div>
        <div className="hud__score">
          {/* Key = score: el "pop" se repite en cada esquiva. */}
          <span key={score} className={score > 0 ? 'hud__value hud__value--pop' : 'hud__value'}>
            {score}
          </span>
          <small>esquivadas</small>
        </div>
        <div className="hud__best">
          Mejor <strong>{best}</strong>
        </div>
      </div>

      {phase === 'ready' && (
        <div className="hud__panel">
          <h1>Esquivá</h1>
          <p>{camera ? 'Mové la cabeza para esquivar las bolas.' : 'Mové el mouse para esquivar las bolas.'}</p>
          <p className="hud__muted">3 vidas · cada vez más bolas y más rápido</p>
          <button className="hud__button" onClick={onStart}>
            Jugar <kbd>Espacio</kbd>
          </button>
        </div>
      )}

      {phase === 'countdown' && (
        <div key={`count-${counter}`} className="hud__countdown">
          {counter}
        </div>
      )}

      {inGame && paused && (
        <div className="hud__panel hud__panel--small">
          <p>Cara no detectada</p>
          <p className="hud__muted">Juego en pausa</p>
        </div>
      )}

      {phase === 'over' && (
        <div className="hud__panel">
          <h2>{newRecord ? '¡Nuevo récord!' : 'Fin del juego'}</h2>
          <div className="hud__final">{score}</div>
          <p className="hud__muted">bolas esquivadas · mejor marca {best}</p>
          <button className="hud__button" onClick={onStart}>
            Jugar de nuevo <kbd>Espacio</kbd>
          </button>
          <p className="hud__muted">Reinicia en {counter}…</p>
        </div>
      )}
    </div>
  )
}
