// Raw video frames straight from the drawing buffer, shared by the MCP render job and scripts/render-media.mjs.
// A DevTools screenshot makes the compositor encode a JPEG and send it as base64, 84 percent of a film job (issue #301).
// A read of the drawing buffer skips both. It must run in the same task as the draw, because the browser clears the
// drawing buffer once it has presented the frame. The page then posts the bytes to a Node receiver as a binary body:
// returning a typed array from Playwright's evaluate costs about 50 ms for a 1280 by 720 frame, a post costs a few.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

/** Runs in the page. Defines window.__finishDraw() and window.__readFrame(url), which posts the bottom-up RGBA pixels. */
function installFrameReader() {
  let pixels;
  const canvasContext = () => document.querySelector('canvas').getContext('webgl2');
  // Waits for the GPU to finish the draw, so that draw time is not counted as read time.
  window.__finishDraw = () => canvasContext().finish();
  window.__readFrame = async (url) => {
    const context = canvasContext();
    const { drawingBufferWidth: width, drawingBufferHeight: height } = context;
    if (!pixels || pixels.length !== width * height * 4) pixels = new Uint8Array(width * height * 4);
    const readStarted = performance.now();
    context.readPixels(0, 0, width, height, context.RGBA, context.UNSIGNED_BYTE, pixels);
    const readMilliseconds = performance.now() - readStarted;
    // A Blob body: Playwright keeps a copy of every typed-array body it sees (3.7 MB a frame) until the page closes.
    // A connection that the server closed while idle fails the first post, so one retry follows.
    let response;
    try { response = await fetch(url, { method: 'POST', body: new Blob([pixels]) }); }
    catch { response = await fetch(url, { method: 'POST', body: new Blob([pixels]) }); }
    if (!response.ok) throw new Error(`The frame receiver answered ${response.status}.`);
    return { width, height, readMilliseconds };
  };
}

/** Call once per page before the first frame. */
export async function installFrameReaderInPage(page) {
  await page.evaluate(installFrameReader);
}

/** The ffmpeg input arguments for raw frames. GL rows run bottom-up, so the picture is flipped, and RGB converts with BT.709. */
export function rawFrameInputArguments({ width, height, fps }) {
  return { input: ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-framerate', String(fps)],
    filter: ['-vf', 'vflip,scale=out_color_matrix=bt709:out_range=tv'] };
}

/** A slow frame on the CPU backend takes longer than the default five seconds a server keeps an idle connection. */
export const KEEP_ALIVE_MILLISECONDS = 120000;

/**
 * Receives one posted frame at a time on a path nobody else knows. `handle(request, response)` returns true when it
 * took the request. `crossOrigin` answers with the headers a page on another port needs.
 */
export function createFrameReceiver({ maximumBytes, crossOrigin = false }) {
  const path = `/__frame/${randomBytes(12).toString('hex')}`;
  // One buffer is reused for every frame, so a long film does not leave a buffer of garbage per frame for the collector.
  const frameBuffer = Buffer.allocUnsafe(maximumBytes);
  let received;
  function handle(request, response) {
    if (request.url !== path) return false;
    if (crossOrigin) response.setHeader('Access-Control-Allow-Origin', '*');
    if (request.method !== 'POST') {
      response.writeHead(405);
      response.end();
      return true;
    }
    let total = 0;
    let tooLarge = false;
    request.on('data', chunk => {
      if (tooLarge) return;
      if (total + chunk.length > maximumBytes) {
        tooLarge = true;
        response.writeHead(413);
        response.end();
        return;
      }
      chunk.copy(frameBuffer, total);
      total += chunk.length;
    });
    request.on('end', () => {
      if (tooLarge) return;
      received = frameBuffer.subarray(0, total);
      response.writeHead(204);
      response.end();
    });
    return true;
  }
  return Object.freeze({
    path,
    handle,
    /** The frame the page posted since the last call, checked against the size the encoder was started with. */
    take({ width, height }, info) {
      if (info.width !== width || info.height !== height) {
        throw new Error(`The drawing buffer is ${info.width}x${info.height} but the video is ${width}x${height}.`);
      }
      const frame = received;
      received = undefined;
      if (!frame || frame.length !== width * height * 4) throw new Error('The page did not deliver a complete frame.');
      return frame;
    },
  });
}

/** A loopback server that only receives frames, for pages that another server already serves. */
export async function startFrameServer(receiver) {
  const server = createServer((request, response) => {
    if (!receiver.handle(request, response)) {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.keepAliveTimeout = KEEP_ALIVE_MILLISECONDS;
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { url: `http://127.0.0.1:${server.address().port}${receiver.path}`,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
