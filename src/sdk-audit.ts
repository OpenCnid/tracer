import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { SDK_VERSION, sha256 } from './protocol.js';

export function auditSdk() {
  const paths = {
    sessions: 'node_modules/openai/src/resources/beta/agents/sessions/sessions.ts',
    agents: 'node_modules/openai/src/resources/beta/agents/agents.ts',
    events: 'node_modules/openai/src/resources/beta/agents/sessions/events.ts',
  };
  const files = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, readFileSync(path, 'utf8')]));
  const source = ts.createSourceFile(paths.sessions, files.sessions!, ts.ScriptTarget.Latest, true);
  const properties: Record<string, string[]> = {};
  function visit(node: ts.Node) {
    if (ts.isInterfaceDeclaration(node) && ['SessionCreateParamsBase', 'Agent', 'SessionUpdateParams'].includes(node.name.text)) {
      properties[node.name.text] = node.members.filter(ts.isPropertySignature).map(p => p.name.getText(source));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  const actual = (JSON.parse(readFileSync('node_modules/openai/package.json', 'utf8')) as {version: string}).version;
  return {
    expectedSdk: SDK_VERSION, actualSdk: actual, versionMatches: actual === SDK_VERSION,
    properties, files: Object.entries(paths).map(([key, path]) => ({ path, sha256: sha256(files[key]!) })),
    sessionBudgetErrorPresent: files.agents!.includes("'session_budget_exceeded'"),
    configurableSessionBudget: 'not exposed in reviewed public contract',
    maximumEnforceableSpendUsd: null,
    note: 'Property inventory is reproducible evidence, not an inference that no undocumented server limit exists.',
  };
}
