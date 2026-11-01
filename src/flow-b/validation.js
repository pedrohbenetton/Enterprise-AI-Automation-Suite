// Fluxo B — validação de schema + regras de negócio sobre a extração da LLM.
// Nada vai para o banco sem passar por aqui. Erros => quarentena; avisos => apenas registrados.
// Embutido no Code node "Validate Invoice".

const DOC_TYPES_OK = ['invoice', 'nfe', 'nfse', 'receipt', 'other'];

function round2(n) {
  return Math.round(n * 100) / 100;
}

function normalizeMoney(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? round2(v) : null;
  if (typeof v !== 'string') return null;
  let s = v.replace(/[^\d,.-]/g, '');
  if (!/\d/.test(s)) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  // Separador decimal = o último que aparecer (1.234,56 vs 1,234.56)
  s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? round2(n) : null;
}

function normalizeDate(v) {
  if (typeof v !== 'string') return null;
  let y; let m; let d;
  let match = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
  if (match) [, y, m, d] = match;
  else {
    match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v.trim());
    if (!match) return null;
    [, d, m, y] = match;
  }
  const iso = `${y}-${m}-${d}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === iso ? iso : null;
}

function normalizeTaxId(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).toUpperCase().replace(/[^0-9A-Z]/g, '');
  return s || null;
}

function checkDigits(base, weights) {
  // CNPJ alfanumérico (IN RFB 2.229/2024): valor do caractere = código ASCII - 48
  const sum = [...base].reduce((acc, ch, i) => acc + (ch.charCodeAt(0) - 48) * weights[i], 0) % 11;
  return sum < 2 ? 0 : 11 - sum;
}

function isValidCnpj(id) {
  if (!/^[0-9A-Z]{12}\d{2}$/.test(id) || /^(\d)\1{13}$/.test(id)) return false;
  const d1 = checkDigits(id.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = checkDigits(id.slice(0, 12) + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return id.endsWith(`${d1}${d2}`);
}

function isValidCpf(id) {
  if (!/^\d{11}$/.test(id) || /^(\d)\1{10}$/.test(id)) return false;
  const dv = (len) => {
    const sum = [...id.slice(0, len)].reduce((acc, ch, i) => acc + Number(ch) * (len + 1 - i), 0);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(id[9]) && dv(10) === Number(id[10]);
}

function approxEqual(a, b) {
  return Math.abs(a - b) <= Math.max(0.05, Math.abs(b) * 0.005);
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function validateTaxId(raw, currency, role, errors, warnings) {
  const id = normalizeTaxId(raw);
  if (!id) return null;
  const brazilian = /^[0-9A-Z]{12}\d{2}$/.test(id) || /^\d{11}$/.test(id);
  if (brazilian) {
    const ok = id.length === 14 ? isValidCnpj(id) : isValidCpf(id);
    if (!ok) errors.push({ code: `${role}_tax_id_invalid`, message: `${role}: CNPJ/CPF com dígito verificador inválido (${raw})` });
  } else if (currency === 'BRL') {
    errors.push({ code: `${role}_tax_id_invalid`, message: `${role}: identificador fiscal em formato desconhecido (${raw})` });
  } else {
    warnings.push({ code: 'foreign_tax_id', message: `${role}: identificador estrangeiro não validado (${raw})` });
  }
  return id;
}

function validateInvoice(raw, { minConfidence, today }) {
  const errors = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: [{ code: 'shape_invalid', message: 'extração não é um objeto' }], warnings, invoice: null };
  }

  if (raw.document_type === 'not_invoice') errors.push({ code: 'not_invoice', message: 'documento não é fatura/nota/recibo' });
  else if (!DOC_TYPES_OK.includes(raw.document_type)) errors.push({ code: 'shape_invalid', message: `document_type inválido: ${raw.document_type}` });

  const currency = typeof raw.currency === 'string' && /^[A-Za-z]{3}$/.test(raw.currency.trim()) ? raw.currency.trim().toUpperCase() : 'BRL';
  const supplier = raw.supplier && typeof raw.supplier === 'object' ? raw.supplier : {};
  const customer = raw.customer && typeof raw.customer === 'object' ? raw.customer : {};

  const supplierName = typeof supplier.name === 'string' ? supplier.name.trim() : '';
  if (!supplierName) errors.push({ code: 'supplier_name_missing', message: 'nome do fornecedor ausente' });
  const supplierTaxId = validateTaxId(supplier.tax_id, currency, 'supplier', errors, warnings);
  if (!supplierTaxId) errors.push({ code: 'supplier_tax_id_missing', message: 'CNPJ/CPF/VAT do fornecedor ausente' });
  const customerTaxId = validateTaxId(customer.tax_id, currency, 'customer', errors, warnings);

  const invoiceNumber = raw.invoice_number !== null && raw.invoice_number !== undefined ? String(raw.invoice_number).trim() : '';
  if (!invoiceNumber) errors.push({ code: 'invoice_number_missing', message: 'número da fatura ausente' });

  const issueDate = normalizeDate(raw.issue_date);
  const dueDate = normalizeDate(raw.due_date);
  if (!issueDate) errors.push({ code: 'issue_date_invalid', message: `data de emissão inválida: ${raw.issue_date}` });
  else {
    if (issueDate > addDays(today, 1)) errors.push({ code: 'issue_date_future', message: `emissão no futuro: ${issueDate}` });
    if (issueDate < addDays(today, -5 * 365)) warnings.push({ code: 'issue_date_old', message: `emissão há mais de 5 anos: ${issueDate}` });
  }
  if (raw.due_date && !dueDate) warnings.push({ code: 'due_date_unparsed', message: `vencimento ilegível: ${raw.due_date}` });
  if (issueDate && dueDate && dueDate < issueDate) errors.push({ code: 'due_before_issue', message: 'vencimento anterior à emissão' });

  const lineItems = (Array.isArray(raw.line_items) ? raw.line_items : []).map((li, i) => {
    const item = {
      description: String((li && li.description) || `item ${i + 1}`).slice(0, 500),
      quantity: normalizeMoney(li && li.quantity),
      unit_price: normalizeMoney(li && li.unit_price),
      total: normalizeMoney(li && li.total),
    };
    if (item.quantity !== null && item.unit_price !== null && item.total !== null
      && !approxEqual(round2(item.quantity * item.unit_price), item.total)) {
      warnings.push({ code: 'line_item_math', message: `item ${i + 1}: quantidade × preço ≠ total` });
    }
    return item;
  });

  const subtotal = normalizeMoney(raw.subtotal);
  const taxTotal = normalizeMoney(raw.tax_total);
  const discount = normalizeMoney(raw.discount_total) || 0;
  const other = normalizeMoney(raw.other_charges) || 0;
  const total = normalizeMoney(raw.total);

  if (total === null) errors.push({ code: 'total_missing', message: 'valor total ausente' });
  else if (total < 0) errors.push({ code: 'total_negative', message: 'valor total negativo' });

  const itemsSum = lineItems.every((li) => li.total !== null) && lineItems.length ? round2(lineItems.reduce((a, li) => a + li.total, 0)) : null;
  if (itemsSum !== null && subtotal !== null && !approxEqual(itemsSum, subtotal)) {
    errors.push({ code: 'line_items_mismatch', message: `soma dos itens (${itemsSum}) ≠ subtotal (${subtotal})` });
  }

  const base = subtotal !== null ? subtotal : itemsSum;
  if (total !== null && base !== null) {
    const withTax = round2(base + (taxTotal || 0) - discount + other);
    const taxEmbedded = round2(base - discount + other); // ex.: ICMS/ISS já incluso nos itens
    if (!approxEqual(withTax, total) && !approxEqual(taxEmbedded, total)) {
      errors.push({ code: 'total_mismatch', message: `total (${total}) ≠ subtotal ± impostos/descontos (${withTax} ou ${taxEmbedded})` });
    }
  } else if (total !== null) {
    warnings.push({ code: 'no_breakdown', message: 'sem itens/subtotal para conferir o total' });
  }

  const confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence) || confidence < minConfidence) {
    errors.push({ code: 'low_confidence', message: `confiança ${raw.confidence} abaixo do mínimo ${minConfidence}` });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    invoice: {
      supplier_name: supplierName || null,
      supplier_tax_id: supplierTaxId,
      customer_name: typeof customer.name === 'string' && customer.name.trim() ? customer.name.trim() : null,
      customer_tax_id: customerTaxId,
      invoice_number: invoiceNumber || null,
      issue_date: issueDate,
      due_date: dueDate,
      currency,
      subtotal,
      tax_total: taxTotal,
      total,
      line_items: lineItems,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, round2(confidence))) : null,
    },
  };
}

// --- test exports ---
module.exports = {
  normalizeMoney, normalizeDate, normalizeTaxId, isValidCnpj, isValidCpf, validateInvoice,
};
