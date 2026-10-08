import { defineConfig } from 'vite';

// Editing another scene must not reload an offline render halfway through a film.
export default defineConfig({
  server: {
    hmr: false,
    watch: { ignored: ['**/*'] },
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
