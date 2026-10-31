import { mat4, quat } from 'gl-matrix';

/** A fixed-size vector of doubles that reads and writes plain arrays. */
export class TransformVector {
  constructor(values) {
    this.values = values;
  }

  toArray() {
    return [...this.values];
  }

  fromArray(array, offset = 0) {
    for (let index = 0; index < this.values.length; index++) this.values[index] = array[offset + index];
    return this;
  }
}

/** A column-major 4x4 matrix with double precision, the shape the glTF import reads. */
export class Matrix4 {
  constructor() {
    this.elements = mat4.identity(new Float64Array(16));
  }

  fromArray(array, offset = 0) {
    for (let index = 0; index < 16; index++) this.elements[index] = array[offset + index];
    return this;
  }

  copy(other) {
    this.elements.set(other.elements);
    return this;
  }

  multiplyMatrices(left, right) {
    mat4.multiply(this.elements, left.elements, right.elements);
    return this;
  }

  determinant() {
    return mat4.determinant(this.elements);
  }

  compose(position, rotation, scale) {
    mat4.fromRotationTranslationScale(this.elements, rotation.values, position.values, scale.values);
    return this;
  }

  /** Split into translation, rotation and scale. A reflection goes into the X scale, as three.js does. */
  decompose(position, rotation, scale) {
    const e = this.elements;
    let scaleX = Math.hypot(e[0], e[1], e[2]);
    const scaleY = Math.hypot(e[4], e[5], e[6]);
    const scaleZ = Math.hypot(e[8], e[9], e[10]);
    if (this.determinant() < 0) scaleX = -scaleX;
    position.fromArray([e[12], e[13], e[14]]);
    const rotationMatrix = new Float64Array(16);
    rotationMatrix[15] = 1;
    for (let row = 0; row < 3; row++) {
      rotationMatrix[row] = e[row] / scaleX;
      rotationMatrix[4 + row] = e[4 + row] / scaleY;
      rotationMatrix[8 + row] = e[8 + row] / scaleZ;
    }
    rotation.fromArray(quat.normalize(new Float64Array(4), mat4.getRotation(new Float64Array(4), rotationMatrix)));
    scale.fromArray([scaleX, scaleY, scaleZ]);
    return this;
  }
}

let nextNodeId = 1;

/** One decoded glTF node or mesh primitive, with just the transform and mesh fields the import reads. */
export class SceneNode {
  constructor() {
    this.uuid = `node-uuid-${nextNodeId++}`;
    this.name = '';
    this.parent = null;
    this.children = [];
    this.position = new TransformVector([0, 0, 0]);
    this.quaternion = new TransformVector([0, 0, 0, 1]);
    this.scale = new TransformVector([1, 1, 1]);
    this.matrix = new Matrix4();
    this.matrixWorld = new Matrix4();
    this.matrixAutoUpdate = true;
    this.matrixWorldNeedsUpdate = false;
    this.association = {};
  }

  add(child) {
    child.parent = this;
    this.children.push(child);
  }

  traverse(visit) {
    visit(this);
    for (const child of this.children) child.traverse(visit);
  }

  updateMatrix() {
    this.matrix.compose(this.position, this.quaternion, this.scale);
    this.matrixWorldNeedsUpdate = true;
  }

  updateMatrixWorld() {
    if (this.matrixAutoUpdate) this.updateMatrix();
    if (this.parent) this.matrixWorld.multiplyMatrices(this.parent.matrixWorld, this.matrix);
    else this.matrixWorld.copy(this.matrix);
    this.matrixWorldNeedsUpdate = false;
    for (const child of this.children) child.updateMatrixWorld();
  }

  getMatrixAt(index, target) {
    return target.fromArray(this.instanceMatrices, index * 16);
  }
}
