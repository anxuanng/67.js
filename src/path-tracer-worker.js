import { attachTracer } from './path-tracer-scene.js';
import { renderBand } from './path-tracer.js';

// One thread of a path trace: receives the flattened scene once, then draws the bands it is given.

let scene = null;
let camera = null;
let options = null;

self.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'scene') {
    scene = attachTracer(message.scene);
    camera = message.camera;
    options = message.options;
    self.postMessage({ type: 'ready' });
    return;
  }
  const band = renderBand(scene, camera, options, message.rowStart, message.rowEnd);
  self.postMessage({ type: 'band', rowStart: message.rowStart, band }, Object.values(band).map(buffer => buffer.buffer));
};
