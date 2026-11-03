// Raw video frames straight from the drawing buffer, shared by the MCP render job and scripts/render-media.mjs.
// A DevTools screenshot makes the compositor encode a JPEG and send it as base64, 84 percent of a film job (issue #301).
// A read of the drawing buffer skips both. It must run in the same task as the draw, because the browser clears the
// drawing buffer once it has presented the frame. The page then sends the bytes to Node over one binary WebSocket and
// waits for a one byte acknowledgement, so one frame is in flight at a time and the encoder sets the pace.
// Returning a typed array from Playwright's evaluate costs about 50 ms for a 1280 by 720 frame. A fetch with a Blob body
// delivered 100 to 150 frames and then failed with "Failed to fetch", so a socket replaces it.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

/** Runs in the page. Defines window.__finishDraw() and window.__readFrame(), which sends the bottom-up RGBA pixels. */
function installFrameReader(url) {
  let pixels;
  let socket;
  let pendingAcknowledgement;
  const canvasContext = () => document.querySelector('canvas').getContext('webgl2');
  // Waits for the GPU to finish the draw, so that draw time is not counted as read time.
  window.__finishDraw = () => canvasContext().finish();
  window.__connectFrameSocket = () => new Promise((resolve, reject) => {
    socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error('The frame socket could not connect.'));
    socket.onclose = () => pendingAcknowledgement?.reject(new Error('The frame socket closed.'));
    socket.onmessage = () => pendingAcknowledgement?.resolve();
  });
  window.__readFrame = async () => {
    const context = canvasContext();
    const { drawingBufferWidth: width, drawingBufferHeight: height } = context;
    if (!pixels || pixels.length !== width * height * 4) pixels = new Uint8Array(width * height * 4);
    const readStarted = performance.now();
    context.readPixels(0, 0, width, height, context.RGBA, context.UNSIGNED_BYTE, pixels);
    const readMilliseconds = performance.now() - readStarted;
    const acknowledged = new Promise((resolve, reject) => { pendingAcknowledgement = { resolve, reject }; });
    socket.send(pixels);
    await acknowledged;
    pendingAcknowledgement = undefined;
    return { width, height, readMilliseconds };
  };
}

/** Call once per page before the first frame. `url` is the receiver's socket address. */
export async function installFrameReaderInPage(page, url) {
  await page.evaluate(installFrameReader, url);
  await page.evaluate(() => window.__connectFrameSocket());
}

/** The ffmpeg input arguments for raw frames. GL rows run bottom-up, so the picture is flipped, and RGB converts with BT.709. */
export function rawFrameInputArguments({ width, height, fps }) {
  return { input: ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-framerate', String(fps)],
    filter: ['-vf', 'vflip,scale=out_color_matrix=bt709:out_range=tv'] };
}

/**
 * Receives one frame at a time on a path nobody else knows. `handleUpgrade(request, socket, head)` returns true when it
 * took the connection, so a server that already serves the page can share its port.
 */
export function createFrameReceiver({ maximumBytes }) {
  const path = `/__frame/${randomBytes(12).toString('hex')}`;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: maximumBytes, perMessageDeflate: false });
  const acknowledgement = Buffer.from([1]);
  let received;
  let chunkHandler;
  sockets.on('connection', socket => {
    socket.on('message', (data, isBinary) => {
      // Encoded chunks go straight to the handler and are not acknowledged. The page's closing text message is.
      if (isBinary && chunkHandler) {
        chunkHandler(data);
        return;
      }
      if (isBinary) received = data;
      socket.send(acknowledgement);
    });
  });
  return Object.freeze({
    path,
    handleUpgrade(request, socket, head) {
      if (request.url !== path) return false;
      sockets.handleUpgrade(request, socket, head, connection => sockets.emit('connection', connection, request));
      return true;
    },
    /** Sends each encoded video chunk from the page to `handler(bytes)` in order. */
    onChunk(handler) {
      chunkHandler = handler;
    },
    /** The frame the page sent since the last call, checked against the size the encoder was started with. */
    take({ width, height }, info) {
      if (info.width !== width || info.height !== height) {
        throw new Error(`The drawing buffer is ${info.width}x${info.height} but the video is ${width}x${height}.`);
      }
      const frame = received;
      received = undefined;
      if (!frame || frame.length !== width * height * 4) throw new Error('The page did not deliver a complete frame.');
      return frame;
    },
    close() {
      for (const client of sockets.clients) client.terminate();
      sockets.close();
    },
  });
}

/** A loopback server that only receives frames, for pages that another server already serves. */
export async function startFrameServer(receiver) {
  const server = createServer((request, response) => {
    response.writeHead(404);
    response.end();
  });
  server.on('upgrade', (request, socket, head) => {
    if (!receiver.handleUpgrade(request, socket, head)) socket.destroy();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { url: `ws://127.0.0.1:${server.address().port}${receiver.path}`,
    close: () => new Promise(resolve => { receiver.close(); server.closeAllConnections(); server.close(resolve); }) };
}

/**
 * Runs in the page. Defines window.__startVideoEncoder(), __encodeFrame() and __finishVideoEncoder().
 * The page encodes each frame with the browser's hardware H.264 encoder, so only the encoded chunks, a few tens of
 * kilobytes a frame, travel over the socket instead of 3.7 MB of pixels (issue #301).
 */
function installVideoEncoder(url) {
  const maximumQueuedFrames = 3;
  const maximumBufferedBytes = 16 * 1024 ** 2;
  let encoder;
  let socket;
  let encoderFailure;
  let wakeAcknowledgement;
  let settings;
  const pause = () => new Promise(resolve => setTimeout(resolve, 1));
  // Waits for the GPU to finish the draw, so that draw time is not counted as encode time.
  window.__finishDraw = () => document.querySelector('canvas').getContext('webgl2').finish();
  window.__startVideoEncoder = async ({ width, height, fps, quantizer }) => {
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return { supported: false, reason: 'WebCodecs is unavailable.' };
    const level = width * height > 1920 * 1088 ? '33' : '28';
    const config = { codec: `avc1.6400${level}`, width, height, framerate: fps, bitrate: 20e6, bitrateMode: 'quantizer',
      hardwareAcceleration: 'prefer-hardware', latencyMode: 'quality', avc: { format: 'annexb' } };
    const support = await VideoEncoder.isConfigSupported(config);
    if (!support.supported) return { supported: false, reason: 'The browser cannot encode this size with a hardware H.264 encoder.' };
    socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('The video socket could not connect.'));
    });
    socket.onmessage = () => wakeAcknowledgement?.();
    encoder = new VideoEncoder({
      output: chunk => {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        socket.send(bytes);
      },
      error: error => { encoderFailure = error; },
    });
    encoder.configure(config);
    settings = { fps, quantizer, keyFrameInterval: fps * 2 };
    return { supported: true };
  };
  // Call in the same task as the draw: the browser clears the drawing buffer once it presents the frame.
  window.__encodeFrame = async index => {
    if (encoderFailure) throw new Error(`The page video encoder failed: ${encoderFailure.message}`);
    const started = performance.now();
    const frame = new VideoFrame(document.querySelector('canvas'), { timestamp: Math.round(index * 1e6 / settings.fps) });
    encoder.encode(frame, { keyFrame: index % settings.keyFrameInterval === 0, avc: { quantizer: settings.quantizer } });
    frame.close();
    const submitMilliseconds = performance.now() - started;
    while (encoder.encodeQueueSize > maximumQueuedFrames || socket.bufferedAmount > maximumBufferedBytes) await pause();
    return { submitMilliseconds, waitMilliseconds: performance.now() - started - submitMilliseconds };
  };
  window.__finishVideoEncoder = async () => {
    await encoder.flush();
    if (encoderFailure) throw new Error(`The page video encoder failed: ${encoderFailure.message}`);
    const acknowledged = new Promise(resolve => { wakeAcknowledgement = resolve; });
    socket.send('end');
    await acknowledged;
    encoder.close();
    socket.close();
  };
}

/** Starts the page's hardware H.264 encoder. Returns { supported, reason }: when it is not supported, use readback frames. */
export async function startVideoEncoderInPage(page, url, { width, height, fps, quantizer }) {
  await page.evaluate(installVideoEncoder, url);
  return page.evaluate(options => window.__startVideoEncoder(options), { width, height, fps, quantizer });
}

/** Quantizer that matches the quality of the NVENC constant quality 20 files this pipeline wrote before. */
export const DEFAULT_PAGE_ENCODER_QUANTIZER = 20;
