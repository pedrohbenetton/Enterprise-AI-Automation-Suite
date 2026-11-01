// Fluxo B — recepção do arquivo: tipo real (magic bytes), tamanho e hash para deduplicação.
// Embutido no Code node "Validate Upload".

const ALLOWED_MIME = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'];

function detectMime(buf) {
  if (!buf || buf.length < 4) return null;
  const hex = buf.subarray(0, 12).toString('hex');
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (hex.startsWith('89504e470d0a1a0a')) return 'image/png';
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('47494638')) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function validateUpload({ buffer, declaredMime = null, fileName = null, maxMb }) {
  const reject = (httpStatus, field, message) => ({ valid: false, httpStatus, errors: [{ field, message }] });
  if (!buffer || !buffer.length) return reject(400, 'file', 'nenhum arquivo enviado (multipart "file" ou JSON {fileName, base64})');

  const maxBytes = Math.round(Number(maxMb) * 1024 * 1024);
  if (buffer.length > maxBytes) return reject(413, 'file', `arquivo excede ${maxMb} MB`);

  // O tipo declarado pelo cliente não é confiável: vale o conteúdo
  const mimeType = detectMime(buffer);
  if (!mimeType || !ALLOWED_MIME.includes(mimeType)) {
    return reject(415, 'file', `tipo não suportado (declarado: ${declaredMime || 'n/a'}). Aceitos: PDF, PNG, JPEG, WEBP, GIF`);
  }

  return {
    valid: true,
    httpStatus: 200,
    errors: [],
    mimeType,
    declaredMime,
    isPdf: mimeType === 'application/pdf',
    fileName: fileName ? String(fileName).slice(0, 255) : `upload.${mimeType.split('/')[1]}`,
    sizeBytes: buffer.length,
  };
}

function decodeJsonUpload(body) {
  if (!body || typeof body !== 'object' || typeof body.base64 !== 'string' || !body.base64) return null;
  let b64 = body.base64.trim();
  let declaredMime = body.mimeType || null;
  const m = /^data:([\w/+.-]+);base64,(.*)$/s.exec(b64);
  if (m) {
    declaredMime = declaredMime || m[1];
    b64 = m[2];
  }
  return { buffer: Buffer.from(b64, 'base64'), declaredMime, fileName: body.fileName || null };
}

function sha256Hex(buffer) {
  // crypto é liberado via NODE_FUNCTION_ALLOW_BUILTIN=crypto (docker-compose.yml)
  // eslint-disable-next-line global-require
  return require('crypto').createHash('sha256').update(buffer).digest('hex');
}

// --- test exports ---
module.exports = { ALLOWED_MIME, detectMime, validateUpload, decodeJsonUpload, sha256Hex };
