// Fluxo A — priorização, payloads de HubSpot/Slack e registro de auditoria.
// Embutido nos Code nodes "Finalize Triage", "Prepare CRM Object", "Prepare Slack Message" e "Build Audit Record".

const CLASSIFIER_LABEL = { llm_primary: 'LLM primária', llm_fallback: 'LLM fallback', rules: 'regras (LLM indisponível)' };
const PRIORITY_EMOJI = { P1: ':rotating_light:', P2: ':large_orange_circle:', P3: ':large_blue_circle:', P4: ':white_circle:' };
const HUBSPOT_TICKET_PRIORITY = { P1: 'HIGH', P2: 'HIGH', P3: 'MEDIUM', P4: 'LOW' };

function clamp01(n) {
  return Math.max(0, Math.min(1, Math.round(n * 100) / 100));
}

function computeScore(classification, enrichment, lead) {
  let score = classification.urgency_score;
  if (classification.sentiment === 'negative') score += 0.1;
  if (classification.category === 'churn_risk') score += 0.1;
  if (enrichment.sizeTier === 'enterprise') score += 0.1;
  else if (enrichment.sizeTier === 'mid_market') score += 0.05;
  if (lead.kind === 'lead' && enrichment.isFreeEmail) score -= 0.1;
  return clamp01(score);
}

function priorityFor(score) {
  if (score >= 0.85) return 'P1';
  if (score >= 0.65) return 'P2';
  if (score >= 0.4) return 'P3';
  return 'P4';
}

function finalizeTriage({ lead, enrichment, result, cfg }) {
  const c = result.classification;
  const isSpam = c.category === 'spam';
  const score = isSpam ? 0 : computeScore(c, enrichment, lead);
  const priority = isSpam ? 'P4' : priorityFor(score);
  return {
    ...c,
    score,
    priority,
    isSpam,
    classifier: result.classifier,
    llmErrors: result.llmErrors || [],
    slackChannel: score >= cfg.urgencyThreshold ? cfg.slackChannelCritical : cfg.slackChannelDefault,
  };
}

function buildContactUpsert(lead, enrichment) {
  const properties = { email: lead.email, hs_lead_status: 'NEW' };
  if (lead.firstName) properties.firstname = lead.firstName;
  if (lead.lastName) properties.lastname = lead.lastName;
  if (lead.phone) properties.phone = lead.phone;
  if (enrichment.companyName) properties.company = enrichment.companyName;
  if (enrichment.isCorporate && enrichment.domain) properties.website = `https://${enrichment.domain}`;
  return { inputs: [{ idProperty: 'email', id: lead.email, properties }] };
}

function extractContactId(resp) {
  if (!resp || resp.error) return null;
  const r = Array.isArray(resp.results) ? resp.results[0] : null;
  return r && r.id ? String(r.id) : null;
}

function crmDescription(lead, triage) {
  return [
    `Prioridade: ${triage.priority} (score ${triage.score}) | Sentimento: ${triage.sentiment} | Categoria: ${triage.category}`,
    `Classificado por: ${CLASSIFIER_LABEL[triage.classifier]}`,
    '',
    `Resumo: ${triage.summary}`,
    '',
    `Mensagem original (${lead.source}):`,
    lead.message,
    '',
    `Resposta sugerida:\n${triage.suggested_reply}`,
  ].join('\n');
}

function buildCrmObject({ lead, triage, contactId, cfg }) {
  // HubSpot v4 association types (HUBSPOT_DEFINED): ticket->contact = 16, deal->contact = 3
  const isTicket = lead.kind === 'ticket';
  const body = isTicket
    ? {
      properties: {
        subject: `[${triage.priority}] ${lead.subject}`.slice(0, 250),
        content: crmDescription(lead, triage),
        hs_pipeline: cfg.hubspotTicketPipeline,
        hs_pipeline_stage: cfg.hubspotTicketStage,
        hs_ticket_priority: HUBSPOT_TICKET_PRIORITY[triage.priority],
      },
    }
    : {
      properties: {
        dealname: `${lead.company || lead.name || lead.email} — ${lead.subject}`.slice(0, 250),
        description: crmDescription(lead, triage),
        pipeline: cfg.hubspotDealPipeline,
        dealstage: cfg.hubspotDealStage,
      },
    };
  if (contactId) {
    body.associations = [{
      to: { id: contactId },
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: isTicket ? 16 : 3 }],
    }];
  }
  return { objectType: isTicket ? 'tickets' : 'deals', body };
}

function extractObjectId(resp) {
  if (!resp || resp.error) return null;
  return resp.id ? String(resp.id) : null;
}

// Normaliza falhas dos nós HTTP (onError: continueRegularOutput) e o "ok:false" da API do Slack
function describeError(resp) {
  if (!resp || typeof resp !== 'object') return 'sem resposta';
  if (resp.ok === false) return `slack_api: ${resp.error || 'unknown'}`;
  if (resp.error) {
    const e = resp.error;
    return (typeof e === 'string' ? e : (e.message || JSON.stringify(e))).slice(0, 300);
  }
  return null;
}

function escapeMrkdwn(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildSlackMessage({ lead, enrichment, triage, crmObjectId }) {
  const title = `${PRIORITY_EMOJI[triage.priority]} ${triage.priority} · ${lead.kind === 'ticket' ? 'Ticket' : 'Lead'}: ${lead.subject}`;
  const fields = [
    `*Contato:*\n${escapeMrkdwn(lead.name || '—')} <mailto:${lead.email}|${escapeMrkdwn(lead.email)}>`,
    `*Empresa:*\n${escapeMrkdwn(enrichment.companyName || '—')} (${enrichment.sizeTier})`,
    `*Sentimento / Urgência:*\n${triage.sentiment} / ${triage.urgency_score}`,
    `*Categoria:*\n${triage.category}`,
  ];
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: title.slice(0, 150), emoji: true } },
    { type: 'section', fields: fields.map((t) => ({ type: 'mrkdwn', text: t })) },
    { type: 'section', text: { type: 'mrkdwn', text: `*Assunto:* ${escapeMrkdwn(lead.subject)}\n*Resumo:* ${escapeMrkdwn(triage.summary)}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `*Resposta sugerida:*\n>${escapeMrkdwn(triage.suggested_reply).replace(/\n/g, '\n>')}` } },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: [
          `Classificador: ${CLASSIFIER_LABEL[triage.classifier]}`,
          `Score: ${triage.score}`,
          `Origem: ${escapeMrkdwn(lead.source)}`,
          crmObjectId ? `HubSpot: ${crmObjectId}` : 'HubSpot: falhou/pulado',
        ].join(' · '),
      }],
    },
  ];
  return {
    channel: triage.slackChannel,
    text: `${triage.priority} — ${escapeMrkdwn(lead.subject)}`,
    blocks,
    unfurl_links: false,
  };
}

function buildAuditRecord({
  lead, enrichment, triage, idempotencyKey, payload, contactId, crmObjectId, slackTs, integrationErrors, startedAt, now,
}) {
  return {
    idempotency_key: idempotencyKey,
    received_at: lead.receivedAt,
    source: lead.source,
    kind: lead.kind,
    contact_email: lead.email,
    contact_name: lead.name,
    company_domain: lead.domain,
    subject: lead.subject,
    payload,
    enrichment,
    sentiment: triage.sentiment,
    urgency_score: triage.urgency_score,
    priority: triage.priority,
    category: triage.category,
    summary: triage.summary,
    suggested_reply: triage.suggested_reply,
    classifier: triage.classifier,
    hubspot_contact_id: contactId,
    hubspot_object_id: crmObjectId,
    slack_message_ts: slackTs,
    status: integrationErrors.length ? 'partial' : 'processed',
    processing_ms: Math.max(0, Date.parse(now) - Date.parse(startedAt)),
  };
}

// --- test exports ---
module.exports = {
  finalizeTriage, computeScore, priorityFor, buildContactUpsert, extractContactId, buildCrmObject, extractObjectId,
  buildSlackMessage, buildAuditRecord, escapeMrkdwn, describeError,
};
