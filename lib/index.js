"use strict";
const AWS = require('aws-sdk');
const URI = require('urijs');
const crypto = require('crypto');

const FORMAT_HASH = /^(thumbnail|xsmall|small|medium|large|xlarge)_/;
// sharp is a peer dependency (Strapi ships it); without it we upload unconverted rather than fail.
const loadSharp = () => {
  try { return require('sharp'); } catch (e) { return null; }
};

// Mutates file to its WebP form. Returns the untouched original ({buffer, mime, ext}) or null if not converted.
// Decides on the real bytes, not file.mime: Strapi derives format files from the main file object while the provider is
// already mutating it, so a PNG buffer can arrive labelled image/webp (seen on the `small` format).
const toWebp = async (file, quality) => {
  if (!file.mime || !file.mime.startsWith('image/') || file.mime === 'image/svg+xml') return null;
  const sharp = loadSharp();
  if (!sharp) { console.warn('[upload-do] sharp not installed, uploading without webp conversion'); return null; }
  const buffer = Buffer.from(file.buffer, 'binary');
  try {
    const { format } = await sharp(buffer).metadata();
    if (format !== 'jpeg' && format !== 'png') return null; // webp, gif, svg... pass through
    const original = { buffer, mime: format === 'png' ? 'image/png' : 'image/jpeg', ext: file.ext && !file.ext.startsWith('.') ? `.${file.ext}` : file.ext };
    if (original.ext === '.webp') original.ext = format === 'png' ? '.png' : '.jpg'; // label was wrong too
    const out = await sharp(buffer).rotate().webp({ quality }).toBuffer(); // rotate(): webp drops EXIF, so bake orientation in
    file.buffer = out;
    file.mime = 'image/webp';
    file.ext = '.webp';
    if (file.name) file.name = `${file.name.replace(/\.(png|jpe?g|webp)$/i, '')}.webp`; // keep the displayed name honest
    file.size = Math.round((out.length / 1000) * 100) / 100; // Strapi stores KB
    file.sizeInBytes = out.length;
    return original;
  } catch (e) {
    console.warn(`[upload-do] webp conversion failed for ${file.name}, uploading original: ${e.message}`);
    return null;
  }
};

class FileLocationConverter {
  constructor(config) {
    this.config = config;
  }

  getKey(file, prefix = '') {
    const filename = `${prefix}${file.hash}${file.ext}`;
    if (!this.config.directory) return filename;
    return `${this.config.directory}/${filename}`;
  }

  getOriginalKey(file, ext) {
    return this.getKey({ hash: file.hash, ext }, 'originals/');
  }

  getUrl(data) {
    if (!this.config.cdn) return data.Location;
    var parts = {};
    URI.parseHost(this.config.cdn, parts);
    parts.protocol = "https"; // Force https
    parts.path = data.Key;
    return URI.build(parts);
  }
}

module.exports = {
  provider: "do",
  name: "Digital Ocean Spaces",
  auth: {
    key: {
      label: "Key",
      type: "text"
    },
    secret: {
      label: "Secret",
      type: "text"
    },
    endpoint: {
      label: "Endpoint (e.g. 'fra1.digitaloceanspaces.com')",
      type: "text",
    },
    cdn: {
      label: "CDN Endpoint (Optional - e.g. 'https://cdn.space.com')",
      type: "text",
    },
    space: {
      label: "Space (e.g. myspace)",
      type: "text",
    },
    directory: {
      label: 'Directory (Optional - e.g. directory - place when you want to save files)',
      type: 'text'
    }
  },
  init: config => {
    const endpoint = new AWS.Endpoint(config.endpoint);
    const converter = new FileLocationConverter(config);

    const S3 = new AWS.S3({
      endpoint: endpoint,
      accessKeyId: config.key,
      secretAccessKey: config.secret,
      params: {
        ACL: 'public-read',
        Bucket: config.space,
        CacheControl: 'public, max-age=31536000, immutable'
      },
    });

    const webp = config.webp !== false;
    const quality = config.webpQuality || 80;
    const keepOriginals = config.keepOriginals !== false;

    const put = (Key, Body, ContentType) => new Promise((resolve, reject) =>
      S3.upload({ Key, Body, ContentType }, (err, data) => (err ? reject(err) : resolve(data))));

    const upload = async file => {
      //--- Format files (thumbnail, small...) get no original; only the main file does.
      const isMain = !FORMAT_HASH.test(file.hash);

      //--- Compute the file key (skip if already an md5 so a re-upload keeps its key).
      if (!/^[a-f0-9]{32}$/.test(file.hash)) file.hash = crypto.createHash('md5').update(file.hash).digest("hex");

      const original = webp ? await toWebp(file, quality) : null;

      //--- Original first: if it fails the webp is not uploaded and nothing is half-linked.
      if (original && keepOriginals && isMain) {
        const key = converter.getOriginalKey(file, original.ext);
        const data = await put(key, original.buffer, original.mime);
        file.provider_metadata = { ...file.provider_metadata, original: { key, url: converter.getUrl(data), mime: original.mime, ext: original.ext } };
      }

      const data = await put(converter.getKey(file), Buffer.from(file.buffer, "binary"), file.mime);
      file.url = converter.getUrl(data);
      delete file.buffer; // Strapi persists this object, keep the raw image out of it
    };

    return {
      upload,

      uploadStream: file => new Promise((resolve, reject) => {
        const _buf = [];

        file.stream.on('data', chunk => _buf.push(chunk));
        file.stream.on('end', () => {
          file.buffer = Buffer.concat(_buf);
          resolve(upload(file));
        });
        file.stream.on('error', err => reject(err));
      }),

      delete: async file => {
        const del = Key => new Promise((resolve, reject) =>
          S3.deleteObject({ Bucket: config.space, Key }, err => (err ? reject(err) : resolve())));
        await del(converter.getKey(file));
        const original = file.provider_metadata && file.provider_metadata.original;
        if (original && original.key) await del(original.key);
      }
    }
  }
}

module.exports.toWebp = toWebp;
