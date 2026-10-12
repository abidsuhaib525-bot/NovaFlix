import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

const BACKEND = process.env.MOVIEBOX_BACKEND ?? 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: BACKEND,
        changeOrigin: true,
        // SSE / streaming must not be buffered.
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['x-accel-buffering'] = 'no';
            }
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        // React is split out so a change to app code does not invalidate the
        // framework chunk in the browser cache. React changes on the order of
        // months; app code changes on the order of hours.
        //
        // `shaka-player` is deliberately absent from this list. The watch route
        // pulls it in through a dynamic `import()`, and Rollup already puts a
        // dynamically imported module in its own chunk -- which is the whole
        // point, since only that route pays the ~775 kB. Naming it here instead
        // splits the package's entry shim from its implementation and emits two
        // requests where one does the job. Rollup's "larger than 500 kB" notice
        // is about that chunk being big, and it is meant to be: it is one
        // library, fetched once, by one route.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
});