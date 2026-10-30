/**
 * Project detection — determines whether the current working directory
 * represents a project and resolves its name.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveProjectsRoot } from "./paths.js";

export interface ProjectInfo {
  /** Project name (directory basename), or null if not in a project. */
  name: string | null;
  /** Path to the project-scoped memory directory, or null. */
  memoryDir: string | null;
}

export interface ProjectSkillInfo extends ProjectInfo {
  /** Path to the project-scoped skills directory, or null. */
  skillsDir: string | null;
}

/**
 * Resolve the repository root shared by every linked worktree of `dir`'s repo.
 *
 * Mirrors what `git rev-parse --git-common-dir` reports, without spawning git:
 * a linked worktree's `.git` is a file pointing at
 * `<main>/.git/worktrees/<name>`, and that directory carries a `commondir`
 * file pointing back at the shared `<main>/.git`. Returns null outside a
 * repository, or for a bare/detached layout with no obvious working root.
 */
function findGitRepoRoot(dir: string): string | null {
  let current = path.resolve(dir);

  while (true) {
    const dotGit = path.join(current, ".git");
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      stat = undefined;
    }

    if (stat?.isDirectory()) return current;

    if (stat?.isFile()) {
      const commonDir = resolveWorktreeCommonDir(current, dotGit);
      if (!commonDir) return current;
      return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir;
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveWorktreeCommonDir(worktreeRoot: string, dotGitFile: string): string | null {
  let pointer: string;
  try {
    pointer = fs.readFileSync(dotGitFile, "utf-8");
  } catch {
    return null;
  }

  const match = /^gitdir:\s*(.+)$/m.exec(pointer);
  if (!match) return null;

  const gitDir = path.resolve(worktreeRoot, match[1].trim());
  try {
    const commonDir = fs.readFileSync(path.join(gitDir, "commondir"), "utf-8").trim();
    if (commonDir) return path.resolve(gitDir, commonDir);
  } catch {
    // Not a linked worktree, or an older layout without `commondir`.
  }

  // `<main>/.git/worktrees/<name>` — two levels up is the shared git dir.
  const parent = path.dirname(gitDir);
  return path.basename(parent) === "worktrees" ? path.dirname(parent) : null;
}

const repoRootCache = new Map<string, string | null>();

function resolveWorkspaceInitiative(
  resolved: string,
  resolvedHome: string,
  repoRoot: string | null,
): string | null {
  const wsRoot = path.join(resolvedHome, "workspaces");

  // 1. Direct path under ~/workspaces/<initiative>[/...] or ~/workspaces/.worktrees/<initiative>/...
  if (resolved.startsWith(wsRoot + path.sep)) {
    const rel = resolved.slice(wsRoot.length + 1);
    const parts = rel.split(path.sep).filter(Boolean);
    if (parts[0] === ".worktrees" && parts.length >= 2) {
      const candidate = parts[1];
      if (candidate && !candidate.startsWith(".") && !candidate.startsWith("_")) {
        return candidate;
      }
    } else if (parts.length >= 1) {
      const candidate = parts[0];
      if (candidate && !candidate.startsWith(".") && !candidate.startsWith("_")) {
        return candidate;
      }
    }
  }

  // 2. Symlinked member checkout when PI_INTERCOM_SCOPE_ID points to ~/workspaces/<initiative>
  const scopeRaw = process.env.PI_INTERCOM_SCOPE_ID?.trim();
  if (scopeRaw) {
    const scopeDir = path.resolve(scopeRaw);
    if (scopeDir.startsWith(wsRoot + path.sep)) {
      const rel = scopeDir.slice(wsRoot.length + 1);
      const parts = rel.split(path.sep).filter(Boolean);
      const initiative = parts[0];
      if (
        parts.length === 1
        && initiative
        && !initiative.startsWith(".")
        && !initiative.startsWith("_")
      ) {
        if (resolved === scopeDir || resolved.startsWith(scopeDir + path.sep)) {
          return initiative;
        }
        try {
          const entries = fs.readdirSync(scopeDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name.startsWith(".")) continue;
            if (!entry.isSymbolicLink() && !entry.isDirectory()) continue;
            const memberReal = fs.realpathSync(path.join(scopeDir, entry.name));
            if (
              resolved === memberReal
              || resolved.startsWith(memberReal + path.sep)
              || (repoRoot && (repoRoot === memberReal || repoRoot.startsWith(memberReal + path.sep)))
            ) {
              return initiative;
            }
          }
        } catch {
          // Ignore unreadable workspace directories
        }
      }
    }
  }

  return null;
}

/**
 * Detect project from the current working directory.
 *
 * A "project" is any directory that is not the user's home directory. Inside a
 * Git repository the project name is the *repository* root's basename, so every
 * linked worktree shares one identity instead of stranding its memory and
 * skills under the worktree directory name (#120). Outside Git it stays the
 * working directory's basename.
 *
 * An existing `projects-memory/<cwd-basename>/` directory still wins over a
 * newly derived repository name, so upgrading never orphans memory that was
 * written under the old cwd-basename identity.
 *
 * Project-scoped memory is stored at ~/.pi/agent/<projectsMemoryDir>/<projectName>/.
 */
export function detectProject(projectsMemoryDir = "projects-memory", cwd?: string): ProjectInfo {
  const dir = cwd ?? process.cwd();
  const homeDir = os.homedir();

  // Normalize paths for comparison
  const resolved = path.resolve(dir);
  const resolvedHome = path.resolve(homeDir);

  if (resolved === resolvedHome || resolved === "/" || !resolved || resolved === resolvedHome + "/") {
    return { name: null, memoryDir: null };
  }

  const cwdName = path.basename(resolved);
  if (!cwdName || cwdName === "." || cwdName === ".." || cwdName === "tmp" || cwdName.startsWith("tmp.")) {
    return { name: null, memoryDir: null };
  }

  const projectsRoot = resolveProjectsRoot(projectsMemoryDir);
  const name = resolveProjectName(resolved, resolvedHome, cwdName, projectsRoot);

  return {
    name,
    memoryDir: path.join(projectsRoot, name),
  };
}

function stripBareGitSuffix(name: string): string {
  return name.endsWith(".git") && name.length > 4 ? name.slice(0, -4) : name;
}

function hasPopulatedStore(projectsRoot: string, name: string): boolean {
  const dir = path.join(projectsRoot, name);
  return (
    fs.existsSync(path.join(dir, "MEMORY.md"))
    || fs.existsSync(path.join(dir, "USER.md"))
    || fs.existsSync(path.join(dir, "failures.md"))
  );
}

function resolveProjectName(
  resolved: string,
  resolvedHome: string,
  cwdName: string,
  projectsRoot: string,
): string {
  let repoRoot = repoRootCache.get(resolved);
  if (repoRoot === undefined) {
    repoRoot = findGitRepoRoot(resolved);
    repoRootCache.set(resolved, repoRoot);
  }

  const normalizedCwdName = stripBareGitSuffix(cwdName);
  const repoName = repoRoot && repoRoot !== resolvedHome
    ? stripBareGitSuffix(path.basename(repoRoot))
    : normalizedCwdName;

  const workspaceInitiative = resolveWorkspaceInitiative(resolved, resolvedHome, repoRoot);
  if (workspaceInitiative) {
    if (
      repoName !== workspaceInitiative
      && hasPopulatedStore(projectsRoot, repoName)
      && !hasPopulatedStore(projectsRoot, workspaceInitiative)
    ) {
      return repoName;
    }
    return workspaceInitiative;
  }

  if (!repoRoot || repoRoot === resolved || repoRoot === resolvedHome) {
    if (cwdName !== normalizedCwdName && hasPopulatedStore(projectsRoot, cwdName)) {
      return cwdName;
    }
    return normalizedCwdName;
  }

  if (!repoName || repoName === normalizedCwdName) return normalizedCwdName;

  // Migration bridge: a store already written under the old cwd-basename
  // identity keeps working. Only fresh directories adopt the repository name.
  if (!fs.existsSync(path.join(projectsRoot, repoName)) && fs.existsSync(path.join(projectsRoot, normalizedCwdName))) {
    return normalizedCwdName;
  }

  return repoName;
}

export function detectProjectSkills(projectsMemoryDir = "projects-memory", cwd?: string): ProjectSkillInfo {
  const project = detectProject(projectsMemoryDir, cwd);
  return {
    ...project,
    skillsDir: project.memoryDir ? path.join(project.memoryDir, "skills") : null,
  };
}
