import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { perConnection, record, shapes, type SentStatement } from '../helpers/statement-shapes';

/**
 * The statement recorder the query-shape suites compare with, on its own.
 *
 * No database: two never-connected clients stand in for two pooled
 * connections, and the driver's `query` is a stub, so every interleaving is
 * exactly the one a test spells out. The two scripts are the Bulk History grid
 * read's — a repeatable-read snapshot and the currency catalogue's own
 * transaction — whose interleaving failed main CI run 37132188079.
 */

const driver = pg.Client.prototype as unknown as {
  query: (this: void, ...args: unknown[]) => unknown;
};
let real: typeof driver.query;

beforeEach(() => {
  real = driver.query;
  driver.query = () => Promise.resolve({ rows: [] });
});

afterEach(() => {
  driver.query = real;
});

const OPEN_SNAPSHOT = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
const SET_USER = "select set_config('app.user_id', $1, true)";
const POSITIONS = 'select "id" from "positions"';
const VALUATIONS = 'select "id" from "position_valuations"';
const TEMPLATES = 'select "id" from "recurring_templates"';
const CURRENCY_READ = 'select "code" from "currencies"';

const SNAPSHOT = [OPEN_SNAPSHOT, SET_USER, POSITIONS, VALUATIONS, TEMPLATES, 'commit'];
const CURRENCIES = ['begin', CURRENCY_READ, 'commit'];

/** Two distinct clients are two connections, as far as the recorder can tell. */
const client = (): pg.Client => Object.create(pg.Client.prototype) as pg.Client;

/**
 * Send `snapshot` on one connection and `currencies` on another, taking the
 * next statement from whichever `order` names: `s` the snapshot, `c` the
 * currency read.
 */
async function send(order: string, snapshot = SNAPSHOT, currencies = CURRENCIES): Promise<SentStatement[]> {
  // Checked here, not inside the call: the recorder swallows a call's errors.
  const turns = [...order];
  const taken = (side: string) => turns.filter((turn) => turn === side).length;
  if (taken('s') !== snapshot.length || taken('c') !== currencies.length || turns.length !== taken('s') + taken('c')) {
    throw new Error(`"${order}" does not send every statement exactly once`);
  }

  const connections = { s: client(), c: client() };
  const queues = { s: [...snapshot], c: [...currencies] };
  return record(async () => {
    for (const turn of turns) {
      const side = turn === 's' ? 's' : 'c';
      await connections[side].query(queues[side].shift() ?? '');
    }
  });
}

const flat = (sent: readonly SentStatement[]) => sent.map(({ shape }) => shape);

describe('the statement recorder', () => {
  it('gives the same statements per connection however two connections interleave', async () => {
    const currencyFirst = await send('cccssssss');
    const woven = await send('scsscsscs');
    const snapshotFirst = await send('ssssssccc');

    // The flat arrival order differs every time: the comparison that broke.
    expect(flat(woven)).not.toEqual(flat(currencyFirst));
    expect(flat(snapshotFirst)).not.toEqual(flat(woven));
    expect(flat(snapshotFirst)).not.toEqual(flat(currencyFirst));

    const expected = [
      ['begin', 'select currencies', 'commit'],
      [
        'begin isolation level repeatable read read only',
        'set user',
        'select positions',
        'select position_valuations',
        'select recurring_templates',
        'commit',
      ],
    ];
    expect(perConnection(currencyFirst)).toEqual(expected);
    expect(perConnection(woven)).toEqual(expected);
    expect(perConnection(snapshotFirst)).toEqual(expected);
  });

  it('still fails a difference within one connection', async () => {
    const expected = perConnection(await send('scsscsscs'));

    // The same interleaving, two of the snapshot's reads swapped on its own
    // connection.
    const swapped = [OPEN_SNAPSHOT, SET_USER, VALUATIONS, POSITIONS, TEMPLATES, 'commit'];
    expect(perConnection(await send('scsscsscs', swapped))).not.toEqual(expected);

    // A read sent twice, or not at all.
    const twice = [OPEN_SNAPSHOT, SET_USER, POSITIONS, POSITIONS, VALUATIONS, TEMPLATES, 'commit'];
    expect(perConnection(await send('scsscssscs', twice))).not.toEqual(expected);
    const dropped = [OPEN_SNAPSHOT, SET_USER, POSITIONS, VALUATIONS, 'commit'];
    expect(perConnection(await send('scsscscs', dropped))).not.toEqual(expected);
  });

  it('still fails a statement that moves to the other connection', async () => {
    const original = await send('scsscsscs');

    // Every statement arrives in exactly the same order, but the currency
    // read is answered on the snapshot's connection.
    const snapshot = [OPEN_SNAPSHOT, SET_USER, POSITIONS, CURRENCY_READ, VALUATIONS, TEMPLATES, 'commit'];
    const moved = await send('scssssscs', snapshot, ['begin', 'commit']);
    expect(flat(moved)).toEqual(flat(original));
    expect(perConnection(moved)).not.toEqual(perConnection(original));
  });

  it('refuses a flat comparison of a call that spoke on more than one connection', async () => {
    const one = client();
    await expect(
      shapes(async () => {
        for (const text of CURRENCIES) await one.query(text);
      }),
    ).resolves.toEqual(['begin', 'select currencies', 'commit']);

    const other = client();
    await expect(
      shapes(async () => {
        await one.query('begin');
        await other.query('begin');
      }),
    ).rejects.toThrow('2 connections');
  });
});
