import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTextureSet } from '../src/texture-set.js';

function fakeFetch(available) {
  const requested = [];
  const fetchBlob = async (url) => {
    requested.push(url);
    const channel = url.split('/').pop().split('.')[0];
    if (!available.includes(channel)) throw new Error(`Texture request failed with status 404: ${url}`);
    return { channel };
  };
  return { requested, fetchBlob };
}

const decodeBlob = async blob => ({ width: 4, height: 4, channel: blob.channel });

test('loads every channel with the right color spaces', async () => {
  const { requested, fetchBlob } = fakeFetch(['color', 'normal', 'roughness', 'height']);
  const set = await loadTextureSet('/textures/leafy_grass/', { fetchBlob, decodeBlob });
  assert.deepEqual(Object.keys(set).sort(), ['color', 'height', 'normal', 'roughness']);
  assert.equal(set.color.colorSpace, 'srgb');
  for (const channel of ['normal', 'roughness', 'height']) assert.equal(set[channel].colorSpace, 'linear');
  assert.equal(set.normal.image.channel, 'normal');
  assert.ok(requested.includes('/textures/leafy_grass/color.webp'));
});

test('skips channels that do not exist unless they were requested by name', async () => {
  const { fetchBlob } = fakeFetch(['color', 'normal', 'roughness']);
  const set = await loadTextureSet('/textures/pine_bark', { fetchBlob, decodeBlob });
  assert.equal(set.height, undefined);
  await assert.rejects(loadTextureSet('/textures/pine_bark', { channels: ['color', 'height'], fetchBlob, decodeBlob }), /404/);
});

test('rejects unknown channels, empty lists and sets with nothing', async () => {
  const { fetchBlob } = fakeFetch([]);
  await assert.rejects(loadTextureSet('/x', { channels: ['metalness'], fetchBlob, decodeBlob }), /Unknown texture channel/);
  await assert.rejects(loadTextureSet('/x', { channels: [], fetchBlob, decodeBlob }), /non-empty/);
  await assert.rejects(loadTextureSet('/x', { fetchBlob, decodeBlob }), /No texture channels/);
  await assert.rejects(loadTextureSet('', { fetchBlob, decodeBlob }), /baseUrl/);
});

test('a color space override applies to its channel', async () => {
  const { fetchBlob } = fakeFetch(['color']);
  const set = await loadTextureSet('/x', { channels: ['color'], colorSpaces: { color: 'linear' }, fetchBlob, decodeBlob });
  assert.equal(set.color.colorSpace, 'linear');
});
