// Colour map as an image sequence: frames are catalog images, the frame follows the scene's motion time. Kept outside
// agent-scene-capabilities.js so the scene entry does not carry text only an agent reads; the MCP runtime adds it to
// scene_capabilities.

export const TEXTURE_SEQUENCE_LIMITS = Object.freeze({
  maxFrames: 64, maxFps: 60, maxSide: 1024, maxDecodedBytes: 64 * 1024 * 1024,
});

export const TEXTURE_SEQUENCE_CAPABILITIES = Object.freeze({
  field: 'material.map = { sequence: { frames: [catalog image asset IDs], fps, loop } }',
  covers: 'color map (map) of surface-tag materials; needs UVs (grid, box and similar); not combined with pattern',
  frame: 'floor(motionTime * fps), wrapped when loop is true (default) and held on the last frame when false; frame 0 before any motion time',
  clock: 'motionTime, also in render jobs (settings.motion.start + elapsed)',
  images: 'PNG, JPEG or WebP files in the --assets folder, listed by scene_asset_catalog with kind image; opaque pixels, one size for all frames',
  ...TEXTURE_SEQUENCE_LIMITS,
});
