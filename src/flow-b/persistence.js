// Fluxo B — registros de banco (invoices / invoice_quarantine), linha da planilha e mensagem de revisão.
// Embutido nos Code nodes "Validate Invoice", "Prepare Sheet Row", "Build Quarantine Record" e "Summarize".

const REASON_LABEL = {
  llm_unavailable: 'LLM indisponível em todos os níveis',
  duplicate_business_key: 'fornecedor + número de fatura já cadastrados',
  not_invoice: 'arquivo não é fatura/nota fiscal',
  low_confidence: 'baixa confiança na extração',
  schema_invalid: 'extração fora do schema',
  business_rule: 'regras de negócio violadas',
};

function buildInvoiceRecord({ doc, invoice, extraction, extractor }) {
  return {
    file_sha256: doc.sha256,
    source_filename: doc.fileName,
    mime_type: doc.mimeType,
    ...invoice,
    extractor,
    raw_extraction: extraction,
  };
}

function quarantineReason({ validation, inserted }) {
  if (!validation) return 'llm_unavailable';
  if (validation.valid && inserted === false) return 'duplicate_business_key';
  const codes = (validation.errors || []).map((e) => e.code);
  if (codes.includes('not_invoice')) return 'not_invoice';
  if (codes.includes('shape_invalid')) return 'schema_invalid';
  if (codes.length === 1 && codes[0] === 'low_confidence') return 'low_confidence';
  return 'business_rule';
}

function buildQuarantineRecord({ doc, reason, validation, extraction, llmErrors = [] }) {
  let errors = validation ? validation.errors : [];
  if (reason === 'llm_unavailable') errors = llmErrors.map((message) => ({ code: 'llm_error', message }));
  if (reason === 'duplicate_business_key') errors = [{ code: 'duplicate_business_key', message: REASON_LABEL[reason] }];
  return {
    file_sha256: doc.sha256,
    source_filename: doc.fileName,
    mime_type: doc.mimeType,
    reason,
    validation_errors: errors,
    raw_extraction: extraction || null,
  };
}

function buildSheetRow({ record, invoiceId, processedAt }) {
  return {
    invoice_id: invoiceId,
    processed_at: processedAt,
    issue_date: record.issue_date,
    due_date: record.due_date || '',
    supplier_name: record.supplier_name,
    supplier_tax_id: record.supplier_tax_id,
    invoice_number: record.invoice_number,
    currency: record.currency,
    subtotal: record.subtotal ?? '',
    tax_total: record.tax_total ?? '',
    total: record.total,
    items_count: record.line_items.length,
    extractor: record.extractor,
    confidence: record.confidence ?? '',
    file_name: record.source_filename,
  };
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildReviewSlack({ doc, reason, errors, quarantineId, channel }) {
  const list = (errors || []).slice(0, 10).map((e) => `• \`${e.code}\` ${esc(e.message)}`).join('\n') || '• (sem detalhes)';
  return {
    channel,
    text: `Fatura em quarentena: ${esc(doc.fileName)} — ${REASON_LABEL[reason] || reason}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: ':mag: Fatura aguardando revisão humana', emoji: true } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Arquivo:*\n${esc(doc.fileName)}` },
          { type: 'mrkdwn', text: `*Motivo:*\n${esc(REASON_LABEL[reason] || reason)}` },
        ],
      },
      { type: 'section', text: { type: 'mrkdwn', text: `*Problemas encontrados:*\n${list}` } },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `quarantine_id: \`${esc(quarantineId || 'n/a')}\` · sha256: \`${doc.sha256.slice(0, 12)}…\`` }],
      },
    ],
    unfurl_links: false,
  };
}

// --- test exports ---
module.exports = {
  REASON_LABEL, buildInvoiceRecord, quarantineReason, buildQuarantineRecord, buildSheetRow, buildReviewSlack,
};
