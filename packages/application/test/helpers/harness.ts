import { randomBytes } from 'node:crypto';
import pg from 'pg';
import {
  createDatabase as createDrizzle,
  createPool,
  type Database,
} from '@vaultide/db';
import {
  adminUrl,
  dropDatabase,
  provisionDatabase,
  type ProvisionedDatabase,
} from '@vaultide/db/testing';
import { createServices, type Services } from '../../src/services';
import { createCapturingMailer, type CapturingMailer } from '../../src/mail/providers';
import { createLogger } from '../../src/logging';
import { createStubFxProvider, type StubFxProvider } from './stub-fx-provider';

/**
 * The integration harness (blueprint 21.3).
 *
 * Every suite provisions a **real** PostgreSQL database through the same
 * scripts an operator runs — admin bootstrap, migrations as `app_owner`, the
 * currency seed — and then connects as `app_user`, the `NOBYPASSRLS` runtime
 * role. Nothing here weakens a control to make testing easier: the tests see
 * exactly the privileges production sees.
 *
 * Two things are substituted, both at the IO boundary the blueprint puts them
 * behind: the mailer captures instead of sending (17.1), and the FX provider is
 * a stub instead of a public HTTP service (10.1). Neither changes a rule.
 */

export interface Harness {
  readonly services: Services;
  readonly db: Database;
  readonly mailer: CapturingMailer;
  readonly fxProvider: StubFxProvider;
  readonly baseUrl: string;
  readonly provisioned: ProvisionedDatabase;
  /** Captured log lines, for the redaction assertions of 18.2. */
  readonly logLines: string[];
  /**
   * Run a statement as `app_owner`.
   *
   * Test *setup* sometimes needs privileges the runtime deliberately lacks —
   * emptying `fx_rates` between cases, for instance, which `app_user` cannot do
   * because those rows are immutable (6.2). Using the owner here keeps the
   * runtime role's privileges honest instead of widening them for the tests.
   */
  asOwner(statement: string, values?: unknown[]): Promise<void>;
  /**
   * Run a statement as `app_user` over a raw connection.
   *
   * The privilege-escalation assertions issue DDL as text, which is what an
   * attacker would do and what an ORM has no way to express. Going through the
   * driver keeps `sql.raw` — banned outside migrations by lint (17.3) — out of
   * the codebase entirely.
   */
  asUser(statement: string, values?: unknown[]): Promise<void>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  readonly rateLimitEnabled?: boolean;
  /** Fixed clock for the FX service, so a refresh is reproducible. */
  readonly now?: () => Date;
}

export const TEST_BASE_URL = 'http://127.0.0.1:3000';

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const provisioned = await provisionDatabase({});
  const pool = createPool({ connectionString: provisioned.userUrl, max: 5 });
  const db = createDrizzle(pool);

  const mailer = createCapturingMailer();
  const fxProvider = createStubFxProvider();

  const logLines: string[] = [];
  const logger = createLogger({
    level: 'debug',
    destination: {
      write(chunk: string): boolean {
        logLines.push(chunk);
        return true;
      },
    } as NodeJS.WritableStream,
  });

  const services = createServices({
    db,
    mailer,
    fxProvider,
    logger,
    ...(options.rateLimitEnabled === undefined
      ? {}
      : { rateLimitEnabled: options.rateLimitEnabled }),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      // 32+ bytes of random data, as 17.3 requires. Generated per harness so no
      // secret is ever committed, not even a test one.
      BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
      BETTER_AUTH_URL: `${TEST_BASE_URL}/api/auth`,
      APP_URL: TEST_BASE_URL,
    },
  });

  const ownerPool = new pg.Pool({ connectionString: provisioned.ownerUrl, max: 2 });
  const rawUserPool = new pg.Pool({ connectionString: provisioned.userUrl, max: 2 });

  return {
    services,
    db,
    mailer,
    fxProvider,
    baseUrl: TEST_BASE_URL,
    provisioned,
    logLines,
    async asOwner(statement: string, values: unknown[] = []): Promise<void> {
      await ownerPool.query(statement, values);
    },
    async asUser(statement: string, values: unknown[] = []): Promise<void> {
      await rawUserPool.query(statement, values);
    },
    async close(): Promise<void> {
      await Promise.allSettled([pool.end(), ownerPool.end(), rawUserPool.end()]);
      await dropDatabase(adminUrl(), provisioned.databaseName);
    },
  };
}
