// GPU crowds (issue 323): one character and one clip draw as a few instanced batches, however many people there are.
//
// The clip's joint matrices are baked once into a table with one row of matrices per frame. Each instance carries
// only two frame offsets and a blend weight (in its assembly offset, which a crowd part does not otherwise use), and
// the vertex shader reads the matrices of its own clip time. Every instance of a material therefore shares a batch,
// and the batch can be culled and drawn in levels like any rigid part.
//
// The pose of an instance is a pure function of its clip time (crowdFrameBlend), so a frame at a seek time equals
// the same frame reached by playing.
import { mat4 } from 'gl-matrix';
import { installCrowdShader } from './shaders.js';
import './skinning.js';

const FLOATS_PER_MATRIX = 16;
const TEXELS_PER_MATRIX = 4;
const DEFAULT_FRAME_RATE = 30;
const DEFAULT_LEVEL_CELLS = Object.freeze([0.02, 0.05]);
const JOINT_STRIDE = 4096;
const WEIGHT_STEPS = 4095;

// Each vertex carries four packed influences in the colour attribute (location 14): joint * 4096 + weight * 4095, exact in a float.
// The frame blend is in assemblyOffset: x and y are the texel offsets of the two frames, z the blend between them.
installCrowdShader(`
uniform float crowdEnabled;
mat4 crowdJoint(int frameTexel, int joint) {
  int texel = frameTexel + joint * 4;
  return mat4(skinTexel(jointPalette, texel), skinTexel(jointPalette, texel + 1),
    skinTexel(jointPalette, texel + 2), skinTexel(jointPalette, texel + 3));
}
mat4 crowdInfluence(float packedInfluence) {
  float joint = floor(packedInfluence / 4096.0);
  float weight = (packedInfluence - joint * 4096.0) / 4095.0;
  int firstFrame = int(assemblyOffset.x + 0.5);
  int secondFrame = int(assemblyOffset.y + 0.5);
  int jointIndex = int(joint + 0.5);
  return (crowdJoint(firstFrame, jointIndex) * (1.0 - assemblyOffset.z) + crowdJoint(secondFrame, jointIndex) * assemblyOffset.z) * weight;
}
mat4 crowdTransform() {
  return crowdInfluence(vertexColor.x) + crowdInfluence(vertexColor.y) + crowdInfluence(vertexColor.z) + crowdInfluence(vertexColor.w);
}`);

/**
 * Merge the parts of a character into crowd geometries, one per material. A rigid part becomes one joint that
 * follows its matrix; a skinned part keeps its joints, each premultiplied by the part's matrix. UVs are kept, so
 * materials with maps work. Parts with morph targets are merged with their weights ignored, unless `morphs` is true:
 * then each keeps its own geometry and draws with the weights it has when the rig is made (one set for the whole crowd,
 * and no levels or culling for that part). Each part is { name, geometry, matrix, material, skin?, morph? } as an imported asset lists them.
 */
export function createCrowdRig(sourceParts, { morphs = false } = {}) {
  if (!Array.isArray(sourceParts) || sourceParts.length === 0) throw new TypeError('A crowd rig needs a list of parts.');
  const jointOffsets = [];
  let jointCount = 0;
  for (const part of sourceParts) {
    if (!part.geometry?.positions || !part.geometry.indices || !part.material) throw new TypeError(`A crowd part needs a geometry and a material: ${part.name}`);
    if (part.skin && !part.geometry.skinIndices) throw new TypeError(`A skinned crowd part needs skin indices and weights: ${part.name}`);
    jointOffsets.push(jointCount);
    jointCount += part.skin ? part.skin.jointMatrices.length / FLOATS_PER_MATRIX : 1;
  }
  if (jointCount > JOINT_STRIDE) throw new RangeError(`A crowd rig holds at most ${JOINT_STRIDE} joints; this one has ${jointCount}.`);
  const groups = new Map();
  const morphedParts = [];
  sourceParts.forEach((part, index) => {
    if (morphs && part.morph && part.geometry.morphTargets) {
      morphedParts.push(index);
      return;
    }
    if (!groups.has(part.material)) groups.set(part.material, []);
    groups.get(part.material).push(index);
  });
  const scratch = mat4.create();
  const entryOf = index => ({ part: sourceParts[index], jointOffset: jointOffsets[index] });
  const parts = [...groups].map(([material, indices]) => ({
    name: sourceParts[indices[0]].name,
    material,
    geometry: mergeCrowdGeometry(indices.map(entryOf)),
  }));
  for (const index of morphedParts) {
    const part = sourceParts[index];
    const geometry = mergeCrowdGeometry([entryOf(index)]);
    geometry.morphTargets = part.geometry.morphTargets;
    parts.push({ name: part.name, material: part.material, geometry, morph: { weights: new Float32Array(part.morph.weights) } });
  }
  return {
    jointCount,
    parts,
    /** Write the current joint matrices (mesh space, ready to skin with) of every joint into `output`. */
    readJointMatrices(output) {
      sourceParts.forEach((part, index) => {
        const offset = jointOffsets[index] * FLOATS_PER_MATRIX;
        if (!part.skin) {
          output.set(part.matrix, offset);
          return;
        }
        for (let joint = 0; joint < part.skin.jointMatrices.length / FLOATS_PER_MATRIX; joint++) {
          mat4.multiply(scratch, part.matrix, part.skin.jointMatrices.subarray(joint * FLOATS_PER_MATRIX, (joint + 1) * FLOATS_PER_MATRIX));
          output.set(scratch, offset + joint * FLOATS_PER_MATRIX);
        }
      });
      return output;
    },
  };
}

function mergeCrowdGeometry(entries) {
  const vertexCount = entries.reduce((total, { part }) => total + part.geometry.positions.length / 3, 0);
  const indexCount = entries.reduce((total, { part }) => total + part.geometry.indices.length, 0);
  const merged = {
    positions: new Float32Array(vertexCount * 3),
    normals: new Float32Array(vertexCount * 3),
    indices: new Uint32Array(indexCount),
    crowdJoints: new Float32Array(vertexCount * 4),
    crowdWeights: new Float32Array(vertexCount * 4),
  };
  if (entries.some(({ part }) => part.geometry.uvs)) merged.uvs = new Float32Array(vertexCount * 2);
  let vertexStart = 0;
  let indexStart = 0;
  for (const { part, jointOffset } of entries) {
    const geometry = part.geometry;
    const count = geometry.positions.length / 3;
    merged.positions.set(geometry.positions, vertexStart * 3);
    merged.normals.set(geometry.normals, vertexStart * 3);
    if (geometry.uvs) merged.uvs.set(geometry.uvs, vertexStart * 2);
    for (let index = 0; index < geometry.indices.length; index++) merged.indices[indexStart + index] = geometry.indices[index] + vertexStart;
    for (let vertex = 0; vertex < count; vertex++) {
      const target = (vertexStart + vertex) * 4;
      if (!part.skin) {
        merged.crowdJoints[target] = jointOffset;
        merged.crowdWeights[target] = 1;
        continue;
      }
      let total = 0;
      for (let influence = 0; influence < 4; influence++) total += geometry.skinWeights[vertex * 4 + influence];
      for (let influence = 0; influence < 4; influence++) {
        merged.crowdJoints[target + influence] = geometry.skinIndices[vertex * 4 + influence] + jointOffset;
        merged.crowdWeights[target + influence] = Math.round(geometry.skinWeights[vertex * 4 + influence] / total * WEIGHT_STEPS) / WEIGHT_STEPS;
      }
    }
    vertexStart += count;
    indexStart += geometry.indices.length;
  }
  packCrowdInfluences(merged);
  return merged;
}

/** The attribute the renderer uploads: joint * 4096 + round(weight * 4095) for each of four influences. Weights are already whole steps. */
function packCrowdInfluences(geometry) {
  geometry.crowdPacked = new Float32Array(geometry.crowdJoints.length);
  for (let index = 0; index < geometry.crowdJoints.length; index++) {
    geometry.crowdPacked[index] = geometry.crowdJoints[index] * JOINT_STRIDE + Math.round(geometry.crowdWeights[index] * WEIGHT_STEPS);
  }
}

/** The position of one crowd vertex under a table of joint matrices at `frameOffset` (in matrices), the maths the shader runs. */
function skinCrowdVertex(geometry, vertex, matrices, frameOffset, output = [0, 0, 0]) {
  const x = geometry.positions[vertex * 3];
  const y = geometry.positions[vertex * 3 + 1];
  const z = geometry.positions[vertex * 3 + 2];
  output[0] = 0;
  output[1] = 0;
  output[2] = 0;
  for (let influence = 0; influence < 4; influence++) {
    const weight = geometry.crowdWeights[vertex * 4 + influence];
    if (weight <= 0) continue;
    const base = (frameOffset + geometry.crowdJoints[vertex * 4 + influence]) * FLOATS_PER_MATRIX;
    output[0] += weight * (matrices[base] * x + matrices[base + 4] * y + matrices[base + 8] * z + matrices[base + 12]);
    output[1] += weight * (matrices[base + 1] * x + matrices[base + 5] * y + matrices[base + 9] * z + matrices[base + 13]);
    output[2] += weight * (matrices[base + 2] * x + matrices[base + 6] * y + matrices[base + 10] * z + matrices[base + 14]);
  }
  return output;
}

/**
 * Bake a clip into a palette: the joint matrices of `frameCount` evenly spaced poses, plus a bounding sphere (in the
 * space of the instance matrix) that covers every vertex in every pose. `poseAt(seconds)` must pose the parts the
 * rig was made from, such as `(seconds) => pose.apply(seconds)`. A looping clip is baked without its end frame, so
 * playback wraps between the last frame and the first.
 */
export function bakeCrowdPalette(rig, poseAt, { duration, loop = true, frameRate = DEFAULT_FRAME_RATE } = {}) {
  if (!Number.isFinite(duration) || duration <= 0) throw new RangeError('Crowd duration must be positive.');
  if (!Number.isFinite(frameRate) || frameRate <= 0) throw new RangeError('Crowd frame rate must be positive.');
  const frameCount = Math.max(2, Math.round(duration * frameRate) + (loop ? 0 : 1));
  const frameStep = loop ? duration / frameCount : duration / (frameCount - 1);
  const matricesPerFrame = rig.jointCount * FLOATS_PER_MATRIX;
  const data = new Float32Array(frameCount * matricesPerFrame);
  for (let frame = 0; frame < frameCount; frame++) {
    poseAt(frame * frameStep);
    rig.readJointMatrices(data.subarray(frame * matricesPerFrame, (frame + 1) * matricesPerFrame));
  }
  const palette = { data, jointCount: rig.jointCount, frameCount, frameStep, duration, loop };
  palette.bounds = measureCrowdBounds(rig, palette);
  return palette;
}

function measureCrowdBounds(rig, palette) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  const point = [0, 0, 0];
  const points = [];
  for (const { geometry } of rig.parts) {
    for (let frame = 0; frame < palette.frameCount; frame++) {
      for (let vertex = 0; vertex < geometry.positions.length / 3; vertex++) {
        skinCrowdVertex(geometry, vertex, palette.data, frame * palette.jointCount, point);
        points.push(point[0], point[1], point[2]);
        for (let axis = 0; axis < 3; axis++) {
          minimum[axis] = Math.min(minimum[axis], point[axis]);
          maximum[axis] = Math.max(maximum[axis], point[axis]);
        }
      }
    }
  }
  const center = minimum.map((value, axis) => (value + maximum[axis]) / 2);
  let radiusSquared = 0;
  for (let index = 0; index < points.length; index += 3) {
    radiusSquared = Math.max(radiusSquared, (points[index] - center[0]) ** 2 + (points[index + 1] - center[1]) ** 2 + (points[index + 2] - center[2]) ** 2);
  }
  return Object.freeze({ center: Object.freeze(center), radius: Math.sqrt(radiusSquared) });
}

/** The two frames and the blend between them for a clip time: [firstTexel, secondTexel, blend], as the shader reads them. */
export function crowdFrameBlend(palette, seconds, output = [0, 0, 0]) {
  const lastFrame = palette.frameCount - 1;
  let position;
  if (palette.loop) {
    const wrapped = seconds - Math.floor(seconds / palette.duration) * palette.duration;
    position = wrapped / palette.frameStep;
  } else {
    position = Math.min(Math.max(seconds, 0), palette.duration) / palette.frameStep;
  }
  let first = Math.floor(position);
  let blend = position - first;
  let second = first + 1;
  if (palette.loop) {
    first %= palette.frameCount;
    second %= palette.frameCount;
  } else if (first >= lastFrame) {
    first = lastFrame;
    second = lastFrame;
    blend = 0;
  }
  const texelsPerFrame = palette.jointCount * TEXELS_PER_MATRIX;
  output[0] = first * texelsPerFrame;
  output[1] = second * texelsPerFrame;
  output[2] = blend;
  return output;
}

/** The skinned position of one vertex of a rig geometry at a clip time, on the CPU. The shader computes the same value. */
export function crowdVertexAt(palette, geometry, vertex, seconds, output = [0, 0, 0]) {
  const blend = crowdFrameBlend(palette, seconds);
  const firstPoint = skinCrowdVertex(geometry, vertex, palette.data, blend[0] / TEXELS_PER_MATRIX);
  const secondPoint = skinCrowdVertex(geometry, vertex, palette.data, blend[1] / TEXELS_PER_MATRIX);
  for (let axis = 0; axis < 3; axis++) output[axis] = firstPoint[axis] * (1 - blend[2]) + secondPoint[axis] * blend[2];
  return output;
}

/**
 * Coarser levels of a crowd geometry for the renderer's `lods`: vertices that share a grid cell and a dominant joint
 * merge into one, which keeps that vertex's joints and weights, so every level skins with the same palette.
 * `cells` lists cell sizes as fractions of the geometry's largest extent; `error` is the largest distance a vertex moves.
 */
export function createCrowdLods(geometry, { cells = DEFAULT_LEVEL_CELLS } = {}) {
  const extent = largestExtent(geometry.positions);
  return [{ geometry, error: 0 }, ...cells.map((fraction) => {
    const cellSize = fraction * extent;
    return { geometry: clusterCrowdGeometry(geometry, cellSize), error: cellSize * Math.sqrt(3) / 2 };
  })];
}

function largestExtent(positions) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], positions[index + axis]);
      maximum[axis] = Math.max(maximum[axis], positions[index + axis]);
    }
  }
  return Math.max(...maximum.map((value, axis) => value - minimum[axis]));
}

function clusterCrowdGeometry(geometry, cellSize) {
  const vertexCount = geometry.positions.length / 3;
  const clusterOfVertex = new Uint32Array(vertexCount);
  const clusterByKey = new Map();
  const representatives = [];
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    let dominant = 0;
    for (let influence = 1; influence < 4; influence++) {
      if (geometry.crowdWeights[vertex * 4 + influence] > geometry.crowdWeights[vertex * 4 + dominant]) dominant = influence;
    }
    const key = [0, 1, 2].map(axis => Math.floor(geometry.positions[vertex * 3 + axis] / cellSize)).join(',') + `:${geometry.crowdJoints[vertex * 4 + dominant]}`;
    if (!clusterByKey.has(key)) {
      clusterByKey.set(key, representatives.length);
      representatives.push({ vertex, count: 0, position: [0, 0, 0], normal: [0, 0, 0], uv: [0, 0] });
    }
    const clusterIndex = clusterByKey.get(key);
    const cluster = representatives[clusterIndex];
    clusterOfVertex[vertex] = clusterIndex;
    cluster.count++;
    for (let axis = 0; axis < 3; axis++) {
      cluster.position[axis] += geometry.positions[vertex * 3 + axis];
      cluster.normal[axis] += geometry.normals[vertex * 3 + axis];
    }
    if (geometry.uvs) {
      cluster.uv[0] += geometry.uvs[vertex * 2];
      cluster.uv[1] += geometry.uvs[vertex * 2 + 1];
    }
  }
  const coarse = {
    positions: new Float32Array(representatives.length * 3),
    normals: new Float32Array(representatives.length * 3),
    ...(geometry.uvs ? { uvs: new Float32Array(representatives.length * 2) } : {}),
    crowdJoints: new Float32Array(representatives.length * 4),
    crowdWeights: new Float32Array(representatives.length * 4),
  };
  representatives.forEach((cluster, index) => {
    const length = Math.hypot(...cluster.normal) || 1;
    for (let axis = 0; axis < 3; axis++) {
      coarse.positions[index * 3 + axis] = cluster.position[axis] / cluster.count;
      coarse.normals[index * 3 + axis] = cluster.normal[axis] / length;
    }
    if (geometry.uvs) {
      coarse.uvs[index * 2] = cluster.uv[0] / cluster.count;
      coarse.uvs[index * 2 + 1] = cluster.uv[1] / cluster.count;
    }
    coarse.crowdJoints.set(geometry.crowdJoints.subarray(cluster.vertex * 4, cluster.vertex * 4 + 4), index * 4);
    coarse.crowdWeights.set(geometry.crowdWeights.subarray(cluster.vertex * 4, cluster.vertex * 4 + 4), index * 4);
  });
  const indices = [];
  for (let corner = 0; corner < geometry.indices.length; corner += 3) {
    const first = clusterOfVertex[geometry.indices[corner]];
    const second = clusterOfVertex[geometry.indices[corner + 1]];
    const third = clusterOfVertex[geometry.indices[corner + 2]];
    if (first !== second && second !== third && first !== third) indices.push(first, second, third);
  }
  coarse.indices = Uint32Array.from(indices);
  packCrowdInfluences(coarse);
  return coarse;
}

/**
 * The renderer parts of a crowd: one part per instance and material, all instances of a material sharing a geometry,
 * a palette and `lods`, so they draw as one batch per material and level. `instances` come from createCrowd (or any
 * list with a column-major `matrix`). Call `setTimes` with each instance's clip time, then `renderer.updateParts(parts)`.
 * `lods: false` turns the coarser levels off; `cells` sets their sizes. `farPose: { distance, rate }` makes an instance
 * more than `distance` from the eye passed to `setTimes` hold each pose for 1 / `rate` seconds. That is still a pure
 * function of the clip time and the eye, so a seek equals playing.
 */
export function createCrowdParts({ rig, palette, instances, lods = true, cells, farPose = null, name = 'crowd' }) {
  if (!instances?.length) throw new TypeError('A crowd needs a list of instances.');
  if (farPose && !(farPose.distance > 0 && farPose.rate > 0)) throw new RangeError('farPose needs a positive distance and rate.');
  const rigParts = rig.parts.map(part => ({ ...part, levels: lods && !part.morph ? createCrowdLods(part.geometry, { cells }) : null }));
  const blends = [];
  const parts = [];
  instances.forEach((instance, index) => {
    const blend = [0, 0, 0];
    blends.push(blend);
    for (const rigPart of rigParts) {
      parts.push({
        name: `${name}-${index}-${rigPart.name}`,
        geometry: rigPart.geometry,
        matrix: instance.matrix,
        material: rigPart.material,
        crowd: palette,
        assembly: { offset: blend, detailOffset: [0, 0, 0] },
        ...(rigPart.morph ? { morph: rigPart.morph } : {}),
        ...(rigPart.levels ? { lods: rigPart.levels } : {}),
      });
    }
  });
  return {
    parts,
    /** Set every instance's clip time: an array of seconds or `(index) => seconds`. `eye` is the camera position, used with `farPose`. */
    setTimes(times, eye = null) {
      blends.forEach((blend, index) => {
        let seconds = typeof times === 'function' ? times(index) : times[index];
        if (farPose && eye) {
          const matrix = instances[index].matrix;
          if (Math.hypot(matrix[12] - eye[0], matrix[13] - eye[1], matrix[14] - eye[2]) > farPose.distance) {
            seconds = Math.floor(seconds * farPose.rate) / farPose.rate;
          }
        }
        crowdFrameBlend(palette, seconds, blend);
      });
    },
  };
}
