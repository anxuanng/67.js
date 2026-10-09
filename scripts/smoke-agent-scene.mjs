import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { chromium } from 'playwright';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const width = Number(process.argv[2] ?? 960);
const height = Number(process.argv[3] ?? 540);
const origin = process.argv[4] ?? 'http://127.0.0.1:5173';
await mkdir('artifacts', { recursive: true });
const recipe = {
  format: '67js.scene', schemaVersion: 1,
  geometries: [
    { id: 'pedestal', type: 'lathe', profile: [[0,0],[0.8,0],[0.9,0.07],[0.9,0.16],[0.74,0.22],[0.48,0.28],[0.42,0.34],[0,0.34]], segments: 64 },
    { id: 'bulb', type: 'sphere', segments: 48, rings: 32 },
    { id: 'ring', type: 'torus', tubeRadius: 0.025, segments: 80, sides: 12 },
    { id: 'post', type: 'cylinder', segments: 40, bevel: 0.02, bevelSegments: 4 },
    { id: 'rail', type: 'tube', path: [[-0.65,-0.35,0],[-0.68,0.3,0],[-0.5,1.05,0],[0,1.38,0],[0.5,1.05,0],[0.68,0.3,0],[0.65,-0.35,0]], radius: 0.026, segments: 80, radialSegments: 12 },
    { id: 'fin', type: 'extrude', contour: [[0,0],[0.28,0],[0.38,0.2],[0.18,0.4],[0,0.32]], depth: 0.035, bevel: 0.008, bevelSegments: 2 },
    { id: 'panel', type: 'box', bevel: 0.06, subdivisions: 4 },
  ],
  materials: [
    { id: 'porcelain', color: [0.7,0.8,0.77], metallic: 0.15, roughness: 0.27 },
    { id: 'brass', color: [0.58,0.3,0.06], metallic: 0.85, roughness: 0.25 },
    { id: 'teal', color: [0.015,0.12,0.14], metallic: 0.72, roughness: 0.3 },
    { id: 'light', color: [0.23,0.8,0.65], metallic: 0.1, roughness: 0.21, emission: 2, emissiveColor: [0.23,0.8,0.65] },
  ],
  nodes: [
    { id: 'lamp', label: 'Aster lamp', translation: [0,0.82,0] },
    { id: 'foot', parent: 'lamp', geometry: 'pedestal', material: 'porcelain', translation: [0,-0.8,0] },
    { id: 'stem', parent: 'lamp', geometry: 'post', material: 'teal', translation: [0,-0.15,0], scale: [0.12,0.72,0.12] },
    { id: 'glow', parent: 'lamp', geometry: 'bulb', material: 'light', translation: [0,0.55,0], scale: [0.3,0.48,0.3] },
    { id: 'switch', parent: 'lamp', geometry: 'panel', material: 'teal', translation: [0,-0.65,0.82], scale: [0.16,0.06,0.04] },
  ],
  camera: { eye: [3.7,2.82,4.6], target: [0,1.06,0], fov: 36, near: 0.1, far: 40 },
};
for (let index = 0; index < 4; index++) {
  const angle = index * Math.PI / 4;
  recipe.nodes.push({ id: `rail-${index}`, parent: 'lamp', geometry: 'rail', material: 'brass', rotation: [0,Math.sin(angle/2),0,Math.cos(angle/2)] });
}
for (let index = 0; index < 3; index++) {
  recipe.nodes.push({ id: `ring-${index}`, parent: 'lamp', geometry: 'ring', material: index === 1 ? 'teal' : 'brass', translation: [0,-0.38 + index * 0.34,0], scale: [0.65,0.65,0.65], rotation: [Math.SQRT1_2,0,0,Math.SQRT1_2] });
}
for (let index = 0; index < 8; index++) {
  const angle = index * Math.PI / 4;
  recipe.nodes.push({ id: `fin-${index}`, parent: 'lamp', geometry: 'fin', material: 'brass', translation: [Math.sin(angle)*0.43,-0.46,Math.cos(angle)*0.43], rotation: [0,Math.sin(angle/2),0,Math.cos(angle/2)], scale: [0.4,0.4,0.4] });
}
const harness = `<!doctype html><html><head><style>html,body{margin:0;height:100%;background:#152126}canvas{width:100vw;height:100vh;display:block}</style></head><body><canvas id="scene"></canvas><script type="module">
import {createAgentScene} from '/src/agent-scene.js';
import {Renderer67} from '/src/renderer.js';
import {exportGlb} from '/src/export.js';
const session=createAgentScene(${JSON.stringify(recipe)});
const renderer=new Renderer67(document.querySelector('canvas'),session.parts,{ground:true,hdr:true,samples:4,pixelRatio:1,memoryBudgetMiB:192});
const effects={bloom:{strength:0.12,threshold:1,radius:1},saturation:1,contrast:1,temperature:0,vignette:0,grain:0};
function draw() {
  renderer.updateParts(session.parts);
  renderer.render({...session.camera,effects});
}
function pixels() {
  const context = renderer.context;
  const buffer = new Uint8Array(context.drawingBufferWidth * context.drawingBufferHeight * 4);
  context.readPixels(0,0,context.drawingBufferWidth,context.drawingBufferHeight,context.RGBA,context.UNSIGNED_BYTE,buffer);
  return buffer;
}
draw();
window.__agentFixture = {
  session, renderer, draw, pixels,
  exportSnapshot: () => Array.from(new Uint8Array(exportGlb(session.parts))),
};
</script></body></html>`;
await writeFile('artifacts/agent-scene-harness.html', harness);
const browser = await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
try {
  const page = await browser.newPage({viewport:{width,height},reducedMotion:'reduce'});
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${origin}/artifacts/agent-scene-harness.html`);
  await page.waitForFunction(()=>window.__agentFixture);
  await page.screenshot({path:`artifacts/agent-scene-${width}x${height}-before.png`});
  const result=await page.evaluate(()=>{
    const {session,renderer,draw,pixels}=window.__agentFixture;
    const parts=[...session.parts];
    const matrices=parts.map(part=>part.matrix);
    const geometries=parts.map(part=>part.geometry);
    const checkpoint=session.checkpoint();
    // Read the freshly rendered buffer before browser compositing may clear it.
    draw();
    const before=pixels();
    const creation={buffer:0,texture:0,framebuffer:0,renderbuffer:0};
    for(const [name,key] of [['createBuffer','buffer'],['createTexture','texture'],['createFramebuffer','framebuffer'],['createRenderbuffer','renderbuffer']]){
      const original=renderer.context[name].bind(renderer.context);
      renderer.context[name]=(...args)=>{
        creation[key]++;
        return original(...args);
      };
    }
    session.apply([{type:'set-node',id:'lamp',translation:[0.18,0.82,0]},{type:'set-node',id:'glow',translation:[0,0.75,0],scale:[0.34,0.3,0.34]},{type:'set-material',id:'light',color:[0.9,0.28,0.04],emissiveColor:[0.9,0.28,0.04]}],{expectedRevision:session.revision});
    draw();
    const after=pixels();
    let changed=0;
    for(let index=0;index<before.length;index++) {
      if(before[index]!==after[index]) {
        changed++;
      }
    }
    window.__agentFixture.restore=()=>{
      session.restore(checkpoint,{expectedRevision:session.revision});
      draw();
      session.releaseCheckpoint(checkpoint);
    };
    window.__agentFixture.before=before;
    return {changed,creation,identities:parts.every((part,index)=>part===session.parts[index]&&matrices[index]===part.matrix&&geometries[index]===part.geometry),inspection:session.inspect(),revision:session.revision,estimatedBytes:renderer.memoryPlan.estimatedBytes,glError:renderer.context.getError(),backend:renderer.context.getParameter(renderer.context.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL)};
  });
  await page.screenshot({path:`artifacts/agent-scene-${width}x${height}-after.png`});
  const restored=await page.evaluate(()=>{
    const fixture=window.__agentFixture;
    fixture.restore();
    const pixels=fixture.pixels();
    return {equal:pixels.every((value,index)=>value===fixture.before[index]),revision:fixture.session.revision,glError:fixture.renderer.context.getError()};
  });
  assert.deepEqual(errors,[]);
  assert.ok(result.changed>1000);
  assert.ok(result.identities);
  assert.deepEqual(result.creation,{buffer:0,texture:0,framebuffer:0,renderbuffer:0});
  assert.ok(restored.equal,'Checkpoint restore must reproduce the original rendered frame');
  assert.equal(result.glError,0);
  assert.equal(restored.glError,0);
  assert.ok(result.estimatedBytes<=192*1048576);
  await page.screenshot({path:`artifacts/agent-scene-${width}x${height}-restored.png`});
  const topView = await page.evaluate(() => {
    const { session, renderer, draw } = window.__agentFixture;
    session.apply([{ type: 'set-camera', eye: [0, 5.5, 0], target: [0, 1.06, 0], up: [0, 0, -1] }], { expectedRevision: session.revision });
    draw();
    return { revision: session.revision, glError: renderer.context.getError() };
  });
  assert.equal(topView.glError, 0);
  await page.screenshot({path:`artifacts/agent-scene-${width}x${height}-top.png`});
  const snapshot = Buffer.from(await page.evaluate(() => window.__agentFixture.exportSnapshot()));
  assert.equal(snapshot.readUInt32LE(0), 0x46546c67);
  assert.equal(snapshot.readUInt32LE(4), 2);
  assert.equal(snapshot.readUInt32LE(8), snapshot.byteLength);
  await writeFile(`artifacts/agent-scene-${width}x${height}.glb`, snapshot);
  await writeFile(`artifacts/agent-scene-${width}x${height}.json`,JSON.stringify({result,restored},null,2));
  console.log(JSON.stringify({width,height,changed:result.changed,allocations:result.creation,retained:result.identities,restore:restored.equal,backend:result.backend,estimatedBytes:result.estimatedBytes}));
} finally {
  await browser.close();
}
