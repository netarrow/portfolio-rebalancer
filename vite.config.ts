import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'

// Numeric app version shown in the UI (rendered as "v<version>"), computed
// automatically — never bumped by hand. In CI/Docker the git commit count is
// injected via the APP_VERSION build arg (see Dockerfile + docker-publish.yml);
// locally we derive the same commit count, falling back to "0".
function resolveAppVersion(): string {
  if (process.env.APP_VERSION) return process.env.APP_VERSION
  try {
    return execSync('git rev-list --count HEAD').toString().trim() || '0'
  } catch {
    return '0'
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(resolveAppVersion()),
  },
  server: {
    port: 3001,
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3002',
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
