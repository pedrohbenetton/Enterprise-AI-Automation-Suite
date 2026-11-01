// Error Workflow global: registra falhas não tratadas na DLQ (Postgres) e alerta o time no Slack.
// Configure-o em Settings > Error Workflow de cada workflow de negócio.

import { createWorkflow, httpJson, RESILIENT, CREDS, AUTH, deterministicUuid } from './lib.mjs';

const WF = '00 - Global Error Handler';

export default function build() {
  const w = createWorkflow(WF);

  const trigger = w.add('Error Trigger', 'n8n-nodes-base.errorTrigger', 1, [0, 300], {});

  const config = w.add('Load Config', 'n8n-nodes-base.set', 3.4, [220, 300], {
    mode: 'manual',
    assignments: {
      assignments: [{
        id: deterministicUuid(`${WF}:config`),
        name: 'config',
        type: 'object',
        value: "={{ { slackChannelOps: $env.SLACK_CHANNEL_OPS || '#automation-ops' } }}",
      }],
    },
    includeOtherFields: true,
    options: {},
  });

  const format = w.code('Format Error', [440, 300], {
    modules: ['src/shared/errors.js'],
    entry: 'return { json: formatErrorEvent($json) };',
  });

  // Continua mesmo se o Postgres estiver fora — o alerta no Slack é o canal de último recurso
  const dlq = w.add('Log to DLQ (Postgres)', 'n8n-nodes-base.postgres', 2.5, [660, 300], {
    operation: 'executeQuery',
    query: `INSERT INTO workflow_errors (workflow_id, workflow_name, execution_id, execution_url, failed_node, error_message, error_stack, payload)
SELECT r.workflow_id, r.workflow_name, r.execution_id, r.execution_url, r.failed_node, r.error_message, r.error_stack, r.payload
FROM jsonb_populate_record(NULL::workflow_errors, $1::jsonb) AS r
RETURNING id;`,
    options: { queryReplacement: '={{ [JSON.stringify($json.record)] }}' },
  }, { credentials: CREDS.postgres, ...RESILIENT(3, 2000) });

  const alert = w.add('Alert Ops (Slack)', 'n8n-nodes-base.httpRequest', 4.2, [880, 300], httpJson({
    url: 'https://slack.com/api/chat.postMessage',
    auth: AUTH.slack,
    jsonBody: `={{ JSON.stringify({
  channel: $('Load Config').first().json.config.slackChannelOps,
  text: $('Format Error').first().json.slackText + ($json.error ? '\\n:warning: DLQ indisponível: ' + ($json.error.message || $json.error) : '\\nDLQ id: ' + $json.id)
}) }}`,
  }), { credentials: CREDS.slack, retryOnFail: true, maxTries: 3, waitBetweenTries: 3000 });

  w.chain(trigger, config, format, dlq, alert);

  w.sticky('E1', [-40, 40], {
    width: 960, height: 200, color: 2,
    content: '## Global Error Handler (DLQ)\nRecebe qualquer falha não tratada dos workflows que o referenciam em *Settings → Error Workflow*. Persiste em `workflow_errors` e alerta `#automation-ops`. Se o Postgres estiver fora, o alerta informa que a DLQ falhou.',
  });

  return w.build();
}
