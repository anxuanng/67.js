import { createServer } from 'node:net';

// A fixed port collides with other test runs and dev servers on the same machine, so tests ask the system for a free one.
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}
