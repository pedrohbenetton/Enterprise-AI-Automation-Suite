// Helpers para declarar workflows n8n em código e gerar o JSON exportável.
// Motivo: a lógica dos Code nodes vive em src/ com testes unitários; o build embute o código
// no JSON, evitando escapar JavaScript à mão e garantindo IDs determinísticos (diffs limpos).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEST_EXPORTS_MARKER = '// --- test exports ---';

export function deterministicUuid(seed) {
  const h = createHash('sha256').update(seed).digest('hex');
  // Formato UUID v4 (versão/variante fixas) a partir do hash
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `4${h.slice(13, 16)}`,
    ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join('-');
}

export function readModule(relPath) {
  const src = readFileSync(path.join(ROOT, relPath), 'utf8').replace(/\r\n/g, '\n');
  const idx = src.indexOf(TEST_EXPORTS_MARKER);
  if (idx === -1) throw new Error(`${relPath}: marcador "${TEST_EXPORTS_MARKER}" ausente`);
  return src.slice(0, idx).trimEnd();
}

export function createWorkflow(name) {
  const nodes = [];
  const connections = {};

  const api = {
    nodes,
    connections,

    add(nodeName, type, typeVersion, position, parameters, extra = {}) {
      if (nodes.some((n) => n.name === nodeName)) throw new Error(`nó duplicado: ${nodeName}`);
      nodes.push({
        id: deterministicUuid(`${name}:${nodeName}`),
        name: nodeName,
        type,
        typeVersion,
        position,
        parameters,
        ...extra,
      });
      return nodeName;
    },

    // Code node: módulos de src/ (sem a seção de testes) + snippet de entrada específico do nó
    code(nodeName, position, { modules = [], entry, mode = 'runOnceForEachItem', notes }) {
      const header = `// GERADO por scripts/build-workflows.mjs a partir de: ${modules.join(', ') || '(inline)'}\n// Edite os arquivos-fonte e rode "npm run build" — não edite este código na UI.`;
      const jsCode = [header, ...modules.map(readModule), '// --- entrada do nó ---', entry.trim()].join('\n\n');
      return api.add(nodeName, 'n8n-nodes-base.code', 2, position, { mode, jsCode }, notes ? { notes, notesInFlow: true } : {});
    },

    sticky(id, position, { content, width = 300, height = 200, color = 7 }) {
      nodes.push({
        id: deterministicUuid(`${name}:sticky:${id}`),
        name: `Sticky Note ${id}`,
        type: 'n8n-nodes-base.stickyNote',
        typeVersion: 1,
        position,
        parameters: { content, width, height, color },
      });
    },

    link(from, to, outputIndex = 0, inputIndex = 0) {
      connections[from] ??= { main: [] };
      const outs = connections[from].main;
      while (outs.length <= outputIndex) outs.push([]);
      outs[outputIndex].push({ node: to, type: 'main', index: inputIndex });
    },

    chain(...names) {
      for (let i = 0; i < names.length - 1; i++) api.link(names[i], names[i + 1]);
    },

    build(settings = {}) {
      return {
        name,
        nodes,
        connections,
        active: false,
        settings: {
          executionOrder: 'v1',
          saveDataErrorExecution: 'all',
          saveDataSuccessExecution: 'all',
          saveManualExecutions: true,
          callerPolicy: 'workflowsFromSameOwner',
          ...settings,
        },
        pinData: {},
        meta: { templateCredsSetupCompleted: false },
      };
    },
  };
  return api;
}

// ---------------------------------------------------------------------------
// Fábricas de parâmetros reutilizadas pelos workflows
// ---------------------------------------------------------------------------

export function ifBoolean(id, leftValue) {
  return {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [{ id, leftValue, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
      combinator: 'and',
    },
    looseTypeValidation: true,
    options: {},
  };
}

export function respondJson(body, responseCode) {
  return { respondWith: 'json', responseBody: body, options: { responseCode } };
}

// HTTP Request com corpo JSON vindo de uma expressão
export function httpJson({ method = 'POST', url, jsonBody, auth, headers = [], query = [], timeout = 15000 }) {
  return {
    method,
    url,
    ...auth,
    sendQuery: query.length > 0,
    ...(query.length ? { queryParameters: { parameters: query } } : {}),
    sendHeaders: headers.length > 0,
    ...(headers.length ? { headerParameters: { parameters: headers } } : {}),
    sendBody: method !== 'GET',
    ...(method !== 'GET' ? { specifyBody: 'json', jsonBody } : {}),
    options: { timeout },
  };
}

// Retry com backoff fixo e, se ainda falhar, segue com o erro no item ({ error })
// para que o próximo Code node decida o fallback em vez de abortar a execução.
export const RESILIENT = (maxTries = 3, waitBetweenTries = 2000) => ({
  retryOnFail: true,
  maxTries,
  waitBetweenTries,
  onError: 'continueRegularOutput',
  alwaysOutputData: true,
});

export const CREDS = {
  anthropic: { httpHeaderAuth: { id: 'cred-anthropic-api', name: 'Anthropic API Key' } },
  webhookAuth: { httpHeaderAuth: { id: 'cred-inbound-webhook', name: 'Inbound Webhook Auth' } },
  enrichment: { httpHeaderAuth: { id: 'cred-enrichment-api', name: 'Enrichment API Key' } },
  hubspot: { hubspotAppToken: { id: 'cred-hubspot-app', name: 'HubSpot Private App' } },
  slack: { slackApi: { id: 'cred-slack-bot', name: 'Slack Bot' } },
  redis: { redis: { id: 'cred-redis-app', name: 'Redis Automation (db 1)' } },
  postgres: { postgres: { id: 'cred-postgres-app', name: 'Postgres Automation' } },
  googleSheets: { googleSheetsOAuth2Api: { id: 'cred-google-sheets', name: 'Google Sheets' } },
};

// Executa a query com um único parâmetro JSON mapeado para colunas via jsonb_populate_record:
// evita problemas de quoting/NULL com dezenas de parâmetros posicionais.
export function pgInsertFromJson({ table, columns, returning, onConflict = '', jsonExpr = '$json.record' }) {
  const cols = columns.join(', ');
  const sel = columns.map((c) => `r.${c}`).join(', ');
  return {
    operation: 'executeQuery',
    query: `INSERT INTO ${table} (${cols})\nSELECT ${sel}\nFROM jsonb_populate_record(NULL::${table}, $1::jsonb) AS r\n${onConflict ? `${onConflict}\n` : ''}RETURNING ${returning};`,
    options: { queryReplacement: `={{ [JSON.stringify(${jsonExpr})] }}` },
  };
}

export const AUTH = {
  headerCred: { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' },
  hubspot: { authentication: 'predefinedCredentialType', nodeCredentialType: 'hubspotAppToken' },
  slack: { authentication: 'predefinedCredentialType', nodeCredentialType: 'slackApi' },
};
