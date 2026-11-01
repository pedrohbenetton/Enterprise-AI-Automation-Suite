// Fluxo A — validação, normalização e chave de idempotência do payload de entrada.
// Este arquivo é embutido no Code node "Validate & Normalize" por scripts/build-workflows.mjs.
// Tudo abaixo do marcador "--- test exports ---" é removido no build.

const LIMITS = { message: 8000, subject: 120, name: 120, company: 160, source: 40 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const KINDS = ['lead', 'ticket'];

function cleanString(value, max) {
  if (value === undefined || value === null) return null;
  const s = String(value).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return max ? s.slice(0, max) : s;
}

function cleanMessage(value) {
  if (value === undefined || value === null) return null;
  // Preserva quebras de linha da mensagem, remove caracteres de controle
  const s = String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  return s ? s.slice(0, LIMITS.message) : null;
}

function normalizeInbound(body, nowIso) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, errors: [{ field: 'body', message: 'JSON object esperado' }], lead: null };
  }

  const email = cleanString(body.email, 254);
  const emailNorm = email ? email.toLowerCase() : null;
  if (!emailNorm || !EMAIL_RE.test(emailNorm)) {
    errors.push({ field: 'email', message: 'e-mail ausente ou inválido' });
  }

  const message = cleanMessage(body.message);
  if (!message || message.length < 3) {
    errors.push({ field: 'message', message: 'mensagem obrigatória (mín. 3 caracteres)' });
  }

  const kindRaw = cleanString(body.kind, 20);
  const kind = kindRaw ? kindRaw.toLowerCase() : 'lead';
  if (!KINDS.includes(kind)) {
    errors.push({ field: 'kind', message: `kind deve ser um de: ${KINDS.join(', ')}` });
  }

  if (errors.length) return { valid: false, errors, lead: null };

  const name = cleanString(body.name, LIMITS.name);
  const [firstName, ...rest] = name ? name.split(' ') : [null];
  const subject = cleanString(body.subject, LIMITS.subject)
    || cleanString(message.split('\n')[0], LIMITS.subject);

  return {
    valid: true,
    errors: [],
    lead: {
      kind,
      source: (cleanString(body.source, LIMITS.source) || 'api').toLowerCase(),
      email: emailNorm,
      name,
      firstName: firstName || null,
      lastName: rest.length ? rest.join(' ') : null,
      company: cleanString(body.company, LIMITS.company),
      domain: emailNorm.split('@')[1],
      phone: cleanString(body.phone, 40),
      subject,
      message,
      metadata: body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? body.metadata : {},
      receivedAt: nowIso,
    },
  };
}

function fnv1a64Hex(str) {
  // Fallback sem dependências caso o módulo crypto não esteja liberado no runner
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193 ^ 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

function hashString(str) {
  try {
    // eslint-disable-next-line global-require
    return require('crypto').createHash('sha256').update(str, 'utf8').digest('hex');
  } catch (e) {
    return fnv1a64Hex(str);
  }
}

function idempotencyKey(lead) {
  // Não inclui receivedAt: reenvios do mesmo formulário colapsam na mesma chave
  return hashString([lead.email, lead.kind, lead.subject || '', lead.message].join('|').toLowerCase());
}

// --- test exports ---
module.exports = { normalizeInbound, idempotencyKey, hashString };
