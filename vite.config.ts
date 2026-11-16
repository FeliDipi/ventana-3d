import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react()],
  // GitHub Pages sirve el proyecto en /ventana-3d/.
  base: command === 'build' ? '/ventana-3d/' : '/',
}))
