# Ventana 3D · Esquivá

Minijuego sobre una "ventana" 3D con head tracking: la webcam sigue tu cabeza y la escena se renderiza con proyección off-axis, como si el monitor fuera un agujero hacia una habitación. Desde el fondo vienen bolas apuntadas a tu cabeza que salen de la pantalla hacia vos: esquivalas moviendo la cabeza.

**Demo:** https://felidipi.github.io/ventana-3d/

## Juego

- Cada bola que te pasa de largo suma una **esquivada**. Si te pega perdés una de las **3 vidas** (después de cada golpe hay 1,2 s de invulnerabilidad).
- Al perder las 3 vidas se muestra el resultado y la partida se reinicia sola a los 5 s (o con `Espacio`). La **mejor marca** queda guardada en el navegador.
- La dificultad sube de a poco: aparecen más bolas y más rápido, y con el tiempo apuntan un poco adelante de tu movimiento. Las curvas están en [src/game/difficulty.ts](src/game/difficulty.ts).
- Si la cámara deja de ver tu cara, el juego se pausa.

## Uso

- Al abrir, la página pide permiso para la cámara. Sin webcam funciona con el mouse (la rueda cambia la distancia).
- **Pantalla completa** da el resultado más fiel: es donde mejor se ve a las bolas salir del monitor.
- `Espacio` / `Enter` jugar. Atajos: `D` debug, `A` ajustes (diagonal de pantalla, FOV de la webcam, distancia interpupilar, factor de profundidad, distancia ojos → centro de la cabeza), `C` centrar vista.
- Pensado para correr en la pantalla donde está la webcam (arriba al centro).

## Stack

Vite · React · TypeScript · Three.js · React Three Fiber · MediaPipe Face Landmarker.

## Desarrollo

```bash
npm install
npm run dev      # http://localhost:5173
npm run build
npm run deploy   # publica dist/ en la rama gh-pages
```
