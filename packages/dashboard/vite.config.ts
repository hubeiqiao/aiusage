import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': {
        target: 'https://aiusage.yizhe.me',
        changeOrigin: true,
      },
      '/pricing': {
        target: 'https://aiusage.yizhe.me',
        changeOrigin: true,
      },
      '/embed/docs': {
        target: 'https://aiusage.yizhe.me',
        changeOrigin: true,
      },
    },
  },
});
