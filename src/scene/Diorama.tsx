import { useLoader } from '@react-three/fiber'
import { useMemo } from 'react'
import { MeshBasicMaterial, type Mesh, type MeshStandardMaterial } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const URL = `${import.meta.env.BASE_URL}models/diorama.glb`

/**
 * Diorama exterior generado por blender/build_diorama.py.
 *
 * La luz viene horneada en las texturas (Cycles), así que se dibuja sin iluminar
 * y sin tone mapping: el color del texel es el color final. Está modelado en
 * metros reales con la pantalla en z = 0, igual que el resto de la escena.
 */
export function Diorama() {
  const gltf = useLoader(GLTFLoader, URL)

  const scene = useMemo(() => {
    const root = gltf.scene
    root.traverse((obj) => {
      const mesh = obj as Mesh
      if (!mesh.isMesh) return
      const src = mesh.material as MeshStandardMaterial
      const map = src.map
      if (map) map.anisotropy = 8
      mesh.material = new MeshBasicMaterial({ map, toneMapped: false })
      src.dispose()
    })
    return root
  }, [gltf])

  return <primitive object={scene} />
}

useLoader.preload(GLTFLoader, URL)
