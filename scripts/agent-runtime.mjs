import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import packageMetadata from '../package.json' with { type: 'json' };
import { createAgentScene, AGENT_SCENE_CAPABILITIES } from '../src/agent-scene.js';
import { createAgentAssetCatalog } from './agent-asset-catalog.mjs';

const EMPTY_RECIPE = { format: '67js.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [] };
const SCENE_LIMITS = createAgentScene(EMPTY_RECIPE).limits;
const MAXIMUM_IMAGE_BYTES = 1024 * 1024;
const MAXIMUM_QUEUED_CALLS = 16;
const EVALUATION_TIMEOUT_MS = 30000;
const html = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#182126}canvas{display:block;width:100vw;height:100vh}</style></head><body><canvas></canvas><script type="module" src="/preview.js"></script></body></html>';

/** Local, serialized browser preview. No browser is launched until scene creation. */
export function createAgentRuntime({ backend = 'gpu', browser: browserPath, memory = 192, assets: assetRoot,
  previewUrl = new URL('../build/mcp/preview.js', import.meta.url) } = {}) {
  if (!['gpu', 'cpu'].includes(backend)) {
    throw new RangeError('backend must be gpu or cpu.');
  }
  if (!Number.isInteger(memory) || memory < 32 || memory > 256) {
    throw new RangeError('memory must be an integer from 32 to 256 MiB.');
  }
  if (browserPath !== undefined && (typeof browserPath !== 'string' || !existsSync(browserPath))) {
    throw new Error('The configured browser executable does not exist.');
  }
  if (assetRoot !== undefined && (typeof assetRoot !== 'string' || !isAbsolute(assetRoot))) {
    throw new TypeError('Asset root must be an explicit absolute directory path.');
  }
  let phase = 'idle';
  let browserInstance;
  let httpServer;
  let page;
  let activeSessionId = null;
  let queuedCalls = 0;
  let queue = Promise.resolve();
  let closing;
  let catalogPromise;
  function catalog() {
    if (!assetRoot) throw new Error('Configure --assets with an absolute directory before importing GLB assets.');
    catalogPromise ??= createAgentAssetCatalog(assetRoot);
    return catalogPromise;
  }

  function enqueue(task) {
    if (closing || phase === 'closing' || phase === 'closed' || phase === 'failed') {
      return Promise.reject(new Error(`The agent runtime is ${phase}.`));
    }
    if (queuedCalls >= MAXIMUM_QUEUED_CALLS) {
      return Promise.reject(new Error('The preview call queue is full. Retry after pending calls finish.'));
    }
    queuedCalls++;
    const result = queue.then(() => {
      if (closing || phase === 'closed' || phase === 'failed') {
        throw new Error(`The agent runtime is ${closing ? 'closing' : phase}.`);
      }
      return task();
    });
    queue = result.catch(() => {}).finally(() => {
      queuedCalls--;
    });
    return result;
  }

  async function shutdownResources() {
    try {
      await browserInstance?.close();
    } finally {
      browserInstance = undefined;
      page = undefined;
      if (httpServer?.listening) {
        httpServer.closeAllConnections();
        await new Promise((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()));
      }
      httpServer = undefined;
    }
  }

  async function boot() {
    if (page) {
      return;
    }
    phase = 'starting';
    try {
      const [{ chromium }, code] = await Promise.all([
        import('playwright-core'),
        readFile(previewUrl, 'utf8'),
      ]);
      httpServer = createServer((request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data: blob:; connect-src blob:");
        if (request.method !== 'GET' || !['/', '/preview.js'].includes(request.url)) {
          response.writeHead(404);
          response.end();
          return;
        }
        response.setHeader('Content-Type', request.url === '/' ? 'text/html; charset=utf-8' : 'application/javascript; charset=utf-8');
        response.end(request.url === '/' ? html : code);
      });
      await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(0, '127.0.0.1', resolve);
      });
      const origin = `http://127.0.0.1:${httpServer.address().port}`;
      const args = ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'];
      if (backend === 'cpu') {
        args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
      }
      browserInstance = await chromium.launch({ headless: true, args,
        ...(browserPath ? { executablePath: browserPath } : { channel: 'chrome' }),
      });
      page = await browserInstance.newPage({ viewport: { width: 768, height: 512 }, deviceScaleFactor: 1 });
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        return url.origin === origin ? route.continue() : route.abort();
      });
      page.setDefaultTimeout(15000);
      await page.goto(origin);
      await page.waitForFunction(() => Boolean(window.__agentPreview));
      phase = 'ready';
    } catch (error) {
      phase = 'failed';
      await shutdownResources();
      throw error;
    }
  }

  function requireSession(sessionId) {
    if (!activeSessionId || sessionId !== activeSessionId) {
      throw new Error('Unknown or disposed scene session.');
    }
  }

  async function invoke(method, input) {
    requireSession(input.sessionId);
    if (!browserInstance?.isConnected() || page.isClosed()) {
      phase = 'failed';
      throw new Error('The preview browser disconnected. The scene cannot be recovered from this runtime.');
    }
    return evaluate(method, input);
  }

  async function evaluate(method, input) {
    let timer;
    let timedOut = false;
    try {
      return await Promise.race([
        page.evaluate(({ method, input }) => window.__agentPreview[method](input), { method, input }),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            phase = 'failed';
            reject(new Error('The preview operation exceeded 30 seconds. This runtime must be closed.'));
          }, EVALUATION_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      if (timedOut) {
        activeSessionId = null;
        await shutdownResources();
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    async capabilities() {
      return {
        scene: AGENT_SCENE_CAPABILITIES,
        sceneLimits: SCENE_LIMITS,
        preview: { backend, memoryBudgetMiB: memory, maximumWidth: 1024, maximumHeight: 1024, maximumImageBytes: MAXIMUM_IMAGE_BYTES, maximumActiveScenes: 1, maximumQueuedCalls: MAXIMUM_QUEUED_CALLS, evaluationTimeoutMs: EVALUATION_TIMEOUT_MS },
        phase: closing && phase !== 'closed' ? 'closing' : phase,
        availableIn: packageMetadata.version,
        assets: {
          configured: Boolean(assetRoot), formats: ['self-contained GLB'],
          maximumBytes: 16 * 1024 * 1024, maximumAssets: 64,
          maximumVertices: 250000, maximumParts: 4096, maximumTexturePixels: 4194304, maximumJoints: 1024, maximumClips: 256,
          commands: ['set-root', 'set-animation', 'set-material', 'set-camera', 'set-environment', 'set-effects', 'set-shadow'],
        },
        unsupported: ['remote asset providers', 'arbitrary code execution', 'animation authoring', 'video jobs'],
      };
    },
    create({ recipe }) {
      return enqueue(async () => {
        if (activeSessionId) {
          throw new Error('Dispose the current scene before creating another.');
        }
        await boot();
        const sessionId = randomUUID();
        const result = await evaluate('create', { recipe, sessionId, memoryBudgetMiB: memory, backend });
        activeSessionId = sessionId;
        return result;
      });
    },
    assetCatalog() {
      return enqueue(async () => assetRoot ? { configured: true, ...(await catalog()).list() } : { configured: false, assets: [] });
    },
    createAsset({ recipe }) {
      return enqueue(async () => {
        if (activeSessionId) throw new Error('Dispose the current scene before creating another.');
        const bytes = await (await catalog()).read(recipe.assetId);
        await boot();
        const sessionId = randomUUID();
        const result = await evaluate('createAsset', { recipe, data: bytes.toString('base64'), sessionId, memoryBudgetMiB: memory, backend });
        activeSessionId = sessionId;
        return result;
      });
    },
    inspect(input) {
      return enqueue(() => invoke('inspect', input));
    },
    apply(input) {
      return enqueue(() => invoke('apply', input));
    },
    look(input) {
      return enqueue(async () => {
        requireSession(input.sessionId);
        const width = input.width ?? 768;
        const height = input.height ?? 512;
        if (![width, height].every(value => Number.isInteger(value) && value >= 64 && value <= 1024)) {
          throw new RangeError('Preview dimensions must be integers from 64 to 1024.');
        }
        await page.setViewportSize({ width, height });
        const result = await invoke('look', { sessionId: input.sessionId });
        if (Buffer.byteLength(result.data, 'base64') > MAXIMUM_IMAGE_BYTES) {
          throw new Error('The PNG exceeds the 1 MiB image response budget. Request a smaller preview.');
        }
        result.metadata.requestedWidth = width;
        result.metadata.requestedHeight = height;
        result.metadata.backend = backend;
        return result;
      });
    },
    checkpoint(input) {
      return enqueue(() => invoke('checkpoint', { ...input, checkpointId: randomUUID() }));
    },
    restore(input) {
      return enqueue(() => invoke('restore', input));
    },
    releaseCheckpoint(input) {
      return enqueue(() => invoke('releaseCheckpoint', input));
    },
    exportRecipe(input) {
      return enqueue(() => invoke('exportRecipe', input));
    },
    dispose(input) {
      return enqueue(async () => {
        const result = await invoke('dispose', input);
        activeSessionId = null;
        return result;
      });
    },
    close() {
      if (!closing) {
        phase = 'closing';
        closing = queue.then(shutdownResources).finally(() => {
          activeSessionId = null;
          phase = 'closed';
        });
      }
      return closing;
    },
  });
}
