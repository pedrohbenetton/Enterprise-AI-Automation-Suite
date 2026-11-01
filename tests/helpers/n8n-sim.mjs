// Mini-simulador de Code nodes do n8n: executa o jsCode EMBUTIDO no JSON exportado
// com $json, $('Nó').first()/isExecuted, $input e this.helpers mockados.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

export function createSimulator(workflow, initial = {}) {
  const out = { ...initial };
  const codeOf = (name) => {
    const node = workflow.nodes.find((n) => n.name === name);
    if (!node || node.type !== 'n8n-nodes-base.code') throw new Error(`Code node inexistente: ${name}`);
    return node.parameters.jsCode;
  };
  const $ = (name) => ({
    first: () => {
      if (!(name in out)) throw new Error(`nó não executado: ${name}`);
      return { json: out[name] };
    },
    get isExecuted() { return name in out; },
  });

  return {
    // mode: runOnceForEachItem
    run(name, $json) {
      const result = new Function('$json', '$', 'require', codeOf(name))($json, $, require);
      out[name] = result.json;
      return result.json;
    },
    // mode: runOnceForAllItems (async, com this.helpers)
    async runAll(name, items, helpers = {}) {
      const fn = new AsyncFunction('$input', '$', 'require', codeOf(name));
      const result = await fn.call({ helpers }, { all: () => items }, $, require);
      if (result[0]) out[name] = result[0].json;
      return result;
    },
    set(name, json) {
      out[name] = json;
      return json;
    },
  };
}
