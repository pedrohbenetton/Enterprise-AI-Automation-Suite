// Fluxo A — enriquecimento de empresa/contato.
// Heurística local sempre roda; API externa (opcional) apenas sobrescreve quando responde algo útil.
// Embutido nos Code nodes "Heuristic Enrichment" e "Merge Enrichment".

const FREE_EMAIL_DOMAINS = [
  'gmail.com', 'googlemail.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.com.br', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com',
  'bol.com.br', 'uol.com.br', 'terra.com.br', 'ig.com.br', 'gmx.com', 'zoho.com',
];

const TLD_COUNTRY = { br: 'BR', pt: 'PT', ar: 'AR', mx: 'MX', es: 'ES', uk: 'GB', de: 'DE', fr: 'FR', it: 'IT', cl: 'CL', co: 'CO' };
const SECOND_LEVEL = ['com', 'net', 'org', 'gov', 'edu', 'co', 'ind', 'adv'];

function sizeTier(employees) {
  const n = Number(employees);
  if (!Number.isFinite(n) || n <= 0) return 'unknown';
  if (n >= 1000) return 'enterprise';
  if (n >= 200) return 'mid_market';
  return 'smb';
}

function companyFromDomain(domain) {
  const labels = domain.toLowerCase().split('.');
  // acme.com.br -> acme ; app.acme.io -> acme
  let idx = labels.length - 2;
  if (labels.length >= 3 && SECOND_LEVEL.includes(labels[labels.length - 2])) idx = labels.length - 3;
  const label = labels[Math.max(idx, 0)];
  return label
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function heuristicEnrichment(lead) {
  const domain = (lead.domain || '').toLowerCase();
  const isFreeEmail = FREE_EMAIL_DOMAINS.includes(domain);
  const tld = domain.split('.').pop();
  return {
    source: 'heuristic',
    domain,
    isFreeEmail,
    isCorporate: Boolean(domain) && !isFreeEmail,
    companyName: lead.company || (domain && !isFreeEmail ? companyFromDomain(domain) : null),
    industry: null,
    employees: null,
    sizeTier: 'unknown',
    country: TLD_COUNTRY[tld] || null,
    fallbackReason: null,
  };
}

function pick(obj, paths) {
  for (const p of paths) {
    const v = p.split('.').reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined), obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

function mergeEnrichment(base, apiResponse) {
  if (!apiResponse || typeof apiResponse !== 'object') return { ...base };
  if (apiResponse.error) {
    const msg = typeof apiResponse.error === 'string' ? apiResponse.error : apiResponse.error.message;
    return { ...base, fallbackReason: `enrichment_api_error: ${msg || 'unknown'}` };
  }

  // Aceita formatos comuns (Clearbit, Apollo, PDL) sem acoplar a um fornecedor
  const name = pick(apiResponse, ['name', 'company.name', 'organization.name']);
  const industry = pick(apiResponse, ['category.industry', 'industry', 'organization.industry']);
  const employeesRaw = pick(apiResponse, ['metrics.employees', 'employees', 'employeeCount', 'organization.estimated_num_employees']);
  const country = pick(apiResponse, ['geo.countryCode', 'country', 'location.country_code']);
  if (!name && !industry && !employeesRaw) return { ...base };

  const employees = employeesRaw !== null && Number.isFinite(Number(employeesRaw)) ? Number(employeesRaw) : null;
  return {
    ...base,
    source: 'api',
    companyName: name || base.companyName,
    industry: industry || null,
    employees,
    sizeTier: sizeTier(employees),
    country: country ? String(country).toUpperCase().slice(0, 2) : base.country,
  };
}

// --- test exports ---
module.exports = { heuristicEnrichment, mergeEnrichment, sizeTier };
