import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    daemon: 'src/daemon.ts',
    'bin/tripwire-proxy': 'bin/tripwire-proxy.ts',
  },
  format: ['cjs', 'esm'],
  // Type declarations for the published library entry only; the daemon and CLI
  // are run, not imported, so they do not need a .d.ts.
  dts: { entry: { index: 'src/index.ts' } },
  clean: true,
  // express + openai stay external - they ship as runtime deps in the image.
  external: ['express', 'openai'],
})
