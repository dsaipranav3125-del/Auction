import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/socket.io': {
        target: 'http://localhost:4000',
        ws: true,
      },
      '/health': 'http://localhost:4000',
      '/players': 'http://localhost:4000',
      '/room-code': 'http://localhost:4000',
    },
  },
})
