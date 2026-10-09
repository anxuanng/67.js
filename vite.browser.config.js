import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    copyPublicDir: false,
    outDir: 'build-browser',
    lib: { entry: 'src/index.js', formats: ['es'], fileName: () => '67.module.js' },
    minify: true,
  },
});
