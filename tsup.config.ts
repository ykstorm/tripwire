import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/daemon.ts'],
  format: ['cjs', 'esm'],
  dts: false,
  clean: true,
})