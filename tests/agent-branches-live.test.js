import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Runs the real MCP server on SwiftShader: branches and review leave the revision, recipe and source image untouched.
// It needs the prepared preview bundle (npm run prepare:release) and ffmpeg to decode PNGs, so it skips without them.
const preview = fileURLToPath(new URL('../build/mcp/preview.js', import.meta.url));
const smoke = fileURLToPath(new URL('../scripts/smoke-agent-branches.mjs', import.meta.url));
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;

test('live MCP branches do not consume revisions or change the scene being edited', {
  skip: !existsSync(preview) || !hasFfmpeg ? 'needs build/mcp (prepare:release) and ffmpeg' : false,
  timeout: 240000,
}, () => {
  const result = spawnSync(process.execPath, [smoke], { encoding: 'utf8', windowsHide: true, timeout: 230000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Branch smoke passed/);
});
