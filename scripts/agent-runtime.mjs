import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { createRequire } from 'node:module';
import packageMetadata from '../package.json' with { type: 'json' };
import { AGENT_SCENE_CAPABILITIES, AGENT_SCENE_DEFAULT_LIMITS, RENDER_PASS_NAMES, RENDER_PASS_DEPTH_RANGE } from '../src/agent-scene-capabilities.js';
import { createAgentAssetCatalog } from './agent-asset-catalog.mjs';
import { createAgentRenderJobs, EXPORT_DIRECTORY_NAME } from './agent-render-jobs.mjs';
import { createFrameEncoder } from './frame-encoder.mjs';
import { isPreviewHost } from './preview-host.mjs';
import { normalizeReview, REVIEW_LIMITS } from './agent-review.mjs';
import { sessionProblem } from '../src/agent-errors.js';

const SCENE_LIMITS = AGENT_SCENE_DEFAULT_LIMITS;
const MAXIMUM_IMAGE_BYTES = 1024 * 1024;
// The object ID pass lists the part behind each ID in the job metrics; longer lists are cut and flagged.
const MAXIMUM_OBJECT_NAMES = 1000;
const MAXIMUM_QUEUED_CALLS = 16;
const MAXIMUM_GLB_BYTES = 32 * 1024 * 1024;
const MAXIMUM_KEPT_GLBS = 8;
const EVALUATION_TIMEOUT_MS = 30000;
const html = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#182126}canvas{display:block;width:100vw;height:100vh}</style></head><body><canvas></canvas><script type="module" src="/preview.js"></script></body></html>';

/** Local, serialized browser preview. No browser is launched until scene creation. */
// Optional peer dependencies the page loads from the host's node_modules. Rapier ships its WASM inside rapier.mjs.
const VENDOR_FILES = Object.freeze({
  '/vendor/manifold.js': { resolve: require => require.resolve('manifold-3d/manifold.js'), type: 'application/javascript; charset=utf-8' },
  '/vendor/manifold.wasm': { resolve: require => require.resolve('manifold-3d/manifold.wasm'), type: 'application/wasm' },
  '/vendor/rapier.js': { resolve: require => join(dirname(require.resolve('@dimforge/rapier3d-compat')), 'rapier.mjs'), type: 'application/javascript; charset=utf-8' },
});

export function createAgentRuntime({ backend = 'gpu', browser: browserPath, memory = 192, assets: assetRoot,
  jobs: jobRoot, ffmpeg = 'ffmpeg',
  previewUrl = new URL(/* @vite-ignore */ '../build/mcp/preview.js', import.meta.url) } = {}) {
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
  if (jobRoot !== undefined && (typeof jobRoot !== 'string' || !isAbsolute(jobRoot))) {
    throw new TypeError('Job root must be an explicit absolute directory path.');
  }
  if (typeof ffmpeg !== 'string' || !ffmpeg || (ffmpeg !== 'ffmpeg' && (!isAbsolute(ffmpeg) || !existsSync(ffmpeg)))) {
    throw new TypeError('FFmpeg must be on PATH or configured with an existing absolute executable path.');
  }
  let phase = 'idle';
  let browserInstance;
  let httpServer;
  let page;
  let reviewPage;
  let cancelReview;
  let activeSessionId = null;
  let queuedCalls = 0;
  let queue = Promise.resolve();
  let closing;
  let catalogPromise;
  let jobsPromise;
  const savedGlbPaths = [];
  function jobs() {
    if (!jobRoot) throw new Error('Configure --jobs with an absolute output directory before submitting render jobs.');
    if (!jobsPromise && closing) throw new Error('The agent runtime is closing or closed.');
    jobsPromise ??= createAgentRenderJobs({ root: jobRoot, run: runJob });
    return jobsPromise;
  }
  // The caller never names a path: files get a server-chosen name in the jobs folder, and only the newest few are kept.
  async function saveGlbExport(bytes) {
    const directory = join(jobRoot, EXPORT_DIRECTORY_NAME);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('The export folder must be a real directory without links.');
    while (savedGlbPaths.length >= MAXIMUM_KEPT_GLBS) await unlink(savedGlbPaths.shift());
    const filename = `${randomUUID()}.glb`;
    const path = join(directory, filename);
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    savedGlbPaths.push(path);
    return { path, filename, mimeType: 'model/gltf-binary', bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), keptExports: savedGlbPaths.length };
  }
  async function requirePreviewRenderer() {
    if (phase !== 'rendering') return;
    const terminal = ['completed', 'cancelled', 'failed', 'interrupted'];
    if ((await jobs()).list().some(record => !terminal.includes(record.state))) {
      throw new Error('The renderer is leased to a render job. Wait for completion or cancel the job.');
    }
    // A queued job can be cancelled before its runner acquires the renderer.
    phase = 'ready';
  }
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

  // Mesh booleans load Manifold and recipe physics loads Rapier, both optional peer dependencies, from the host's
  // node_modules. Without one the page gets a 404 and the edit reports the install command.
  function serveVendorFile({ resolve, type }, response) {
    let path;
    try {
      path = resolve(createRequire(import.meta.url));
    } catch {
      response.writeHead(404);
      response.end();
      return;
    }
    readFile(path).then(bytes => {
      response.setHeader('Content-Type', type);
      response.end(bytes);
    }, () => {
      response.writeHead(404);
      response.end();
    });
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
        if (!isPreviewHost(request.headers.host, httpServer.address().port)) {
          response.writeHead(403);
          response.end();
          return;
        }
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'self' blob:");
        const vendor = request.method === 'GET' ? VENDOR_FILES[request.url] : undefined;
        if (vendor) {
          serveVendorFile(vendor, response);
          return;
        }
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
      throw new Error(sessionProblem(sessionId, activeSessionId));
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

  async function evaluate(method, input, target = page) {
    let timer;
    let timedOut = false;
    try {
      return await Promise.race([
        target.evaluate(({ method, input }) => window.__agentPreview[method](input), { method, input }),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            if (target === page) phase = 'failed';
            reject(new Error(target === page
              ? 'The preview operation exceeded 30 seconds. This runtime must be closed.'
              : 'The private render operation exceeded 30 seconds.'));
          }, EVALUATION_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      if (timedOut) {
        if (target === page) {
          activeSessionId = null;
          await shutdownResources();
        } else {
          await target.close();
        }
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function runJob({ jobId, directory, snapshot, settings, signal, progress }) {
    let jobPage;
    let encoder;
    let suspended = false;
    const sessionId = activeSessionId;
    const started = performance.now();
    const metrics = { backend, requestedWidth: settings.width, requestedHeight: settings.height,
      renderSeconds: 0, captureSeconds: 0, peakNodeBytes: 0, peakBrowserHeap: 0, maximumPendingFrames: 1 };
    const abort = () => { jobPage?.close().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      await enqueue(async () => {
        await invoke('suspend', { sessionId });
        suspended = true;
      });
      signal.throwIfAborted();
      jobPage = await browserInstance.newPage({ viewport: { width: settings.width, height: settings.height }, deviceScaleFactor: 1 });
      signal.throwIfAborted();
      const origin = `http://127.0.0.1:${httpServer.address().port}`;
      await jobPage.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      jobPage.setDefaultTimeout(15000);
      await jobPage.goto(origin);
      await jobPage.waitForFunction(() => Boolean(window.__agentPreview));
      const input = { sessionId: jobId, recipe: snapshot.recipe, memoryBudgetMiB: memory, backend,
        ...(snapshot.assetBytes ? { data: snapshot.assetBytes.toString('base64') } : {}) };
      const created = await jobPage.evaluate(({ method, input }) => window.__agentPreview[method](input),
        { method: snapshot.assetBytes ? 'createAsset' : 'create', input });
      const width = settings.kind === 'video' ? Math.floor(created.render.width / 2) * 2 : created.render.width;
      const height = settings.kind === 'video' ? Math.floor(created.render.height / 2) * 2 : created.render.height;
      if (width < 64 || height < 64) throw new Error('Render budget reduced the job below its minimum output size.');
      await jobPage.setViewportSize({ width, height });
      const session = await jobPage.context().newCDPSession(jobPage);
      const artifacts = [];
      if (settings.kind === 'video') {
        encoder = createFrameEncoder({ executable: ffmpeg, output: join(directory, 'render.mp4.partial'),
          fps: settings.fps, format: 'jpeg', signal });
      }
      for (let frame = 0; frame < settings.frameCount; frame++) {
        signal.throwIfAborted();
        const elapsed = settings.kind === 'video' ? frame / settings.fps
          : settings.kind === 'stills' ? settings.duration * frame / (settings.frameCount - 1) : 0;
        const frameInput = { sessionId: jobId,
          rendererTime: (settings.rendererTime?.start ?? 0) + elapsed * (settings.rendererTime?.rate ?? 1),
          ...(settings.motion ? { motionTime: settings.motion.start + elapsed } : {}),
          ...(settings.animation ? { animation: { clip: settings.animation.clip, time: settings.animation.start + elapsed } } : {}) };
        const renderStarted = performance.now();
        const rendered = await jobPage.evaluate(input => window.__agentPreview.frame(input), frameInput);
        metrics.renderSeconds += (performance.now() - renderStarted) / 1000;
        if (backend === 'cpu' && !/swiftshader/i.test(rendered.graphics)) throw new Error('CPU job did not select SwiftShader.');
        metrics.graphics = rendered.graphics;
        metrics.width = width;
        metrics.height = height;
        metrics.estimatedBytes = rendered.estimatedBytes;
        async function captureFrameBytes() {
          const captureStarted = performance.now();
          const captured = await session.send('Page.captureScreenshot', { fromSurface: true,
            format: settings.kind === 'video' ? 'jpeg' : 'png',
            ...(settings.kind === 'video' ? { quality: 95 } : { optimizeForSpeed: true }) });
          const captureBytes = Buffer.from(captured.data, 'base64');
          metrics.captureSeconds += (performance.now() - captureStarted) / 1000;
          if (captureBytes.length > MAXIMUM_IMAGE_BYTES) throw new Error('Captured job frame exceeded 1 MiB.');
          signal.throwIfAborted();
          return captureBytes;
        }
        async function writeArtifact(filename, artifactBytes) {
          await writeFile(join(directory, `${filename}.partial`), artifactBytes, { flag: 'wx' });
          artifacts.push({ temporary: `${filename}.partial`, filename, mimeType: 'image/png' });
        }
        const bytes = await captureFrameBytes();
        if (encoder) await encoder.writeFrame(bytes);
        else {
          const stem = settings.kind === 'image' ? 'render' : `frame-${frame}`;
          await writeArtifact(`${stem}.png`, bytes);
          // Passes follow the lit image of the same instant, so each seek yields every file for that frame.
          for (const pass of settings.passes ?? []) {
            const passInfo = await jobPage.evaluate(input => window.__agentPreview.frame(input),
              { ...frameInput, pass, passDepthRange: RENDER_PASS_DEPTH_RANGE });
            await writeArtifact(`${stem}-${pass}.png`, await captureFrameBytes());
            if (pass === 'depth') metrics.depthRangeMetres = RENDER_PASS_DEPTH_RANGE;
            if (pass === 'objectId') {
              metrics.objectNames = passInfo.objectNames.slice(0, MAXIMUM_OBJECT_NAMES);
              metrics.objectNamesTruncated = passInfo.objectNames.length > MAXIMUM_OBJECT_NAMES;
            }
          }
        }
        metrics.peakNodeBytes = Math.max(metrics.peakNodeBytes, process.memoryUsage().rss);
        const heap = await session.send('Runtime.getHeapUsage');
        metrics.peakBrowserHeap = Math.max(metrics.peakBrowserHeap, heap.usedSize);
        if (metrics.peakNodeBytes > 512 * 1024 ** 2 || metrics.peakBrowserHeap > 256 * 1024 ** 2) {
          throw new Error('Render job exceeded its Node RSS or sampled browser heap guard.');
        }
        await progress({ frames: frame + 1, maximumPendingFrames: 1 });
      }
      if (encoder) {
        metrics.encoder = await encoder.finish();
        artifacts.push({ temporary: 'render.mp4.partial', filename: 'render.mp4', mimeType: 'video/mp4' });
      }
      metrics.elapsedSeconds = (performance.now() - started) / 1000;
      return { artifacts, metrics };
    } finally {
      signal.removeEventListener('abort', abort);
      try { await encoder?.close(); }
      finally {
        try {
          if (jobPage && !jobPage.isClosed()) {
            try { await jobPage.evaluate(sessionId => window.__agentPreview.dispose({ sessionId }), jobId); }
            finally { await jobPage.close(); }
          }
        }
        finally {
          if (suspended && !closing) {
            try {
              await enqueue(() => invoke('resume', { sessionId }));
              phase = 'ready';
            } catch (error) {
              phase = 'failed';
              throw new Error(`Preview recovery failed after render job: ${error.message}`);
            }
          } else if (!closing && phase !== 'failed') phase = 'ready';
        }
      }
    }
  }

  return Object.freeze({
    async capabilities() {
      return {
        scene: AGENT_SCENE_CAPABILITIES,
        sceneLimits: SCENE_LIMITS,
        preview: { backend, memoryBudgetMiB: memory, maximumWidth: 1024, maximumHeight: 1024, maximumImageBytes: MAXIMUM_IMAGE_BYTES, maximumActiveScenes: 1, maximumQueuedCalls: MAXIMUM_QUEUED_CALLS, evaluationTimeoutMs: EVALUATION_TIMEOUT_MS },
        review: { ...REVIEW_LIMITS, backend, memoryBudgetMiB: memory, evaluationTimeoutMs: EVALUATION_TIMEOUT_MS,
          totalTimeoutMs: EVALUATION_TIMEOUT_MS,
          sourcePreserved: true, defaultMotionTime: null, defaultRendererTime: 0 },
        phase: closing && phase !== 'closed' ? 'closing' : phase,
        availableIn: packageMetadata.version,
        assets: {
          configured: Boolean(assetRoot), formats: ['self-contained GLB'],
          maximumBytes: 16 * 1024 * 1024, maximumAssets: 64,
          maximumVertices: 250000, maximumParts: 4096, maximumTexturePixels: 4194304, maximumJoints: 1024, maximumClips: 256,
          commands: ['set-root', 'set-asset-node', 'set-motion', 'set-animation', 'set-material', 'set-camera', 'set-environment', 'set-effects', 'set-shadow'],
        },
        jobs: { configured: Boolean(jobRoot), kinds: ['image', 'stills', 'video'], passes: RENDER_PASS_NAMES, maximumActiveJobs: 1,
          maximumDuration: 30, maximumFps: 30, maximumFrames: 900, maximumStills: 8,
          encoder: 'CPU H.264', audio: false, previewSuspendedDuringJob: true,
          glbExport: { maximumBytes: MAXIMUM_GLB_BYTES, maximumKept: MAXIMUM_KEPT_GLBS, maximumTextureSize: 4096 },
          records: jobRoot ? (await jobs()).list().map(record => ({ jobId: record.jobId, state: record.state,
            sourceRevision: record.sourceRevision, progress: record.progress })) : [] },
        unsupported: ['remote asset providers', 'arbitrary code execution', 'imported morph track authoring', 'job audio'],
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
    inspectMeshes(input) {
      return enqueue(() => invoke('inspectMeshes', input));
    },
    setMeshStack(input) {
      return enqueue(async () => {
        await requirePreviewRenderer();
        return invoke('setMeshStack', input);
      });
    },
    editMesh(input) {
      return enqueue(async () => {
        await requirePreviewRenderer();
        return invoke('editMesh', input);
      });
    },
    apply(input) {
      return enqueue(async () => {
        await requirePreviewRenderer();
        return invoke('apply', input);
      });
    },
    look(input) {
      return enqueue(async () => {
        await requirePreviewRenderer();
        requireSession(input.sessionId);
        const width = input.width ?? 768;
        const height = input.height ?? 512;
        if (![width, height].every(value => Number.isInteger(value) && value >= 64 && value <= 1024)) {
          throw new RangeError('Preview dimensions must be integers from 64 to 1024.');
        }
        await page.setViewportSize({ width, height });
        const result = await invoke('look', { sessionId: input.sessionId,
          ...(input.motionTime !== undefined ? { motionTime: input.motionTime } : {}) });
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
      return enqueue(async () => {
        await requirePreviewRenderer();
        return invoke('checkpoint', { ...input, checkpointId: randomUUID() });
      });
    },
    review(input) {
      let settings;
      try { settings = normalizeReview(input); }
      catch (error) { return Promise.reject(error); }
      return enqueue(async () => {
        await requirePreviewRenderer();
        requireSession(settings.sessionId);
        const snapshot = await invoke('snapshot', settings);
        const assetBytes = snapshot.recipe.format === '67js.asset' ? await (await catalog()).read(snapshot.recipe.assetId) : undefined;
        const privateSessionId = randomUUID();
        const started = performance.now();
        let suspended = false;
        let privateCreated = false;
        let session;
        let output;
        let deadlineExpired = false;
        let cancellationReason;
        const cancellation = new Promise((resolve, reject) => {
          cancelReview = error => {
            cancellationReason ??= error;
            reject(cancellationReason);
            reviewPage?.close().catch(() => {});
          };
        });
        // Cancellation can arrive during source suspension, before acquisition attaches its race.
        cancellation.catch(() => {});
        const deadline = setTimeout(() => {
          deadlineExpired = true;
          cancelReview(new Error('The review exceeded its total 30 second deadline.'));
        }, EVALUATION_TIMEOUT_MS);
        function requireReviewOpen() {
          if (deadlineExpired) throw new Error('The review exceeded its total 30 second deadline.');
          if (closing) throw new Error('The agent runtime is closing.');
        }
        async function reviewEvaluate(method, value) {
          requireReviewOpen();
          const result = await evaluate(method, value, reviewPage);
          requireReviewOpen();
          return result;
        }
        try {
          await invoke('suspend', { sessionId: settings.sessionId });
          suspended = true;
          phase = 'reviewing';
          requireReviewOpen();
          const acquisition = browserInstance.newPage({ viewport: { width: settings.width, height: settings.height }, deviceScaleFactor: 1 })
            .then(async acquired => {
              if (cancellationReason) {
                await acquired.close();
                throw cancellationReason;
              }
              return acquired;
            });
          reviewPage = await Promise.race([acquisition, cancellation]);
          requireReviewOpen();
          const origin = `http://127.0.0.1:${httpServer.address().port}`;
          await reviewPage.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
          reviewPage.setDefaultTimeout(15000);
          await reviewPage.goto(origin);
          await reviewPage.waitForFunction(() => Boolean(window.__agentPreview));
          await reviewEvaluate(assetBytes ? 'createAsset' : 'create', { sessionId: privateSessionId,
            recipe: snapshot.recipe, memoryBudgetMiB: memory, backend,
            ...(assetBytes ? { data: assetBytes.toString('base64') } : {}) });
          privateCreated = true;
          await reviewEvaluate('reviewBegin', { sessionId: privateSessionId,
            width: settings.gridWidth, height: settings.gridHeight });
          session = await reviewPage.context().newCDPSession(reviewPage);
          const shots = [];
          let peakBrowserHeap = 0;
          let peakNodeBytes = 0;
          for (const [index, shot] of settings.shots.entries()) {
            const rendered = await reviewEvaluate('reviewShot', { sessionId: privateSessionId, shot, index,
              width: settings.width, height: settings.height, columns: settings.columns });
            if (backend === 'cpu' && !/swiftshader/i.test(rendered.graphics)) throw new Error('CPU review did not select SwiftShader.');
            peakNodeBytes = Math.max(peakNodeBytes, process.memoryUsage().rss);
            peakBrowserHeap = Math.max(peakBrowserHeap, (await session.send('Runtime.getHeapUsage')).usedSize);
            if (peakNodeBytes > 512 * 1024 ** 2 || peakBrowserHeap > 256 * 1024 ** 2) {
              throw new Error('Review exceeded its Node RSS or sampled browser heap guard.');
            }
            shots.push(rendered);
          }
          const result = await reviewEvaluate('reviewResult', { sessionId: privateSessionId });
          if (Buffer.byteLength(result.data, 'base64') > MAXIMUM_IMAGE_BYTES) throw new Error('The review PNG exceeds the 1 MiB image response budget. Request smaller shots.');
          output = { ...result, metadata: { sessionId: settings.sessionId, sourceRevision: snapshot.sourceRevision,
            backend, width: settings.gridWidth, height: settings.gridHeight, shots,
            peakNodeBytes, peakBrowserHeap, maximumPendingFrames: 1 } };
        } catch (error) {
          if (deadlineExpired) throw new Error('The review exceeded its total 30 second deadline.');
          throw error;
        } finally {
          clearTimeout(deadline);
          cancelReview = undefined;
          try {
            if (reviewPage && !reviewPage.isClosed()) {
              try {
                if (privateCreated && !closing) await evaluate('dispose', { sessionId: privateSessionId }, reviewPage);
              } finally {
                try { await reviewPage.close(); }
                catch (error) {
                  phase = 'failed';
                  await shutdownResources();
                  throw error;
                }
              }
            }
          } finally {
            reviewPage = undefined;
            await session?.detach().catch(() => {});
            if (suspended && !closing && phase !== 'failed') {
              try { await invoke('resume', { sessionId: settings.sessionId }); }
              catch (error) {
                phase = 'failed';
                throw new Error(`Preview recovery failed after review: ${error.message}`);
              }
              phase = 'ready';
            }
          }
        }
        output.metadata.elapsedSeconds = (performance.now() - started) / 1000;
        return output;
      });
    },
    restore(input) {
      return enqueue(async () => {
        await requirePreviewRenderer();
        return invoke('restore', input);
      });
    },
    releaseCheckpoint(input) {
      return enqueue(async () => {
        await requirePreviewRenderer();
        return invoke('releaseCheckpoint', input);
      });
    },
    exportRecipe(input) {
      return enqueue(() => invoke('exportRecipe', input));
    },
    dispose(input) {
      return enqueue(async () => {
        await requirePreviewRenderer();
        const result = await invoke('dispose', input);
        activeSessionId = null;
        return result;
      });
    },
    exportGlb({ sessionId, clip, motionTime, maxTextureSize }) {
      return enqueue(async () => {
        await requirePreviewRenderer();
        await jobs();
        const exported = await invoke('exportGlb', { sessionId, clip, motionTime, maxTextureSize, maximumBytes: MAXIMUM_GLB_BYTES });
        const { data, ...summary } = exported;
        const file = await saveGlbExport(Buffer.from(data, 'base64'));
        return { ...summary, ...file };
      });
    },
    submitJob({ sessionId, expectedRevision, settings }) {
      return enqueue(async () => {
        await requirePreviewRenderer();
        const controller = await jobs();
        const snapshot = await invoke('snapshot', { sessionId, expectedRevision });
        const assetBytes = snapshot.recipe.format === '67js.asset' ? await (await catalog()).read(snapshot.recipe.assetId) : undefined;
        phase = 'rendering';
        try {
          return await controller.submit({ sourceRevision: snapshot.sourceRevision,
            snapshot: { recipe: snapshot.recipe, clips: snapshot.clips, ...(assetBytes ? { assetBytes } : {}) }, settings });
        } catch (error) {
          phase = 'ready';
          throw error;
        }
      });
    },
    async jobStatus({ jobId }) {
      const record = (await jobs()).status(jobId);
      if (phase === 'rendering' && ['completed', 'cancelled', 'failed', 'interrupted'].includes(record.state)) {
        await requirePreviewRenderer();
      }
      return record;
    },
    async cancelJob({ jobId }) {
      return (await jobs()).cancel(jobId);
    },
    async jobResult({ jobId }) {
      const result = (await jobs()).result(jobId);
      return { ...result, artifacts: result.artifacts.map(artifact => ({
        ...artifact, path: join(jobRoot, result.jobId, artifact.filename),
      })) };
    },
    async releaseJob({ jobId }) {
      return (await jobs()).release(jobId);
    },
    close() {
      if (!closing) {
        phase = 'closing';
        cancelReview?.(new Error('The agent runtime is closing.'));
        closing = (async () => {
          try {
            await reviewPage?.close().catch(() => {});
            if (jobsPromise) await (await jobsPromise).close();
          } finally {
            await queue;
            await shutdownResources();
          }
        })().finally(() => {
          activeSessionId = null;
          phase = 'closed';
        });
      }
      return closing;
    },
  });
}
