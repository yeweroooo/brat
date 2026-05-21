import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createBratSvg, normalizeRenderOptions, renderBrat } from '../src/index.js';

test('renderBrat writes a square PNG', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brat-sharp-test-'));
  const out = path.join(dir, 'brat.png');

  try {
    const result = await renderBrat({
      text: 'hello brat',
      out,
      size: 512
    });

    const metadata = await sharp(out).metadata();
    assert.equal(result.path, out);
    assert.equal(result.width, 512);
    assert.equal(result.height, 512);
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.width, 512);
    assert.equal(metadata.height, 512);
    assert.ok(result.size > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('createBratSvg escapes text content', async () => {
  const svg = await createBratSvg({
    text: '<hello & brat>',
    size: 256
  });

  assert.match(svg, /&lt;hello/);
  assert.match(svg, /&amp;/);
  assert.match(svg, /brat&gt;/);
  assert.doesNotMatch(svg, /<hello & brat>/);
});

test('normalizeRenderOptions rejects invalid input', () => {
  assert.throws(() => normalizeRenderOptions({ text: '' }), /text/);
  assert.throws(() => normalizeRenderOptions({ text: 'ok', size: 128 }), /size/);
  assert.throws(() => normalizeRenderOptions({ text: 'ok', layout: 'browser' }), /layout/);
  assert.throws(() => normalizeRenderOptions({ text: 'ok', blur: 99 }), /blur/);
});
