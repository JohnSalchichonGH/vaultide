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

/** One statement's shape, and the connection that sent it. */
export interface SentStatement {
  /**
   * 0 for the first connection the call spoke on, 1 for the next, and so on.
   * It tells connections apart and means nothing more: when a call uses two at
   * once, which one speaks first is the pool's and the network's choice.
   */
  readonly connection: number;
  readonly shape: string;
}

/**
 * Run one call and record every statement it sent, refused or not, with the
 * connection that sent it.
 *
 * The patch is on the driver's prototype, so it sees every pooled client the
 * call checks out, and a call that reads on two connections at once is
 * recorded whole.
 */
export async function record(run: () => Promise<unknown>): Promise<SentStatement[]> {
  const sent: { connection: number; text: string }[] = [];
  const connections = new WeakMap<object, number>();
  let opened = 0;
  const driver = pg.Client.prototype as unknown as {
    query: (this: void, ...args: unknown[]) => unknown;
  };
  const original = driver.query;
  driver.query = function patched(this: unknown, ...args: unknown[]) {
    const client = this as object;
    let connection = connections.get(client);
    if (connection === undefined) {
      connection = opened;
      opened += 1;
      connections.set(client, connection);
    }
    const first = args[0] as string | { text?: string } | undefined;
    sent.push({ connection, text: typeof first === 'string' ? first : (first?.text ?? '') });
    return Reflect.apply(original, this, args) as unknown;
  };

  try {
    await run().catch(() => undefined);
  } finally {
    driver.query = original;
  }
  return sent.map(({ connection, text }) => ({ connection, shape: shapeOf(text) }));
}

/**
 * Run one call, and tell `onAnswered` about each statement the driver
 * answers: its shape and the connection that sent it, as `record` numbers
 * them.
 *
 * The listener is attached to the driver's promise before that promise is
 * handed back, so it hears each answer before the code that sent the
 * statement does. A test can therefore act at an exact point in a call: once
 * a statement is answered, and before anything that follows it has run.
 * Unlike `record`, the call's own result and errors are passed through.
 */
export async function whileAnswering<T>(
  run: () => Promise<T>,
  onAnswered: (statement: SentStatement) => void,
): Promise<T> {
  const connections = new WeakMap<object, number>();
  let opened = 0;
  const driver = pg.Client.prototype as unknown as {
    query: (this: void, ...args: unknown[]) => unknown;
  };
  const original = driver.query;
  driver.query = function patched(this: unknown, ...args: unknown[]) {
    const client = this as object;
    let connection = connections.get(client);
    if (connection === undefined) {
      connection = opened;
      opened += 1;
      connections.set(client, connection);
    }
    const first = args[0] as string | { text?: string } | undefined;
    const statement = { connection, shape: shapeOf(typeof first === 'string' ? first : (first?.text ?? '')) };
    const answer = Reflect.apply(original, this, args) as unknown;
    if (answer instanceof Promise) {
      void answer.then(
        () => {
          onAnswered(statement);
        },
        () => undefined,
      );
    }
    return answer;
  };

  try {
    return await run();
  } finally {
    driver.query = original;
  }
}

/**
 * Each connection's statements, in the order that connection sent them.
 *
 * Within one connection the order is the code's: a transaction sends its
 * statements one after another, so a statement that moves is a real change.
 * Between connections it is not. Two reads running at once on pooled clients
 * interleave however they are scheduled — the Bulk History grid read's
 * snapshot and its currency read did, on main CI run 37132188079.
 *
 * So no connection's statements are ever reordered; only the connections
 * themselves are listed in a fixed order of their content. A comparison is
 * then blind to the scheduling and to nothing else: a statement added,
 * dropped, reordered within its connection or moved to another one still
 * fails it, and so does a connection more or fewer.
 */
export function perConnection(sent: readonly SentStatement[]): string[][] {
  const statements = new Map<number, string[]>();
  for (const { connection, shape } of sent) {
    const own = statements.get(connection);
    if (own === undefined) statements.set(connection, [shape]);
    else own.push(shape);
  }
  return [...statements.values()].sort(bySequence);
}

/** Whole sequences, statement by statement; a sequence comes before any longer one it begins. */
function bySequence(a: readonly string[], b: readonly string[]): number {
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    const left = a[index] ?? '';
    const right = b[index] ?? '';
    if (left !== right) return left < right ? -1 : 1;
  }
  return a.length - b.length;
}

/**
 * Run one call that speaks on a single connection, and return the shape of
 * every statement it sent, in order.
 *
 * Arrival order is deterministic only on one connection, so a call that used
 * more is refused rather than compared flat: compare it with
 * `perConnection(await record(...))`.
 */
export async function shapes(run: () => Promise<unknown>): Promise<string[]> {
  const sent = await record(run);
  const connections = new Set(sent.map(({ connection }) => connection)).size;
  if (connections > 1) {
    throw new Error(
      `The call sent statements on ${String(connections)} connections, which interleave nondeterministically; compare perConnection(await record(...)) instead.`,
    );
  }
  return sent.map(({ shape }) => shape);
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
