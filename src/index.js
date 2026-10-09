import packageMetadata from '../package.json' with { type: 'json' };

export const VERSION = packageMetadata.version;
export { Renderer67 } from './renderer.js';
export { box, cylinder, sphere, torus } from './geometry.js';
export { exportGlb } from './export.js';
export { RENDER_PRESETS, planRenderSize, estimateFrameBytes } from './budget.js';

export { assemblyOffset } from './assembly.js';
