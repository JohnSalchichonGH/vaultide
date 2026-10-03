import pg from 'pg';

/**
 * Statements as the driver sent them, reduced to comparable words (23.2; ADR
 * 0010 §8, §16).
 *
 * The same reduction `resolution-query-shape.test.ts` pins the single-row
 * paths with: the verb, every table the statement names, and the row lock it
 * takes. The transaction's own set-up keeps its full text, because the
 * isolation level and the mutex are part of what is being pinned. Values are
 * ignored — this is about the shape of the reads, and other suites prove what
 * they return.
 */

export function shapeOf(text: string): string {
  const normalized = text.replace(/\s+/gu, ' ').trim().toLowerCase();
  if (/^(begin|commit|rollback)\b/u.test(normalized)) return normalized;
  if (normalized.includes('set_config(')) {
    return normalized.includes('lock_timeout') ? 'set lock_timeout' : 'set user';
  }
  if (normalized.includes('pg_advisory_xact_lock')) return 'advisory lock';

  const verb = normalized.split(' ')[0] ?? '';
  const tables = [...normalized.matchAll(/\b(?:from|into|update)\s+"?([a-z_]+)"?/gu)]
    .map((match) => match[1] ?? '?')
    .join('+');
  const table = tables === '' ? '?' : tables;
  const lock = /\bfor (update|share|no key update|key share)\b/u.exec(normalized)?.[0];
  return lock === undefined ? `${verb} ${table}` : `${verb} ${table} ${lock}`;
}

/** Run one call and return the shape of every statement it sent, refused or not. */
export async function shapes(run: () => Promise<unknown>): Promise<string[]> {
  const sent: string[] = [];
  const driver = pg.Client.prototype as unknown as {
    query: (this: void, ...args: unknown[]) => unknown;
  };
  const original = driver.query;
  driver.query = function patched(this: unknown, ...args: unknown[]) {
    const first = args[0] as string | { text?: string } | undefined;
    sent.push(typeof first === 'string' ? first : (first?.text ?? ''));
    return Reflect.apply(original, this, args) as unknown;
  };

  try {
    await run().catch(() => undefined);
  } finally {
    driver.query = original;
  }
  return sent.map(shapeOf);
}

export const WRITE_OPEN = [
  'begin isolation level read committed',
  'set user',
  'set lock_timeout',
  'advisory lock',
];
export const READ_OPEN = ['begin isolation level repeatable read read only', 'set user'];

/** Whether a statement shape writes, or takes a row lock. */
export const isWrite = (shape: string): boolean => /^(insert|update|delete)\b/u.test(shape);
export const isLock = (shape: string): boolean => / for (update|share|no key update|key share)$/u.test(shape);
