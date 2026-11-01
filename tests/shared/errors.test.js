const test = require('node:test');
const assert = require('node:assert/strict');
const { formatErrorEvent } = require('../../src/shared/errors.js');

test('formatErrorEvent monta registro da DLQ e texto do alerta', () => {
  const ev = {
    execution: {
      id: '231', url: 'http://localhost:5678/workflow/1/executions/231', lastNodeExecuted: 'Save Audit (Postgres)',
      mode: 'webhook', error: { message: 'connect ECONNREFUSED 172.18.0.2:5432', stack: 'Error: connect...\n at x' },
    },
    workflow: { id: 'abc', name: '01 - Inbound Lead & Ticket Triage' },
  };
  const { record, slackText } = formatErrorEvent(ev);
  assert.equal(record.workflow_name, '01 - Inbound Lead & Ticket Triage');
  assert.equal(record.failed_node, 'Save Audit (Postgres)');
  assert.equal(record.execution_id, '231');
  assert.match(record.error_message, /ECONNREFUSED/);
  assert.match(slackText, /Save Audit/);
  assert.match(slackText, /executions\/231/);
});

test('formatErrorEvent tolera falha no gatilho (sem execution.id)', () => {
  const { record, slackText } = formatErrorEvent({
    trigger: { error: { message: 'Webhook inválido' }, mode: 'trigger' },
    workflow: { id: 'x', name: 'WF' },
  });
  assert.equal(record.execution_id, null);
  assert.match(record.error_message, /Webhook inválido/);
  assert.ok(slackText.length > 0);
});
