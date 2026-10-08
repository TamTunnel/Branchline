/**
 * Minimal ambient Node.js / runtime declarations for the Branchline API.
 *
 * The monorepo intentionally carries no `@types/node` dependency (no `npm
 * install` during this sprint), so the handful of Node APIs and runtime
 * globals the API uses are declared here, following the same pattern as
 * apps/cli/src/node-shims.d.ts. Keep these declarations narrow: they only
 * need to cover what src/ actually calls.
 */

declare module "node:child_process" {
  export interface ExecFileOptions {
    cwd?: string;
    encoding?: string;
  }
  export interface ExecFileException extends Error {
    stdout?: string;
    stderr?: string;
    code?: number | null;
  }
  export function execFile(
    file: string,
    args: readonly string[],
    options: ExecFileOptions,
    callback: (
      error: ExecFileException | null,
      stdout: string,
      stderr: string,
    ) => void,
  ): void;
}

declare module "node:fs/promises" {
  export interface MkdirOptions {
    recursive?: boolean;
  }
  export function mkdir(path: string, options?: MkdirOptions): Promise<string | undefined>;
  export function unlink(path: string): Promise<void>;
  export function writeFile(
    path: string,
    data: string | Uint8Array,
  ): Promise<void>;
}

declare module "node:path" {
  export const sep: string;
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
}

declare const process: {
  env: { [key: string]: string | undefined };
  exit(code?: number): never;
};

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
};

/** Minimal Request/Response globals (real Worker runtime provides the full ones). */
declare class Request {
  constructor(input: string | Request, init?: Record<string, unknown>);
  readonly url: string;
  readonly method: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

declare class Response {
  constructor(body?: unknown, init?: { status?: number; headers?: Record<string, string> });
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}
