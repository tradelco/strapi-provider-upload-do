const assert = require('assert');
const sharp = require('sharp');
const { toWebp } = require('./lib');

(async () => {
  const png = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#f00' } }).png().toBuffer();
  const file = { name: 'a.png', mime: 'image/png', ext: '.png', buffer: png, size: 0 };
  const orig = await toWebp(file, 80);
  assert.equal(file.mime, 'image/webp');
  assert.equal(file.ext, '.webp');
  assert.equal(file.buffer.slice(8, 12).toString(), 'WEBP');
  assert.equal(orig.ext, '.png');
  assert.ok(orig.buffer.equals(png), 'original untouched');

  const svg = { name: 'a.svg', mime: 'image/svg+xml', ext: '.svg', buffer: Buffer.from('<svg/>') };
  assert.equal(await toWebp(svg, 80), null);
  assert.equal(svg.ext, '.svg');

  const bad = { name: 'b.png', mime: 'image/png', ext: '.png', buffer: Buffer.from('not an image') };
  assert.equal(await toWebp(bad, 80), null);
  assert.equal(bad.ext, '.png');
  console.log('ok');
})();

// full provider flow with a stubbed S3: uploadStream path, original linking, buffer cleanup, delete
(async () => {
  const AWS = require('aws-sdk');
  const { Readable } = require('stream');
  const calls = [];
  AWS.S3.prototype.upload = function (p, cb) { calls.push(p.Key); cb(null, { Key: p.Key, Location: 'loc/' + p.Key }); };
  AWS.S3.prototype.deleteObject = function (p, cb) { calls.push('del:' + p.Bucket + ':' + p.Key); cb(null, {}); };
  const prov = require('./lib').init({ endpoint: 'e.example.com', key: 'k', secret: 's', space: 'sp', cdn: 'cdn.example.com' });
  const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#00f' } }).png().toBuffer();
  const main = { name: 'a.png', hash: 'slug.', ext: '.png', mime: 'image/png', stream: Readable.from([png]) };
  await prov.uploadStream(main);
  assert.ok(main.url.endsWith('.webp') && main.ext === '.webp');
  assert.equal(main.buffer, undefined, 'buffer removed');
  assert.ok(main.provider_metadata.original.key.startsWith('originals/') && main.provider_metadata.original.ext === '.png');
  const thumb = { name: 't.png', hash: 'thumbnail_slug.', ext: '.png', mime: 'image/png', buffer: png };
  await prov.upload(thumb);
  assert.equal(thumb.provider_metadata, undefined, 'formats get no original');
  await prov.delete(main);
  assert.deepEqual(calls.filter(c => c.startsWith('del:')).length, 2);
  const nodot = { name: 'n.png', hash: 'nodot.', ext: 'png', mime: 'image/png', buffer: png };
  await prov.upload(nodot);
  assert.ok(nodot.provider_metadata.original.key.endsWith('.png'), 'original key keeps a dot');
  console.log('flow ok');
})();
