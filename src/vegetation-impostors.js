// Impostors and cross-fades for vegetation levels.
//
// An impostor is a tree drawn as one camera-facing card. `bakeImpostorAtlas` renders the tree from every direction of a
// hemi-octahedral grid into a colour atlas (RGBA) and a normal atlas (tangent space of the view, OpenGL green up), on the
// CPU, so it runs in Node and the browser alike and its pixels repeat exactly. The `impostor` material tag in the vertex
// shader (impostor-shader.js) turns the card to the eye and picks the nearest view. Level changes fade with a screen-door
// dither (`alphaMode: 'dither'`), chosen from the distance alone, so a seek to any camera repeats the same picture.

import { IMPOSTOR_FRAMES } from './impostor-shader.js';

export const FADE_STEPS = 8;
export const IMPOSTOR_CARD_TRIANGLES = 2;
const DEFAULT_FRAME_SIZE = 96;
const DEFAULT_BAKE_LEVEL = 3;
const FRAME_MARGIN_PIXELS = 2;
const EMPTY_BAND = 1e-6;

const impostorCache = new WeakMap();

function srgbToLinear(byte) {
  const value = byte / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function linearToSrgbByte(value) {
  const clamped = Math.min(1, Math.max(0, value));
  const encoded = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}

const SRGB_DECODE = Float32Array.from({ length: 256 }, (_, byte) => srgbToLinear(byte));

/** The direction (unit vector from the tree to the eye, in the tree's frame) that atlas cell `column`, `row` was baked from. */
export function impostorFrameDirection(column, row) {
  const squareX = (column + 0.5) / IMPOSTOR_FRAMES * 2 - 1;
  const squareY = (row + 0.5) / IMPOSTOR_FRAMES * 2 - 1;
  const x = (squareX + squareY) / 2;
  const z = (squareX - squareY) / 2;
  const y = 1 - Math.abs(x) - Math.abs(z);
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}

/** The atlas cell the shader picks for a direction to the eye (the same fold as `impostorCell` in impostor-shader.js). */
export function impostorCellOf(direction) {
  const y = Math.max(direction[1], 0);
  const sum = Math.max(Math.abs(direction[0]) + y + Math.abs(direction[2]), 1e-5);
  const squareX = ((direction[0] + direction[2]) / sum) * 0.5 + 0.5;
  const squareY = ((direction[0] - direction[2]) / sum) * 0.5 + 0.5;
  const clampCell = value => Math.min(IMPOSTOR_FRAMES - 1, Math.max(0, Math.floor(value * IMPOSTOR_FRAMES)));
  return { column: clampCell(squareX), row: clampCell(squareY) };
}

/** Right and up of a card that faces `toEye`, as the shader builds them. */
export function impostorCardBasis(toEye) {
  let right = [toEye[2], 0, -toEye[0]];
  const rightLength = Math.hypot(right[0], right[2]);
  right = rightLength > 0.001 ? [right[0] / rightLength, 0, right[2] / rightLength] : [1, 0, 0];
  const up = [
    toEye[1] * right[2] - toEye[2] * right[1],
    toEye[2] * right[0] - toEye[0] * right[2],
    toEye[0] * right[1] - toEye[1] * right[0],
  ];
  return { right, up };
}

function prepareParts(variant, level) {
  return variant.levels[level].parts.map((part) => {
    const { geometry, material } = part;
    const map = material.map?.image?.data ? material.map : null;
    return {
      geometry, map,
      wrap: map ? map.wrapS === 10497 : false,
      baseColor: material.color,
      cutoff: material.alphaMode === 'mask' ? material.alphaCutoff ?? 0.5 : 0,
    };
  });
}

function drawFrame(parts, view, extent, size, buffers) {
  const { colorPixels, normalPixels, depthBuffer, offset, rowStride } = buffers;
  const { right, up, toEye, center } = view;
  const pixelsPerMeter = size / (2 * extent);
  for (const part of parts) {
    const { positions, normals, uvs, colors, indices } = part.geometry;
    const vertexCount = positions.length / 3;
    const screenX = new Float32Array(vertexCount);
    const screenY = new Float32Array(vertexCount);
    const depth = new Float32Array(vertexCount);
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const x = positions[vertex * 3] - center[0];
      const y = positions[vertex * 3 + 1] - center[1];
      const z = positions[vertex * 3 + 2] - center[2];
      screenX[vertex] = (x * right[0] + y * right[1] + z * right[2]) * pixelsPerMeter + size / 2;
      screenY[vertex] = size / 2 - (x * up[0] + y * up[1] + z * up[2]) * pixelsPerMeter;
      depth[vertex] = x * toEye[0] + y * toEye[1] + z * toEye[2];
    }
    for (let triangle = 0; triangle < indices.length; triangle += 3) {
      const a = indices[triangle];
      const b = indices[triangle + 1];
      const c = indices[triangle + 2];
      const area = (screenX[b] - screenX[a]) * (screenY[c] - screenY[a]) - (screenX[c] - screenX[a]) * (screenY[b] - screenY[a]);
      if (Math.abs(area) < 1e-9) continue;
      const minimumX = Math.max(0, Math.floor(Math.min(screenX[a], screenX[b], screenX[c])));
      const maximumX = Math.min(size - 1, Math.ceil(Math.max(screenX[a], screenX[b], screenX[c])));
      const minimumY = Math.max(0, Math.floor(Math.min(screenY[a], screenY[b], screenY[c])));
      const maximumY = Math.min(size - 1, Math.ceil(Math.max(screenY[a], screenY[b], screenY[c])));
      // Both barycentric weights are linear in the pixel position, so a step along a row adds a constant.
      const inverseArea = 1 / area;
      const weightAAcross = (screenY[b] - screenY[c]) * inverseArea;
      const weightBAcross = (screenY[c] - screenY[a]) * inverseArea;
      const weightADown = (screenX[c] - screenX[b]) * inverseArea;
      const weightBDown = (screenX[a] - screenX[c]) * inverseArea;
      const firstSampleX = minimumX + 0.5;
      const weightAAtOrigin = (screenX[b] * screenY[c] - screenX[c] * screenY[b]) * inverseArea;
      const weightBAtOrigin = (screenX[c] * screenY[a] - screenX[a] * screenY[c]) * inverseArea;
      for (let pixelY = minimumY; pixelY <= maximumY; pixelY++) {
        const sampleY = pixelY + 0.5;
        let weightA = weightAAtOrigin + firstSampleX * weightAAcross + sampleY * weightADown - weightAAcross;
        let weightB = weightBAtOrigin + firstSampleX * weightBAcross + sampleY * weightBDown - weightBAcross;
        for (let pixelX = minimumX; pixelX <= maximumX; pixelX++) {
          weightA += weightAAcross;
          weightB += weightBAcross;
          const weightC = 1 - weightA - weightB;
          if (weightA < 0 || weightB < 0 || weightC < 0) continue;
          const pixelDepth = weightA * depth[a] + weightB * depth[b] + weightC * depth[c];
          const bufferIndex = pixelY * size + pixelX;
          if (pixelDepth <= depthBuffer[bufferIndex]) continue;
          let red = part.baseColor[0];
          let green = part.baseColor[1];
          let blue = part.baseColor[2];
          if (colors) {
            red *= weightA * colors[a * 3] + weightB * colors[b * 3] + weightC * colors[c * 3];
            green *= weightA * colors[a * 3 + 1] + weightB * colors[b * 3 + 1] + weightC * colors[c * 3 + 1];
            blue *= weightA * colors[a * 3 + 2] + weightB * colors[b * 3 + 2] + weightC * colors[c * 3 + 2];
          }
          if (part.map) {
            const u = weightA * uvs[a * 2] + weightB * uvs[b * 2] + weightC * uvs[c * 2];
            const v = weightA * uvs[a * 2 + 1] + weightB * uvs[b * 2 + 1] + weightC * uvs[c * 2 + 1];
            const texel = sampleTexel(part.map, u, v, part.wrap);
            if (texel.alpha / 255 < part.cutoff) continue;
            red *= texel.red;
            green *= texel.green;
            blue *= texel.blue;
          }
          let normalX = weightA * normals[a * 3] + weightB * normals[b * 3] + weightC * normals[c * 3];
          let normalY = weightA * normals[a * 3 + 1] + weightB * normals[b * 3 + 1] + weightC * normals[c * 3 + 1];
          let normalZ = weightA * normals[a * 3 + 2] + weightB * normals[b * 3 + 2] + weightC * normals[c * 3 + 2];
          const normalLength = Math.hypot(normalX, normalY, normalZ) || 1;
          normalX /= normalLength;
          normalY /= normalLength;
          normalZ /= normalLength;
          const facing = normalX * toEye[0] + normalY * toEye[1] + normalZ * toEye[2];
          const flip = facing < 0 ? -1 : 1;
          const tangentX = (normalX * right[0] + normalY * right[1] + normalZ * right[2]) * flip;
          const tangentY = (normalX * up[0] + normalY * up[1] + normalZ * up[2]) * flip;
          const tangentZ = Math.abs(facing);
          depthBuffer[bufferIndex] = pixelDepth;
          const colorIndex = offset + pixelY * rowStride + pixelX * 4;
          colorPixels[colorIndex] = linearToSrgbByte(red);
          colorPixels[colorIndex + 1] = linearToSrgbByte(green);
          colorPixels[colorIndex + 2] = linearToSrgbByte(blue);
          colorPixels[colorIndex + 3] = 255;
          normalPixels[colorIndex] = Math.round((tangentX * 0.5 + 0.5) * 255);
          normalPixels[colorIndex + 1] = Math.round((tangentY * 0.5 + 0.5) * 255);
          normalPixels[colorIndex + 2] = Math.round((tangentZ * 0.5 + 0.5) * 255);
          normalPixels[colorIndex + 3] = 255;
        }
      }
    }
  }
}

const sampledTexel = { red: 0, green: 0, blue: 0, alpha: 0 };

function sampleTexel(map, u, v, wrap) {
  const { width, height, data } = map.image;
  const fractionU = wrap ? u - Math.floor(u) : Math.min(1, Math.max(0, u));
  const fractionV = wrap ? v - Math.floor(v) : Math.min(1, Math.max(0, v));
  const x = Math.min(width - 1, Math.floor(fractionU * width));
  const y = Math.min(height - 1, Math.floor(fractionV * height));
  const index = (y * width + x) * 4;
  sampledTexel.red = SRGB_DECODE[data[index]];
  sampledTexel.green = SRGB_DECODE[data[index + 1]];
  sampledTexel.blue = SRGB_DECODE[data[index + 2]];
  sampledTexel.alpha = data[index + 3];
  return sampledTexel;
}

const NEIGHBOR_OFFSETS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
let filledPairs = new Int32Array(0);

// Empty pixels take the colour of a covered neighbour (alpha stays 0), so mip levels and filtering never pull in black.
function bleedColors(colorPixels, size, frameColumn, frameRow, atlasWidth) {
  const rowStride = atlasWidth * 4;
  const origin = frameRow * size * rowStride + frameColumn * size * 4;
  if (filledPairs.length < size * size * 2) filledPairs = new Int32Array(size * size * 2);
  for (let pass = 0; pass < 3; pass++) {
    let filledCount = 0;
    for (let pixelY = 0; pixelY < size; pixelY++) {
      for (let pixelX = 0; pixelX < size; pixelX++) {
        const index = origin + pixelY * rowStride + pixelX * 4;
        if (colorPixels[index + 3] !== 0) continue;
        for (const [stepX, stepY] of NEIGHBOR_OFFSETS) {
          const neighborX = pixelX + stepX;
          const neighborY = pixelY + stepY;
          if (neighborX < 0 || neighborY < 0 || neighborX >= size || neighborY >= size) continue;
          const neighbor = origin + neighborY * rowStride + neighborX * 4;
          if (colorPixels[neighbor + 3] === 0) continue;
          filledPairs[filledCount * 2] = index;
          filledPairs[filledCount * 2 + 1] = neighbor;
          filledCount++;
          break;
        }
      }
    }
    for (let pair = 0; pair < filledCount; pair++) {
      const index = filledPairs[pair * 2];
      const neighbor = filledPairs[pair * 2 + 1];
      colorPixels[index] = colorPixels[neighbor];
      colorPixels[index + 1] = colorPixels[neighbor + 1];
      colorPixels[index + 2] = colorPixels[neighbor + 2];
      colorPixels[index + 3] = 1;
    }
  }
  for (let pixelY = 0; pixelY < size; pixelY++) {
    for (let pixelX = 0; pixelX < size; pixelX++) {
      const index = origin + pixelY * rowStride + pixelX * 4;
      if (colorPixels[index + 3] === 1) colorPixels[index + 3] = 0;
    }
  }
}

/**
 * Bakes `variant` (a tree from `createTree`) into atlases of IMPOSTOR_FRAMES squared views, `frameSize` pixels each.
 * Returns the pixels of the colour and normal atlas and the card: `radius` and `centerHeight` in the tree's meters.
 */
export function bakeImpostorAtlas(variant, { frameSize = DEFAULT_FRAME_SIZE, level = DEFAULT_BAKE_LEVEL } = {}) {
  const minimum = variant.bounds.minimum;
  const maximum = variant.bounds.maximum;
  const center = [(minimum[0] + maximum[0]) / 2, (minimum[1] + maximum[1]) / 2, (minimum[2] + maximum[2]) / 2];
  const radius = Math.hypot(maximum[0] - minimum[0], maximum[1] - minimum[1], maximum[2] - minimum[2]) / 2;
  const cardRadius = radius * frameSize / (frameSize - 2 * FRAME_MARGIN_PIXELS);
  const atlasWidth = frameSize * IMPOSTOR_FRAMES;
  const colorPixels = new Uint8ClampedArray(atlasWidth * atlasWidth * 4);
  const normalPixels = new Uint8ClampedArray(atlasWidth * atlasWidth * 4);
  for (let index = 0; index < normalPixels.length; index += 4) {
    normalPixels[index] = 128;
    normalPixels[index + 1] = 128;
    normalPixels[index + 2] = 255;
    normalPixels[index + 3] = 255;
  }
  const parts = prepareParts(variant, level);
  const depthBuffer = new Float32Array(frameSize * frameSize);
  for (let row = 0; row < IMPOSTOR_FRAMES; row++) {
    for (let column = 0; column < IMPOSTOR_FRAMES; column++) {
      const toEye = impostorFrameDirection(column, row);
      const { right, up } = impostorCardBasis(toEye);
      depthBuffer.fill(-Infinity);
      const offset = row * frameSize * atlasWidth * 4 + column * frameSize * 4;
      drawFrame(parts, { right, up, toEye, center }, cardRadius, frameSize, { colorPixels, normalPixels, depthBuffer, offset, rowStride: atlasWidth * 4 });
      bleedColors(colorPixels, frameSize, column, row, atlasWidth);
    }
  }
  return { width: atlasWidth, height: atlasWidth, colorPixels, normalPixels, radius: cardRadius, centerHeight: center[1], center, frameSize };
}

function textureDescriptor(pixels, size, colorSpace) {
  const data = pixels;
  const image = typeof ImageData === 'undefined' ? { width: size, height: size, data } : new ImageData(data, size, size);
  return { image, colorSpace, wrapS: 33071, wrapT: 33071, minFilter: 9987, magFilter: 9729 };
}

function cardGeometry(radius, centerHeight) {
  return {
    positions: new Float32Array([-radius, centerHeight + radius, 0, radius, centerHeight + radius, 0, radius, centerHeight - radius, 0, -radius, centerHeight - radius, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

/** The impostor of a tree variant: `{ geometry, material, bakeMilliseconds }`, baked once and cached on the variant. */
export function getImpostor(variant, options = {}) {
  const cached = impostorCache.get(variant);
  if (cached) return cached;
  const started = performance.now();
  const atlas = bakeImpostorAtlas(variant, options);
  const impostor = {
    geometry: cardGeometry(atlas.radius, atlas.centerHeight),
    material: {
      tag: 'impostor', color: [1, 1, 1], roughness: 0.9, metallic: 0, emission: 0,
      map: textureDescriptor(atlas.colorPixels, atlas.width, 'srgb'),
      normalMap: textureDescriptor(atlas.normalPixels, atlas.width, 'linear'),
      alphaMode: 'mask', alphaCutoff: 0.5, doubleSided: true,
    },
    atlasSize: atlas.width,
    bakeMilliseconds: 0,
  };
  impostor.bakeMilliseconds = performance.now() - started;
  impostorCache.set(variant, impostor);
  return impostor;
}

/**
 * Bakes the impostor of every tree variant now, so no frame pays for it. `variants` is `forest.variants` (species to
 * variant arrays) or a list of variants. Returns `{ count, milliseconds }`.
 */
export function prepareImpostors(variants, options = {}) {
  const list = Array.isArray(variants) ? variants : Object.values(variants).flat();
  const started = performance.now();
  let count = 0;
  for (const variant of list) {
    if (variant.kind !== 'tree') continue;
    getImpostor(variant, options);
    count++;
  }
  return { count, milliseconds: performance.now() - started };
}

/**
 * Where a distance falls among level `thresholds`, with a cross-fade of `band` (a fraction) around each one.
 * Returns `{ level, next, step }`: `step` of FADE_STEPS eighths of the way from `level` to `next`; 0 means only `level`.
 * It depends on the distance alone, so a given camera always gives the same answer.
 */
export function blendLevels(distance, thresholds, band) {
  for (let index = 0; index < thresholds.length; index++) {
    const low = thresholds[index] * (1 - band);
    const high = thresholds[index] * (1 + band);
    if (distance < low || (high - low < EMPTY_BAND && distance < thresholds[index])) return { level: index, next: index, step: 0 };
    if (distance <= high && high - low >= EMPTY_BAND) {
      const step = Math.round((distance - low) / (high - low) * FADE_STEPS);
      if (step <= 0) return { level: index, next: index, step: 0 };
      if (step >= FADE_STEPS) return { level: index + 1, next: index + 1, step: 0 };
      return { level: index, next: index + 1, step };
    }
  }
  return { level: thresholds.length, next: thresholds.length, step: 0 };
}

// The default switch distances hold for a 4 pixel error on a 1080 pixel high view with a 60 degree vertical field of view.
const REFERENCE_PIXELS_PER_RADIAN = 1080 / (2 * Math.tan(Math.PI / 6));
const REFERENCE_PIXEL_ERROR = 4;

/**
 * The factor on the default switch distances for a level to show an error of at most `pixels` on screen
 * (`{ pixels = 4, height, fov }`: the view's height in pixels and its vertical field of view in degrees).
 * A finer error or a taller view switches later; an instance's own scale multiplies the distance too, since its errors grow with it.
 */
export function pixelErrorScale({ pixels = REFERENCE_PIXEL_ERROR, height = 1080, fov = 60 } = {}) {
  const pixelsPerRadian = height / (2 * Math.tan(fov * Math.PI / 360));
  return pixelsPerRadian / REFERENCE_PIXELS_PER_RADIAN * REFERENCE_PIXEL_ERROR / pixels;
}

function tintedMaterial(material, tintable, tint) {
  return tintable ? { ...material, color: material.color.map((channel, axis) => channel * tint[axis]) } : material;
}

// A fade is a mask material whose opacity bias carries the dither coverage (see ALPHA_COVERAGE in impostor-shader.js).
function fadedMaterial(material, coverage, incoming) {
  return { ...material, alphaMode: 'mask', alphaCutoff: material.alphaMode === 'mask' ? material.alphaCutoff ?? 0.5 : 0.5, opacityBias: incoming ? 1 + coverage : coverage };
}

function blendParts(instance, level, useImpostor, fade, options) {
  const key = `${useImpostor ? 'i' : level}|${fade ? `${fade.opacity}|${fade.incoming}` : ''}`;
  instance.blendParts ??= new Map();
  if (instance.blendParts.has(key)) return instance.blendParts.get(key);
  const label = `${instance.species} ${instance.index}`;
  const fadeMaterial = material => (fade ? fadedMaterial(material, fade.opacity, fade.incoming) : material);
  let parts;
  if (useImpostor) {
    const impostor = getImpostor(instance.variant, options);
    parts = [{ name: `${label} impostor`, geometry: impostor.geometry, matrix: instance.matrix, material: fadeMaterial(tintedMaterial(impostor.material, true, instance.tint)) }];
  } else {
    parts = instance.variant.levels[level].parts.map(part => ({
      name: `${label} ${part.role}`, geometry: part.geometry, shadowLods: part.shadowLods, matrix: instance.matrix,
      material: fadeMaterial(tintedMaterial(part.material, part.tintable, instance.tint)),
    }));
  }
  instance.blendParts.set(key, parts);
  return parts;
}

/**
 * `selectLevels` with cross-fades and impostors: the level comes from the distance alone (no hysteresis), and within
 * `fade` (a fraction of a threshold, either side) two levels draw with complementary dither coverage.
 * `impostors` is `true` or `{ from, frameSize, level }`: levels from `from` (default 3, the last) draw the baked card.
 */
export function selectBlendedLevels(instances, eye, { distanceScale = 1, fade = 0.06, cullDistance = Infinity, impostors = false, pixelError = null } = {}) {
  const pixelScale = pixelError ? pixelErrorScale(pixelError) : 1;
  const impostorOptions = impostors && typeof impostors === 'object' ? impostors : {};
  const firstImpostorLevel = impostors ? impostorOptions.from ?? 3 : Infinity;
  const parts = [];
  const levelCounts = [];
  let changed = false;
  let culled = 0;
  let triangles = 0;
  let cards = 0;
  let fading = 0;
  for (const instance of instances) {
    const distance = Math.hypot(eye[0] - instance.position[0], eye[1] - instance.position[1], eye[2] - instance.position[2]);
    const culledNow = distance > cullDistance;
    const thresholds = instance.variant.distances.map(threshold => threshold * distanceScale * pixelScale * (pixelError ? instance.scale : 1));
    const blend = culledNow ? { level: -1, next: -1, step: 0 } : blendLevels(distance, thresholds, fade);
    const usesCard = level => instance.variant.kind === 'tree' && level >= firstImpostorLevel;
    const bothCards = blend.step > 0 && usesCard(blend.level) && usesCard(blend.next);
    const step = bothCards ? 0 : blend.step;
    const signature = `${blend.level}:${step > 0 ? blend.next : blend.level}:${step}`;
    if (signature !== instance.blendSignature) changed = true;
    instance.blendSignature = signature;
    instance.level = blend.level;
    if (blend.level < 0) {
      culled++;
      continue;
    }
    levelCounts[blend.level] = (levelCounts[blend.level] ?? 0) + 1;
    const drawLevel = (level, opacity, incoming) => {
      const useImpostor = usesCard(level);
      parts.push(...blendParts(instance, level, useImpostor, opacity === 1 ? null : { opacity, incoming }, impostorOptions));
      triangles += useImpostor ? IMPOSTOR_CARD_TRIANGLES : instance.variant.levels[level].triangles;
      if (useImpostor) cards++;
    };
    if (step === 0) {
      drawLevel(blend.level, 1, false);
    } else {
      fading++;
      drawLevel(blend.level, 1 - step / FADE_STEPS, false);
      drawLevel(blend.next, step / FADE_STEPS, true);
    }
  }
  return { parts, changed, levelCounts: Array.from(levelCounts, count => count ?? 0), culled, triangles, impostors: cards, fading };
}
