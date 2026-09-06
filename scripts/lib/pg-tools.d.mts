/** Types for the operational PostgreSQL tool helpers (scripts/lib/pg-tools.mjs). */
export declare function pgBinDir(): string;
export declare function pgTool(name: string): string;
export declare function runPgTool(
  name: string,
  args: readonly string[],
  options?: Record<string, unknown>,
): string;
