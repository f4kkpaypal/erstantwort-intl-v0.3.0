'use strict';

const { parentPort } = require('worker_threads');
const jpeg = require('jpeg-js');

const PHOTO_MAX = 90000;
const MAX_PIXELS = 12000000;

function imageKind(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return '';
}

function halfRgba(rgba) {
  const width = Math.max(1, Math.floor(rgba.width / 2));
  const height = Math.max(1, Math.floor(rgba.height / 2));
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = ((y * 2) * rgba.width + (x * 2)) * 4;
      const to = (y * width + x) * 4;
      data[to] = rgba.data[from];
      data[to + 1] = rgba.data[from + 1];
      data[to + 2] = rgba.data[from + 2];
      data[to + 3] = 255;
    }
  }
  return { width, height, data };
}

function fit(buf, kind) {
  let rgba;
  if (kind === 'image/png') {
    const { PNG } = require('pngjs');
    const png = PNG.sync.read(buf);
    if (png.width * png.height > MAX_PIXELS) return null;
    rgba = { width: png.width, height: png.height, data: png.data };
  } else {
    const decoded = jpeg.decode(buf, {
      useTArray: true,
      formatAsRGBA: true,
      maxMemoryUsageInMB: 128,
      maxResolutionInMP: 12,
    });
    if (decoded.width * decoded.height > MAX_PIXELS) return null;
    rgba = { width: decoded.width, height: decoded.height, data: Buffer.from(decoded.data) };
  }
  let quality = 60;
  for (let step = 0; step < 8; step += 1) {
    const encoded = jpeg.encode({ data: rgba.data, width: rgba.width, height: rgba.height }, quality);
    const out = Buffer.from(encoded.data);
    if (out.length <= PHOTO_MAX && imageKind(out) === 'image/jpeg') return { mime: 'image/jpeg', buffer: out };
    if (rgba.width > 48 && rgba.height > 48) rgba = halfRgba(rgba);
    else quality = Math.max(20, quality - 15);
  }
  return null;
}

parentPort.on('message', (msg) => {
  try {
    const fitted = fit(Buffer.from(msg.buffer), msg.kind);
    if (!fitted) parentPort.postMessage({ ok: false });
    else parentPort.postMessage({ ok: true, mime: fitted.mime, buffer: fitted.buffer });
  } catch {
    parentPort.postMessage({ ok: false });
  }
});
