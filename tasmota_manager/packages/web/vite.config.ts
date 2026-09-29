/// <reference types="vitest/config" />
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative Pfade, damit die App unter dem HA-Ingress-Pfad funktioniert.
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  server: { proxy: { '/api': { target: 'http://localhost:8099', ws: true } } },
  test: { environment: 'jsdom', setupFiles: ['./src/test/setup.ts'] },
});
