import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    copyPublicDir: false,
    rolldownOptions: {
      external: ['@dimforge/rapier3d-compat'],
      output: { banner: `/*! ${readFileSync('LICENSE', 'utf8')}\nThird-party notices: ${readFileSync('THIRD-PARTY-NOTICES.md', 'utf8')} */` },
    },
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
        sculpt: 'src/sculpt.js',
        surface: 'src/surface.js',
        'mesh-query': 'src/mesh-query.js',
        shrinkwrap: 'src/shrinkwrap.js',
        'surface-attachment': 'src/surface-attachment.js',
        physics: 'src/physics.js',
        spume: 'src/spume.js',
        retarget: 'src/retarget.js',
        vehicle: 'src/vehicle.js',
        vegetation: 'src/vegetation.js',
        terrain: 'src/terrain.js',
        grass: 'src/grass.js',
        'texture-set': 'src/texture-set.js',
        'agent-scene': 'src/agent-scene.js',
        'agent-asset': 'src/agent-asset.js',
        hdri: 'src/hdri.js',
      },
      formats: ['es'],
      fileName: (_, entry) => entry === 'core' ? '67.module.js' : `${entry}.js`,
    },
    minify: true,
  },
});
