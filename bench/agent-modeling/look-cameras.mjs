// The fixed cameras of the look score. They are placed from the reference's bounds, not the candidate's, so a
// candidate that is too big, too small or off centre shows it in every view.

const PADDING = 1.2;
const DISTANCE_FACTOR = 4;

export const LOOK_VIEWS = [
  { name: 'front', direction: [0, 0, 1] },
  { name: 'side', direction: [1, 0, 0] },
  { name: 'three-quarter', direction: [0.58, 0.4, 0.71] },
];

export function boundsOfGeometries(geometries) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const { positions } of geometries) {
    for (let index = 0; index < positions.length; index++) {
      const axis = index % 3;
      minimum[axis] = Math.min(minimum[axis], positions[index]);
      maximum[axis] = Math.max(maximum[axis], positions[index]);
    }
  }
  return { minimum, maximum };
}

/** One orthographic camera per view, all framing the same sphere around the reference. */
export function lookCameras(referenceBounds) {
  const target = referenceBounds.minimum.map((value, axis) => (value + referenceBounds.maximum[axis]) / 2);
  const diameter = Math.hypot(...referenceBounds.maximum.map((value, axis) => value - referenceBounds.minimum[axis]));
  const distance = diameter * DISTANCE_FACTOR;
  return LOOK_VIEWS.map(({ name, direction }) => {
    const length = Math.hypot(...direction);
    return {
      name,
      camera: {
        eye: target.map((value, axis) => value + direction[axis] / length * distance),
        target,
        up: [0, 1, 0],
        projection: 'orthographic',
        orthographicHeight: diameter * PADDING,
        fov: 45,
        near: 0.1,
        far: distance * 3,
      },
    };
  });
}
