import { useFrame } from '@react-three/fiber'
import { useMemo } from 'react'
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, ShaderMaterial } from 'three'
import { mulberry32 } from './random'

/**
 * Motas de polen/polvo iluminadas por el sol, a ambos lados del plano de la pantalla.
 * Las que quedan delante (z > 0) "salen" del monitor por el parallax de movimiento.
 *
 * Para no producir violaciones de ventana (algo delante de la pantalla cortado por
 * su borde), las motas delanteras se desvanecen al acercarse al borde de la imagen.
 */

interface Group {
  count: number
  /** Devuelve [x, y, z, tamaño (m), amplitud de deriva (m), período de vida (s)]. */
  make: (r: () => number) => [number, number, number, number, number, number]
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

const GROUPS: Group[] = [
  // Delante de la pantalla, dentro del centro de la abertura.
  {
    count: 22,
    make: (r) => [
      lerp(-0.12, 0.12, r()),
      lerp(-0.06, 0.07, r()),
      lerp(0.015, 0.11, r()),
      lerp(0.0016, 0.0028, r()),
      lerp(0.006, 0.014, r()),
      lerp(9, 16, r()),
    ],
  },
  // Junto a la ventana, del lado de afuera.
  {
    count: 60,
    make: (r) => {
      const d = lerp(0.02, 1.5, r() ** 1.5)
      return [
        lerp(-1, 1, r()) * (0.16 + 0.32 * d),
        lerp(-0.08 - 0.12 * d, 0.09 + 0.2 * d, r()),
        -d,
        lerp(0.002, 0.0035, r()) * (1 + d * 1.5),
        0.01 + 0.02 * d,
        lerp(10, 18, r()),
      ]
    },
  },
  // Vilanos flotando sobre el jardín.
  {
    count: 55,
    make: (r) => {
      const d = lerp(1.5, 14, r())
      return [
        lerp(-1, 1, r()) * (0.2 + 0.3 * d),
        lerp(-0.05, 0.12, r()) * d,
        -d,
        lerp(0.012, 0.022, r()),
        0.04 + 0.015 * d,
        lerp(12, 22, r()),
      ]
    },
  },
]

const vertexShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec4 aParams; // x: fase, y: período (s), z: tamaño (m), w: amplitud (m)
  uniform float uTime;
  uniform float uScale;
  varying float vAlpha;

  void main() {
    float life = fract(uTime / aParams.y + aParams.x);
    float t = uTime + aParams.x * 97.0;
    float a = aParams.w;
    vec3 p = position + vec3(
      sin(t * 0.31) * a + sin(t * 0.73) * a * 0.4,
      (life - 0.5) * a * 1.6 + sin(t * 0.47) * a * 0.5,
      sin(t * 0.23) * a * 0.8
    );
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float dist = -mv.z;
    gl_PointSize = max(aParams.z * uScale / dist, 1.0);

    float alpha = sin(PI * life);            // aparece y se apaga suave
    alpha *= 0.65 + 0.35 * sin(t * 2.1);     // titileo
    if (p.z > 0.0) {
      vec2 ndc = gl_Position.xy / gl_Position.w;
      alpha *= 1.0 - smoothstep(0.68, 0.88, max(abs(ndc.x), abs(ndc.y)));
    }
    alpha *= smoothstep(0.1, 0.18, dist);    // nada pegado al ojo
    vAlpha = alpha;
    #include <logdepthbuf_vertex>
  }
`

const fragmentShader = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uColor;
  varying float vAlpha;

  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float glow = exp(-d * d * 5.0) * (1.0 - d);
    gl_FragColor = vec4(uColor * glow * vAlpha, 1.0);
    #include <logdepthbuf_fragment>
  }
`

export function Motes() {
  const { geometry, material } = useMemo(() => {
    const rand = mulberry32(42)
    const n = GROUPS.reduce((s, g) => s + g.count, 0)
    const pos = new Float32Array(n * 3)
    const params = new Float32Array(n * 4)
    let i = 0
    for (const g of GROUPS) {
      for (let k = 0; k < g.count; k++, i++) {
        const [x, y, z, size, amp, period] = g.make(rand)
        pos.set([x, y, z], i * 3)
        params.set([rand(), period, size, amp], i * 4)
      }
    }
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(pos, 3))
    geometry.setAttribute('aParams', new BufferAttribute(params, 4))
    const material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uScale: { value: 1 },
        uColor: { value: new Color(1.0, 0.86, 0.62).multiplyScalar(0.85) },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    })
    return { geometry, material }
  }, [])

  useFrame((state) => {
    const u = material.uniforms
    u.uTime.value = state.clock.elapsedTime
    // Píxeles por metro a 1 m de distancia (vale para el frustum asimétrico).
    u.uScale.value = state.camera.projectionMatrix.elements[5] * state.size.height * state.viewport.dpr * 0.5
  })

  return <points geometry={geometry} material={material} frustumCulled={false} />
}
