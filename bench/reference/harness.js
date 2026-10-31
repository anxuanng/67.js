// Runs in the page: draws one reference scene, and describes it as plain data for Blender.
import { Renderer67 } from '/src/renderer.js';
import { REFERENCE_SCENES } from './scenes.js';

function encodeBytes(typedArray) {
  const bytes = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
  let text = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(text);
}

function plainData(value) {
  if (ArrayBuffer.isView(value)) return { type: value.constructor.name, base64: encodeBytes(value) };
  if (value instanceof ImageData) return { width: value.width, height: value.height, data: plainData(value.data) };
  if (Array.isArray(value)) return value.map(plainData);
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry !== 'function') result[key] = plainData(entry);
    }
    return result;
  }
  return value;
}

function addWeightedTransform(output, offset, palette, joint, weight, x, y, z, translationWeight) {
  const base = joint * 16;
  output[offset] += weight * (palette[base] * x + palette[base + 4] * y + palette[base + 8] * z + palette[base + 12] * translationWeight);
  output[offset + 1] += weight * (palette[base + 1] * x + palette[base + 5] * y + palette[base + 9] * z + palette[base + 13] * translationWeight);
  output[offset + 2] += weight * (palette[base + 2] * x + palette[base + 6] * y + palette[base + 10] * z + palette[base + 14] * translationWeight);
}

// Blender's glTF importer cannot reproduce this rig's pose (three.js and 67.js agree on it), so Blender gets the
// skinned result as plain geometry. A score then measures shading, and not an importer's pose.
function bakeSkinnedGeometry(part) {
  const { geometry, skin } = part;
  const positions = new Float32Array(geometry.positions.length);
  const normals = new Float32Array(geometry.normals.length);
  const influenceCount = geometry.skinWeights.length / (geometry.positions.length / 3);
  for (let vertex = 0; vertex < geometry.positions.length / 3; vertex++) {
    const offset = vertex * 3;
    for (let influence = 0; influence < influenceCount; influence++) {
      const weight = geometry.skinWeights[vertex * influenceCount + influence];
      if (weight === 0) continue;
      const joint = geometry.skinIndices[vertex * influenceCount + influence];
      addWeightedTransform(positions, offset, skin.jointMatrices, joint, weight, geometry.positions[offset], geometry.positions[offset + 1], geometry.positions[offset + 2], 1);
      addWeightedTransform(normals, offset, skin.jointMatrices, joint, weight, geometry.normals[offset], geometry.normals[offset + 1], geometry.normals[offset + 2], 0);
    }
    const length = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]) || 1;
    for (let axis = 0; axis < 3; axis++) normals[offset + axis] /= length;
  }
  return { ...geometry, positions, normals };
}

function describeScene(id, scene) {
  const { map: _map, ...environment } = scene.environment;
  const geometries = new Map();
  const describedParts = scene.parts.map(part => {
    const geometry = part.skin ? bakeSkinnedGeometry(part) : part.geometry;
    if (!geometries.has(geometry)) geometries.set(geometry, geometries.size);
    return { name: part.name, geometry: geometries.get(geometry), matrix: [...part.matrix], material: plainData(part.material) };
  });
  return {
    id, camera: scene.camera, environment, world: scene.blenderWorld,
    parts: describedParts,
    geometries: [...geometries.keys()].map(({ positions, normals, uvs, colors, indices }) => plainData({ positions, normals, uvs, colors, indices })),
  };
}

async function renderReferenceScene(id, { describe, ambientOcclusion = 0, ambientOcclusionRadius = 0.5 }) {
  const scene = await REFERENCE_SCENES[id]();
  const canvas = document.querySelector('canvas');
  const renderer = new Renderer67(canvas, scene.parts, {
    ground: false, hdr: true, depth: true, samples: 4, pixelRatio: 1, memoryBudgetMiB: 1024, world: true,
    environment: scene.environment, shadowBounds: scene.shadow,
  });
  renderer.resize();
  const frame = { ...scene.camera, environment: scene.environment, time: 0, exposure: 1, effects: { ambientOcclusion, ambientOcclusionRadius } };
  renderer.render(frame);
  renderer.render(frame);
  const debug = renderer.context.getExtension('WEBGL_debug_renderer_info');
  const result = {
    image: canvas.toDataURL('image/png').split(',')[1],
    glError: renderer.context.getError(),
    graphics: renderer.context.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : renderer.context.RENDERER),
    description: describe ? describeScene(id, scene) : null,
  };
  renderer.dispose();
  return result;
}

window.renderReferenceScene = renderReferenceScene;
window.referenceSceneIds = Object.keys(REFERENCE_SCENES);
