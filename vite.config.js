import { defineConfig } from 'vite';

const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { headers },
  preview: { headers },
  build: { rolldownOptions: { input: { object: 'index.html', nature: 'nature.html', film: 'film.html' } } },
});
