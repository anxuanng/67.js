import { defineConfig } from 'vite';

const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { headers },
  preview: { headers },
  build: { rolldownOptions: { input: { home: 'index.html', object: 'object.html', nature: 'nature.html', film: 'film.html', motion: 'motion.html', view2d: 'view2d.html', assets: 'assets.html', guide: 'getting-started.html' } } },
});
