// Measures KTX2 upload (issue #304) with Khronos's AnisotropyBarnLamp, in the PNG and the KHR_texture_basisu variant.
//   gpu-lock: bash ~/.agents/tools/gpu-lock.sh node bench/ktx2/measure.mjs
// Downloads the glTF files (CC BY 4.0, Analytical Graphics, Inc. and Wayfair, LLC) into the gitignored artifacts/ktx2/, never committed.
// Per backend (the RTX GPU, then SwiftShader) it loads each variant three times and records the formats, the texture bytes the
// engine accounts for and the load time. On the GPU it also draws both variants through the Khronos framing of the reference
// suite into artifacts/ktx2/render/<variant>/, ready for score.py (see the README of bench/reference).
import { mkdir, writeFile, access } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SOURCE = 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/AnisotropyBarnLamp';
const ASSET_DIRECTORY = 'artifacts/ktx2/AnisotropyBarnLamp';
const VARIANT_FILES = {
  png: ['glTF', ['AnisotropyBarnLamp.gltf', 'AnisotropyBarnLamp.bin', 'AnisotropyBarnLamp_anisotropy.png', 'AnisotropyBarnLamp_basecolor.png', 'AnisotropyBarnLamp_normalbump.png', 'AnisotropyBarnLamp_occlusionroughnessmetal.png']],
  ktx2: ['glTF-KTX-BasisU', ['AnisotropyBarnLamp.gltf', 'AnisotropyBarnLamp.bin', 'AnisotropyBarnLamp_anisotropy.ktx2', 'AnisotropyBarnLamp_basecolor.ktx2', 'AnisotropyBarnLamp_normalbump.ktx2', 'AnisotropyBarnLamp_occlusionroughnessmetal.ktx2']],
};
const BACKENDS = {
  gpu: ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'],
  swiftshader: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
};
const LOAD_REPEATS = 3;

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function download() {
  for (const [variant, [folder, names]] of Object.entries(VARIANT_FILES)) {
    await mkdir(`${ASSET_DIRECTORY}/${variant}`, { recursive: true });
    for (const name of names) {
      const target = `${ASSET_DIRECTORY}/${variant}/${name}`;
      if (await exists(target)) continue;
      const response = await fetch(`${SOURCE}/${folder}/${name}`);
      if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
      await writeFile(target, Buffer.from(await response.arrayBuffer()));
    }
  }
}

function summarize(asset) {
  const byFormat = {};
  for (const texture of asset.textureFormats) byFormat[texture.format] = (byFormat[texture.format] ?? 0) + 1;
  return {
    formats: byFormat,
    textures: asset.textureFormats.map(({ format, width, height, colorSpace, bytes }) => ({ format, width, height, colorSpace, bytes })),
    totalBytes: asset.textureFormats.reduce((sum, texture) => sum + texture.bytes, 0),
  };
}

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await download();
const server = await createServer({ server: { host: '127.0.0.1', port: 0, fs: { strict: false } }, logLevel: 'silent' });
await server.listen();
const serverUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
const report = {};
try {
  for (const [backend, args] of Object.entries(BACKENDS)) {
    const browser = await chromium.launch({ executablePath: CHROME, headless: true, args });
    try {
      const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
      page.on('pageerror', error => console.log('PAGE ERROR', error.message));
      await page.goto(`${serverUrl}/bench/reference/harness.html?set=ktx2`, { timeout: 180000 });
      await page.waitForFunction(() => window.loadBarnLampVariant, null, { timeout: 180000 });
      const result = await page.evaluate(async repeats => {
        const context = document.createElement('canvas').getContext('webgl2');
        const debug = context.getExtension('WEBGL_debug_renderer_info');
        const variants = {};
        for (const variant of ['png', 'ktx2']) {
          const seconds = [];
          let last = null;
          for (let run = 0; run < repeats; run++) {
            const start = performance.now();
            last = await window.loadBarnLampVariant(variant);
            seconds.push((performance.now() - start) / 1000);
          }
          variants[variant] = { seconds, workerConfig: last.workerConfig, textureFormats: last.asset.textureFormats };
        }
        return { renderer: context.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : context.RENDERER), variants };
      }, LOAD_REPEATS);
      report[backend] = { renderer: result.renderer, variants: {} };
      for (const [variant, data] of Object.entries(result.variants)) {
        const { textureFormats, seconds, workerConfig } = data;
        report[backend].variants[variant] = { seconds, workerConfig, ...summarize({ textureFormats }) };
      }
      if (backend === 'gpu') {
        for (const variant of ['png', 'ktx2']) {
          const rendered = await page.evaluate(sceneId => window.renderReferenceScene(sceneId, { describe: false }), `AnisotropyBarnLamp-${variant}`);
          if (rendered.glError !== 0) throw new Error(`${variant} gave WebGL error ${rendered.glError}.`);
          await mkdir(`artifacts/ktx2/render/${variant}`, { recursive: true });
          await writeFile(`artifacts/ktx2/render/${variant}/AnisotropyBarnLamp-gpu.png`, Buffer.from(rendered.image, 'base64'));
        }
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}
await writeFile('artifacts/ktx2/result.json', JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, (key, value) => (key === 'textures' ? undefined : value), 1));
