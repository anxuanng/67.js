import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    copyPublicDir: false,
    rolldownOptions: { output: { banner: `/*! ${readFileSync('LICENSE', 'utf8')} */` } },
    outDir: 'build-browser',
    lib: { entry: 'src/index.js', formats: ['es'], fileName: () => '67.module.js' },
    minify: true,
  },
});
