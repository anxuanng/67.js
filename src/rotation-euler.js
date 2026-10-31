import { quat } from 'gl-matrix';

// Euler angles in Blender's XYZ order: the rotation is X first, then Y, then Z, so R = Rz * Ry * Rx. Angles are radians
// here. Quaternions are XYZW. Constraints and joint limits use this order so their numbers match Blender's.

const GIMBAL_THRESHOLD = 1 - 1e-9;

/** Quaternion from Euler X, Y, Z angles in radians. */
export function quaternionFromEuler(out, angleX, angleY, angleZ) {
  const quaternionX = quat.setAxisAngle(new Float64Array(4), [1, 0, 0], angleX);
  const quaternionY = quat.setAxisAngle(new Float64Array(4), [0, 1, 0], angleY);
  const quaternionZ = quat.setAxisAngle(new Float64Array(4), [0, 0, 1], angleZ);
  quat.multiply(out, quaternionZ, quaternionY);
  return quat.multiply(out, out, quaternionX);
}

/** Euler X, Y, Z angles in radians from a quaternion. At gimbal lock the Z angle is zero and X takes the whole turn. */
export function eulerFromQuaternion(rotation) {
  const [x, y, z, w] = rotation;
  const lengthSquared = x * x + y * y + z * z + w * w;
  const scale = lengthSquared > 0 ? 2 / lengthSquared : 0;
  const row2Column0 = scale * (x * z - w * y);
  const row2Column1 = scale * (y * z + w * x);
  const row2Column2 = 1 - scale * (x * x + y * y);
  const row1Column0 = scale * (x * y + w * z);
  const row0Column0 = 1 - scale * (y * y + z * z);
  if (Math.abs(row2Column0) >= GIMBAL_THRESHOLD) {
    const row1Column1 = 1 - scale * (x * x + z * z);
    const row1Column2 = scale * (y * z - w * x);
    return [Math.atan2(-row1Column2, row1Column1), Math.asin(Math.max(-1, Math.min(1, -row2Column0))), 0];
  }
  return [Math.atan2(row2Column1, row2Column2), Math.asin(-row2Column0), Math.atan2(row1Column0, row0Column0)];
}
