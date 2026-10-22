import { defineConfig, type Plugin } from 'vitest/config'
import react from '@vitejs/plugin-react'

// The built page may only load its own files and in-memory images; it cannot make network requests.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

function contentSecurityPolicy(): Plugin {
  return {
    name: 'csp-meta',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  }
}

export default defineConfig({
  base: process.env.GITHUB_ACTIONS === 'true' ? '/unpinned/' : '/',
  plugins: [react(), contentSecurityPolicy()],
  build: {
    sourcemap: true,
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: './src/test-setup.ts',
    css: true,
  },
})
