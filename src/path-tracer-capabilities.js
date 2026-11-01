// The offline path tracer that a render job selects with settings.renderer, as plain data for the MCP server. The code
// and its own bounds are src/path-tracer.js; tests/path-tracer.test.js keeps these numbers equal to PATH_TRACER_LIMITS
// there. It lives apart from agent-scene-capabilities.js so the agent scene bundle does not carry it. maxSeconds stops
// below the job deadline.
export const PATH_TRACER_JOB_LIMITS = Object.freeze({
  samples: Object.freeze({ minimum: 1, maximum: 1024, default: 64 }),
  bounces: Object.freeze({ minimum: 1, maximum: 16, default: 8 }),
  maxSeconds: Object.freeze({ minimum: 1, maximum: 600, default: 120 }),
  seed: Object.freeze({ minimum: 0, maximum: 2147483647, default: 0 }),
});

export const PATH_TRACER_CAPABILITIES = Object.freeze({
  setting: 'settings.renderer { type: "pathTracer", samples, bounces, denoise, seed, maxSeconds }; image jobs only, no passes. Past maxSeconds the job fails.',
  skips: 'volume fog, occlusion and emissive maps, translucent leaves, liquids, caustics, depth of field, bloom; the job result lists what the scene asked for.',
  limits: PATH_TRACER_JOB_LIMITS,
});
