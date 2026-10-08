/**
 * Minimal ambient Node.js declarations for the `bl` CLI.
 *
 * The monorepo intentionally carries no `@types/node` dependency (no `npm
 * install` during this sprint), so the handful of Node globals the CLI uses
 * are declared here. Keep these declarations narrow: they only need to cover
 * what src/index.ts actually calls.
 */

declare module "node:child_process" {
  export interface SpawnSyncOptions {
    stdio?: "inherit" | "pipe" | "ignore";
  }
  export interface SpawnSyncResult {
    /** Exit code, or null if the process failed to launch. */
    status: number | null;
  }
  export function spawnSync(
    command: string,
    args?: readonly string[],
    options?: SpawnSyncOptions,
  ): SpawnSyncResult;
}

declare const process: {
  readonly argv: string[];
  env: { [key: string]: string | undefined };
  cwd(): string;
  exit(code?: number): never;
};

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
};

declare class URL {
  constructor(url: string | URL, base?: string | URL);
  toString(): string;
}

declare class Response {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

declare function fetch(
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<Response>;
