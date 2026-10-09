import { mat4, vec3 } from 'gl-matrix';

export function applyProjection(matrix, frame, aspect, { world = false } = {}) {
  if (!Number.isFinite(aspect) || aspect <= 0) throw new RangeError('Camera aspect must be positive and finite');
  if (frame.projection === undefined && frame.fov === undefined) return matrix;
  const near = frame.near ?? 0.1;
  const far = frame.far ?? (world ? 600 : 100);
  if (!Number.isFinite(near) || !Number.isFinite(far) || near <= 0 || far <= near) throw new RangeError('Camera clipping planes must satisfy 0 < near < far');
  if (frame.projection === 'orthographic') {
    const height = frame.orthographicHeight ?? 4;
    if (!Number.isFinite(height) || height <= 0) throw new RangeError('Orthographic height must be positive and finite');
    const halfHeight = height / 2;
    return mat4.ortho(matrix, -halfHeight * aspect, halfHeight * aspect, -halfHeight, halfHeight, near, far);
  }
  if (frame.projection && frame.projection !== 'perspective') throw new RangeError(`Unsupported camera projection: ${frame.projection}`);
  const fov = frame.fov ?? 45;
  if (!Number.isFinite(fov) || fov <= 0 || fov >= 180) throw new RangeError('Camera field of view must be between 0 and 180 degrees');
  return mat4.perspective(matrix, fov * Math.PI / 180, aspect, near, far);
}

const viewDirections = { front: [0, 0, 1], right: [1, 0, 0], top: [0, 1, 0], perspective: [0.58, 0.34, 0.74] };

export function cameraView(name = 'front', { target = [0, 1.5, 0], height = 3.8, distance = 8 } = {}) {
  const direction = viewDirections[name];
  if (!direction) throw new RangeError(`Unsupported camera view: ${name}`);
  if (!Number.isFinite(height) || height <= 0) throw new RangeError('Orthographic height must be positive and finite');
  if (target.length !== 3 || !target.every(Number.isFinite) || !Number.isFinite(distance) || distance <= 0) throw new RangeError('Camera target and positive distance must be finite');
  const unitDirection = vec3.normalize(vec3.create(), direction);
  const eye = Array.from(vec3.scaleAndAdd(vec3.create(), target, unitDirection, distance));
  return { eye, target: [...target], up: name === 'top' ? [0, 0, -1] : [0, 1, 0], projection: name === 'perspective' ? 'perspective' : 'orthographic', orthographicHeight: height, fov: 45 };
}

export function fitOrthographicHeight(bounds, view, aspect, padding = 1.15) {
  if (!Number.isFinite(aspect) || aspect <= 0 || !Number.isFinite(padding) || padding < 1) throw new RangeError('Fit aspect must be positive and padding at least one');
  if (bounds.minimum.length !== 3 || bounds.maximum.length !== 3 || !bounds.minimum.every(Number.isFinite) || !bounds.maximum.every((value, axis) => Number.isFinite(value) && value >= bounds.minimum[axis])) throw new RangeError('Fit bounds must be finite and ordered');
  const basis = mat4.lookAt(mat4.create(), view.eye, view.target, view.up ?? [0, 1, 0]);
  const minimum = [Infinity, Infinity];
  const maximum = [-Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const point = [0, 1, 2].map(axis => corner & (1 << axis) ? bounds.maximum[axis] : bounds.minimum[axis]);
    const projected = vec3.transformMat4(vec3.create(), point, basis);
    for (let axis = 0; axis < 2; axis++) {
      minimum[axis] = Math.min(minimum[axis], projected[axis]);
      maximum[axis] = Math.max(maximum[axis], projected[axis]);
    }
  }
  return Math.max(maximum[1] - minimum[1], (maximum[0] - minimum[0]) / aspect) * padding;
}
