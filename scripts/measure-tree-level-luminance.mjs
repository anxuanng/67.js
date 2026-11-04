// Draws only the foliage of one tree at each level of detail, from three sides and under three lights (sky only, sun behind the
// tree, sun in front of it), in headless Chrome (SwiftShader unless `--gpu`). It prints, as JSON, the mean linear luminance of
// the pure leaf pixels (every pixel that differs from an empty frame) and each level's ratio to level 0 (issue #432).
//   --species a,b     limit the species (default all five)         --seed N     tree seed (default 3)
//   --pictures <dir>  also write every frame as <species>-<light>-L<level>.png
//   --fit             solve, per species and level, the colour gain and sky gain that bring all three ratios to 1, and write
//                     them to src/tree-level-gains.js (the gains in the file are ignored while fitting)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const port = 5189;
const useGpu = process.argv.includes('--gpu');
const fit = process.argv.includes('--fit');
const optionValue = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const speciesList = optionValue('--species', 'palm,broadleaf,conifer,birch,bush').split(',');
const seed = Number(optionValue('--seed', 3));
const plainMeanMode = process.argv.includes('--plain-mean');
const pictureDirectory = optionValue('--pictures', null);
if (pictureDirectory) await mkdir(pictureDirectory, { recursive: true });

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The server did not start.')), 30000);
    server.stdout.on('data', (data) => {
      if (/ready in/.test(data.toString())) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.on('exit', (code) => reject(new Error(`The server exited ${code}.`)));
  });
  const args = useGpu ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'];
  browser = await chromium.launch({ headless: true, args });
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  page.on('pageerror', error => console.error(error.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  const result = await page.evaluate(async ({ speciesList, seed, pictureDirectory, fit, plainMeanMode }) => {
    const { createTree, vegetationParts } = await import('/src/vegetation.js');
    const { Renderer67 } = await import('/src/renderer.js');
    const { matchMeanVisibility, scaleVisibility } = await import('/src/tree-sky.js');
    const { TREE_LEVEL_GAINS } = await import('/src/tree-level-gains.js');
    const { constantLighting, environment, SUN_COLOR } = await import('/bench/reference/scenes.js');
    if (fit) for (const species of Object.keys(TREE_LEVEL_GAINS)) delete TREE_LEVEL_GAINS[species];

    const SIZE = 512;
    const AZIMUTHS = [0, 120, 240];
    const LIGHTS = ['sky', 'sunBehind', 'sunFront'];
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    document.body.append(canvas);
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const sky = constantLighting(1);
    const toLinear = value => {
      const unit = value / 255;
      return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    };
    const turn = ([x, y, z], degrees) => {
      const angle = degrees * Math.PI / 180;
      return [x * Math.cos(angle) + z * Math.sin(angle), y, -x * Math.sin(angle) + z * Math.cos(angle)];
    };
    const sunFor = (lightName, azimuth) => {
      if (lightName === 'sky') return environment(sky);
      const toward = lightName === 'sunBehind' ? [-3, 4, -6] : [3, 4, 6];
      return environment(sky, { lightDirection: turn(toward, azimuth), keyColor: SUN_COLOR });
    };

    function drawPixels(parts, frame) {
      const renderer = new Renderer67(canvas, parts, { ground: false, world: true, samples: 1, pixelRatio: 1 });
      renderer.render(frame);
      renderer.render(frame);
      const context = renderer.context;
      const pixels = new Uint8Array(SIZE * SIZE * 4);
      context.readPixels(0, 0, SIZE, SIZE, context.RGBA, context.UNSIGNED_BYTE, pixels);
      return pixels;
    }

    const pictures = {};
    const pictureOf = (pixels) => {
      const flat = document.createElement('canvas');
      flat.width = SIZE;
      flat.height = SIZE;
      const image = new ImageData(SIZE, SIZE);
      for (let row = 0; row < SIZE; row++) image.data.set(pixels.subarray(row * SIZE * 4, (row + 1) * SIZE * 4), (SIZE - 1 - row) * SIZE * 4);
      flat.getContext('2d').putImageData(image, 0, 0);
      return flat.toDataURL('image/png');
    };

    // Mean linear luminance of the pure leaf pixels of `parts`, pooled over the three sides, for each light.
    function measureLights(parts, view, label) {
      const means = {};
      for (const lightName of LIGHTS) {
        let sum = 0;
        let count = 0;
        AZIMUTHS.forEach((azimuth, side) => {
          const frame = { eye: turn([0, 1.7 - view.middle, view.distance], azimuth).map((value, axis) => value + (axis === 1 ? view.middle : 0)), target: [0, view.middle, 0], up: [0, 1, 0], fov: 25, near: 0.1, far: 500, time: 0, wind: 0, exposure: 1, environment: sunFor(lightName, azimuth) };
          const empty = drawPixels([], frame);
          const pixels = drawPixels(parts, frame);
          for (let offset = 0; offset < pixels.length; offset += 4) {
            if (pixels[offset] === empty[offset] && pixels[offset + 1] === empty[offset + 1] && pixels[offset + 2] === empty[offset + 2]) continue;
            sum += 0.2126 * toLinear(pixels[offset]) + 0.7152 * toLinear(pixels[offset + 1]) + 0.0722 * toLinear(pixels[offset + 2]);
            count++;
          }
          if (pictureDirectory && side === 0) pictures[`${label}-${lightName}`] = pictureOf(pixels);
        });
        means[lightName] = sum / Math.max(1, count);
      }
      return means;
    }

    const foliageParts = (tree, level, override) => {
      const parts = vegetationParts(tree, identity, level).filter(part => part.name.endsWith('foliage'));
      // The shadow layers point at the original geometry, and the frames have no shadows.
      return override ? parts.map(part => ({ ...part, geometry: override(part.geometry), shadowLods: undefined })) : parts;
    };
    const ratiosOf = (means, reference) => LIGHTS.map(light => means[light] / reference[light]);

    const output = {};
    const gains = {};
    for (const species of speciesList) {
      const tree = createTree(species, seed);
      const crown = tree.levels[0].parts.find(part => part.role === 'foliage').geometry.positions;
      let top = -Infinity;
      let reach = 0;
      for (let offset = 0; offset < crown.length; offset += 3) {
        top = Math.max(top, crown[offset + 1]);
        reach = Math.max(reach, Math.hypot(crown[offset], crown[offset + 2]));
      }
      // A far tree is seen from the ground: eye at 1.7 m, so the flat clumps of the far levels show from below.
      const view = { middle: top / 2, distance: Math.max(top, reach * 2) * 3 };
      const reference = measureLights(foliageParts(tree, 0), view, `${species}-L0`);
      output[species] = { level0: reference, levels: [] };
      gains[species] = {};
      for (let level = 1; level < tree.levels.length; level++) {
        // `--plain-mean` re-matches the level to level 0 by the plain mean over vertices, as main did before #432.
        const plainMean = geometry => {
          const levelZero = tree.levels[0].parts.find(part => part.role === 'foliage').geometry.skyVisibility;
          const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
          return { ...geometry, skyVisibility: matchMeanVisibility(geometry.skyVisibility, mean(levelZero), new Float32Array(geometry.skyVisibility.length).fill(1)) };
        };
        const before = ratiosOf(measureLights(foliageParts(tree, level, plainMeanMode ? plainMean : null), view, `${species}-L${level}`), reference);
        let after = before;
        if (fit) {
          const drawWith = (colorGain, skyGain) => ratiosOf(measureLights(foliageParts(tree, level, geometry => ({
            ...geometry, colors: geometry.colors.map(channel => channel * colorGain), skyVisibility: scaleVisibility(geometry.skyVisibility, skyGain),
          })), view, `${species}-L${level}-fit`), reference).map(Math.log);
          // Colour moves every light one for one; the sky gain's pull on each light is measured once with a step of 1.5.
          let colorGain = 1;
          let skyGain = 1;
          let residual = before.map(Math.log);
          const step = Math.log(1.5);
          const pull = drawWith(1, 1.5).map((value, light) => (value - residual[light]) / step);
          for (let iteration = 0; iteration < 4; iteration++) {
            // Least squares for the two log gains with a small pull towards no change in the sky gain.
            const ridge = 0.02;
            const aa = LIGHTS.length;
            const ab = pull.reduce((sum, value) => sum + value, 0);
            const bb = pull.reduce((sum, value) => sum + value * value, 0) + ridge;
            const ra = residual.reduce((sum, value) => sum - value, 0);
            const rb = residual.reduce((sum, value, light) => sum - value * pull[light], 0);
            const determinant = aa * bb - ab * ab;
            const colorStep = (ra * bb - rb * ab) / determinant;
            const skyStep = (aa * rb - ab * ra) / determinant;
            colorGain *= Math.exp(colorStep);
            skyGain = Math.min(4, Math.max(0.25, skyGain * Math.exp(skyStep)));
            residual = drawWith(colorGain, skyGain);
          }
          after = residual.map(Math.exp);
          gains[species][level] = { color: Number(colorGain.toFixed(3)), sky: Number(skyGain.toFixed(3)) };
        }
        output[species].levels.push({ level, before, after });
      }
    }
    return { output, gains, pictures };
  }, { speciesList, seed, pictureDirectory, fit, plainMeanMode });
  for (const [name, dataUrl] of Object.entries(result.pictures)) {
    await writeFile(`${pictureDirectory}/${name}.png`, Buffer.from(dataUrl.split(',')[1], 'base64'));
  }
  if (fit) {
    const gainsFile = new URL('../src/tree-level-gains.js', import.meta.url);
    const header = (await readFile(gainsFile, 'utf8')).split('export const')[0];
    const rows = Object.entries(result.gains).map(([species, levels]) => {
      const entries = Object.entries(levels).map(([level, gain]) => `${level}: { color: ${gain.color}, sky: ${gain.sky} }`);
      return `  ${species}: { ${entries.join(', ')} },`;
    });
    await writeFile(gainsFile, `${header}export const TREE_LEVEL_GAINS = {\n${rows.join('\n')}\n};\n`);
  }
  console.log(JSON.stringify({ ...result.output, gains: fit ? result.gains : undefined }));
} finally {
  await browser?.close();
  server.kill();
}
