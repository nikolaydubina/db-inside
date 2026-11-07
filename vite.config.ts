import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  server: { port: 5199, open: false },
  build: { target: 'es2022' },
})
