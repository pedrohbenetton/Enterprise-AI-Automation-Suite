const test = require('node:test');
const assert = require('node:assert/strict');
const { heuristicEnrichment, mergeEnrichment, sizeTier } = require('../../src/flow-a/enrichment.js');

test('heurística identifica e-mail gratuito', () => {
  const e = heuristicEnrichment({ domain: 'gmail.com', company: null });
  assert.equal(e.isFreeEmail, true);
  assert.equal(e.isCorporate, false);
  assert.equal(e.companyName, null);
  assert.equal(e.source, 'heuristic');
});

test('heurística deriva empresa e país do domínio corporativo', () => {
  const e = heuristicEnrichment({ domain: 'acme-logistica.com.br', company: null });
  assert.equal(e.isCorporate, true);
  assert.equal(e.companyName, 'Acme Logistica');
  assert.equal(e.country, 'BR');
});

test('heurística prefere empresa informada no formulário', () => {
  const e = heuristicEnrichment({ domain: 'acme.com', company: 'ACME Corp' });
  assert.equal(e.companyName, 'ACME Corp');
});

test('merge usa resposta da API quando válida (formato estilo Clearbit)', () => {
  const base = heuristicEnrichment({ domain: 'acme.com', company: null });
  const merged = mergeEnrichment(base, {
    name: 'ACME Inc.',
    category: { industry: 'Logistics' },
    metrics: { employees: 1200 },
    geo: { countryCode: 'US' },
  });
  assert.equal(merged.source, 'api');
  assert.equal(merged.companyName, 'ACME Inc.');
  assert.equal(merged.industry, 'Logistics');
  assert.equal(merged.employees, 1200);
  assert.equal(merged.sizeTier, 'enterprise');
  assert.equal(merged.country, 'US');
});

test('merge faz fallback para heurística quando a API falha', () => {
  const base = heuristicEnrichment({ domain: 'acme.com', company: null });
  const merged = mergeEnrichment(base, { error: { message: 'timeout of 5000ms exceeded' } });
  assert.equal(merged.source, 'heuristic');
  assert.match(merged.fallbackReason, /timeout/);
  assert.equal(merged.companyName, 'Acme');
});

test('merge ignora resposta vazia sem marcar erro', () => {
  const base = heuristicEnrichment({ domain: 'acme.com', company: null });
  const merged = mergeEnrichment(base, {});
  assert.equal(merged.source, 'heuristic');
});

test('sizeTier', () => {
  assert.equal(sizeTier(null), 'unknown');
  assert.equal(sizeTier(15), 'smb');
  assert.equal(sizeTier(250), 'mid_market');
  assert.equal(sizeTier(5000), 'enterprise');
});
