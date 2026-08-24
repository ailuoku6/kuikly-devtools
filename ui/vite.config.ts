import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const PANEL_PORT = Number(process.env.KUIKLY_DEVTOOLS_PANEL_PORT ?? 8090);

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The panel is served over the LAN from a Node process, not a CDN; a single chunk keeps the
    // static server trivial and avoids a waterfall on first paint.
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5199,
    proxy: {
      '/api': `http://localhost:${PANEL_PORT}`,
      '/ws': { target: `ws://localhost:${PANEL_PORT}`, ws: true },
    },
  },
});
