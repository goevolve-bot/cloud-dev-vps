import { execFile, spawn, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";

export interface ExecFileAsyncResult {
  readonly stdout: string;
  readonly stderr: string;
}

export const childProcess = {
  execFile,
  spawn,
  execFileAsync(
    file: string,
    args: string[],
    opts?: ExecFileOptions,
  ): Promise<ExecFileAsyncResult> {
    // Promisify this.execFile dynamically so that any test mock of execFile is used
    return promisify(this.execFile)(file, args, opts) as Promise<ExecFileAsyncResult>;
  },
};
export type ChildProcessWrapper = typeof childProcess;
