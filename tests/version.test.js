import test from 'node:test';
import assert from 'node:assert/strict';
import packageMetadata from '../package.json' with { type: 'json' };
import { VERSION } from '../src/index.js';

test('VERSION matches the version in package.json', () => {
  assert.equal(VERSION, packageMetadata.version, 'Set src/version.js to the version in package.json.');
});
