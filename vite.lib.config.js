import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    copyPublicDir: false,
    rolldownOptions: { output: { banner: `/*! ${readFileSync('LICENSE', 'utf8')}\nOptional glTF decoder: ${readFileSync('THIRD-PARTY-NOTICES.md', 'utf8')} */` } },
    outDir: 'build',
    lib: {
      entry: {
        core: 'src/index.js',
        model: 'src/model.js',
        nature: 'src/nature.js',
        film: 'src/film.js',
        motion: 'src/motion.js',
        canvas2d: 'src/canvas2d.js',
        gltf: 'src/gltf.js',
        modeling: 'src/modeling.js',
      },
      formats: ['es'],
      fileName: (_, entry) => entry === 'core' ? '67.module.js' : `${entry}.js`,
    },
    minify: true,
  },
});
