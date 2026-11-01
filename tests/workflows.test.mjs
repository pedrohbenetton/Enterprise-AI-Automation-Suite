// Valida os JSONs exportáveis: sincronia com o build, integridade estrutural e
// execução simulada dos Code nodes do Fluxo A (código embutido, não os módulos-fonte).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { buildAll } from '../scripts/build-workflows.mjs';
import { createSimulator } from './helpers/n8n-sim.mjs';

const outputs = await buildAll();

test('JSONs versionados estão sincronizados com o build', () => {
  assert.ok(outputs.length >= 2);
  for (const { file, content } of outputs) {
    assert.ok(existsSync(file), `${file} não existe — rode npm run build`);
    assert.equal(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), content, `${file} desatualizado`);
    JSON.parse(content);
  }
});

for (const { workflow } of outputs) {
  test(`estrutura válida: ${workflow.name}`, () => {
    const names = workflow.nodes.map((n) => n.name);
    const ids = workflow.nodes.map((n) => n.id);
    assert.equal(new Set(names).size, names.length, 'nomes de nós duplicados');
    assert.equal(new Set(ids).size, ids.length, 'ids de nós duplicados');

    for (const n of workflow.nodes) {
      assert.match(n.type, /^n8n-nodes-base\./);
      assert.equal(typeof n.typeVersion, 'number');
      assert.ok(Array.isArray(n.position) && n.position.length === 2);
    }

    const byName = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));
    for (const [from, { main }] of Object.entries(workflow.connections)) {
      assert.ok(byName[from], `conexão de nó inexistente: ${from}`);
      if (byName[from].type === 'n8n-nodes-base.if') assert.ok(main.length <= 2);
      for (const branch of main) for (const c of branch) assert.ok(byName[c.node], `conexão para nó inexistente: ${c.node}`);
    }

    // Todo nó (exceto sticky notes e o gatilho) precisa ser alcançável
    const targets = new Set(Object.values(workflow.connections).flatMap(({ main }) => main.flat().map((c) => c.node)));
    for (const n of workflow.nodes) {
      if (n.type === 'n8n-nodes-base.stickyNote' || /webhook$|errorTrigger$/.test(n.type)) continue;
      assert.ok(targets.has(n.name), `nó órfão: ${n.name}`);
    }

    // Credenciais: só referências por nome, nunca valores
    assert.doesNotMatch(JSON.stringify(workflow), /sk-ant-|xoxb-|pat-na1-/);
  });

  test(`Code nodes compilam: ${workflow.name}`, () => {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    for (const n of workflow.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
      assert.doesNotThrow(() => new AsyncFunction('$json', '$', '$input', 'require', n.parameters.jsCode), n.name);
    }
  });
}

// ---------------------------------------------------------------------------
// Simulação do Fluxo A executando o jsCode embutido de cada Code node
// ---------------------------------------------------------------------------
const flowA = outputs.find((o) => o.workflow.name.startsWith('01')).workflow;

const CONFIG = {
  urgencyThreshold: 0.75, llmPrimaryModel: 'claude-sonnet-5-5', llmFallbackModel: 'claude-haiku-5-5', llmTimeoutMs: 30000,
  slackChannelCritical: '#leads-criticos', slackChannelDefault: '#leads-inbound', slackChannelOps: '#automation-ops',
  hubspotTicketPipeline: '0', hubspotTicketStage: '1', hubspotDealPipeline: 'default', hubspotDealStage: 'appointmentscheduled',
  enrichmentApiUrl: '',
};

const simulator = () => createSimulator(flowA, { 'Load Config': { config: CONFIG } });

const toolUse = (input) => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', name: 'classify_inbound', input }],
});

function runUntilClassification(sim, body) {
  const v = sim.run('Validate & Normalize', { body });
  assert.equal(v.valid, true);
  const h = sim.run('Heuristic Enrichment', {});
  const m = sim.run('Merge Enrichment', h);
  return sim.run('Build LLM Request', m);
}

test('simulação: caminho feliz (LLM primária + HubSpot + Slack)', () => {
  const sim = simulator();
  const req = runUntilClassification(sim, {
    kind: 'ticket', email: 'cto@bigcorp.com', name: 'Carla Dias', subject: 'API fora do ar', message: 'Nossa integração parou às 9h, urgente.',
  });
  assert.equal(req.llm.primary.model, 'claude-sonnet-5-5');

  const p = sim.run('Parse Primary', toolUse({
    sentiment: 'negative', urgency_score: 0.9, category: 'technical_issue', summary: 'API parada.', suggested_reply: 'Estamos atuando.',
  }));
  assert.equal(p.result.ok, true);

  const f = sim.run('Finalize Triage', p);
  assert.equal(f.triage.priority, 'P1');
  assert.equal(f.llm, undefined);

  const crm = sim.run('Prepare CRM Object', { results: [{ id: '501' }] });
  assert.equal(crm.crmObject.objectType, 'tickets');
  sim.set('HubSpot Create Ticket/Deal', { id: '9001' });
  const s = sim.run('Prepare Slack Message', { id: '9001' });
  assert.equal(s.slack.channel, '#leads-criticos');
  sim.set('Slack Notify', { ok: true, ts: '1730000000.0001' });

  const a = sim.run('Build Audit Record', {});
  assert.equal(a.record.status, 'processed');
  assert.equal(a.record.hubspot_object_id, '9001');
  assert.equal(a.record.slack_message_ts, '1730000000.0001');
  assert.equal(a.degraded, false);
});

test('simulação: ambas LLMs falham -> regras; HubSpot falha -> partial + alerta', () => {
  const sim = simulator();
  runUntilClassification(sim, {
    kind: 'ticket', email: 'joao@gmail.com', subject: 'Cancelamento', message: 'Quero cancelar, cobrança indevida, péssimo.',
  });
  const p = sim.run('Parse Primary', { error: { message: '529 overloaded_error' } });
  assert.equal(p.result.ok, false);
  const fb = sim.run('Parse Fallback', { error: { message: 'timeout of 30000ms exceeded' } });
  assert.equal(fb.result.ok, false);
  assert.equal(fb.result.llmErrors.length, 2);

  const r = sim.run('Rule-based Classifier', fb);
  assert.equal(r.result.classifier, 'rules');
  assert.equal(r.result.classification.category, 'churn_risk');

  sim.run('Finalize Triage', r);
  const crm = sim.run('Prepare CRM Object', { error: { message: '401 - Authentication credentials not found' } });
  assert.equal(crm.contactId, null);
  assert.equal(crm.crmObject.body.associations, undefined);
  sim.run('Prepare Slack Message', { id: '777' });
  sim.set('Slack Notify', { ok: false, error: 'channel_not_found' });

  const a = sim.run('Build Audit Record', {});
  assert.equal(a.record.status, 'partial');
  assert.equal(a.record.classifier, 'rules');
  assert.equal(a.record.slack_message_ts, null);
  assert.equal(a.degraded, true);
  assert.match(a.opsAlertText, /overloaded/);
  assert.match(a.opsAlertText, /hubspot_contact/);
  assert.match(a.opsAlertText, /channel_not_found/);
});

test('simulação: spam pula CRM/Slack e audita mesmo assim', () => {
  const sim = simulator();
  runUntilClassification(sim, { email: 'promo@seo-agency.biz', message: 'Ofertas de SEO e backlink baratos!' });
  const p = sim.run('Parse Primary', toolUse({
    sentiment: 'neutral', urgency_score: 0, category: 'spam', summary: 'Spam de SEO.', suggested_reply: '-',
  }));
  const f = sim.run('Finalize Triage', p);
  assert.equal(f.triage.isSpam, true);
  const a = sim.run('Build Audit Record', f);
  assert.equal(a.record.priority, 'P4');
  assert.equal(a.record.hubspot_contact_id, null);
  assert.equal(a.record.status, 'processed');
});

test('simulação: payload inválido não segue adiante', () => {
  const sim = simulator();
  const v = sim.run('Validate & Normalize', { body: { email: 'x', message: '' } });
  assert.equal(v.valid, false);
  assert.equal(v.idempotencyKey, null);
});
