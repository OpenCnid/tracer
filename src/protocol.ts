import { createHash } from 'node:crypto';
import type { SessionCreateParamsStreaming } from 'openai/resources/beta/agents/sessions/sessions';

export const PROTOCOL = 'native-seam-v2';
export const DEFAULT_MODEL = 'gpt-5.6-luna';
export const PREREGISTRATION = 'evidence/preregistration-v2.json';
export const SDK_VERSION = '7.15.0';
export const LIMITS = Object.freeze({
  sessions: 9, toolExecutions: 2, toolOutputBytes: 16_384,
  httpRequests: 40, pages: 12, events: 2_000, evidenceBytes: 8_388_608,
  deadlineMs: 120_000, studyUsd: 2, reservationUsd: 0.2,
});
export const ARMS = ['direct-native', 'programmatic-local', 'programmatic-native'] as const;
export type Arm = typeof ARMS[number];
export interface Trial { id: string; block: number; arm: Arm; seed: string; model: string }
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export function matrix(seed: string, model: string): Trial[] {
  return Array.from({ length: 3 }, (_, block) =>
    Array.from({ length: 3 }, (_, offset) => {
      const arm = ARMS[(offset + block) % ARMS.length]!;
      return { id: `b${block + 1}-${arm}`, block: block + 1, arm,
        seed: sha256(`${seed}:${block}:${arm}`), model };
    })).flat();
}

export function fixture(trial: Trial) {
  return { trial: trial.id, tasks: [0, 1].map(i => ({
    key: `task-${i}`, nonce: sha256(`${trial.seed}:${i}`).slice(0, 32),
    instruction: 'Reverse the nonce exactly. Preserve case. Return only the reversed string.',
  })) };
}

export function checkResults(trial: Trial, input: unknown): boolean {
  if (!input || typeof input !== 'object' || !('results' in input)) return false;
  const rows = input.results;
  if (!Array.isArray(rows) || rows.length !== 2) return false;
  const tasks = fixture(trial).tasks;
  return tasks.every(task => rows.filter(row => row && typeof row === 'object' &&
    row.key === task.key && row.value === [...task.nonce].reverse().join('')).length === 1);
}

const guides: Record<Arm, string> = {
  'direct-native': 'Call tracer_fixture directly. Delegate each of its two tasks to a separate native subagent in this session using direct delegation calls. Wait for both children. Send their exact answers to tracer_submit.',
  'programmatic-local': 'Use one generated JavaScript program through exec. In that program call tracer_fixture, loop over both tasks and reverse each nonce locally, then call tracer_submit from that same program. Do not delegate.',
  'programmatic-native': 'Use a generated JavaScript program through exec. Inside the program call tracer_fixture and loop over both tasks. For each task, construct its child prompt from the fixture, invoke a native subagent in this session FROM THE PROGRAM, collect its completed answer as a value in code, and submit both answers through tracer_submit FROM CODE. Use the native tools and signatures actually exposed by the runtime. Do not invent tool names, reverse the nonce in the parent, move delegation outside code, or start independent API sessions. If a required native operation is not available to the program, make at most one valid attempt if possible and report the actual error or missing capability. Do not substitute another route.',
};

export function requestFor(trial: Trial): SessionCreateParamsStreaming {
  return {
    agent: {
      model: trial.model, service_tier: 'default', reasoning: { effort: 'low' },
      instructions: 'This is a bounded integration probe. Follow the specified route. Use no web, shell, or external services. Stop after one fixture call and one submission. For a native-delegation arm create exactly two children, use the same model as this session, instruct each child to perform only its assigned string transformation without delegation, and wait for both. Do not retry tasks. A failure is useful evidence; report it truthfully. Finish with a short explanation of what executed.',
      multi_agent: trial.arm === 'programmatic-local' ? { enabled: false } :
        { enabled: true, max_concurrent_subagents: 1 },
      tools: [
        { type: 'programmatic_tool_calling', enabled: trial.arm !== 'direct-native' },
        { type: 'function', name: 'tracer_fixture', description: 'Return JSON with trial and tasks: two objects with key, nonce, instruction. No arguments.',
          parameters: { type: 'object', properties: {}, additionalProperties: false } },
        { type: 'function', name: 'tracer_submit', description: 'Submit exactly two results as {results:[{key,value}]}. Returns JSON {accepted:boolean}. Call once.',
          parameters: { type: 'object', properties: { results: { type: 'array', minItems: 2, maxItems: 2,
            items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } },
              required: ['key', 'value'], additionalProperties: false } } }, required: ['results'], additionalProperties: false } },
      ],
    },
    environment: { type: 'none' }, metadata: { protocol: PROTOCOL, trial: trial.id },
    input: guides[trial.arm], stream: true,
  };
}
