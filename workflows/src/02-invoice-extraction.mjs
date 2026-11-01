// Fluxo B — Extrator e normalizador de faturas / notas fiscais.
// Upload (multipart ou JSON base64) -> tipo real + tamanho + hash -> dedupe -> 202
// -> LLM multimodal (primária -> fallback -> texto do PDF) -> schema + regras de negócio
// -> Postgres (invoices) + Google Sheets  |  quarentena + revisão humana no Slack.

import {
  createWorkflow, ifBoolean, respondJson, httpJson, pgInsertFromJson, RESILIENT, CREDS, AUTH, deterministicUuid,
} from './lib.mjs';

const WF = '02 - Invoice Extraction & Normalization';
const M = {
  intake: 'src/flow-b/intake.js',
  extraction: 'src/flow-b/extraction.js',
  validation: 'src/flow-b/validation.js',
  persistence: 'src/flow-b/persistence.js',
};
const CFG = "$('Load Config').first().json.config";
const ANTHROPIC = {
  url: 'https://api.anthropic.com/v1/messages',
  auth: AUTH.headerCred,
  headers: [{ name: 'anthropic-version', value: '2023-06-01' }],
  jsonBody: '={{ JSON.stringify($json.body) }}',
  timeout: `={{ ${CFG}.llmTimeoutMs }}`,
};
const OUT = `
const out = (name) => {
  try { return $(name).isExecuted ? $(name).first().json : null; } catch (e) { return null; }
};`;

export default function build() {
  const w = createWorkflow(WF);
  const id = (k) => deterministicUuid(`${WF}:${k}`);

  // ------------------------------------------------------------------ entrada
  const webhook = w.add('Webhook Upload', 'n8n-nodes-base.webhook', 2, [0, 300], {
    httpMethod: 'POST',
    path: 'invoice-upload',
    authentication: 'headerAuth',
    responseMode: 'responseNode',
    options: {},
  }, { webhookId: id('webhook'), credentials: CREDS.webhookAuth });

  const validateUpload = w.code('Validate Upload', [220, 300], {
    modules: [M.intake],
    mode: 'runOnceForAllItems',
    entry: `
// Limite lido do ambiente quando permitido; 10 MB por padrão (N8N_PAYLOAD_SIZE_MAX é o teto duro)
const maxMb = (() => { try { return Number($env.INVOICE_MAX_FILE_MB) || 10; } catch (e) { return 10; } })();
const results = [];
const items = $input.all();

for (let i = 0; i < items.length; i++) {
  const item = items[i];
  const binKey = item.binary ? Object.keys(item.binary)[0] : null;
  let buffer = null;
  let declaredMime = null;
  let fileName = null;

  if (binKey) {
    // Multipart: funciona com binary mode "database"/"filesystem" (não lê item.binary.data direto)
    buffer = await this.helpers.getBinaryDataBuffer(i, binKey);
    declaredMime = item.binary[binKey].mimeType || null;
    fileName = item.binary[binKey].fileName || null;
  } else {
    const decoded = decodeJsonUpload(item.json.body);
    if (decoded) ({ buffer, declaredMime, fileName } = decoded);
  }

  const v = validateUpload({ buffer, declaredMime, fileName, maxMb });
  if (!v.valid) {
    results.push({ json: { valid: false, httpStatus: v.httpStatus, errors: v.errors } });
    continue;
  }

  const binary = binKey
    ? item.binary
    : { document: await this.helpers.prepareBinaryData(buffer, v.fileName, v.mimeType) };

  results.push({
    json: {
      valid: true,
      httpStatus: 202,
      errors: [],
      file: {
        sha256: sha256Hex(buffer),
        mimeType: v.mimeType,
        declaredMime: v.declaredMime,
        isPdf: v.isPdf,
        fileName: v.fileName,
        sizeBytes: v.sizeBytes,
        binaryKey: binKey || 'document',
        base64: buffer.toString('base64'),
      },
    },
    binary,
  });
}
return results;`,
  });

  const isValid = w.add('Is Valid Upload?', 'n8n-nodes-base.if', 2.2, [440, 300], ifBoolean(id('isValid'), '={{ $json.valid }}'));

  const respondRejected = w.add('Respond Rejected', 'n8n-nodes-base.respondToWebhook', 1.1, [660, 480],
    respondJson('={{ JSON.stringify({ status: "rejected", errors: $json.errors }) }}', '={{ $json.httpStatus }}'));

  const isPdf = w.add('Is PDF?', 'n8n-nodes-base.if', 2.2, [660, 200], ifBoolean(id('isPdf'), '={{ $json.file.isPdf }}'));

  // Texto embutido do PDF: insumo do último nível de fallback. PDFs escaneados retornam vazio.
  const extractText = w.add('Extract PDF Text', 'n8n-nodes-base.extractFromFile', 1, [880, 100], {
    operation: 'pdf',
    binaryPropertyName: '={{ $json.file.binaryKey }}',
    options: { joinPages: true },
  }, { onError: 'continueRegularOutput', alwaysOutputData: true });

  const prepareDoc = w.code('Prepare Document', [1100, 200], {
    entry: `
const up = $('Validate Upload').first().json;
const { base64, ...meta } = up.file; // base64 fica só em "Validate Upload" (evita copiar MBs entre nós)
let text = '';
try {
  if ($('Extract PDF Text').isExecuted) text = String($('Extract PDF Text').first().json.text || '');
} catch (e) { text = ''; }
const cleaned = text.replace(/\\s+/g, ' ').trim();
return { json: { doc: { ...meta, hasText: cleaned.length >= 50, textChars: cleaned.length }, pdfText: cleaned.slice(0, 60000) } };`,
  });

  const config = w.add('Load Config', 'n8n-nodes-base.set', 3.4, [1320, 200], {
    mode: 'manual',
    assignments: {
      assignments: [{
        id: id('config'),
        name: 'config',
        type: 'object',
        value: `={{ {
  llmPrimaryModel: $env.LLM_PRIMARY_MODEL || 'claude-sonnet-5-5',
  llmFallbackModel: $env.LLM_FALLBACK_MODEL || 'claude-haiku-5-5',
  llmTimeoutMs: Number($env.INVOICE_LLM_TIMEOUT_MS || 90000),
  minConfidence: Number($env.INVOICE_MIN_CONFIDENCE || 0.7),
  slackChannelFinance: $env.SLACK_CHANNEL_FINANCE || '#financeiro-revisao',
  slackChannelOps: $env.SLACK_CHANNEL_OPS || '#automation-ops',
  gsheetsDocId: $env.GSHEETS_INVOICES_DOC_ID || '',
  gsheetsSheetName: $env.GSHEETS_INVOICES_SHEET || 'Invoices'
} }}`,
      }],
    },
    includeOtherFields: true,
    options: {},
  });

  const checkDup = w.add('Check Duplicate (Postgres)', 'n8n-nodes-base.postgres', 2.5, [1540, 200], {
    operation: 'executeQuery',
    query: 'SELECT id::text AS invoice_id FROM invoices WHERE file_sha256 = $1 LIMIT 1;',
    options: { queryReplacement: '={{ [$json.doc.sha256] }}' },
  }, { credentials: CREDS.postgres, retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, alwaysOutputData: true });

  const isDup = w.add('Is Duplicate?', 'n8n-nodes-base.if', 2.2, [1760, 200], ifBoolean(id('isDup'), '={{ Boolean($json.invoice_id) }}'));

  const respondDup = w.add('Respond 409 Duplicate', 'n8n-nodes-base.respondToWebhook', 1.1, [1980, 40],
    respondJson("={{ JSON.stringify({ status: 'duplicate', invoiceId: $json.invoice_id, documentId: $('Load Config').first().json.doc.sha256 }) }}", 409));

  const respond202 = w.add('Respond 202 Accepted', 'n8n-nodes-base.respondToWebhook', 1.1, [1980, 200],
    respondJson("={{ JSON.stringify({ status: 'accepted', documentId: $('Load Config').first().json.doc.sha256, fileName: $('Load Config').first().json.doc.fileName }) }}", 202));

  // ---------------------------------------------------------------- extração
  const buildPrimary = w.code('Build Primary Request', [2200, 200], {
    modules: [M.extraction],
    entry: `
const f = $('Validate Upload').first().json.file;
const cfg = ${CFG};
return { json: { body: buildVisionBody({ model: cfg.llmPrimaryModel, base64: f.base64, mimeType: f.mimeType, fileName: f.fileName }) } };`,
  });

  const llmPrimary = w.add('LLM Primary Vision (Claude)', 'n8n-nodes-base.httpRequest', 4.2, [2420, 200], httpJson(ANTHROPIC),
    { credentials: CREDS.anthropic, ...RESILIENT(3, 5000) });

  const parsePrimary = w.code('Parse Primary', [2640, 200], {
    modules: [M.extraction],
    entry: `
const ctx = $('Load Config').first().json;
const r = parseExtraction($json, 'llm_primary');
return { json: { doc: ctx.doc, result: r, llmErrors: r.ok ? [] : ['primary: ' + r.error] } };`,
  });

  const primaryOk = w.add('Primary OK?', 'n8n-nodes-base.if', 2.2, [2860, 200], ifBoolean(id('primaryOk'), '={{ $json.result.ok }}'));

  const buildFallback = w.code('Build Fallback Request', [3080, 400], {
    modules: [M.extraction],
    entry: `
const f = $('Validate Upload').first().json.file;
const cfg = ${CFG};
return { json: { body: buildVisionBody({ model: cfg.llmFallbackModel, base64: f.base64, mimeType: f.mimeType, fileName: f.fileName }) } };`,
  });

  const llmFallback = w.add('LLM Fallback Vision (Claude)', 'n8n-nodes-base.httpRequest', 4.2, [3300, 400], httpJson(ANTHROPIC),
    { credentials: CREDS.anthropic, ...RESILIENT(2, 3000) });

  const parseFallback = w.code('Parse Fallback', [3520, 400], {
    modules: [M.extraction],
    entry: `
const prev = $('Parse Primary').first().json;
const r = parseExtraction($json, 'llm_fallback');
return { json: { doc: prev.doc, result: r, llmErrors: r.ok ? prev.llmErrors : [...prev.llmErrors, 'fallback: ' + r.error] } };`,
  });

  const fallbackOk = w.add('Fallback OK?', 'n8n-nodes-base.if', 2.2, [3740, 400], ifBoolean(id('fallbackOk'), '={{ $json.result.ok }}'));

  const hasText = w.add('Has PDF Text?', 'n8n-nodes-base.if', 2.2, [3960, 560],
    ifBoolean(id('hasText'), "={{ $('Prepare Document').first().json.doc.hasText }}"));

  const buildText = w.code('Build Text Request', [4180, 560], {
    modules: [M.extraction],
    entry: `
const ctx = $('Load Config').first().json;
// Modelo primário: este nível cobre falhas ligadas ao arquivo (tamanho, PDF malformado), não à capacidade
return { json: { body: buildTextBody({ model: ctx.config.llmPrimaryModel, text: ctx.pdfText, fileName: ctx.doc.fileName }) } };`,
  });

  const llmText = w.add('LLM Text Fallback (Claude)', 'n8n-nodes-base.httpRequest', 4.2, [4400, 560], httpJson(ANTHROPIC),
    { credentials: CREDS.anthropic, ...RESILIENT(2, 3000) });

  const parseText = w.code('Parse Text', [4620, 560], {
    modules: [M.extraction],
    entry: `
const prev = $('Parse Fallback').first().json;
const r = parseExtraction($json, 'pdf_text_llm');
return { json: { doc: prev.doc, result: r, llmErrors: r.ok ? prev.llmErrors : [...prev.llmErrors, 'pdf_text: ' + r.error] } };`,
  });

  const textOk = w.add('Text OK?', 'n8n-nodes-base.if', 2.2, [4840, 560], ifBoolean(id('textOk'), '={{ $json.result.ok }}'));

  // --------------------------------------------------------------- validação
  const validateInvoice = w.code('Validate Invoice', [5060, 200], {
    modules: [M.validation, M.persistence],
    entry: `
const cfg = ${CFG};
const v = validateInvoice($json.result.extraction, { minConfidence: cfg.minConfidence, today: new Date().toISOString().slice(0, 10) });
const record = v.valid
  ? buildInvoiceRecord({ doc: $json.doc, invoice: v.invoice, extraction: $json.result.extraction, extractor: $json.result.extractor })
  : null;
return { json: { ...$json, validation: v, record } };`,
  });

  const isInvoiceValid = w.add('Is Invoice Valid?', 'n8n-nodes-base.if', 2.2, [5280, 200], ifBoolean(id('isInvoiceValid'), '={{ $json.validation.valid }}'));

  // ON CONFLICT sem alvo cobre tanto file_sha256 (corrida entre uploads) quanto (fornecedor, número)
  const insertInvoice = w.add('Insert Invoice (Postgres)', 'n8n-nodes-base.postgres', 2.5, [5500, 100], pgInsertFromJson({
    table: 'invoices',
    columns: ['file_sha256', 'source_filename', 'mime_type', 'supplier_name', 'supplier_tax_id', 'customer_name', 'customer_tax_id',
      'invoice_number', 'issue_date', 'due_date', 'currency', 'subtotal', 'tax_total', 'total', 'line_items', 'extractor',
      'confidence', 'raw_extraction'],
    onConflict: 'ON CONFLICT DO NOTHING',
    returning: 'id::text AS invoice_id',
  }), { credentials: CREDS.postgres, retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, alwaysOutputData: true });

  const inserted = w.add('Inserted?', 'n8n-nodes-base.if', 2.2, [5720, 100], ifBoolean(id('inserted'), '={{ Boolean($json.invoice_id) }}'));

  const sheetsEnabled = w.add('Sheets Enabled?', 'n8n-nodes-base.if', 2.2, [5940, 0], ifBoolean(id('sheetsEnabled'), `={{ Boolean(${CFG}.gsheetsDocId) }}`));

  const prepRow = w.code('Prepare Sheet Row', [6160, -100], {
    modules: [M.persistence],
    entry: `
const v = $('Validate Invoice').first().json;
const invoiceId = $('Insert Invoice (Postgres)').first().json.invoice_id;
return { json: buildSheetRow({ record: v.record, invoiceId, processedAt: new Date().toISOString() }) };`,
  });

  // Planilha é um destino secundário (visão do financeiro): falha não desfaz o registro no banco
  const appendSheet = w.add('Append to Google Sheets', 'n8n-nodes-base.googleSheets', 4.5, [6380, -100], {
    resource: 'sheet',
    operation: 'append',
    documentId: { __rl: true, value: `={{ ${CFG}.gsheetsDocId }}`, mode: 'id' },
    sheetName: { __rl: true, value: `={{ ${CFG}.gsheetsSheetName }}`, mode: 'name' },
    columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [] },
    options: {},
  }, { credentials: CREDS.googleSheets, ...RESILIENT(3, 2000) });

  const summarize = w.code('Summarize', [6600, 100], {
    entry: `${OUT}
const v = $('Validate Invoice').first().json;
const invoiceId = $('Insert Invoice (Postgres)').first().json.invoice_id;
const sheets = out('Append to Google Sheets');
const issues = [...v.llmErrors];
if (sheets && sheets.error) issues.push('google_sheets: ' + (sheets.error.message || sheets.error));
const degraded = issues.length > 0;
const opsAlertText = degraded
  ? [
    ':warning: *Extração de fatura degradada* — ' + v.doc.fileName,
    'Extrator usado: ' + v.result.extractor + ' · invoice_id: ' + invoiceId,
    ...issues.map((e) => '• ' + e),
  ].join('\\n')
  : null;
return { json: { invoiceId, extractor: v.result.extractor, warnings: v.validation.warnings, degraded, opsAlertText } };`,
  });

  const degradedIf = w.add('Degraded?', 'n8n-nodes-base.if', 2.2, [6820, 100], ifBoolean(id('degraded'), '={{ $json.degraded }}'));

  const alertOps = w.add('Alert Ops (Slack)', 'n8n-nodes-base.httpRequest', 4.2, [7040, 0], httpJson({
    url: 'https://slack.com/api/chat.postMessage',
    auth: AUTH.slack,
    jsonBody: `={{ JSON.stringify({ channel: ${CFG}.slackChannelOps, text: $json.opsAlertText }) }}`,
  }), { credentials: CREDS.slack, ...RESILIENT(2, 2000) });

  // -------------------------------------------------------------- quarentena
  const buildQuarantine = w.code('Build Quarantine Record', [5720, 560], {
    modules: [M.persistence],
    entry: `${OUT}
const val = out('Validate Invoice');
const ins = out('Insert Invoice (Postgres)');
const lastParse = out('Parse Text') || out('Parse Fallback') || out('Parse Primary');
const validation = val ? val.validation : null;
const reason = quarantineReason({ validation, inserted: ins ? Boolean(ins.invoice_id) : null });
const record = buildQuarantineRecord({
  doc: $('Load Config').first().json.doc,
  reason,
  validation,
  extraction: val ? val.result.extraction : null,
  llmErrors: (val || lastParse || { llmErrors: [] }).llmErrors,
});
return { json: { reason, record } };`,
  });

  const insertQuarantine = w.add('Insert Quarantine (Postgres)', 'n8n-nodes-base.postgres', 2.5, [5940, 560], pgInsertFromJson({
    table: 'invoice_quarantine',
    columns: ['file_sha256', 'source_filename', 'mime_type', 'reason', 'validation_errors', 'raw_extraction'],
    returning: 'id::text AS quarantine_id',
  }), { credentials: CREDS.postgres, retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 });

  const prepReview = w.code('Prepare Review Message', [6160, 560], {
    modules: [M.persistence],
    entry: `
const q = $('Build Quarantine Record').first().json;
return {
  json: buildReviewSlack({
    doc: $('Load Config').first().json.doc,
    reason: q.reason,
    errors: q.record.validation_errors,
    quarantineId: $json.quarantine_id,
    channel: ${CFG}.slackChannelFinance,
  }),
};`,
  });

  const slackReview = w.add('Slack Review Request', 'n8n-nodes-base.httpRequest', 4.2, [6380, 560], httpJson({
    url: 'https://slack.com/api/chat.postMessage',
    auth: AUTH.slack,
    jsonBody: '={{ JSON.stringify($json) }}',
  }), { credentials: CREDS.slack, ...RESILIENT(3, 2000) });

  // --------------------------------------------------------------- conexões
  w.chain(webhook, validateUpload, isValid);
  w.link(isValid, isPdf, 0);
  w.link(isValid, respondRejected, 1);
  w.link(isPdf, extractText, 0);
  w.link(isPdf, prepareDoc, 1);
  w.link(extractText, prepareDoc);
  w.chain(prepareDoc, config, checkDup, isDup);
  w.link(isDup, respondDup, 0);
  w.link(isDup, respond202, 1);
  w.chain(respond202, buildPrimary, llmPrimary, parsePrimary, primaryOk);
  w.link(primaryOk, validateInvoice, 0);
  w.link(primaryOk, buildFallback, 1);
  w.chain(buildFallback, llmFallback, parseFallback, fallbackOk);
  w.link(fallbackOk, validateInvoice, 0);
  w.link(fallbackOk, hasText, 1);
  w.link(hasText, buildText, 0);
  w.link(hasText, buildQuarantine, 1);
  w.chain(buildText, llmText, parseText, textOk);
  w.link(textOk, validateInvoice, 0);
  w.link(textOk, buildQuarantine, 1);
  w.link(validateInvoice, isInvoiceValid);
  w.link(isInvoiceValid, insertInvoice, 0);
  w.link(isInvoiceValid, buildQuarantine, 1);
  w.link(insertInvoice, inserted);
  w.link(inserted, sheetsEnabled, 0);
  w.link(inserted, buildQuarantine, 1);
  w.link(sheetsEnabled, prepRow, 0);
  w.link(sheetsEnabled, summarize, 1);
  w.chain(prepRow, appendSheet, summarize, degradedIf);
  w.link(degradedIf, alertOps, 0);
  w.chain(buildQuarantine, insertQuarantine, prepReview, slackReview);

  // ---------------------------------------------------------- documentação
  w.sticky('B1', [-40, -160], {
    width: 1300, height: 300, color: 4,
    content: '## 1. Recepção segura\nMultipart (`file`) ou JSON `{fileName, base64}` · tipo real por **magic bytes** (não confia no Content-Type) · limite de tamanho (413/415) · **SHA-256** do arquivo · texto do PDF extraído localmente para o último fallback.',
  });
  w.sticky('B2', [1300, -160], {
    width: 840, height: 300, color: 5,
    content: '## 2. Deduplicação\nMesmo arquivo reenviado → **409** com o `invoiceId` existente. Novos → **202** imediato com `documentId` (sha256).',
  });
  w.sticky('B3', [2180, -160], {
    width: 2860, height: 300, color: 6,
    content: '## 3. Extração com fallback em 3 níveis\n**Visão primária** (PDF nativo / imagem) → **visão fallback** → **texto do PDF + LLM** (cobre falhas ligadas ao arquivo). Saída via *tool use forçado*. Sem extração possível → quarentena `llm_unavailable`.',
  });
  w.sticky('B4', [5040, -360], {
    width: 2200, height: 260, color: 3,
    content: '## 4. Validação → Persistência\nSchema + regras: CNPJ/CPF (inclui **CNPJ alfanumérico 2026**), soma dos itens = subtotal, total = subtotal ± impostos/descontos (aceita imposto embutido), datas coerentes, confiança mínima. Válida → `invoices` (idempotente) → Google Sheets (secundário; falha só alerta).',
  });
  w.sticky('B5', [5700, 760], {
    width: 900, height: 200, color: 2,
    content: '## 5. Quarentena (human-in-the-loop)\nInválidas, duplicadas por fornecedor+número ou sem extração → `invoice_quarantine` + pedido de revisão no Slack do financeiro com os motivos.',
  });

  return w.build();
}
