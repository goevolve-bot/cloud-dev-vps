import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

export const childProcess = {
  execFile,
  spawn,
  execFileAsync(
    file: string,
    args: string[],
    opts?: any,
  ): Promise<any> {
    // Promisify this.execFile dynamically so that any test mock of execFile is used
    return promisify(this.execFile)(file, args, opts);
  },
};
export type ChildProcessWrapper = typeof childProcess;
