// Frame time, draw calls, picture and culling checks of the GPU crowd path: npm run benchmark:crowd [-- --cpu | --gpu] [--counts 100,500] [--frames 10]
// --cpu uses SwiftShader (the path a headless agent has); the default is the machine's GPU. Prints one JSON object.
import { writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { chromium } from 'playwright';
import { createServer } from 'vite';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const flags = process.argv.slice(2);
const useCpu = flags.includes('--cpu');
const countsFlag = flags.indexOf('--counts');
const counts = (countsFlag >= 0 ? flags[countsFlag + 1] : '100,500').split(',').map(Number);
const framesFlag = flags.indexOf('--frames');
const frames = framesFlag >= 0 ? Number(flags[framesFlag + 1]) : 10;
const instanceCounts = flags.includes('--instances') ? flags[flags.indexOf('--instances') + 1].split(',').map(Number) : [];
const width = 1280;
const height = 720;

const browserArguments = ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'];
if (useCpu) browserArguments.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' });
await server.listen();
const address = server.httpServer.address();
const url = `http://localhost:${address.port}/bench/crowd/harness.html`;

async function runTask(request) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: browserArguments });
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    if (process.env.CROWD_NO_CULL) await page.addInitScript('globalThis.CROWD_NO_CULL = true');
    await page.goto(url);
    await page.waitForFunction(() => window.runCrowd);
    const result = await page.evaluate(task => window.runCrowd(task), request);
    if (errors.length) throw new Error(errors.join('\n'));
    return result;
  } finally {
    await browser.close();
  }
}

const report = { backend: useCpu ? 'swiftshader' : 'gpu', width, height, frames };
try {
  report.pictures = await runTask({ task: 'pictures', dump: Boolean(process.env.CROWD_DUMP) });
  if (report.pictures.dumps) {
    for (const [name, dataUrl] of Object.entries(report.pictures.dumps)) await writeFile(`${process.env.CROWD_DUMP}/${name}.png`, Buffer.from(dataUrl.split(',')[1], 'base64'));
    delete report.pictures.dumps;
  }
  report.culling = await runTask({ task: 'culling' });
  report.crowd = [];
  for (const count of counts) report.crowd.push(await runTask({ task: 'measure', count, frames, spacing: 3 }));
  report.perInstance = [];
  for (const count of instanceCounts) report.perInstance.push(await runTask({ task: 'instances', count, frames, spacing: 3 }));
} finally {
  await server.close();
}
console.log(JSON.stringify(report, null, 1));
