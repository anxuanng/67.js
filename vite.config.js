import { defineConfig } from 'vite';

const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { headers, watch: { ignored: ['**/.claude/**'] } },
  // Scan only the project's own pages. Agent worktrees under .claude hold hundreds of copies of them and made the first page load take 13 s.
  optimizeDeps: { entries: ['*.html', 'bench/**/*.html'] },
  preview: { headers },
  build: {
    rolldownOptions: {
      input: {
        home: 'index.html',
        downloads: 'downloads.html',
        object: 'object.html',
        nature: 'nature.html',
        film: 'film.html',
        motion: 'motion.html',
        modeling: 'modeling.html',
        view2d: 'view2d.html',
        assets: 'assets.html',
        guide: 'getting-started.html',
        docs: 'docs.html',
        showcase: 'showcase.html',
      },
    },
  },
});
