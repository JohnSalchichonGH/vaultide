import { describe, expect, it } from 'vitest';
import { databaseUrlEnvVar, requireDatabaseUrl } from '../../src/env';
import { RLS_USER_PREDICATE } from '../../src/schema/rls';

describe('database URLs by role (22.2)', () => {
  it('maps each role to its own environment variable', () => {
    expect(databaseUrlEnvVar('app_user')).toBe('DATABASE_URL');
    expect(databaseUrlEnvVar('app_owner')).toBe('DATABASE_URL_DIRECT_OWNER');
    expect(databaseUrlEnvVar('app_backup')).toBe('DATABASE_URL_BACKUP');
    expect(databaseUrlEnvVar('admin')).toBe('DATABASE_URL_ADMIN');
  });

  it('fails loudly when a credential is missing', () => {
    expect(() => requireDatabaseUrl('app_owner', {})).toThrow('DATABASE_URL_DIRECT_OWNER');
    expect(() => requireDatabaseUrl('app_user', { DATABASE_URL: '' })).toThrow('DATABASE_URL');
    expect(requireDatabaseUrl('app_user', { DATABASE_URL: 'postgres://x' })).toBe('postgres://x');
  });
});

describe('RLS predicate (17.4, D44)', () => {
  it('maps a missing or empty setting to NULL so the policy denies', () => {
    expect(RLS_USER_PREDICATE).toContain("current_setting('app.current_user_id', true)");
    expect(RLS_USER_PREDICATE).toContain('NULLIF');
    expect(RLS_USER_PREDICATE).toContain('::uuid');
  });
});
