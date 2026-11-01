const test = require('node:test');
const assert = require('node:assert/strict');
const {
  finalizeTriage,
  buildContactUpsert,
  extractContactId,
  buildCrmObject,
  buildSlackMessage,
  buildAuditRecord,
  describeError,
} = require('../../src/flow-a/routing.js');

const cfg = {
  urgencyThreshold: 0.75,
  slackChannelCritical: '#leads-criticos',
  slackChannelDefault: '#leads-inbound',
  hubspotTicketPipeline: '0',
  hubspotTicketStage: '1',
  hubspotDealPipeline: 'default',
  hubspotDealStage: 'appointmentscheduled',
};

const lead = {
  kind: 'ticket', source: 'form', email: 'ops@acme.com', name: 'Joana Lima', firstName: 'Joana', lastName: 'Lima',
  company: null, domain: 'acme.com', subject: 'Sistema fora do ar', message: 'Fora do ar.',
  receivedAt: '2026-10-31T12:00:00.000Z', metadata: {},
};
const enrichment = { source: 'api', companyName: 'Acme', sizeTier: 'enterprise', employees: 1500, isCorporate: true };

const classification = (over = {}) => ({
  sentiment: 'negative', urgency_score: 0.8, category: 'technical_issue',
  summary: 'Indisponibilidade.', suggested_reply: 'Estamos verificando.', language: 'pt', ...over,
});

test('finalizeTriage: enterprise + negativo + urgente => P1 no canal crítico', () => {
  const t = finalizeTriage({ lead, enrichment, result: { classification: classification(), classifier: 'llm_primary' }, cfg });
  assert.equal(t.priority, 'P1');
  assert.equal(t.slackChannel, '#leads-criticos');
  assert.equal(t.classifier, 'llm_primary');
  assert.ok(t.score <= 1);
});

test('finalizeTriage: lead positivo de baixa urgência => P3/P4 no canal padrão', () => {
  const t = finalizeTriage({
    lead: { ...lead, kind: 'lead' },
    enrichment: { ...enrichment, sizeTier: 'smb' },
    result: { classification: classification({ sentiment: 'positive', urgency_score: 0.3, category: 'demo_request' }), classifier: 'rules' },
    cfg,
  });
  assert.ok(['P3', 'P4'].includes(t.priority));
  assert.equal(t.slackChannel, '#leads-inbound');
});

test('finalizeTriage: spam vira P4 e pula CRM', () => {
  const t = finalizeTriage({
    lead, enrichment, result: { classification: classification({ category: 'spam', urgency_score: 0.9 }), classifier: 'llm_fallback' }, cfg,
  });
  assert.equal(t.priority, 'P4');
  assert.equal(t.isSpam, true);
});

test('buildContactUpsert usa e-mail como idProperty', () => {
  const b = buildContactUpsert(lead, enrichment);
  assert.equal(b.inputs[0].idProperty, 'email');
  assert.equal(b.inputs[0].id, 'ops@acme.com');
  assert.equal(b.inputs[0].properties.firstname, 'Joana');
  assert.equal(b.inputs[0].properties.company, 'Acme');
});

test('extractContactId tolera erro', () => {
  assert.equal(extractContactId({ results: [{ id: '123' }] }), '123');
  assert.equal(extractContactId({ error: { message: '401' } }), null);
  assert.equal(extractContactId(undefined), null);
});

test('buildCrmObject: ticket associado ao contato', () => {
  const triage = finalizeTriage({ lead, enrichment, result: { classification: classification(), classifier: 'llm_primary' }, cfg });
  const o = buildCrmObject({ lead, triage, contactId: '123', cfg });
  assert.equal(o.objectType, 'tickets');
  assert.equal(o.body.properties.hs_pipeline, '0');
  assert.equal(o.body.properties.hs_ticket_priority, 'HIGH');
  assert.equal(o.body.associations[0].to.id, '123');
  assert.equal(o.body.associations[0].types[0].associationTypeId, 16);
});

test('buildCrmObject: deal sem contato não envia associations', () => {
  const l = { ...lead, kind: 'lead' };
  const triage = finalizeTriage({ lead: l, enrichment, result: { classification: classification({ category: 'demo_request' }), classifier: 'rules' }, cfg });
  const o = buildCrmObject({ lead: l, triage, contactId: null, cfg });
  assert.equal(o.objectType, 'deals');
  assert.equal(o.body.properties.pipeline, 'default');
  assert.equal(o.body.associations, undefined);
});

test('buildSlackMessage contém prioridade, fallback e escapa mrkdwn', () => {
  const triage = finalizeTriage({ lead, enrichment, result: { classification: classification(), classifier: 'rules' }, cfg });
  const m = buildSlackMessage({ lead: { ...lead, subject: '<script>&' }, enrichment, triage, crmObjectId: '999' });
  assert.equal(m.channel, '#leads-criticos');
  assert.match(m.text, /P1/);
  const blob = JSON.stringify(m.blocks);
  assert.match(blob, /&lt;script&gt;&amp;/);
  assert.match(blob, /regras/i);
  assert.match(blob, /999/);
});

test('buildAuditRecord marca partial quando alguma integração falha', () => {
  const triage = finalizeTriage({ lead, enrichment, result: { classification: classification(), classifier: 'llm_primary' }, cfg });
  const rec = buildAuditRecord({
    lead, enrichment, triage, idempotencyKey: 'k1', payload: { a: 1 },
    contactId: '1', crmObjectId: null, slackTs: '1730.1', integrationErrors: ['hubspot_object: 400'],
    startedAt: '2026-10-31T12:00:00.000Z', now: '2026-10-31T12:00:02.500Z',
  });
  assert.equal(rec.status, 'partial');
  assert.equal(rec.processing_ms, 2500);
  assert.equal(rec.idempotency_key, 'k1');
  assert.equal(rec.priority, 'P1');
  assert.equal(rec.classifier, 'llm_primary');
});

test('describeError cobre erro do nó HTTP, Slack ok:false e sucesso', () => {
  assert.match(describeError({ error: { message: '401 Unauthorized' } }), /401/);
  assert.equal(describeError({ ok: false, error: 'channel_not_found' }), 'slack_api: channel_not_found');
  assert.equal(describeError({ ok: true, ts: '1.2' }), null);
  assert.equal(describeError({ id: '55' }), null);
  assert.equal(describeError(null), 'sem resposta');
});

test('buildAuditRecord marca processed quando tudo deu certo', () => {
  const triage = finalizeTriage({ lead, enrichment, result: { classification: classification(), classifier: 'llm_primary' }, cfg });
  const rec = buildAuditRecord({
    lead, enrichment, triage, idempotencyKey: 'k1', payload: {}, contactId: '1', crmObjectId: '2', slackTs: '3',
    integrationErrors: [], startedAt: lead.receivedAt, now: lead.receivedAt,
  });
  assert.equal(rec.status, 'processed');
});
