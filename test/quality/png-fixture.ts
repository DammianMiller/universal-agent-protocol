/**
 * Shared synthetic-PNG encoder for the tier suites — pure Node (zlib deflate
 * + CRC32), so tests assert exact values with no binary fixtures in the repo
 * and the decoder under test is exercised on real PNG bytes.
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import { deflateSync } from 'zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, tail]);
}

/** Encode an 8-bit RGB PNG (colour-type 2, filter none) from a pixel function. */
export function encodePng(w: number, h: number, px: (x: number, y: number) => [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolor
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const [r, g, b] = px(x, y);
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Write a synthetic PNG under `dir` and return its path. */
export function pngPath(dir: string, name: string, w: number, h: number, px: (x: number, y: number) => [number, number, number]): string {
  const path = join(dir, name);
  writeFileSync(path, encodePng(w, h, px));
  return path;
}
