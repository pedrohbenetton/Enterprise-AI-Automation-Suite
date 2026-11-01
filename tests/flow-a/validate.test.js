const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeInbound, idempotencyKey, hashString } = require('../../src/flow-a/validate.js');

const NOW = '2026-10-31T12:00:00.000Z';

test('normaliza payload válido e aplica defaults', () => {
  const r = normalizeInbound({
    email: '  Ana.Souza@ACME.com.br ',
    name: 'Ana Maria Souza',
    message: 'Gostaria de uma demo da plataforma para 300 usuários.',
  }, NOW);

  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
  assert.equal(r.lead.email, 'ana.souza@acme.com.br');
  assert.equal(r.lead.domain, 'acme.com.br');
  assert.equal(r.lead.kind, 'lead');
  assert.equal(r.lead.source, 'api');
  assert.equal(r.lead.firstName, 'Ana');
  assert.equal(r.lead.lastName, 'Maria Souza');
  assert.equal(r.lead.subject, 'Gostaria de uma demo da plataforma para 300 usuários.');
  assert.equal(r.lead.receivedAt, NOW);
});

test('rejeita e-mail inválido, mensagem vazia e kind desconhecido', () => {
  const r = normalizeInbound({ email: 'sem-arroba', message: ' ', kind: 'pedido' }, NOW);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.field === 'email'));
  assert.ok(r.errors.some((e) => e.field === 'message'));
  assert.ok(r.errors.some((e) => e.field === 'kind'));
});

test('rejeita body ausente ou não-objeto', () => {
  assert.equal(normalizeInbound(null, NOW).valid, false);
  assert.equal(normalizeInbound('texto', NOW).valid, false);
  assert.equal(normalizeInbound([1, 2], NOW).valid, false);
});

test('trunca mensagem longa e assunto derivado', () => {
  const r = normalizeInbound({ email: 'a@b.co', message: 'x'.repeat(20000) }, NOW);
  assert.equal(r.valid, true);
  assert.equal(r.lead.message.length, 8000);
  assert.ok(r.lead.subject.length <= 120);
});

test('idempotencyKey é determinística e sensível ao conteúdo', () => {
  const a = normalizeInbound({ email: 'A@b.co', subject: 'Oi', message: 'Teste 1' }, NOW).lead;
  const b = normalizeInbound({ email: 'a@b.co ', subject: 'Oi', message: 'Teste 1' }, '2026-11-01T00:00:00Z').lead;
  const c = normalizeInbound({ email: 'a@b.co', subject: 'Oi', message: 'Teste 2' }, NOW).lead;
  assert.equal(idempotencyKey(a), idempotencyKey(b));
  assert.notEqual(idempotencyKey(a), idempotencyKey(c));
  assert.match(idempotencyKey(a), /^[0-9a-f]{16,64}$/);
});

test('hashString produz sha256 hex', () => {
  assert.equal(
    hashString('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});
