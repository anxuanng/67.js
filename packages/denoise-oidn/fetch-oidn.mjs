// Downloads the official Open Image Denoise release for this platform into ./vendor (ignored by git), after checking
// its SHA-256. Run it with `npm run fetch` in this package. The downloaded archive is only unpacked, never run as a script.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OIDN_VERSION } from './index.mjs';

const RELEASE_ASSETS = {
  'win32-x64': { name: `oidn-${OIDN_VERSION}.x64.windows.zip`, sha256: 'f11f91bc072a5e3a564515724cb72ab8fcfbc445c84a84c197ff9b16cc01396f' },
  'linux-x64': { name: `oidn-${OIDN_VERSION}.x86_64.linux.tar.gz`, sha256: '743c3e2aff8c220d5d70fe6cb970fb3d36f2702d2693c61d1d148e404cf37cd6' },
  'darwin-x64': { name: `oidn-${OIDN_VERSION}.x86_64.macos.tar.gz`, sha256: 'a4341639005a33ce0d944bd7c771ce34de1465be7eb3189b7c3b5b0064429832' },
  'darwin-arm64': { name: `oidn-${OIDN_VERSION}.arm64.macos.tar.gz`, sha256: '98e0aca8e7ab69e9f4f0191582a500fd8b0d9085d68662f18ab6469e934a6efd' },
};

const VENDOR_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), 'vendor');

function extract(archivePath, destination) {
  // Windows ships bsdtar, which reads zip files; GNU tar from Git for Windows does not.
  const tarCommand = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const result = spawnSync(tarCommand, ['-xf', archivePath, '-C', destination], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Unpacking the Open Image Denoise archive failed.');
}

export async function fetchOidn() {
  const asset = RELEASE_ASSETS[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error(`There is no official Open Image Denoise build for ${process.platform} ${process.arch}.`);
  const installDirectory = join(VENDOR_DIRECTORY, `oidn-${OIDN_VERSION}`);
  if (existsSync(installDirectory)) return installDirectory;
  const response = await fetch(`https://github.com/RenderKit/oidn/releases/download/v${OIDN_VERSION}/${asset.name}`);
  if (!response.ok) throw new Error(`Downloading ${asset.name} failed with HTTP ${response.status}.`);
  const archiveBytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(archiveBytes).digest('hex');
  if (digest !== asset.sha256) throw new Error(`${asset.name} has SHA-256 ${digest}, not the pinned ${asset.sha256}.`);
  const staging = join(VENDOR_DIRECTORY, `staging-${process.pid}`);
  await mkdir(staging, { recursive: true });
  try {
    const archivePath = join(staging, asset.name);
    await writeFile(archivePath, archiveBytes);
    extract(archivePath, staging);
    const unpackedName = asset.name.replace(/\.(zip|tar\.gz)$/, '');
    await rename(join(staging, unpackedName), installDirectory);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return installDirectory;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(`Open Image Denoise ${OIDN_VERSION} is in ${await fetchOidn()}`);
}
