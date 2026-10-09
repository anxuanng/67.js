import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { chromium } from 'playwright';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir('artifacts', { recursive: true });
const width = Number(process.argv[2] ?? 960);
const height = Number(process.argv[3] ?? 540);
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/attachment-smoke.html', route => route.fulfill({
    contentType: 'text/html',
    body: `<canvas style="width:${width}px;height:${height}px;display:block"></canvas>`,
  }));
  await page.goto('http://127.0.0.1:5173/attachment-smoke.html');
  const report = await page.evaluate(async () => {
    const { Renderer67, torus, sphere, createMorphPose, createSkinPose, fitPerspectiveDistance } = await import('/build/67.module.js');
    const { createSurfaceAttachment } = await import('/build/surface-attachment.js');
    const { createMeshQueryIndex, createMeshPairQuery } = await import('/build/mesh-query.js');
    const { mat4 } = await import('/node_modules/.vite/deps/gl-matrix.js');
    const { vertexShader } = await import('/src/shaders.js');
    const columns = 32;
    const rows = 20;
    const vertexCount = (columns + 1) * (rows + 1);
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const deltas = new Float32Array(vertexCount * 3);
    const normalDeltas = new Float32Array(vertexCount * 3);
    const skinIndices = new Uint16Array(vertexCount * 4);
    const skinWeights = new Float32Array(vertexCount * 4);
    const indices = [];
    for (let row = 0; row <= rows; row++) {
      for (let column = 0; column <= columns; column++) {
        const vertex = row * (columns + 1) + column;
        const horizontal = column / columns;
        const vertical = row / rows;
        positions.set([(horizontal - 0.5) * 3.2, (vertical - 0.5) * 2, 0], vertex * 3);
        normals.set([0, 0, 1], vertex * 3);
        const height = 0.32 * Math.sin(horizontal * Math.PI) * Math.cos((vertical - 0.5) * Math.PI);
        const slopeX = 0.32 * Math.PI / 3.2 * Math.cos(horizontal * Math.PI) * Math.cos((vertical - 0.5) * Math.PI);
        const slopeY = -0.32 * Math.PI / 2 * Math.sin(horizontal * Math.PI) * Math.sin((vertical - 0.5) * Math.PI);
        const normalLength = Math.hypot(slopeX, slopeY, 1);
        deltas.set([0, 0, height], vertex * 3);
        normalDeltas.set([-slopeX / normalLength, -slopeY / normalLength, 1 / normalLength - 1], vertex * 3);
        skinIndices.set([0, 1, 0, 0], vertex * 4);
        skinWeights.set([1 - horizontal, horizontal, 0, 0], vertex * 4);
        if (row < rows && column < columns) {
          indices.push(vertex, vertex + 1, vertex + columns + 2, vertex, vertex + columns + 2, vertex + columns + 1);
        }
      }
    }
    const morph = createMorphPose(1);
    const skin = createSkinPose(2);
    const matrix = mat4.create();
    const target = {
      name: 'Deforming alloy panel',
      geometry: { positions, normals, indices: new Uint32Array(indices), skinIndices, skinWeights, morphTargets: [{ positions: deltas, normals: normalDeltas }] },
      morph, skin, matrix,
      material: { color: [0.025, 0.24, 0.35], metallic: 0.65, roughness: 0.35, emission: 0 },
      castShadow: false,
    };
    const triangle = (10 * columns + 20) * 2;
    const barycentric = [0.25, 0.35, 0.4];
    const clearance = 0.003;
    const attachment = createSurfaceAttachment(target, { triangle, barycentric, clearance, rotation: 0.25 });
    const badgeGeometry = torus(0.12, 48, 16);
    for (let offset = 0; offset < badgeGeometry.positions.length; offset += 3) {
      badgeGeometry.positions[offset] *= 0.16;
      badgeGeometry.positions[offset + 1] *= 0.16;
      badgeGeometry.positions[offset + 2] = badgeGeometry.positions[offset + 2] * 0.16 + 0.04;
    }
    const jewelGeometry = sphere(32, 20);
    for (let offset = 0; offset < jewelGeometry.positions.length; offset += 3) {
      jewelGeometry.positions[offset] *= 0.115;
      jewelGeometry.positions[offset + 1] *= 0.115;
      jewelGeometry.positions[offset + 2] = jewelGeometry.positions[offset + 2] * 0.035 + 0.04;
    }
    const ring = { name: 'Retained brass ring', geometry: badgeGeometry, matrix: attachment.matrix,
      material: { color: [0.75, 0.35, 0.035], metallic: 0.85, roughness: 0.23, emission: 0 }, castShadow: false };
    const jewel = { name: 'Retained amber insert', geometry: jewelGeometry, matrix: attachment.matrix,
      material: { color: [1, 0.12, 0.005], metallic: 0.05, roughness: 0.25, emission: 0.12 }, castShadow: false };
    const parts = [target, ring, jewel];
    const canvas = document.querySelector('canvas');
    const renderer = new Renderer67(canvas, parts, {
      world: true, ground: false, hdr: true, samples: 2, pixelRatio: 1, memoryBudgetMiB: 96,
      environment: { keyIntensity: 0.8, fillIntensity: 0.6, ambientIntensity: 0.4 },
    });
    const camera = { eye: [2.4, 1.8, 5], target: [0, 0, 0], fov: 35 };
    const distance = fitPerspectiveDistance({ minimum: [-2.2, -1.3, -1.2], maximum: [2.2, 1.3, 1.2] }, camera, canvas.clientWidth / canvas.clientHeight);
    const initialDistance = Math.hypot(...camera.eye);
    camera.eye = camera.eye.map(value => value * distance / initialDistance);
    const frame = { ...camera, time: 0, effects: { grain: 0, bloom: { strength: 0 } } };
    const context = renderer.context;
    const gpuInfo = context.getExtension('WEBGL_debug_renderer_info');
    const gpu = gpuInfo ? context.getParameter(gpuInfo.UNMASKED_RENDERER_WEBGL) : context.getParameter(context.RENDERER);
    const batch = renderer.partLocations.get(target).batch;
    function shader(type, source) {
      const result = context.createShader(type);
      context.shaderSource(result, source);
      context.compileShader(result);
      if (!context.getShaderParameter(result, context.COMPILE_STATUS)) throw new Error(context.getShaderInfoLog(result));
      return result;
    }
    const vertex = shader(context.VERTEX_SHADER, vertexShader);
    const fragment = shader(context.FRAGMENT_SHADER, '#version 300 es\nprecision highp float;out vec4 color;void main(){color=vec4(0.0);}');
    const program = context.createProgram();
    context.attachShader(program, vertex);
    context.attachShader(program, fragment);
    context.transformFeedbackVaryings(program, ['worldPosition', 'gl_Position'], context.INTERLEAVED_ATTRIBS);
    context.linkProgram(program);
    if (!context.getProgramParameter(program, context.LINK_STATUS)) throw new Error(context.getProgramInfoLog(program));
    const feedback = context.createTransformFeedback();
    const feedbackBuffer = context.createBuffer();
    const feedbackData = new Float32Array(vertexCount * 7);
    context.bindBuffer(context.TRANSFORM_FEEDBACK_BUFFER, feedbackBuffer);
    context.bufferData(context.TRANSFORM_FEEDBACK_BUFFER, feedbackData.byteLength, context.STREAM_READ);
    context.bindBuffer(context.TRANSFORM_FEEDBACK_BUFFER, null);
    const identity = mat4.create();
    const ringIndex = createMeshQueryIndex(badgeGeometry);
    const jewelIndex = createMeshQueryIndex(jewelGeometry);
    function captureVertices() {
      context.useProgram(program);
      context.uniformMatrix4fv(context.getUniformLocation(program, 'viewProjection'), false, identity);
      context.uniform1f(context.getUniformLocation(program, 'skinEnabled'), 1);
      context.uniform1f(context.getUniformLocation(program, 'morphEnabled'), 1);
      context.uniform1i(context.getUniformLocation(program, 'morphVertexCount'), vertexCount);
      context.uniform1i(context.getUniformLocation(program, 'morphTargetCount'), 1);
      context.uniform1fv(context.getUniformLocation(program, 'morphWeights[0]'), morph.weights);
      for (const [unit, name, texture] of [[6, 'skinInfluences', batch.influenceTexture.texture], [7, 'jointPalette', batch.skinTexture.texture], [8, 'morphTargets', batch.morphTexture.texture]]) {
        context.activeTexture(context.TEXTURE0 + unit);
        context.bindTexture(context.TEXTURE_2D, texture);
        context.uniform1i(context.getUniformLocation(program, name), unit);
      }
      context.bindVertexArray(batch.vertexArray);
      context.bindTransformFeedback(context.TRANSFORM_FEEDBACK, feedback);
      context.bindBufferBase(context.TRANSFORM_FEEDBACK_BUFFER, 0, feedbackBuffer);
      context.enable(context.RASTERIZER_DISCARD);
      context.beginTransformFeedback(context.POINTS);
      context.drawArraysInstanced(context.POINTS, 0, vertexCount, 1);
      context.endTransformFeedback();
      context.disable(context.RASTERIZER_DISCARD);
      context.bindTransformFeedback(context.TRANSFORM_FEEDBACK, null);
      context.bindVertexArray(null);
      context.bindBuffer(context.TRANSFORM_FEEDBACK_BUFFER, feedbackBuffer);
      context.getBufferSubData(context.TRANSFORM_FEEDBACK_BUFFER, 0, feedbackData);
      context.bindBuffer(context.TRANSFORM_FEEDBACK_BUFFER, null);
      const points = [];
      const worldPositions = new Float32Array(vertexCount * 3);
      for (let vertex = 0; vertex < vertexCount; vertex++) {
        for (let axis = 0; axis < 3; axis++) worldPositions[vertex * 3 + axis] = feedbackData[vertex * 7 + axis] / feedbackData[vertex * 7 + 6];
      }
      for (let corner = 0; corner < 3; corner++) {
        const vertex = target.geometry.indices[triangle * 3 + corner];
        const offset = vertex * 7;
        const homogeneous = feedbackData[offset + 6];
        points.push(Array.from(feedbackData.subarray(offset, offset + 3), value => value / homogeneous));
      }
      return { points, worldPositions };
    }
    function proof(points) {
      const edge = points[1].map((value, axis) => value - points[0][axis]);
      const second = points[2].map((value, axis) => value - points[0][axis]);
      const cross = [edge[1] * second[2] - edge[2] * second[1], edge[2] * second[0] - edge[0] * second[2], edge[0] * second[1] - edge[1] * second[0]];
      const normal = cross.map(value => value / Math.hypot(...cross));
      const center = [0, 1, 2].map(axis => points.reduce((total, point, corner) => total + point[axis] * barycentric[corner], 0));
      const expected = center.map((value, axis) => value + normal[axis] * clearance);
      const positionError = Math.hypot(...expected.map((value, axis) => value - attachment.matrix[12 + axis]));
      const normalError = Math.hypot(...normal.map((value, axis) => value - attachment.matrix[8 + axis]));
      if (positionError > 2e-6 || normalError > 2e-5) throw new Error(`Attachment diverged from actual GPU triangle: ${positionError}, ${normalError}`);
      return { positionError, normalError };
    }
    const allocations = { buffers: 0, textures: 0, framebuffers: 0, renderbuffers: 0 };
    for (const [method, key] of [['createBuffer', 'buffers'], ['createTexture', 'textures'], ['createFramebuffer', 'framebuffers'], ['createRenderbuffer', 'renderbuffers']]) {
      const original = context[method].bind(context);
      context[method] = (...argumentsList) => {
        allocations[key]++;
        return original(...argumentsList);
      };
    }
    const retainedMatrix = attachment.matrix;
    const frames = [];
    let baseline;
    let changedChannels = 0;
    function pose(time) {
      morph.weights[0] = 0.5 + Math.sin(time) * 0.45;
      mat4.fromYRotation(matrix, Math.sin(time * 0.7) * 0.2);
      mat4.scale(matrix, matrix, [1.1, 0.95, 0.9]);
      matrix[4] += Math.sin(time * 0.4) * 0.12;
      matrix[12] = Math.sin(time * 0.6) * 0.2;
      for (let joint = 0; joint < 2; joint++) {
        const rotation = mat4.fromYRotation(mat4.create(), Math.sin(time) * (joint === 0 ? 0.5 : -0.5));
        const pivot = joint === 0 ? -0.8 : 0.8;
        rotation[12] = pivot - rotation[0] * pivot;
        rotation[14] = -rotation[2] * pivot;
        skin.jointMatrices.set(rotation, joint * 16);
      }
      attachment.update();
      renderer.updateParts(parts);
      renderer.render(frame);
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      context.readPixels(0, 0, canvas.width, canvas.height, context.RGBA, context.UNSIGNED_BYTE, pixels);
      const captured = captureVertices();
      const result = proof(captured.points);
      const posedIndex = createMeshQueryIndex({ positions: captured.worldPositions, indices: target.geometry.indices });
      try {
        for (const [accessoryName, accessoryIndex] of [['ring', ringIndex], ['jewel', jewelIndex]]) {
          const contact = createMeshPairQuery(posedIndex, accessoryIndex).evaluate(identity, attachment.matrix);
          if (contact.kind !== 'surface-disjoint') throw new Error(`Fixture ${accessoryName} overlaps the GPU-posed target at ${time}: ${JSON.stringify(contact)}`);
        }
      } finally {
        posedIndex.dispose();
      }
      if (context.getError()) throw new Error('Surface attachment smoke generated a graphics error');
      if (attachment.matrix !== retainedMatrix) throw new Error('Attachment matrix identity changed');
      if (!baseline) baseline = pixels;
      else if (time === 0) {
        if (pixels.some((value, index) => value !== baseline[index])) throw new Error('Reverse pose changed pixels');
      } else {
        changedChannels = Math.max(changedChannels, pixels.reduce((count, value, index) => count + (value !== baseline[index] ? 1 : 0), 0));
      }
      frames.push({ time, ...result });
    }
    for (const time of [0, 1.2, 2.7, 0.5, 0]) pose(time);
    for (let update = 0; update < 80; update++) {
      attachment.update();
      renderer.updateParts(parts, { shadows: false });
    }
    pose(1.2);
    window.__attachmentSmoke = { renderer, frame };
    const report = { gpu, frames, changedChannels, allocations, estimatedBytes: renderer.memoryPlan.estimatedBytes, vertexCount };
    ringIndex.dispose();
    jewelIndex.dispose();
    context.deleteTransformFeedback(feedback);
    context.deleteBuffer(feedbackBuffer);
    context.deleteProgram(program);
    context.deleteShader(vertex);
    context.deleteShader(fragment);
    return report;
  });
  assert.deepEqual(errors, []);
  assert.ok(report.changedChannels > 1000, 'Rendered deformation did not visibly change');
  assert.deepEqual(report.allocations, { buffers: 0, textures: 0, framebuffers: 0, renderbuffers: 0 });
  // Render the final presentation after releasing the diagnostic feedback objects.
  await page.evaluate(() => {
    const { renderer, frame } = window.__attachmentSmoke;
    renderer.render(frame);
  });
  await page.locator('canvas').screenshot({ path: `artifacts/surface-attachment-${width}x${height}.png` });
  await page.evaluate(() => window.__attachmentSmoke.renderer.dispose());
  await writeFile(`artifacts/surface-attachment-${width}x${height}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
