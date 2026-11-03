import { execFileSync } from "node:child_process";
import fs from "node:fs";

/**
 * Turn a scratch directory into a project fixture.
 *
 * `detectProject` returns no identity for a non-repository directory under a
 * scratch root (os.tmpdir(), /tmp, ...), so a test that needs `<tmp>/<name>`
 * to be the project `<name>` must give it a working-tree repository first.
 * The repository root is the directory itself, so the project name stays its
 * basename.
 */
export function initScratchProject(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
  return dir;
}
