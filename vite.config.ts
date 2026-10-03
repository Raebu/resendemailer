import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: '.',
  server: {
    host: '127.0.0.1',
    port: 8767,
    proxy: {
      '/api': 'http://127.0.0.1:8768',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
