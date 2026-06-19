import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    daemon: 'src/daemon.ts',
    'bin/tripwire-proxy': 'bin/tripwire-proxy.ts',
  },
  format: ['cjs', 'esm'],
  dts: false,
  clean: true,
  // express + openai stay external — they ship as runtime deps in the image.
  external: ['express', 'openai'],
})
