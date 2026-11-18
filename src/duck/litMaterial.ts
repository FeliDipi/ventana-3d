/* Portado de tuxdi-site-webapp/components/common/3D/litMaterial.ts y Duck.tsx (set "lit"). */
import { MeshPhysicalMaterial, type Texture } from 'three'
import { fresnelRim, RIM_CACHE_KEY } from './fresnelRim'

/**
 * Goma bajo una capa de barniz: la capa es lo que toma el color de las luces de la
 * escena (un difuso amarillo bajo luz cian solo puede volver oliva).
 */
export const LIT_BASE = {
  roughness: 0.5,
  metalness: 0,
  clearcoat: 0.6,
  clearcoatRoughness: 0.5,
} as const

/** Las partes "Brillos" (ojos, pico): más lisas, sin llegar a espejo. */
export const LIT_BRILLOS = { roughness: 0.15, clearcoat: 1, clearcoatRoughness: 0.05 } as const

export function createDuckMaterial(
  map: Texture | null,
  overrides?: ConstructorParameters<typeof MeshPhysicalMaterial>[0],
) {
  const material = new MeshPhysicalMaterial({
    map,
    color: 0xffffff,
    ...LIT_BASE,
    // El pato es el sujeto: la niebla de la habitación no lo lava.
    fog: false,
    ...overrides,
  })
  material.onBeforeCompile = fresnelRim
  material.customProgramCacheKey = () => RIM_CACHE_KEY
  return material
}
