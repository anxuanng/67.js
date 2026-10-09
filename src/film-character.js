const FULL_TURN = Math.PI * 2;

function gaussian(distance, width) {
  return Math.exp(-((distance / width) ** 2));
}

function facialFeature(horizontal, height, center, level, width, length) {
  return gaussian(horizontal - center, width) * gaussian(height - level, length);
}

// Internal film geometry: +Y is up, +Z is the face, and horizontal wraps once.
// Tiny polar caps preserve the film mesher's finite-difference normal convention.
export function sampleScientistHead(horizontal, vertical) {
  const angle = horizontal * FULL_TURN;
  const elevation = 0.008 + vertical * (Math.PI - 0.016);
  const height = Math.cos(elevation);
  const radius = Math.sin(elevation);
  const front = Math.max(0, Math.sin(angle));
  const jawTransition = 1 / (1 + Math.exp((height + 0.46) * 12));
  const templeIndent = 0.065 * gaussian(height - 0.34, 0.18);
  const cheekWidth = 0.055 * gaussian(height + 0.13, 0.17);
  const width = 0.94 - 0.20 * jawTransition - templeIndent + cheekWidth;
  const horizontalPoint = Math.cos(angle) * radius * width;
  let depth = Math.sin(angle) * radius * (1 - 0.075 * front ** 2);

  // Features change the same continuous surface instead of adding nose or jaw solids.
  let facialDepth = 0.23 * facialFeature(horizontalPoint, height, 0, 0.035, 0.105, 0.31);
  facialDepth += 0.25 * facialFeature(horizontalPoint, height, 0, -0.14, 0.14, 0.095);
  facialDepth -= 0.055 * facialFeature(horizontalPoint, height, 0, -0.245, 0.085, 0.035);
  facialDepth += 0.09 * facialFeature(horizontalPoint, height, 0, -0.33, 0.31, 0.11);
  facialDepth -= 0.025 * facialFeature(horizontalPoint, height, 0, -0.335, 0.25, 0.016);
  facialDepth += 0.17 * facialFeature(horizontalPoint, height, 0, -0.65, 0.31, 0.16);
  facialDepth -= 0.045 * facialFeature(horizontalPoint, height, 0, -0.47, 0.28, 0.065);

  for (const side of [-1, 1]) {
    facialDepth -= 0.17 * facialFeature(horizontalPoint, height, side * 0.42, 0.153, 0.20, 0.095);
    facialDepth += 0.115 * facialFeature(horizontalPoint, height, side * 0.40, 0.30, 0.255, 0.075);
    facialDepth += 0.095 * facialFeature(horizontalPoint, height, side * 0.53, -0.095, 0.23, 0.115);
    facialDepth -= 0.065 * facialFeature(horizontalPoint, height, side * 0.51, -0.29, 0.19, 0.16);
    facialDepth += 0.105 * facialFeature(horizontalPoint, height, side * 0.12, -0.175, 0.065, 0.065);
    facialDepth -= 0.025 * facialFeature(horizontalPoint, height, side * 0.06, -0.265, 0.025, 0.05);
  }
  depth += front ** 6 * facialDepth;
  return [horizontalPoint, height, depth];
}
