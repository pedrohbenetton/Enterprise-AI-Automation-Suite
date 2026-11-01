const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildInvoiceRecord, buildQuarantineRecord, quarantineReason, buildSheetRow, buildReviewSlack,
} = require('../../src/flow-b/persistence.js');

const doc = { sha256: 'a'.repeat(64), fileName: 'nf-123.pdf', mimeType: 'application/pdf', sizeBytes: 1000 };
const invoice = {
  supplier_name: 'Fornecedor', supplier_tax_id: '11222333000181', customer_name: null, customer_tax_id: null,
  invoice_number: '123', issue_date: '2026-10-15', due_date: null, currency: 'BRL',
  subtotal: 100, tax_total: 0, total: 100, line_items: [{ description: 'x', quantity: 1, unit_price: 100, total: 100 }], confidence: 0.9,
};

test('buildInvoiceRecord mapeia colunas da tabela invoices', () => {
  const r = buildInvoiceRecord({ doc, invoice, extraction: { raw: true }, extractor: 'llm_fallback' });
  assert.equal(r.file_sha256, doc.sha256);
  assert.equal(r.source_filename, 'nf-123.pdf');
  assert.equal(r.extractor, 'llm_fallback');
  assert.deepEqual(r.raw_extraction, { raw: true });
  assert.equal(r.total, 100);
});

test('quarantineReason prioriza a causa mais específica', () => {
  assert.equal(quarantineReason({ validation: null, inserted: null }), 'llm_unavailable');
  assert.equal(quarantineReason({ validation: { valid: true }, inserted: false }), 'duplicate_business_key');
  assert.equal(quarantineReason({ validation: { valid: false, errors: [{ code: 'not_invoice' }] } }), 'not_invoice');
  assert.equal(quarantineReason({ validation: { valid: false, errors: [{ code: 'low_confidence' }, { code: 'total_mismatch' }] } }), 'business_rule');
  assert.equal(quarantineReason({ validation: { valid: false, errors: [{ code: 'low_confidence' }] } }), 'low_confidence');
  assert.equal(quarantineReason({ validation: { valid: false, errors: [{ code: 'shape_invalid' }] } }), 'schema_invalid');
});

test('buildQuarantineRecord inclui erros de LLM quando não houve extração', () => {
  const r = buildQuarantineRecord({ doc, reason: 'llm_unavailable', validation: null, extraction: null, llmErrors: ['primary: 529'] });
  assert.equal(r.reason, 'llm_unavailable');
  assert.deepEqual(r.validation_errors, [{ code: 'llm_error', message: 'primary: 529' }]);
  assert.equal(r.raw_extraction, null);
});

test('buildSheetRow é plano e contém o id do banco', () => {
  const row = buildSheetRow({ record: buildInvoiceRecord({ doc, invoice, extraction: {}, extractor: 'llm_primary' }), invoiceId: 'uuid-1', processedAt: '2026-10-31T12:00:00Z' });
  assert.equal(row.invoice_id, 'uuid-1');
  assert.equal(row.items_count, 1);
  for (const v of Object.values(row)) assert.notEqual(typeof v, 'object');
});

test('buildReviewSlack lista motivos e escapa nome do arquivo', () => {
  const m = buildReviewSlack({
    doc: { ...doc, fileName: '<x>.pdf' }, reason: 'business_rule', quarantineId: 'q-1', channel: '#financeiro-revisao',
    errors: [{ code: 'total_mismatch', message: 'total diverge' }],
  });
  assert.equal(m.channel, '#financeiro-revisao');
  const blob = JSON.stringify(m.blocks);
  assert.match(blob, /total_mismatch/);
  assert.match(blob, /&lt;x&gt;\.pdf/);
  assert.match(blob, /q-1/);
});
