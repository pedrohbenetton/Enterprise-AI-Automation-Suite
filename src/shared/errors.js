// Error Workflow global — normaliza o payload do Error Trigger do n8n
// em um registro da DLQ (tabela workflow_errors) e no texto de alerta do Slack.

function formatErrorEvent(event) {
  const exec = (event && event.execution) || {};
  const trigger = (event && event.trigger) || {};
  const wf = (event && event.workflow) || {};
  const err = exec.error || trigger.error || {};
  const message = String(err.message || err.description || 'erro desconhecido').slice(0, 2000);

  const record = {
    workflow_id: wf.id ? String(wf.id) : null,
    workflow_name: wf.name || 'desconhecido',
    execution_id: exec.id ? String(exec.id) : null,
    execution_url: exec.url || null,
    failed_node: exec.lastNodeExecuted || (err.node && err.node.name) || null,
    error_message: message,
    error_stack: err.stack ? String(err.stack).slice(0, 8000) : null,
    payload: { mode: exec.mode || trigger.mode || null },
  };

  const slackText = [
    `:red_circle: *Falha no workflow* \`${record.workflow_name}\``,
    `Nó: ${record.failed_node || 'n/a'}`,
    `Erro: ${message.slice(0, 500)}`,
    record.execution_url ? `Execução: ${record.execution_url}` : 'Execução: (falha no gatilho)',
  ].join('\n');

  return { record, slackText };
}

// --- test exports ---
module.exports = { formatErrorEvent };
