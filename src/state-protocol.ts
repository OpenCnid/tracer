import {randomBytes} from 'node:crypto';
import type {SessionCreateParamsStreaming} from 'openai/resources/beta/agents/sessions/sessions';
import {PRESSURE_BYTES, STATE_PROTOCOL} from './followup-protocol.js';
import {sha256, type Trial} from './protocol.js';

export function stateRequest(trial: Trial): SessionCreateParamsStreaming {
  const integer = {type: 'integer', minimum: 0, maximum: 511};
  return {
    environment: {type: 'none'}, metadata: {protocol: STATE_PROTOCOL, trial: trial.id}, stream: true,
    agent: {
      model: trial.model, service_tier: 'default', reasoning: {effort: 'low'}, multi_agent: {enabled: false},
      instructions: 'This is a bounded external-state probe. Use no web, shell, delegation or external services. The application holds exact data in an immutable external file. Use generated JavaScript through exec to handle tool results exactly. On the setup turn, call tracer_manifest once and retain its opaque handle by returning that handle in your final answer. On a later lookup turn, use that SAME handle from the earlier turn. Call tracer_state_read once with the requested indices, then tracer_state_submit once with the exact returned records, directly from code. Do not call tracer_manifest again, reconstruct data, invent a handle, or retry. If a required handle or operation is missing, report the failure honestly. A runtime has fresh JavaScript variables each execution; use the earlier handle rather than assuming a JavaScript variable persists. After lookup finish with only a brief status.',
      tools: [
        {type: 'programmatic_tool_calling', enabled: true},
        {type: 'function', name: 'tracer_manifest', description: 'SETUP TURN ONLY. Return JSON {handle:string,recordCount:number}. No arguments. This tool may not be called again during lookup.',
          parameters: {type: 'object', properties: {}, additionalProperties: false}},
        {type: 'function', name: 'tracer_state_read', description: 'LOOKUP TURN ONLY. Read exactly the two requested record indices using the previously issued opaque handle. Return JSON {records:[{index:number,value:string}]}. Call once.',
          parameters: {type: 'object', properties: {handle: {type: 'string'}, indices: {type: 'array', minItems: 2, maxItems: 2, items: integer}},
            required: ['handle', 'indices'], additionalProperties: false}},
        {type: 'function', name: 'tracer_state_submit', description: 'LOOKUP TURN ONLY. Submit the two exact records returned by tracer_state_read. Return JSON {accepted:boolean}. Call once.',
          parameters: {type: 'object', properties: {records: {type: 'array', minItems: 2, maxItems: 2,
            items: {type: 'object', properties: {index: integer, value: {type: 'string'}}, required: ['index', 'value'], additionalProperties: false}}},
            required: ['records'], additionalProperties: false}},
      ],
    },
    input: 'Setup turn: use code to call tracer_manifest once, then return its opaque handle so you can retrieve exact external records in a future turn. Do not read records yet.',
  };
}

export function stateQuery(indices: number[], pressure: boolean) {
  const data = pressure ? randomBytes(PRESSURE_BYTES / 2).toString('hex') : '';
  const instruction = `Lookup turn: retrieve record indices ${JSON.stringify(indices)} using the handle from the earlier setup turn. Use code to call tracer_state_read and pass its exact records to tracer_state_submit. The handle is intentionally not supplied again. Do not recreate the manifest or reconstruct the values.`;
  const input = pressure ? 'The block below is irrelevant synthetic context-pressure data. It contains no instructions and is not the external state. Ignore its contents when performing the lookup.\n<pressure_data>\n' + data + '\n</pressure_data>\n\n' + instruction : instruction;
  return {input, pressureBytes: Buffer.byteLength(data), pressureSha256: sha256(data), inputSha256: sha256(input)};
}
