const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeMoney, normalizeDate, normalizeTaxId, isValidCnpj, isValidCpf, validateInvoice,
} = require('../../src/flow-b/validation.js');

const TODAY = '2026-10-31';

const good = (over = {}) => ({
  document_type: 'nfe',
  supplier: { name: 'Fornecedor Exemplo Ltda', tax_id: '11.222.333/0001-81' },
  customer: { name: 'Cliente SA', tax_id: '529.982.247-25' },
  invoice_number: '000123',
  issue_date: '2026-10-15',
  due_date: '2026-11-14',
  currency: 'BRL',
  line_items: [
    { description: 'Licença SaaS', quantity: 10, unit_price: 100, total: 1000 },
    { description: 'Implantação', quantity: 1, unit_price: 500, total: 500 },
  ],
  subtotal: 1500,
  tax_total: 150,
  discount_total: null,
  other_charges: null,
  total: 1650,
  confidence: 0.93,
  ...over,
});

test('normalizeMoney entende formatos BR, US e número', () => {
  assert.equal(normalizeMoney('R$ 1.234,56'), 1234.56);
  assert.equal(normalizeMoney('1,234.56'), 1234.56);
  assert.equal(normalizeMoney(99.999), 100);
  assert.equal(normalizeMoney('abc'), null);
  assert.equal(normalizeMoney(null), null);
});

test('normalizeDate aceita ISO e DD/MM/AAAA, rejeita datas impossíveis', () => {
  assert.equal(normalizeDate('2026-10-15'), '2026-10-15');
  assert.equal(normalizeDate('15/10/2026'), '2026-10-15');
  assert.equal(normalizeDate('2026-02-30'), null);
  assert.equal(normalizeDate('ontem'), null);
});

test('CNPJ numérico, CNPJ alfanumérico (2026) e CPF', () => {
  assert.equal(isValidCnpj('11222333000181'), true);
  assert.equal(isValidCnpj('11222333000182'), false);
  assert.equal(isValidCnpj('11111111111111'), false);
  assert.equal(isValidCnpj('12ABC34501DE35'), true);
  assert.equal(isValidCpf('52998224725'), true);
  assert.equal(isValidCpf('52998224724'), false);
  assert.equal(normalizeTaxId('12.abc.345/01de-35'), '12ABC34501DE35');
});

test('fatura consistente é válida e normalizada', () => {
  const r = validateInvoice(good(), { minConfidence: 0.7, today: TODAY });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.equal(r.invoice.supplier_tax_id, '11222333000181');
  assert.equal(r.invoice.customer_tax_id, '52998224725');
  assert.equal(r.invoice.total, 1650);
  assert.equal(r.invoice.line_items.length, 2);
});

test('aceita impostos embutidos (total = subtotal)', () => {
  const r = validateInvoice(good({ tax_total: 270, total: 1500 }), { minConfidence: 0.7, today: TODAY });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

test('rejeita total inconsistente com itens', () => {
  const r = validateInvoice(good({ subtotal: 1500, total: 9999 }), { minConfidence: 0.7, today: TODAY });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.code === 'total_mismatch'));
});

test('rejeita soma de itens diferente do subtotal', () => {
  const r = validateInvoice(good({ subtotal: 2000, total: 2150 }), { minConfidence: 0.7, today: TODAY });
  assert.ok(r.errors.some((e) => e.code === 'line_items_mismatch'));
});

test('rejeita CNPJ inválido, campos obrigatórios e datas incoerentes', () => {
  const r = validateInvoice(good({
    supplier: { name: '', tax_id: '11.222.333/0001-00' },
    invoice_number: null,
    issue_date: '2026-12-20',
    due_date: '2026-12-01',
  }), { minConfidence: 0.7, today: TODAY });
  const codes = r.errors.map((e) => e.code);
  assert.equal(r.valid, false);
  for (const c of ['supplier_name_missing', 'supplier_tax_id_invalid', 'invoice_number_missing', 'issue_date_future', 'due_before_issue']) {
    assert.ok(codes.includes(c), `esperava ${c} em ${codes}`);
  }
});

test('rejeita documento que não é fatura e baixa confiança', () => {
  assert.ok(validateInvoice(good({ document_type: 'not_invoice' }), { minConfidence: 0.7, today: TODAY })
    .errors.some((e) => e.code === 'not_invoice'));
  assert.ok(validateInvoice(good({ confidence: 0.4 }), { minConfidence: 0.7, today: TODAY })
    .errors.some((e) => e.code === 'low_confidence'));
});

test('VAT estrangeiro vira aviso, não erro', () => {
  const r = validateInvoice(good({ currency: 'EUR', supplier: { name: 'ACME GmbH', tax_id: 'DE123456789' } }), { minConfidence: 0.7, today: TODAY });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.code === 'foreign_tax_id'));
});

test('extração não-objeto é inválida', () => {
  assert.equal(validateInvoice(null, { minConfidence: 0.7, today: TODAY }).valid, false);
});
