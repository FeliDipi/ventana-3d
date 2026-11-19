import { DuckIcon } from './DuckIcon'
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
            <DuckIcon key={i} className={i < lives ? 'life' : 'life life--lost'} />
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
          Récord <strong>{best}</strong>
        </div>
      </div>

      {phase === 'ready' && (
        <div className="hud__panel">
          <h1 className="hud__title">
            <span>Esquivá</span>
            <span className="hud__title-outline">al pato</span>
          </h1>
          <p>
            {camera
              ? 'El pato del fondo te tira bolas. Mové la cabeza para esquivarlas.'
              : 'El pato del fondo te tira bolas. Mové el mouse para esquivarlas.'}
          </p>
          <p className="hud__muted">3 vidas · ojo con los amagues, las curvas y los rebotes</p>
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
          <p>El pato no te ve 👀</p>
          <p className="hud__muted">Juego en pausa · volvé a la cámara</p>
        </div>
      )}

      {phase === 'over' && (
        <div className="hud__panel">
          <h2 className="hud__title hud__title--small">
            {newRecord ? (
              <>
                <span>¡Récord</span>
                <span className="hud__title-outline">del estanque!</span>
              </>
            ) : (
              <>
                <span>¡Te</span>
                <span className="hud__title-outline">embocó!</span>
              </>
            )}
          </h2>
          <div className="hud__final">{score}</div>
          <p className="hud__muted">bolas esquivadas · récord {best}</p>
          <button className="hud__button" onClick={onStart}>
            Jugar de nuevo <kbd>Espacio</kbd>
          </button>
          <p className="hud__muted">Reinicia en {counter}…</p>
        </div>
      )}
    </div>
  )
}
