// Silhouette masks and their overlap. The look score compares what the object covers from a fixed camera, so a
// recipe that passes every size check but is shaped wrongly still scores lower.
//
// The cameras are orthographic: a pixel is covered when any triangle of the object lands on it, which needs no GPU
// and gives the same mask on every machine.

export const MASK_SIZE = 256;

function subtract(first, second) {
  return first.map((value, axis) => value - second[axis]);
}

function cross(first, second) {
  return [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
}

function normalize(vector) {
  const length = Math.hypot(...vector);
  return vector.map(value => value / length);
}

function dot(first, second) {
  return first.reduce((sum, value, axis) => sum + value * second[axis], 0);
}

function cameraBasis(camera) {
  const forward = normalize(subtract(camera.target, camera.eye));
  const right = normalize(cross(forward, camera.up));
  const up = cross(right, forward);
  return { right, up };
}

/** Projects a world point to pixel coordinates; y grows downward like an image. */
export function projectToPixel(camera, point, size = MASK_SIZE) {
  const { right, up } = cameraBasis(camera);
  const offset = subtract(point, camera.target);
  const height = camera.orthographicHeight;
  return [
    size / 2 + dot(offset, right) / height * size,
    size / 2 - dot(offset, up) / height * size,
  ];
}

function fillTriangle(mask, size, corners) {
  const [first, second, third] = corners;
  const minimumX = Math.max(0, Math.floor(Math.min(first[0], second[0], third[0])));
  const maximumX = Math.min(size - 1, Math.ceil(Math.max(first[0], second[0], third[0])));
  const minimumY = Math.max(0, Math.floor(Math.min(first[1], second[1], third[1])));
  const maximumY = Math.min(size - 1, Math.ceil(Math.max(first[1], second[1], third[1])));
  const area = (second[0] - first[0]) * (third[1] - first[1]) - (third[0] - first[0]) * (second[1] - first[1]);
  if (area === 0) return;
  for (let y = minimumY; y <= maximumY; y++) {
    for (let x = minimumX; x <= maximumX; x++) {
      const pointX = x + 0.5;
      const pointY = y + 0.5;
      const weightFirst = ((second[0] - pointX) * (third[1] - pointY) - (third[0] - pointX) * (second[1] - pointY)) / area;
      const weightSecond = ((third[0] - pointX) * (first[1] - pointY) - (first[0] - pointX) * (third[1] - pointY)) / area;
      const weightThird = 1 - weightFirst - weightSecond;
      if (weightFirst >= 0 && weightSecond >= 0 && weightThird >= 0) mask[y * size + x] = 1;
    }
  }
}

/** Rasterizes world-space geometries ({ positions, indices }) into a 0/1 mask. */
export function rasterizeSilhouette(geometries, camera, size = MASK_SIZE) {
  const mask = new Uint8Array(size * size);
  for (const { positions, indices } of geometries) {
    const pixels = [];
    for (let vertex = 0; vertex < positions.length / 3; vertex++) {
      pixels.push(projectToPixel(camera, [positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]], size));
    }
    for (let triangle = 0; triangle < indices.length; triangle += 3) {
      fillTriangle(mask, size, [pixels[indices[triangle]], pixels[indices[triangle + 1]], pixels[indices[triangle + 2]]]);
    }
  }
  return mask;
}

/** Intersection over union of two masks of equal size. Two empty masks count as a perfect match. */
export function intersectionOverUnion(first, second) {
  if (first.length !== second.length) throw new RangeError('Masks must have the same size.');
  let intersection = 0;
  let union = 0;
  for (let pixel = 0; pixel < first.length; pixel++) {
    if (first[pixel] && second[pixel]) intersection++;
    if (first[pixel] || second[pixel]) union++;
  }
  return union === 0 ? 1 : intersection / union;
}
