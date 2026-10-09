const FULL_TURN = Math.PI * 2;

function gaussian(distance, width) {
  return Math.exp(-((distance / width) ** 2));
}

function facialFeature(horizontal, height, center, level, width, length) {
  return gaussian(horizontal - center, width) * gaussian(height - level, length);
}

function lidFalloff(distance, inner, outer) {
  const amount = Math.max(0, Math.min(1, (Math.abs(distance) - inner) / (outer - inner)));
  return 1 - amount ** 3 * (10 - 15 * amount + 6 * amount * amount);
}

// Internal film geometry: +Y is up, +Z is the face, and horizontal wraps once.
// Tiny polar caps preserve the film mesher's finite-difference normal convention.
export function sampleScientistHead(horizontal, vertical, expression = -1) {
  const angle = horizontal * FULL_TURN;
  const elevation = 0.008 + vertical * (Math.PI - 0.016);
  const height = Math.cos(elevation);
  const radius = Math.sin(elevation);
  const front = Math.max(0, Math.sin(angle));
  const jawTransition = 1 / (1 + Math.exp((height + 0.46) * 12));
  const templeIndent = 0.065 * gaussian(height - 0.34, 0.18);
  const cheekWidth = 0.055 * gaussian(height + 0.13, 0.17);
  const width = 0.98 - 0.12 * jawTransition - templeIndent + cheekWidth;
  const horizontalPoint = Math.cos(angle) * radius * width;
  let depth = Math.sin(angle) * radius * (1 - 0.075 * front ** 2);

  // Features change the same continuous surface instead of adding nose or jaw solids.
  let facialDepth = 0.19 * facialFeature(horizontalPoint, height, 0, 0.035, 0.105, 0.31);
  facialDepth += 0.19 * facialFeature(horizontalPoint, height, 0, -0.14, 0.14, 0.095);
  facialDepth -= 0.055 * facialFeature(horizontalPoint, height, 0, -0.245, 0.085, 0.035);
  const mouthLine = -0.35 - 0.014 * (horizontalPoint / 0.3) ** 2;
  facialDepth += 0.022 * facialFeature(horizontalPoint, height, 0, mouthLine + 0.020, 0.27, 0.026);
  facialDepth += 0.030 * facialFeature(horizontalPoint, height, 0, mouthLine - 0.028, 0.25, 0.03);
  facialDepth -= 0.015 * facialFeature(horizontalPoint, height, 0, mouthLine, 0.26, 0.012);
  facialDepth += 0.19 * facialFeature(horizontalPoint, height, 0, -0.65, 0.36, 0.17);
  facialDepth -= 0.045 * facialFeature(horizontalPoint, height, 0, -0.47, 0.28, 0.065);

  for (const side of [-1, 1]) {
    const eyeHorizontal = (horizontalPoint - side * 0.40) / 0.21;
    const eyeHeight = height - 0.155 - side * eyeHorizontal * 0.009;
    const almond = Math.max(0, 1 - eyeHorizontal * eyeHorizontal);
    facialDepth -= 0.14 * facialFeature(horizontalPoint, height, side * 0.40, 0.17, 0.24, 0.14);
    // A convex inset eye and its rolled lid edge are part of the face grid.
    facialDepth += 0.055 * gaussian(eyeHorizontal, 0.87) * gaussian(eyeHeight, 0.045);
    facialDepth += 0.042 * gaussian(eyeHorizontal, 1.02) * gaussian(Math.abs(eyeHeight) - 0.060 * almond, 0.019);
    facialDepth += 0.18 * facialFeature(horizontalPoint, height, side * 0.40, 0.30, 0.255, 0.075);
    facialDepth += 0.095 * facialFeature(horizontalPoint, height, side * 0.53, -0.095, 0.23, 0.115);
    facialDepth -= 0.065 * facialFeature(horizontalPoint, height, side * 0.51, -0.29, 0.19, 0.16);
    facialDepth += 0.105 * facialFeature(horizontalPoint, height, side * 0.12, -0.175, 0.065, 0.065);
    facialDepth -= 0.025 * facialFeature(horizontalPoint, height, side * 0.06, -0.265, 0.025, 0.05);
  }
  depth += front ** 6 * facialDepth;
  let posedHeight = height;
  const facing = Math.min(1, front * 2);
  for (const side of [-1, 1]) {
    const eyeHorizontal = horizontalPoint - side * 0.40;
    const eyeHeight = height - 0.155;
    if (expression === 0) {
      // The lid follows one elliptical socket contour. Its C2 radial blend
      // avoids straight patch edges, and retaining XY prevents folded rows.
      const socketRadius = Math.hypot(eyeHorizontal / 0.22, eyeHeight / 0.105);
      const cover = 0.862 - 0.075 * socketRadius * socketRadius;
      const difference = cover - depth;
      const raised = (difference + Math.hypot(difference, 0.022)) / 2;
      const region = lidFalloff(socketRadius, 0.8, 1.8) * facing;
      const crease = 0.003 * gaussian(eyeHorizontal, 0.18) * gaussian(eyeHeight + 0.016, 0.022);
      depth += (raised - crease) * region;
    }
    if (expression === 1) {
      // Keep the brow's support above the mobile lid so additive normal targets
      // do not drag the closed cap into a second, conflicting crease.
      posedHeight -= 0.040 * facialFeature(horizontalPoint, height, side * 0.28, 0.34, 0.26, 0.09) * facing;
    }
  }
  if (expression === 2) {
    const lowerFace = gaussian(horizontalPoint, 0.40) * gaussian(height + 0.43, 0.23) * facing;
    posedHeight -= 0.026 * lowerFace;
    depth -= 0.035 * lowerFace;
  }
  return [horizontalPoint, posedHeight, depth];
}

/** Pigment follows the same vertices as the lips, eyelid rims and expressions. */
export function scientistSkinColor([horizontal, height, depth]) {
  const color = [0.48, 0.285, 0.19];
  if (depth < 0.5) return color;
  const blend = (pigment, amount) => {
    for (let channel = 0; channel < 3; channel++) color[channel] += (pigment[channel] - color[channel]) * amount;
  };
  const cheek = facialFeature(Math.abs(horizontal), height, 0.53, -0.12, 0.23, 0.2);
  blend([0.46, 0.235, 0.16], cheek * 0.32);
  blend([0.30, 0.23, 0.18], gaussian(height + 0.58, 0.25) * 0.18);
  const mouthLine = -0.35 - 0.014 * (horizontal / 0.3) ** 2;
  blend([0.36, 0.185, 0.135], facialFeature(horizontal, height, 0, mouthLine, 0.27, 0.035) * 0.4);
  blend([0.12, 0.057, 0.038], facialFeature(horizontal, height, 0, mouthLine, 0.26, 0.010) * 0.8);
  for (const side of [-1, 1]) {
    const browLevel = 0.31 - side * (horizontal - side * 0.40) * 0.12;
    blend([0.045, 0.030, 0.022], facialFeature(horizontal, height, side * 0.40, browLevel, 0.235, 0.025) * 0.93);
    blend([0.13, 0.065, 0.04], facialFeature(horizontal, height, side * 0.09, -0.207, 0.035, 0.016) * 0.85);
  }
  return color;
}

// These globes sit behind the rolled skin rim. The aperture is the intersection
// of the two curved surfaces, so eyes keep real depth under side lighting.
export function sampleScientistEye(horizontal, vertical, side, gaze = false) {
  const longitude = horizontal * FULL_TURN;
  const elevation = 0.008 + vertical * (Math.PI - 0.016);
  const radius = Math.sin(elevation);
  const point = [Math.cos(longitude) * radius * 0.195, Math.cos(elevation) * 0.072, Math.sin(longitude) * radius * 0.105];
  if (gaze) {
    const angle = 0.16;
    const horizontalPoint = point[0];
    point[0] = horizontalPoint * Math.cos(angle) + point[2] * Math.sin(angle);
    point[2] = point[2] * Math.cos(angle) - horizontalPoint * Math.sin(angle);
  }
  return [point[0] + side * 0.40, point[1] + 0.155, point[2] + 0.735];
}

export function scientistEyeColor([horizontal, height, depth], side) {
  if (depth < 0.8) return [0.37, 0.39, 0.33];
  const radius = Math.hypot((horizontal - side * 0.40) / 0.060, (height - 0.155) / 0.043);
  if (radius < 0.46) return [0.007, 0.01, 0.009];
  if (radius < 0.90) return [0.065, 0.105, 0.09];
  if (radius < 1.10) return [0.025, 0.045, 0.034];
  return [0.37, 0.39, 0.33];
}

export function sampleScientistHair(horizontal, vertical) {
  const angle = horizontal * FULL_TURN;
  const front = Math.max(0, Math.sin(angle));
  const hairline = 1.85 - front * 0.94 + 0.13 * Math.cos(angle) * front;
  const elevation = 0.008 + vertical * hairline;
  const height = Math.cos(elevation);
  const radius = Math.sin(elevation);
  const sweep = gaussian(height - 0.72, 0.4) * front;
  const comb = 0.009 * Math.sin(angle * 18 + elevation * 4) * Math.sin(elevation);
  return [Math.cos(angle) * radius * (1.00 + comb) - 0.085 * sweep,
    height + 0.045 + 0.10 * sweep,
    Math.sin(angle) * radius * (0.98 + comb) - 0.035];
}
