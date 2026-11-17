# Ventana 3D

PoC de una "ventana" 3D con head tracking: la webcam sigue tu cabeza y la escena se renderiza con proyección off-axis, como si el monitor fuera una ventana real. Detrás hay un diorama exterior low-poly (macetas en el alféizar, enredadera, jardín con cabaña, estanque, bosque y montañas) modelado en Blender con la luz horneada; todo está a escala real, así que al moverte las macetas tapan y destapan un paisaje que se comporta como uno de verdad. Delante de la pantalla flotan motas de polen y de vez en cuando pasa una mariposa, que parecen salir del monitor.

**Demo:** https://felidipi.github.io/ventana-3d/

## Uso

- Al abrir, la página pide permiso para la cámara. Sin webcam funciona con el mouse (la rueda cambia la distancia).
- **Pantalla completa** da el resultado más fiel.
- Atajos: `D` debug, `A` ajustes (diagonal de pantalla, FOV de la webcam, distancia interpupilar, factor de profundidad, distancia ojos → centro de la cabeza), `C` centrar vista, `E` alterna con la sala de prueba (cuadrícula, columna y esfera), `P` muestra u oculta el contenido delante de la pantalla (motas y mariposa).
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

## Escena (Blender)

`public/models/diorama.glb` se genera con [`blender/build_diorama.py`](blender/build_diorama.py): modela la escena por código, hornea la iluminación de Cycles en una textura por capa y exporta el GLB. La app la dibuja sin luces (`MeshBasicMaterial`), así que el costo en el navegador es mínimo.

```bash
# Vistas de control en blender/preview/ (rápido, sin hornear)
blender --background --factory-startup --python blender/build_diorama.py -- --preview
# Escena completa: hornea (~4 min con GPU), guarda blender/diorama.blend y exporta el GLB
blender --background --factory-startup --python blender/build_diorama.py
```

Coordenadas en Blender: metros reales, la pantalla es el plano Y = 0, la escena se extiende hacia +Y y +Z es arriba (el exportador glTF lo convierte a la convención de la app, con la escena en z < 0).

**Escala.** El muro, el alféizar y las macetas se modelan en tamaño real. El paisaje se modela en "coordenadas de maqueta" (más cómodas de componer) y al final se escala `REAL_K = 30` veces alrededor del ojo por defecto (`M_REAL`): desde ese punto la imagen no cambia, pero el parallax y el acercamiento son los de un paisaje real (cabaña a ~75 m, suelo ~3,6 m bajo la ventana, cordillera a cientos de metros, cielo a 1,8 km). Mezclar escalas produce el "efecto maqueta": al acercarse, lo cercano parece venir hacia uno y el fondo alejarse.
