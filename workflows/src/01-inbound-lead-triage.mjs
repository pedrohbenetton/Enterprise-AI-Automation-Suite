// Fluxo A — Triagem e resposta inteligente de inbound leads / tickets.
// Webhook -> validação/idempotência -> enriquecimento -> LLM (primária -> fallback -> regras)
// -> HubSpot (contato + ticket/deal) -> Slack -> auditoria no Postgres -> alerta de degradação.
//
// Toda execução nasce de UM item de webhook, então os Code nodes usam $('Nó').first()
// para ler contexto de nós anteriores (robusto mesmo através de nós que não propagam pairedItem).

import {
  createWorkflow, ifBoolean, respondJson, httpJson, RESILIENT, CREDS, AUTH, deterministicUuid,
} from './lib.mjs';

const WF = '01 - Inbound Lead & Ticket Triage';
const M = {
  validate: 'src/flow-a/validate.js',
  enrichment: 'src/flow-a/enrichment.js',
  classification: 'src/flow-a/classification.js',
  routing: 'src/flow-a/routing.js',
};
const CFG = "$('Load Config').first().json.config";
const ANTHROPIC_HEADERS = [{ name: 'anthropic-version', value: '2023-06-01' }];

export default function build() {
  const w = createWorkflow(WF);

  // ------------------------------------------------------------------ entrada
  const webhook = w.add('Webhook Inbound', 'n8n-nodes-base.webhook', 2, [0, 300], {
    httpMethod: 'POST',
    path: 'inbound-lead',
    authentication: 'headerAuth',
    responseMode: 'responseNode',
    options: {},
  }, { webhookId: deterministicUuid(`${WF}:webhook`), credentials: CREDS.webhookAuth });

  const config = w.add('Load Config', 'n8n-nodes-base.set', 3.4, [220, 300], {
    mode: 'manual',
    assignments: {
      assignments: [{
        id: deterministicUuid(`${WF}:config`),
        name: 'config',
        type: 'object',
        value: `={{ {
  urgencyThreshold: Number($env.TRIAGE_URGENCY_THRESHOLD || 0.75),
  llmPrimaryModel: $env.LLM_PRIMARY_MODEL || 'claude-sonnet-5-5',
  llmFallbackModel: $env.LLM_FALLBACK_MODEL || 'claude-haiku-5-5',
  llmTimeoutMs: Number($env.LLM_TIMEOUT_MS || 30000),
  slackChannelCritical: $env.SLACK_CHANNEL_CRITICAL || '#leads-criticos',
  slackChannelDefault: $env.SLACK_CHANNEL_DEFAULT || '#leads-inbound',
  slackChannelOps: $env.SLACK_CHANNEL_OPS || '#automation-ops',
  hubspotTicketPipeline: $env.HUBSPOT_TICKET_PIPELINE || '0',
  hubspotTicketStage: $env.HUBSPOT_TICKET_STAGE || '1',
  hubspotDealPipeline: $env.HUBSPOT_DEAL_PIPELINE || 'default',
  hubspotDealStage: $env.HUBSPOT_DEAL_STAGE || 'appointmentscheduled',
  enrichmentApiUrl: $env.ENRICHMENT_API_URL || ''
} }}`,
      }],
    },
    includeOtherFields: true,
    options: {},
  });

  const validate = w.code('Validate & Normalize', [440, 300], {
    modules: [M.validate],
    entry: `
const result = normalizeInbound($json.body, new Date().toISOString());
return {
  json: {
    ...result,
    idempotencyKey: result.valid ? idempotencyKey(result.lead) : null,
    payload: $json.body ?? null,
  },
};`,
  });

  const isValid = w.add('Is Valid?', 'n8n-nodes-base.if', 2.2, [660, 300],
    ifBoolean(deterministicUuid(`${WF}:isValid`), '={{ $json.valid }}'));

  const respond400 = w.add('Respond 400 Invalid', 'n8n-nodes-base.respondToWebhook', 1.1, [880, 480],
    respondJson('={{ JSON.stringify({ status: "rejected", errors: $json.errors }) }}', 400));

  // Redis INCR é atômico: o 1º request recebe 1, reenvios recebem >1 (TTL 24h).
  // Se o Redis cair, o item segue com { error } e o fluxo processa (fail-open);
  // a UNIQUE(idempotency_key) no Postgres segura duplicatas na auditoria.
  const lock = w.add('Idempotency Lock (Redis)', 'n8n-nodes-base.redis', 1, [880, 200], {
    operation: 'incr',
    key: '=triage:idem:{{ $json.idempotencyKey }}',
    expire: true,
    ttl: 86400,
  }, { credentials: CREDS.redis, ...RESILIENT(2, 500) });

  const isDuplicate = w.add('Is Duplicate?', 'n8n-nodes-base.if', 2.2, [1100, 200], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [{
        id: deterministicUuid(`${WF}:isDuplicate`),
        leftValue: "={{ Number($json['triage:idem:' + $('Validate & Normalize').first().json.idempotencyKey] ?? 1) }}",
        rightValue: 1,
        operator: { type: 'number', operation: 'gt' },
      }],
      combinator: 'and',
    },
    looseTypeValidation: true,
    options: {},
  });

  const respondDup = w.add('Respond 200 Duplicate', 'n8n-nodes-base.respondToWebhook', 1.1, [1320, 40],
    respondJson("={{ JSON.stringify({ status: 'duplicate', idempotencyKey: $('Validate & Normalize').first().json.idempotencyKey }) }}", 200));

  // Responde cedo: o chamador (formulário/CRM/chat) não espera a LLM.
  const respond202 = w.add('Respond 202 Accepted', 'n8n-nodes-base.respondToWebhook', 1.1, [1320, 200],
    respondJson("={{ JSON.stringify({ status: 'accepted', idempotencyKey: $('Validate & Normalize').first().json.idempotencyKey, receivedAt: $('Validate & Normalize').first().json.lead.receivedAt }) }}", 202));

  // ------------------------------------------------------------ enriquecimento
  const heuristic = w.code('Heuristic Enrichment', [1540, 200], {
    modules: [M.enrichment],
    entry: `
const v = $('Validate & Normalize').first().json;
const cfg = ${CFG};
const enrichment = heuristicEnrichment(v.lead);
return {
  json: {
    lead: v.lead,
    idempotencyKey: v.idempotencyKey,
    payload: v.payload,
    startedAt: v.lead.receivedAt,
    enrichment,
    useExternal: Boolean(cfg.enrichmentApiUrl) && enrichment.isCorporate,
    enrichmentUrl: cfg.enrichmentApiUrl,
  },
};`,
  });

  const useExternal = w.add('Use External Enrichment?', 'n8n-nodes-base.if', 2.2, [1760, 200],
    ifBoolean(deterministicUuid(`${WF}:useExternal`), '={{ $json.useExternal }}'));

  const enrichApi = w.add('Enrichment API', 'n8n-nodes-base.httpRequest', 4.2, [1980, 80], httpJson({
    method: 'GET',
    url: '={{ $json.enrichmentUrl }}',
    auth: AUTH.headerCred,
    query: [{ name: 'domain', value: '={{ $json.enrichment.domain }}' }],
    timeout: 5000,
  }), { credentials: CREDS.enrichment, ...RESILIENT(2, 1000) });

  const mergeEnrich = w.code('Merge Enrichment', [2200, 200], {
    modules: [M.enrichment],
    entry: `
const ctx = $('Heuristic Enrichment').first().json;
const enrichment = ctx.useExternal ? mergeEnrichment(ctx.enrichment, $json) : ctx.enrichment;
const { useExternal, enrichmentUrl, ...rest } = ctx;
return { json: { ...rest, enrichment } };`,
  });

  // ------------------------------------------------------------- classificação
  const buildReq = w.code('Build LLM Request', [2420, 200], {
    modules: [M.classification],
    entry: `
const cfg = ${CFG};
const body = (model) => buildAnthropicBody({ model, lead: $json.lead, enrichment: $json.enrichment });
return { json: { ...$json, llm: { primary: body(cfg.llmPrimaryModel), fallback: body(cfg.llmFallbackModel) } } };`,
  });

  const llmPrimary = w.add('LLM Primary (Claude)', 'n8n-nodes-base.httpRequest', 4.2, [2640, 200], httpJson({
    url: 'https://api.anthropic.com/v1/messages',
    auth: AUTH.headerCred,
    headers: ANTHROPIC_HEADERS,
    jsonBody: '={{ JSON.stringify($json.llm.primary) }}',
    timeout: `={{ ${CFG}.llmTimeoutMs }}`,
  }), { credentials: CREDS.anthropic, ...RESILIENT(3, 3000) });

  const parsePrimary = w.code('Parse Primary', [2860, 200], {
    modules: [M.classification],
    entry: `
const ctx = $('Build LLM Request').first().json;
const r = parseLlmResponse($json, 'llm_primary');
return { json: { ...ctx, result: { ...r, llmErrors: r.ok ? [] : ['primary: ' + r.error] } } };`,
  });

  const primaryOk = w.add('Primary OK?', 'n8n-nodes-base.if', 2.2, [3080, 200],
    ifBoolean(deterministicUuid(`${WF}:primaryOk`), '={{ $json.result.ok }}'));

  const llmFallback = w.add('LLM Fallback (Claude)', 'n8n-nodes-base.httpRequest', 4.2, [3300, 400], httpJson({
    url: 'https://api.anthropic.com/v1/messages',
    auth: AUTH.headerCred,
    headers: ANTHROPIC_HEADERS,
    jsonBody: '={{ JSON.stringify($json.llm.fallback) }}',
    timeout: `={{ ${CFG}.llmTimeoutMs }}`,
  }), { credentials: CREDS.anthropic, ...RESILIENT(2, 2000) });

  const parseFallback = w.code('Parse Fallback', [3520, 400], {
    modules: [M.classification],
    entry: `
const prev = $('Parse Primary').first().json;
const r = parseLlmResponse($json, 'llm_fallback');
const llmErrors = r.ok ? prev.result.llmErrors : [...prev.result.llmErrors, 'fallback: ' + r.error];
return { json: { ...prev, result: { ...r, llmErrors } } };`,
  });

  const fallbackOk = w.add('Fallback OK?', 'n8n-nodes-base.if', 2.2, [3740, 400],
    ifBoolean(deterministicUuid(`${WF}:fallbackOk`), '={{ $json.result.ok }}'));

  const rules = w.code('Rule-based Classifier', [3960, 560], {
    modules: [M.classification],
    entry: `
// Último nível de fallback: nunca depende de serviço externo
return {
  json: {
    ...$json,
    result: { ok: true, classifier: 'rules', classification: ruleBasedClassification($json.lead), llmErrors: $json.result.llmErrors, error: null },
  },
};`,
  });

  // ------------------------------------------------------------ roteamento/CRM
  const finalize = w.code('Finalize Triage', [4180, 200], {
    modules: [M.routing],
    entry: `
const cfg = ${CFG};
const triage = finalizeTriage({ lead: $json.lead, enrichment: $json.enrichment, result: $json.result, cfg });
const { llm, ...ctx } = $json;
return { json: { ...ctx, triage, hubspotContact: buildContactUpsert(ctx.lead, ctx.enrichment) } };`,
  });

  const isSpam = w.add('Is Spam?', 'n8n-nodes-base.if', 2.2, [4400, 200],
    ifBoolean(deterministicUuid(`${WF}:isSpam`), '={{ $json.triage.isSpam }}'));

  const hsContact = w.add('HubSpot Upsert Contact', 'n8n-nodes-base.httpRequest', 4.2, [4620, 60], httpJson({
    url: 'https://api.hubapi.com/crm/v3/objects/contacts/batch/upsert',
    auth: AUTH.hubspot,
    jsonBody: '={{ JSON.stringify($json.hubspotContact) }}',
  }), { credentials: CREDS.hubspot, ...RESILIENT(3, 2000) });

  const prepCrm = w.code('Prepare CRM Object', [4840, 60], {
    modules: [M.routing],
    entry: `
const ctx = $('Finalize Triage').first().json;
const contactId = extractContactId($json);
const crmObject = buildCrmObject({ lead: ctx.lead, triage: ctx.triage, contactId, cfg: ${CFG} });
return { json: { ...ctx, contactId, contactError: contactId ? null : describeError($json), crmObject } };`,
  });

  const hsObject = w.add('HubSpot Create Ticket/Deal', 'n8n-nodes-base.httpRequest', 4.2, [5060, 60], httpJson({
    url: '=https://api.hubapi.com/crm/v3/objects/{{ $json.crmObject.objectType }}',
    auth: AUTH.hubspot,
    jsonBody: '={{ JSON.stringify($json.crmObject.body) }}',
  }), { credentials: CREDS.hubspot, ...RESILIENT(3, 2000) });

  const prepSlack = w.code('Prepare Slack Message', [5280, 60], {
    modules: [M.routing],
    entry: `
const ctx = $('Prepare CRM Object').first().json;
const crmObjectId = extractObjectId($json);
const slack = buildSlackMessage({ lead: ctx.lead, enrichment: ctx.enrichment, triage: ctx.triage, crmObjectId });
return { json: { ...ctx, crmObjectId, crmError: crmObjectId ? null : describeError($json), slack } };`,
  });

  const slackNotify = w.add('Slack Notify', 'n8n-nodes-base.httpRequest', 4.2, [5500, 60], httpJson({
    url: 'https://slack.com/api/chat.postMessage',
    auth: AUTH.slack,
    jsonBody: '={{ JSON.stringify($json.slack) }}',
  }), { credentials: CREDS.slack, ...RESILIENT(3, 2000) });

  // --------------------------------------------------------------- auditoria
  const audit = w.code('Build Audit Record', [5720, 200], {
    modules: [M.routing],
    entry: `
const base = $('Finalize Triage').first().json;
const out = (name) => {
  try { return $(name).isExecuted ? $(name).first().json : null; } catch (e) { return null; }
};
const crm = out('Prepare CRM Object');
const slackPrep = out('Prepare Slack Message');
const slackResp = out('Slack Notify');

const integrationErrors = [];
if (crm && crm.contactError) integrationErrors.push('hubspot_contact: ' + crm.contactError);
if (slackPrep && slackPrep.crmError) integrationErrors.push('hubspot_object: ' + slackPrep.crmError);
const slackErr = slackResp ? describeError(slackResp) : null;
if (slackErr) integrationErrors.push('slack: ' + slackErr);

const record = buildAuditRecord({
  lead: base.lead,
  enrichment: base.enrichment,
  triage: base.triage,
  idempotencyKey: base.idempotencyKey,
  payload: base.payload,
  contactId: crm ? crm.contactId : null,
  crmObjectId: slackPrep ? slackPrep.crmObjectId : null,
  slackTs: slackResp && slackResp.ok ? slackResp.ts : null,
  integrationErrors,
  startedAt: base.startedAt,
  now: new Date().toISOString(),
});

const degraded = integrationErrors.length > 0 || base.triage.classifier !== 'llm_primary';
const opsAlertText = degraded
  ? [
    ':warning: *Triagem degradada* — ' + base.triage.priority + ' · ' + base.lead.email,
    'Classificador: ' + base.triage.classifier,
    ...base.triage.llmErrors.map((e) => '• LLM ' + e),
    ...integrationErrors.map((e) => '• ' + e),
    'idempotency_key: ' + base.idempotencyKey,
  ].join('\\n')
  : null;

return { json: { record, integrationErrors, degraded, opsAlertText } };`,
  });

  // jsonb_populate_record: um único parâmetro JSON mapeado para as colunas (sem problemas de NULL/quoting)
  const save = w.add('Save Audit (Postgres)', 'n8n-nodes-base.postgres', 2.5, [5940, 200], {
    operation: 'executeQuery',
    query: `INSERT INTO leads_triage (
  idempotency_key, received_at, source, kind, contact_email, contact_name, company_domain, subject,
  payload, enrichment, sentiment, urgency_score, priority, category, summary, suggested_reply,
  classifier, hubspot_contact_id, hubspot_object_id, slack_message_ts, status, processing_ms
)
SELECT
  r.idempotency_key, r.received_at, r.source, r.kind, r.contact_email, r.contact_name, r.company_domain, r.subject,
  r.payload, r.enrichment, r.sentiment, r.urgency_score, r.priority, r.category, r.summary, r.suggested_reply,
  r.classifier, r.hubspot_contact_id, r.hubspot_object_id, r.slack_message_ts, r.status, r.processing_ms
FROM jsonb_populate_record(NULL::leads_triage, $1::jsonb) AS r
ON CONFLICT (idempotency_key) DO NOTHING
RETURNING id, status;`,
    options: { queryReplacement: '={{ [JSON.stringify($json.record)] }}' },
  }, {
    credentials: CREDS.postgres,
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 2000,
    alwaysOutputData: true,
    notes: 'Sem continueOnFail de propósito: se a auditoria falhar após os retries, o Error Workflow registra e alerta.',
  });

  const needsAlert = w.add('Degraded?', 'n8n-nodes-base.if', 2.2, [6160, 200],
    ifBoolean(deterministicUuid(`${WF}:degraded`), "={{ $('Build Audit Record').first().json.degraded }}"));

  const alertOps = w.add('Alert Ops (Slack)', 'n8n-nodes-base.httpRequest', 4.2, [6380, 100], httpJson({
    url: 'https://slack.com/api/chat.postMessage',
    auth: AUTH.slack,
    jsonBody: `={{ JSON.stringify({ channel: ${CFG}.slackChannelOps, text: $('Build Audit Record').first().json.opsAlertText }) }}`,
  }), { credentials: CREDS.slack, ...RESILIENT(2, 2000) });

  // --------------------------------------------------------------- conexões
  w.chain(webhook, config, validate, isValid);
  w.link(isValid, lock, 0);
  w.link(isValid, respond400, 1);
  w.link(lock, isDuplicate);
  w.link(isDuplicate, respondDup, 0);
  w.link(isDuplicate, respond202, 1);
  w.chain(respond202, heuristic, useExternal);
  w.link(useExternal, enrichApi, 0);
  w.link(useExternal, mergeEnrich, 1);
  w.link(enrichApi, mergeEnrich);
  w.chain(mergeEnrich, buildReq, llmPrimary, parsePrimary, primaryOk);
  w.link(primaryOk, finalize, 0);
  w.link(primaryOk, llmFallback, 1);
  w.chain(llmFallback, parseFallback, fallbackOk);
  w.link(fallbackOk, finalize, 0);
  w.link(fallbackOk, rules, 1);
  w.link(rules, finalize);
  w.link(finalize, isSpam);
  w.link(isSpam, audit, 0);
  w.link(isSpam, hsContact, 1);
  w.chain(hsContact, prepCrm, hsObject, prepSlack, slackNotify, audit, save, needsAlert);
  w.link(needsAlert, alertOps, 0);

  // ---------------------------------------------------------- documentação
  w.sticky('A1', [-40, -160], {
    width: 1120, height: 300, color: 4,
    content: '## 1. Entrada segura\nHeader Auth no webhook · validação/normalização · **idempotência atômica** (Redis INCR + TTL 24h, fail-open) · resposta **202** imediata — o chamador nunca espera a LLM.',
  });
  w.sticky('A2', [1500, -160], {
    width: 900, height: 300, color: 5,
    content: '## 2. Enriquecimento\nHeurística local sempre roda (e-mail corporativo vs. gratuito, empresa pelo domínio, país pelo TLD). API externa é **opcional** (`ENRICHMENT_API_URL`), com timeout de 5s e fallback para a heurística.',
  });
  w.sticky('A3', [2600, -160], {
    width: 1540, height: 300, color: 6,
    content: '## 3. Classificação com fallback em 3 níveis\n**LLM primária** (retry 3x) → **LLM fallback** (retry 2x) → **regras determinísticas**. Saída via *tool use forçado* + validação de schema: JSON fora do contrato conta como falha e desce para o próximo nível. Conteúdo do usuário isolado em tags contra prompt injection.',
  });
  w.sticky('A4', [4380, -200], {
    width: 1540, height: 240, color: 3,
    content: '## 4. Ações\nPrioridade P1–P4 (urgência + sentimento + porte da conta) · upsert de contato e ticket/deal no HubSpot · Slack no canal crítico ou padrão. Spam pula o CRM. Falha de integração não aborta: vira status **partial** na auditoria.',
  });
  w.sticky('A5', [5700, 380], {
    width: 900, height: 220, color: 2,
    content: '## 5. Auditoria & Observabilidade\nRegistro em `leads_triage` (idempotente). Se a LLM primária falhou ou alguma integração quebrou, alerta em `#automation-ops`. Erros não tratados → **Error Workflow** (DLQ `workflow_errors`).',
  });

  return w.build();
}
