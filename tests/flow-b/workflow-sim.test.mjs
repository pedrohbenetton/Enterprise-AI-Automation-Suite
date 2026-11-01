// Simulação ponta a ponta do Fluxo B executando o jsCode embutido no JSON exportado.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAll } from '../../scripts/build-workflows.mjs';
import { createSimulator } from '../helpers/n8n-sim.mjs';

const flowB = (await buildAll()).find((o) => o.workflow.name.startsWith('02')).workflow;

const CONFIG = {
  llmPrimaryModel: 'claude-sonnet-5-5', llmFallbackModel: 'claude-haiku-5-5', llmTimeoutMs: 90000, minConfidence: 0.7,
  slackChannelFinance: '#financeiro-revisao', slackChannelOps: '#automation-ops', gsheetsDocId: 'sheet-123', gsheetsSheetName: 'Invoices',
};
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n');
const EXE = Buffer.from('MZ\x90\x00\x03\x00\x00\x00');
const today = new Date().toISOString().slice(0, 10);

const helpersFor = (buffer) => ({
  getBinaryDataBuffer: async () => buffer,
  prepareBinaryData: async (buf, fileName, mimeType) => ({ fileName, mimeType, data: buf.toString('base64') }),
});

const toolUse = (input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'record_invoice', input }] });

const extraction = (over = {}) => ({
  document_type: 'nfe',
  supplier: { name: 'Fornecedor Exemplo Ltda', tax_id: '11.222.333/0001-81' },
  customer: { name: 'Cliente SA', tax_id: null },
  invoice_number: '4567', issue_date: today, due_date: null, currency: 'BRL',
  line_items: [{ description: 'Serviço', quantity: 2, unit_price: 250, total: 500 }],
  subtotal: 500, tax_total: 0, discount_total: null, other_charges: null, total: 500, confidence: 0.95,
  ...over,
});

async function intake(sim, { buffer, multipart = true, pdfText = '' }) {
  const item = multipart
    ? { json: { body: {} }, binary: { file: { mimeType: 'application/pdf', fileName: 'nf-4567.pdf' } } }
    : { json: { body: { fileName: 'nf-4567.pdf', base64: buffer.toString('base64') } } };
  const [res] = await sim.runAll('Validate Upload', [item], helpersFor(buffer));
  if (!res.json.valid) return res;
  if (res.json.file.isPdf) sim.set('Extract PDF Text', { text: pdfText });
  const doc = sim.run('Prepare Document', {});
  sim.set('Load Config', { ...doc, config: CONFIG });
  return res;
}

test('fluxo B: caminho feliz multipart -> invoices + planilha', async () => {
  const sim = createSimulator(flowB);
  const res = await intake(sim, { buffer: PDF });
  assert.equal(res.json.file.mimeType, 'application/pdf');
  assert.match(res.json.file.sha256, /^[0-9a-f]{64}$/);
  assert.ok(res.binary.file);

  const req = sim.run('Build Primary Request', {});
  assert.equal(req.body.messages[0].content[0].type, 'document');
  assert.equal(req.body.messages[0].content[0].source.data, PDF.toString('base64'));

  const p = sim.run('Parse Primary', toolUse(extraction()));
  assert.equal(p.result.ok, true);
  assert.equal(p.doc.base64, undefined, 'base64 não deve trafegar além de Validate Upload');

  const v = sim.run('Validate Invoice', p);
  assert.equal(v.validation.valid, true, JSON.stringify(v.validation.errors));
  assert.equal(v.record.supplier_tax_id, '11222333000181');
  assert.equal(v.record.extractor, 'llm_primary');

  sim.set('Insert Invoice (Postgres)', { invoice_id: 'inv-1' });
  const row = sim.run('Prepare Sheet Row', {});
  assert.equal(row.invoice_id, 'inv-1');
  sim.set('Append to Google Sheets', row);
  const s = sim.run('Summarize', row);
  assert.equal(s.degraded, false);
});

test('fluxo B: upload JSON base64 gera binário para o Extract from File', async () => {
  const sim = createSimulator(flowB);
  const res = await intake(sim, { buffer: PDF, multipart: false });
  assert.equal(res.json.valid, true);
  assert.equal(res.json.file.binaryKey, 'document');
  assert.equal(res.binary.document.mimeType, 'application/pdf');
});

test('fluxo B: executável disfarçado é rejeitado com 415', async () => {
  const sim = createSimulator(flowB);
  const res = await intake(sim, { buffer: EXE });
  assert.equal(res.json.valid, false);
  assert.equal(res.json.httpStatus, 415);
});

test('fluxo B: visões falham, texto do PDF salva a extração (degradado)', async () => {
  const sim = createSimulator(flowB);
  await intake(sim, { buffer: PDF, pdfText: 'NOTA FISCAL ELETRÔNICA Nº 4567 Fornecedor Exemplo Ltda CNPJ 11.222.333/0001-81 Total R$ 500,00 '.repeat(2) });
  sim.run('Parse Primary', { error: { message: '529 overloaded_error' } });
  sim.run('Build Fallback Request', {});
  const fb = sim.run('Parse Fallback', { error: { message: '400 invalid_request_error: Could not process PDF' } });
  assert.equal(fb.result.ok, false);

  const t = sim.run('Build Text Request', {});
  assert.match(t.body.messages[0].content, /<document_text>/);
  const pt = sim.run('Parse Text', toolUse(extraction()));
  assert.equal(pt.result.extractor, 'pdf_text_llm');
  assert.equal(pt.llmErrors.length, 2);

  const v = sim.run('Validate Invoice', pt);
  assert.equal(v.record.extractor, 'pdf_text_llm');
  sim.set('Insert Invoice (Postgres)', { invoice_id: 'inv-2' });
  sim.set('Append to Google Sheets', { error: { message: '403 PERMISSION_DENIED' } });
  const s = sim.run('Summarize', {});
  assert.equal(s.degraded, true);
  assert.match(s.opsAlertText, /overloaded/);
  assert.match(s.opsAlertText, /google_sheets: 403/);
});

test('fluxo B: LLMs de visão falham em PDF escaneado (sem texto) -> quarentena llm_unavailable', async () => {
  const sim = createSimulator(flowB);
  await intake(sim, { buffer: PDF, pdfText: '' });
  sim.run('Parse Primary', { error: { message: 'timeout' } });
  sim.run('Parse Fallback', { error: { message: 'timeout' } });
  const q = sim.run('Build Quarantine Record', {});
  assert.equal(q.reason, 'llm_unavailable');
  assert.equal(q.record.validation_errors.length, 2);

  sim.set('Insert Quarantine (Postgres)', { quarantine_id: 'q-9' });
  const msg = sim.run('Prepare Review Message', { quarantine_id: 'q-9' });
  assert.equal(msg.channel, '#financeiro-revisao');
  assert.match(JSON.stringify(msg.blocks), /q-9/);
});

test('fluxo B: regra de negócio violada -> quarentena business_rule', async () => {
  const sim = createSimulator(flowB);
  await intake(sim, { buffer: PDF });
  const p = sim.run('Parse Primary', toolUse(extraction({ total: 9999 })));
  const v = sim.run('Validate Invoice', p);
  assert.equal(v.validation.valid, false);
  const q = sim.run('Build Quarantine Record', v);
  assert.equal(q.reason, 'business_rule');
  assert.ok(q.record.validation_errors.some((e) => e.code === 'total_mismatch'));
  assert.ok(q.record.raw_extraction);
});

test('fluxo B: fornecedor+número já existentes -> quarentena duplicate_business_key', async () => {
  const sim = createSimulator(flowB);
  await intake(sim, { buffer: PDF });
  const p = sim.run('Parse Primary', toolUse(extraction()));
  sim.run('Validate Invoice', p);
  sim.set('Insert Invoice (Postgres)', {});
  const q = sim.run('Build Quarantine Record', {});
  assert.equal(q.reason, 'duplicate_business_key');
});
