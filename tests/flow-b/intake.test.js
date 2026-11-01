const test = require('node:test');
const assert = require('node:assert/strict');
const { detectMime, validateUpload, sha256Hex, decodeJsonUpload } = require('../../src/flow-b/intake.js');

const PDF = Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj\n');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const EXE = Buffer.from('MZ\x90\x00\x03\x00\x00\x00');

test('detectMime pelos magic bytes', () => {
  assert.equal(detectMime(PDF), 'application/pdf');
  assert.equal(detectMime(PNG), 'image/png');
  assert.equal(detectMime(JPG), 'image/jpeg');
  assert.equal(detectMime(WEBP), 'image/webp');
  assert.equal(detectMime(EXE), null);
  assert.equal(detectMime(Buffer.alloc(0)), null);
});

test('validateUpload aceita PDF e usa o tipo detectado, não o declarado', () => {
  const r = validateUpload({ buffer: PDF, declaredMime: 'application/octet-stream', fileName: 'nf.pdf', maxMb: 10 });
  assert.equal(r.valid, true);
  assert.equal(r.mimeType, 'application/pdf');
  assert.equal(r.isPdf, true);
  assert.equal(r.httpStatus, 200);
});

test('validateUpload rejeita executável disfarçado de PDF (415)', () => {
  const r = validateUpload({ buffer: EXE, declaredMime: 'application/pdf', fileName: 'fatura.pdf', maxMb: 10 });
  assert.equal(r.valid, false);
  assert.equal(r.httpStatus, 415);
});

test('validateUpload rejeita arquivo acima do limite (413)', () => {
  const big = Buffer.concat([PDF, Buffer.alloc(2 * 1024 * 1024)]);
  const r = validateUpload({ buffer: big, declaredMime: 'application/pdf', fileName: 'x.pdf', maxMb: 1 });
  assert.equal(r.valid, false);
  assert.equal(r.httpStatus, 413);
});

test('validateUpload rejeita ausência de arquivo (400)', () => {
  const r = validateUpload({ buffer: null, maxMb: 10 });
  assert.equal(r.valid, false);
  assert.equal(r.httpStatus, 400);
});

test('decodeJsonUpload aceita base64 puro e data URI', () => {
  const b64 = PDF.toString('base64');
  const a = decodeJsonUpload({ fileName: 'a.pdf', mimeType: 'application/pdf', base64: b64 });
  const b = decodeJsonUpload({ fileName: 'b.pdf', base64: `data:application/pdf;base64,${b64}` });
  assert.ok(a.buffer.equals(PDF));
  assert.ok(b.buffer.equals(PDF));
  assert.equal(b.declaredMime, 'application/pdf');
  assert.equal(decodeJsonUpload({}), null);
});

test('sha256Hex', () => {
  assert.equal(sha256Hex(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
