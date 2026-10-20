import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/** Baut den Cloud-Server als eine einzige Datei für Node (dist-server/efeu-server.mjs). */
export default defineConfig({
  define: { __EFEU_VERSION__: JSON.stringify(version) },
  publicDir: false,
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: 'server/main.ts',
    outDir: 'dist-server',
    target: 'node22',
    emptyOutDir: true,
    minify: true,
    rollupOptions: { output: { format: 'esm', entryFileNames: 'efeu-server.mjs', inlineDynamicImports: true } },
  },
});
