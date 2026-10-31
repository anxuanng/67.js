// Position-based cloth (Muller et al., "Position Based Dynamics", 2007), recorded offline as frames.
// Constraints are solved in a fixed order with no random numbers, so the same input always gives the same frames,
// and playback is an interpolation between two recorded frames: a seek never runs the solver.

export const CLOTH_LIMITS = Object.freeze({
  maxParticles: 5000,
  maxFrameParticles: 3_000_000,
  // About 18 ns an operation measured on the dev machine, so the cap is a bake of roughly three seconds.
  maxWork: 1.5e8,
  substeps: 4,
  iterations: 8,
});

const AIR_DENSITY = 1.2;
const WELD_DIGITS = 5;
const GRAVITY_DEFAULT = Object.freeze([0, -9.81, 0]);

/** Unique particles of a triangle mesh: vertices at the same position share one, so a seam does not tear open. */
export function weldVertices(positions, indices) {
  const particleOfKey = new Map();
  const particleOfVertex = new Uint32Array(positions.length / 3);
  const representatives = [];
  for (let vertex = 0; vertex < particleOfVertex.length; vertex++) {
    const offset = vertex * 3;
    const key = `${positions[offset].toFixed(WELD_DIGITS)},${positions[offset + 1].toFixed(WELD_DIGITS)},${positions[offset + 2].toFixed(WELD_DIGITS)}`;
    let particle = particleOfKey.get(key);
    if (particle === undefined) {
      particle = representatives.length;
      particleOfKey.set(key, particle);
      representatives.push(vertex);
    }
    particleOfVertex[vertex] = particle;
  }
  const triangles = [];
  for (let corner = 0; corner < indices.length; corner += 3) {
    const first = particleOfVertex[indices[corner]];
    const second = particleOfVertex[indices[corner + 1]];
    const third = particleOfVertex[indices[corner + 2]];
    if (first !== second && second !== third && first !== third) {
      triangles.push(first, second, third);
    }
  }
  return { particleOfVertex, representatives, triangles: Uint32Array.from(triangles) };
}

function edgeKey(first, second, particleCount) {
  return first < second ? first * particleCount + second : second * particleCount + first;
}

// Stretch constraints along every edge, bend constraints between the far corners of two triangles sharing an edge.
function buildConstraints(positions, triangles, particleCount, bendStiffness, stretchStiffness) {
  const edgeNeighbours = new Map();
  for (let corner = 0; corner < triangles.length; corner += 3) {
    for (let side = 0; side < 3; side++) {
      const first = triangles[corner + side];
      const second = triangles[corner + (side + 1) % 3];
      const opposite = triangles[corner + (side + 2) % 3];
      const key = edgeKey(first, second, particleCount);
      const entry = edgeNeighbours.get(key) ?? { first: Math.min(first, second), second: Math.max(first, second), opposites: [] };
      entry.opposites.push(opposite);
      edgeNeighbours.set(key, entry);
    }
  }
  const firsts = [];
  const seconds = [];
  const stiffnesses = [];
  const add = (first, second, stiffness) => {
    firsts.push(first);
    seconds.push(second);
    stiffnesses.push(stiffness);
  };
  const orderedEntries = [...edgeNeighbours.entries()].sort((left, right) => left[0] - right[0]);
  for (const [, entry] of orderedEntries) {
    add(entry.first, entry.second, stretchStiffness);
  }
  if (bendStiffness > 0) {
    for (const [, entry] of orderedEntries) {
      if (entry.opposites.length === 2 && entry.opposites[0] !== entry.opposites[1]) {
        add(entry.opposites[0], entry.opposites[1], bendStiffness);
      }
    }
  }
  const restLengths = new Float64Array(firsts.length);
  for (let constraint = 0; constraint < firsts.length; constraint++) {
    const a = firsts[constraint] * 3;
    const b = seconds[constraint] * 3;
    restLengths[constraint] = Math.hypot(positions[a] - positions[b], positions[a + 1] - positions[b + 1], positions[a + 2] - positions[b + 2]);
  }
  return { count: firsts.length, firsts: Uint32Array.from(firsts), seconds: Uint32Array.from(seconds), stiffnesses: Float64Array.from(stiffnesses), restLengths };
}

// Rest area each particle represents (a third of its triangles), used to turn wind pressure into acceleration.
function particleAreas(positions, triangles, particleCount) {
  const areas = new Float64Array(particleCount);
  for (let corner = 0; corner < triangles.length; corner += 3) {
    const area = triangleNormal(positions, triangles[corner], triangles[corner + 1], triangles[corner + 2], [0, 0, 0]) / 2;
    for (let side = 0; side < 3; side++) {
      areas[triangles[corner + side]] += area / 3;
    }
  }
  return areas;
}

// Writes the unit normal into `normal` and returns twice the triangle area.
function triangleNormal(positions, first, second, third, normal) {
  const a = first * 3;
  const b = second * 3;
  const c = third * 3;
  const edgeOne = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
  const edgeTwo = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
  const x = edgeOne[1] * edgeTwo[2] - edgeOne[2] * edgeTwo[1];
  const y = edgeOne[2] * edgeTwo[0] - edgeOne[0] * edgeTwo[2];
  const z = edgeOne[0] * edgeTwo[1] - edgeOne[1] * edgeTwo[0];
  const length = Math.sqrt(x * x + y * y + z * z);
  if (length > 0) {
    normal[0] = x / length;
    normal[1] = y / length;
    normal[2] = z / length;
  }
  return length;
}

function applyWind(state, wind, areas, triangles, secondsPerSubstep, density) {
  const { positions, velocities, particleCount } = state;
  const pressures = state.windScratch;
  pressures.fill(0);
  const normal = [0, 0, 0];
  for (let corner = 0; corner < triangles.length; corner += 3) {
    const first = triangles[corner];
    const second = triangles[corner + 1];
    const third = triangles[corner + 2];
    const doubleArea = triangleNormal(positions, first, second, third, normal);
    if (doubleArea === 0) continue;
    let relative = 0;
    for (let axis = 0; axis < 3; axis++) {
      const velocity = (velocities[first * 3 + axis] + velocities[second * 3 + axis] + velocities[third * 3 + axis]) / 3;
      relative += (wind[axis] - velocity) * normal[axis];
    }
    const pressure = 0.5 * AIR_DENSITY * relative * Math.abs(relative);
    const force = pressure * doubleArea / 2 / 3;
    for (const particle of [first, second, third]) {
      for (let axis = 0; axis < 3; axis++) {
        pressures[particle * 3 + axis] += force * normal[axis];
      }
    }
  }
  for (let particle = 0; particle < particleCount; particle++) {
    const mass = Math.max(areas[particle], 1e-9) * density;
    for (let axis = 0; axis < 3; axis++) {
      velocities[particle * 3 + axis] += pressures[particle * 3 + axis] / mass * secondsPerSubstep;
    }
  }
}

function solveDistances(positions, inverseMasses, constraints) {
  const { count, firsts, seconds, stiffnesses, restLengths } = constraints;
  for (let constraint = 0; constraint < count; constraint++) {
    const first = firsts[constraint];
    const second = seconds[constraint];
    const weightSum = inverseMasses[first] + inverseMasses[second];
    if (weightSum === 0) continue;
    const a = first * 3;
    const b = second * 3;
    const dx = positions[b] - positions[a];
    const dy = positions[b + 1] - positions[a + 1];
    const dz = positions[b + 2] - positions[a + 2];
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (length < 1e-12) continue;
    const correction = stiffnesses[constraint] * (length - restLengths[constraint]) / (length * weightSum);
    positions[a] += dx * correction * inverseMasses[first];
    positions[a + 1] += dy * correction * inverseMasses[first];
    positions[a + 2] += dz * correction * inverseMasses[first];
    positions[b] -= dx * correction * inverseMasses[second];
    positions[b + 1] -= dy * correction * inverseMasses[second];
    positions[b + 2] -= dz * correction * inverseMasses[second];
  }
}

// Each collider pushes a point to its surface plus `thickness` and reports the outward normal, or null when clear.
function pushOutOfBall(point, ball, thickness, normal) {
  const dx = point[0] - ball.center[0];
  const dy = point[1] - ball.center[1];
  const dz = point[2] - ball.center[2];
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const reach = ball.radius + thickness;
  if (distance >= reach) return false;
  if (distance > 1e-12) {
    normal[0] = dx / distance;
    normal[1] = dy / distance;
    normal[2] = dz / distance;
  } else {
    normal[0] = 0;
    normal[1] = 1;
    normal[2] = 0;
  }
  for (let axis = 0; axis < 3; axis++) {
    point[axis] = ball.center[axis] + normal[axis] * reach;
  }
  return true;
}

function pushOutOfBox(point, box, thickness, normal) {
  const { center, axes, halfExtents } = box;
  const offset = [point[0] - center[0], point[1] - center[1], point[2] - center[2]];
  const local = axes.map(axis => offset[0] * axis[0] + offset[1] * axis[1] + offset[2] * axis[2]);
  const closest = local.map((value, index) => Math.min(Math.max(value, -halfExtents[index]), halfExtents[index]));
  const delta = local.map((value, index) => value - closest[index]);
  const distance = Math.hypot(...delta);
  const pushed = [...local];
  const localNormal = [0, 0, 0];
  if (distance > 1e-12) {
    if (distance >= thickness) return false;
    for (let index = 0; index < 3; index++) {
      localNormal[index] = delta[index] / distance;
      pushed[index] = closest[index] + localNormal[index] * thickness;
    }
  } else {
    let shallowest = 0;
    for (let index = 1; index < 3; index++) {
      if (halfExtents[index] - Math.abs(local[index]) < halfExtents[shallowest] - Math.abs(local[shallowest])) shallowest = index;
    }
    const sign = local[shallowest] >= 0 ? 1 : -1;
    localNormal[shallowest] = sign;
    pushed[shallowest] = sign * (halfExtents[shallowest] + thickness);
  }
  for (let axis = 0; axis < 3; axis++) {
    normal[axis] = 0;
    point[axis] = center[axis];
    for (let index = 0; index < 3; index++) {
      normal[axis] += axes[index][axis] * localNormal[index];
      point[axis] += axes[index][axis] * pushed[index];
    }
  }
  return true;
}

function collide(state, previous, colliders, thickness, friction) {
  const { positions, inverseMasses, particleCount } = state;
  const point = [0, 0, 0];
  const normal = [0, 0, 0];
  for (let particle = 0; particle < particleCount; particle++) {
    if (inverseMasses[particle] === 0) continue;
    const offset = particle * 3;
    point[0] = positions[offset];
    point[1] = positions[offset + 1];
    point[2] = positions[offset + 2];
    for (const collider of colliders) {
      const touched = collider.kind === 'ball' ? pushOutOfBall(point, collider, thickness, normal) : pushOutOfBox(point, collider, thickness, normal);
      if (!touched) continue;
      // Friction removes part of the sideways travel this substep, so cloth drags over a surface instead of skating.
      const travel = [point[0] - previous[offset], point[1] - previous[offset + 1], point[2] - previous[offset + 2]];
      const along = travel[0] * normal[0] + travel[1] * normal[1] + travel[2] * normal[2];
      for (let axis = 0; axis < 3; axis++) {
        point[axis] -= (travel[axis] - along * normal[axis]) * friction;
      }
    }
    positions[offset] = point[0];
    positions[offset + 1] = point[1];
    positions[offset + 2] = point[2];
  }
}

function checkWork(particleCount, constraintCount, triangleCount, colliderCount, frameCount) {
  const work = frameCount * CLOTH_LIMITS.substeps * (CLOTH_LIMITS.iterations * constraintCount + triangleCount + particleCount * (colliderCount + 1));
  if (particleCount > CLOTH_LIMITS.maxParticles) {
    throw new RangeError(`Cloth has ${particleCount} particles; the limit is ${CLOTH_LIMITS.maxParticles}. Use a coarser grid.`);
  }
  if (particleCount * frameCount > CLOTH_LIMITS.maxFrameParticles) {
    throw new RangeError(`Cloth would record ${particleCount * frameCount} particle positions; the limit is ${CLOTH_LIMITS.maxFrameParticles}. Use a shorter duration or a coarser grid.`);
  }
  if (work > CLOTH_LIMITS.maxWork) {
    throw new RangeError(`Cloth needs ${Math.round(work)} solver operations; the limit is ${CLOTH_LIMITS.maxWork}. Use a shorter duration or a coarser grid.`);
  }
}

/**
 * Simulate one sheet. `positions` are world-space rest positions (3 numbers per particle), `triangles` index them.
 * Options: pinned (particle indices that stay put), gravity, wind (m/s), stiffness and bend (0 to 1), density (kg/m2),
 * damping (1/s), friction (0 to 1), thickness (m), colliders ({ kind: 'ball', center, radius } or
 * { kind: 'box', center, axes, halfExtents }), frameCount and framesPerSecond.
 * Returns the recorded frames: Float32Array of frameCount * particleCount * 3.
 */
export function bakeCloth(positions, triangles, options) {
  const particleCount = positions.length / 3;
  const colliders = options.colliders ?? [];
  const constraints = buildConstraints(positions, triangles, particleCount, options.bend ?? 0.1, options.stiffness ?? 0.9);
  checkWork(particleCount, constraints.count, triangles.length / 3, colliders.length, options.frameCount);
  const gravity = options.gravity ?? GRAVITY_DEFAULT;
  const wind = options.wind ?? [0, 0, 0];
  const density = options.density ?? 0.2;
  const damping = options.damping ?? 0.3;
  const friction = options.friction ?? 0.3;
  const thickness = options.thickness ?? 0.01;
  const hasWind = wind.some(component => component !== 0);
  const frameSeconds = 1 / (options.framesPerSecond ?? 60);
  const substepSeconds = frameSeconds / CLOTH_LIMITS.substeps;
  const dampingFactor = Math.exp(-damping * substepSeconds);
  const areas = hasWind ? particleAreas(positions, triangles, particleCount) : null;
  const inverseMasses = new Float64Array(particleCount).fill(1);
  for (const particle of options.pinned ?? []) {
    inverseMasses[particle] = 0;
  }
  const state = {
    particleCount, inverseMasses, positions: Float64Array.from(positions),
    velocities: new Float64Array(positions.length), windScratch: new Float64Array(positions.length),
  };
  const previous = new Float64Array(positions.length);
  const frames = new Float32Array(options.frameCount * positions.length);
  frames.set(Float32Array.from(positions), 0);
  for (let frame = 1; frame < options.frameCount; frame++) {
    for (let substep = 0; substep < CLOTH_LIMITS.substeps; substep++) {
      if (hasWind) applyWind(state, wind, areas, triangles, substepSeconds, density);
      previous.set(state.positions);
      for (let particle = 0; particle < particleCount; particle++) {
        if (inverseMasses[particle] === 0) continue;
        for (let axis = 0; axis < 3; axis++) {
          const index = particle * 3 + axis;
          state.velocities[index] += gravity[axis] * substepSeconds;
          state.positions[index] += state.velocities[index] * substepSeconds;
        }
      }
      for (let iteration = 0; iteration < CLOTH_LIMITS.iterations; iteration++) {
        solveDistances(state.positions, inverseMasses, constraints);
        collide(state, previous, colliders, thickness, friction);
      }
      for (let index = 0; index < positions.length; index++) {
        state.velocities[index] = (state.positions[index] - previous[index]) / substepSeconds * dampingFactor;
      }
    }
    if (!state.positions.every(Number.isFinite)) {
      throw new RangeError('Cloth became unstable (non-finite positions). Lower the wind, raise density or use a finer grid.');
    }
    frames.set(Float32Array.from(state.positions), frame * positions.length);
  }
  return Object.freeze({ particleCount, frameCount: options.frameCount, framesPerSecond: options.framesPerSecond ?? 60, frames, constraintCount: constraints.count });
}

/** Write the particle positions at `time` into `target`, a linear blend of the two nearest recorded frames. */
export function sampleClothFrames(recording, time, target) {
  const stride = recording.particleCount * 3;
  const position = Math.min(Math.max(time * recording.framesPerSecond, 0), recording.frameCount - 1);
  const lower = Math.floor(position);
  const upper = Math.min(lower + 1, recording.frameCount - 1);
  const blend = position - lower;
  for (let index = 0; index < stride; index++) {
    const before = recording.frames[lower * stride + index];
    const after = recording.frames[upper * stride + index];
    target[index] = before + (after - before) * blend;
  }
  return target;
}
