const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.codePointAt(i);
    if (cp > 0xffff) i++;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return out;
}

function fromUtf8(bytes) {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    let cp;
    if (b < 0x80) { cp = b; i += 1; }
    else if ((b & 0xe0) === 0xc0) { cp = ((b & 31) << 6) | (bytes[i + 1] & 63); i += 2; }
    else if ((b & 0xf0) === 0xe0) { cp = ((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63); i += 3; }
    else { cp = ((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63); i += 4; }
    out += String.fromCodePoint(cp);
  }
  return out;
}

function encode(str) {
  const bytes = utf8Bytes(String(str));
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    out += A[b0 >> 2];
    out += A[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
    out += b1 === undefined ? '=' : A[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
    out += b2 === undefined ? '=' : A[b2 & 63];
  }
  return out;
}

function decode(b64) {
  if (typeof b64 !== 'string') throw new Error('not a string');
  if (b64.length % 4 !== 0) throw new Error('length must be a multiple of 4');
  if (b64 === '') return '';
  const body = b64.replace(/=+$/, '');
  const pad = b64.length - body.length;
  if (pad > 2) throw new Error('too much padding');
  for (const ch of body) if (A.indexOf(ch) === -1) throw new Error('invalid base64 character: ' + ch);
  const bytes = [];
  for (let i = 0; i < body.length; i += 4) {
    const c = [0, 1, 2, 3].map((k) => A.indexOf(body[i + k]));
    bytes.push(((c[0] << 2) | (c[1] >> 4)) & 255);
    if (c[2] !== -1) bytes.push(((c[1] << 4) | (c[2] >> 2)) & 255);
    if (c[3] !== -1) bytes.push(((c[2] << 6) | c[3]) & 255);
  }
  return fromUtf8(bytes);
}

module.exports = { encode, decode };
