/**
 * Database URLs by role (blueprint 22.2). Each credential exists in exactly one
 * place: the runtime holds only `app_user`, CI only `app_owner`, the backup
 * workflow only `app_backup`, and the manual bootstrap workflow only the admin.
 */
export type DatabaseRole = 'app_user' | 'app_owner' | 'app_backup' | 'admin';

const ENV_VAR: Record<DatabaseRole, string> = {
  app_user: 'DATABASE_URL',
  app_owner: 'DATABASE_URL_DIRECT_OWNER',
  app_backup: 'DATABASE_URL_BACKUP',
  admin: 'DATABASE_URL_ADMIN',
};

export function databaseUrlEnvVar(role: DatabaseRole): string {
  return ENV_VAR[role];
}

export function requireDatabaseUrl(role: DatabaseRole, env = process.env): string {
  const name = ENV_VAR[role];
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set; it holds the ${role} connection string.`);
  }
  return value;
}
