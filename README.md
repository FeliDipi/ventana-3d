# Ventana 3D

PoC de una "ventana" 3D con head tracking: la webcam sigue tu cabeza y la escena se renderiza con proyección off-axis, como si el monitor fuera un agujero hacia una habitación. Al moverte, la esfera aparece y desaparece detrás de la columna.

**Demo:** https://felidipi.github.io/ventana-3d/

## Uso

- Al abrir, la página pide permiso para la cámara. Sin webcam funciona con el mouse (la rueda cambia la distancia).
- **Pantalla completa** da el resultado más fiel.
- Atajos: `D` debug, `A` ajustes (diagonal de pantalla, FOV de la webcam, distancia interpupilar, factor de profundidad, distancia ojos → centro de la cabeza), `C` centrar vista.
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
