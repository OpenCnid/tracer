import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIMITS, sha256 } from './protocol.js';

export class Evidence {
  private sequence = 0;
  private previous = '0'.repeat(64);
  private bytes = 0;
  constructor(readonly directory: string, private readonly secrets: string[] = []) {
    mkdirSync(directory, { recursive: true });
    // Exclusive creation prevents accidentally overwriting an earlier attempt.
    writeFileSync(join(directory, 'events.jsonl'), '', { flag: 'wx' });
  }
  private encode(value: unknown) {
    let text = JSON.stringify(value);
    for (const secret of this.secrets.filter(Boolean)) text = text.split(secret).join('[REDACTED]');
    return text;
  }
  write(name: string, value: unknown) {
    if (!/^[a-z0-9-]+\.json$/.test(name)) throw new Error('INVALID_EVIDENCE_NAME');
    writeFileSync(join(this.directory, name), this.encode(value) + '\n', { flag: 'wx' });
  }
  record(kind: string, data: unknown) {
    const body = JSON.parse(this.encode({ sequence: this.sequence, at: new Date().toISOString(),
      kind, data, previous: this.previous })) as Record<string, unknown>;
    const hash = sha256(JSON.stringify(body));
    const line = JSON.stringify({ ...body, hash }) + '\n';
    if (this.bytes + Buffer.byteLength(line) > LIMITS.evidenceBytes) throw new Error('EVIDENCE_BYTE_CAP');
    appendFileSync(join(this.directory, 'events.jsonl'), line);
    this.bytes += Buffer.byteLength(line); this.previous = hash; this.sequence++;
  }
  tryRecord(kind: string, data: unknown): boolean {
    try { this.record(kind, data); return true; } catch { return false; }
  }
}

export function verifyLog(path: string): number {
  let previous = '0'.repeat(64); let sequence = 0;
  for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
    const { hash, ...body } = JSON.parse(line) as Record<string, unknown>;
    if (body.sequence !== sequence || body.previous !== previous || sha256(JSON.stringify(body)) !== hash)
      throw new Error('EVIDENCE_CHAIN_INVALID');
    previous = String(hash); sequence++;
  }
  return sequence;
}

export function safeError(error: unknown) {
  // Do not persist SDK request objects, headers, or arbitrary response bodies.
  const e = error as { name?: string; status?: number; code?: string; request_id?: string };
  return { name: e?.name ?? 'Error', status: e?.status ?? null,
    code: e?.code ?? null, request_id: e?.request_id ?? null };
}
