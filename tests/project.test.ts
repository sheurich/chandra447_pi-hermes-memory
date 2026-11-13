import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectProject, detectProjectSkills, isScratchRoot } from "../src/project.js";
import { AGENT_ROOT } from "../src/paths.js";

/**
 * A non-repository project path that is NOT under a scratch root. It need not
 * exist: detectProject only stats for `.git` on the way up, and `$HOME` itself
 * is excluded from repository identity, so the basename rule applies.
 */
const NON_SCRATCH_PROJECT_DIR = path.join(os.homedir(), "src", "demo-repo");

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

/** Real repo with one commit plus a linked worktree, since #120 is entirely about worktree layout. */
function makeRepoWithWorktree(): { root: string; repo: string; worktree: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hermes-project-")));
  const repo = path.join(root, "my-project");
  fs.mkdirSync(path.join(repo, "packages", "api"), { recursive: true });
  git(root, "init", "-q", "-b", "main", "my-project");
  fs.writeFileSync(path.join(repo, "README.md"), "x\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");

  const worktree = path.join(root, "worktrees", "issue-123");
  git(repo, "worktree", "add", "-q", "-b", "issue-123", worktree);

  return { root, repo, worktree };
}

describe("project detection", () => {
  it("detectProject returns null outside a project", () => {
    const result = detectProject("projects-memory", os.homedir());
    assert.deepStrictEqual(result, { name: null, memoryDir: null });
  });

  it("detectProject resolves the project memory directory from cwd", () => {
    const cwd = NON_SCRATCH_PROJECT_DIR;
    const result = detectProject("projects-memory", cwd);

    assert.strictEqual(result.name, "demo-repo");
    assert.strictEqual(
      result.memoryDir,
      path.join(AGENT_ROOT, "projects-memory", "demo-repo"),
    );
  });

  it("detectProjectSkills appends the skills directory for dynamic discovery", () => {
    const cwd = NON_SCRATCH_PROJECT_DIR;
    const result = detectProjectSkills("projects-memory", cwd);

    assert.strictEqual(result.name, "demo-repo");
    assert.strictEqual(
      result.skillsDir,
      path.join(AGENT_ROOT, "projects-memory", "demo-repo", "skills"),
    );
  });
});

describe("git worktree project identity (#120)", () => {
  it("gives a linked worktree the same project identity as its main checkout", () => {
    const { root, repo, worktree } = makeRepoWithWorktree();
    try {
      assert.strictEqual(detectProject("projects-memory", repo).name, "my-project");
      assert.strictEqual(detectProject("projects-memory", worktree).name, "my-project");
      assert.strictEqual(
        detectProject("projects-memory", worktree).memoryDir,
        detectProject("projects-memory", repo).memoryDir,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("scopes a subdirectory of the repository to the repository", () => {
    const { root, repo } = makeRepoWithWorktree();
    try {
      assert.strictEqual(
        detectProject("projects-memory", path.join(repo, "packages", "api")).name,
        "my-project",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps using an existing cwd-basename store instead of orphaning it", () => {
    const { root, repo } = makeRepoWithWorktree();
    const legacy = path.join(AGENT_ROOT, "projects-memory", "api");
    const legacyPreexisting = fs.existsSync(legacy);
    try {
      fs.mkdirSync(legacy, { recursive: true });
      assert.strictEqual(
        detectProject("projects-memory", path.join(repo, "packages", "api")).name,
        "api",
      );
    } finally {
      if (!legacyPreexisting) fs.rmSync(legacy, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the directory basename outside a repository", () => {
    assert.strictEqual(
      detectProject("projects-memory", NON_SCRATCH_PROJECT_DIR).name,
      path.basename(NON_SCRATCH_PROJECT_DIR),
    );
  });

  it("maps ~/workspaces/<initiative> paths and worktrees to the initiative name", () => {
    const wsPath = path.join(os.homedir(), "workspaces", "demo-initiative", "subrepo", "pkg");
    const wtPath = path.join(os.homedir(), "workspaces", ".worktrees", "demo-initiative", "feat-branch");
    assert.strictEqual(detectProject("projects-memory", wsPath).name, "demo-initiative");
    assert.strictEqual(detectProject("projects-memory", wtPath).name, "demo-initiative");
  });

  it("maps symlinked member repos via PI_INTERCOM_SCOPE_ID to the workspace initiative", () => {
    const wsDir = path.join(os.homedir(), "workspaces", "test-ws-scope-" + process.pid);
    const externalRepo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hermes-ext-repo-")));
    const prevHermesScope = process.env.PI_HERMES_MEMORY_SCOPE;
    const prevScope = process.env.PI_INTERCOM_SCOPE_ID;
    try {
      fs.mkdirSync(wsDir, { recursive: true });
      fs.symlinkSync(externalRepo, path.join(wsDir, "member-repo"));
      delete process.env.PI_HERMES_MEMORY_SCOPE;
      process.env.PI_INTERCOM_SCOPE_ID = wsDir;
      assert.strictEqual(detectProject("projects-memory", externalRepo).name, path.basename(wsDir));
    } finally {
      if (prevHermesScope === undefined) delete process.env.PI_HERMES_MEMORY_SCOPE;
      else process.env.PI_HERMES_MEMORY_SCOPE = prevHermesScope;
      if (prevScope === undefined) delete process.env.PI_INTERCOM_SCOPE_ID;
      else process.env.PI_INTERCOM_SCOPE_ID = prevScope;
      fs.rmSync(wsDir, { recursive: true, force: true });
      fs.rmSync(externalRepo, { recursive: true, force: true });
    }
  });

  describe("PI_HERMES_MEMORY_SCOPE", () => {
    const SCOPE_VARS = ["PI_HERMES_MEMORY_SCOPE", "PI_INTERCOM_SCOPE_ID"] as const;

    /**
     * A git repository under os.tmpdir() plus helpers to expose it as a symlinked
     * member of one or more ~/workspaces/<initiative> directories. The repository
     * basename is the expected project when no initiative scope applies.
     */
    function withScopeFixture(
      run: (fx: { repo: string; repoName: string; makeInitiative: (name: string) => string }) => void,
    ): void {
      const saved = SCOPE_VARS.map((name) => [name, process.env[name]] as const);
      const tag = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hermes-scope-")));
      const repoName = `scope-member-${tag}`;
      const repo = path.join(root, repoName);
      const initiatives: string[] = [];
      try {
        for (const name of SCOPE_VARS) delete process.env[name];
        fs.mkdirSync(repo, { recursive: true });
        git(root, "init", "-q", "-b", "main", repoName);
        const makeInitiative = (name: string): string => {
          const dir = path.join(os.homedir(), "workspaces", `${name}-${tag}`);
          fs.mkdirSync(dir, { recursive: true });
          fs.symlinkSync(repo, path.join(dir, "member-repo"));
          initiatives.push(dir);
          return dir;
        };
        run({ repo, repoName, makeInitiative });
      } finally {
        for (const [name, value] of saved) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        for (const dir of initiatives) fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(root, { recursive: true, force: true });
      }
    }

    it("maps a symlinked member checkout and its skills dir with PI_HERMES_MEMORY_SCOPE alone", () => {
      withScopeFixture(({ repo, makeInitiative }) => {
        const ws = makeInitiative("hermes-only");
        process.env.PI_HERMES_MEMORY_SCOPE = ws;
        const name = path.basename(ws);
        assert.strictEqual(detectProject("projects-memory", repo).name, name);
        assert.strictEqual(
          detectProjectSkills("projects-memory", repo).skillsDir,
          path.join(AGENT_ROOT, "projects-memory", name, "skills"),
        );
      });
    });

    it("prefers PI_HERMES_MEMORY_SCOPE over PI_INTERCOM_SCOPE_ID when both are valid", () => {
      withScopeFixture(({ repo, makeInitiative }) => {
        const dedicated = makeInitiative("hermes-a");
        const legacy = makeInitiative("intercom-b");
        process.env.PI_HERMES_MEMORY_SCOPE = dedicated;
        process.env.PI_INTERCOM_SCOPE_ID = legacy;
        assert.strictEqual(detectProject("projects-memory", repo).name, path.basename(dedicated));
      });
    });

    it("falls back to PI_INTERCOM_SCOPE_ID when PI_HERMES_MEMORY_SCOPE is empty or whitespace", () => {
      withScopeFixture(({ repo, makeInitiative }) => {
        const legacy = makeInitiative("intercom-fallback");
        process.env.PI_INTERCOM_SCOPE_ID = legacy;
        for (const blank of ["", "   "]) {
          process.env.PI_HERMES_MEMORY_SCOPE = blank;
          assert.strictEqual(detectProject("projects-memory", repo).name, path.basename(legacy));
        }
      });
    });

    it("does not fall through to PI_INTERCOM_SCOPE_ID when PI_HERMES_MEMORY_SCOPE is non-empty but invalid", () => {
      withScopeFixture(({ repo, repoName, makeInitiative }) => {
        const legacy = makeInitiative("intercom-valid");
        const wsRoot = path.join(os.homedir(), "workspaces");
        const invalid = [
          path.join(wsRoot, `nonexistent-${process.pid}`),
          path.join(wsRoot, `.dotted-${process.pid}`),
          path.join(wsRoot, `_underscore-${process.pid}`),
          path.join(wsRoot, path.basename(legacy), "nested"),
          path.join(os.tmpdir(), "outside-workspaces"),
          "../../elsewhere",
        ];
        process.env.PI_INTERCOM_SCOPE_ID = legacy;
        for (const value of invalid) {
          process.env.PI_HERMES_MEMORY_SCOPE = value;
          const name = detectProject("projects-memory", repo).name;
          assert.strictEqual(name, repoName, `scope ${value}`);
          assert.notStrictEqual(name, path.basename(legacy), `scope ${value}`);
        }
      });
    });

    it("accepts a relative PI_HERMES_MEMORY_SCOPE that resolves to a valid initiative", () => {
      withScopeFixture(({ repo, makeInitiative }) => {
        const ws = makeInitiative("hermes-relative");
        process.env.PI_HERMES_MEMORY_SCOPE = path.relative(process.cwd(), ws);
        assert.notStrictEqual(process.env.PI_HERMES_MEMORY_SCOPE, ws);
        assert.strictEqual(detectProject("projects-memory", repo).name, path.basename(ws));
      });
    });
  });

  it("strips trailing .git suffix from bare-repo directory names outside scratch roots", () => {
    const bareDir = path.join(os.homedir(), "src", "ca-boulder.git");
    assert.strictEqual(detectProject("projects-memory", bareDir).name, "ca-boulder");
  });

  it("rejects tmp.* dirs and the /tmp root itself", () => {
    assert.strictEqual(detectProject("projects-memory", "/tmp/tmp.M23k7be8TF").name, null);
    assert.strictEqual(detectProject("projects-memory", "/tmp").name, null);
  });
});

describe("scratch roots never mint a project identity without a repository", () => {
  it("isScratchRoot recognizes the temp roots and their children", () => {
    assert.strictEqual(isScratchRoot("/tmp"), true);
    assert.strictEqual(isScratchRoot("/tmp/x"), true);
    assert.strictEqual(isScratchRoot("/private/tmp/x"), true);
    assert.strictEqual(isScratchRoot("/var/folders/ab/cd/T/x"), true);
    assert.strictEqual(isScratchRoot("/private/var/folders/ab/cd/T/x"), true);
    assert.strictEqual(isScratchRoot(path.join(os.tmpdir(), "pi-live-verify-abc")), true);
    assert.strictEqual(isScratchRoot(path.join(fs.realpathSync(os.tmpdir()), "pi-live-verify-abc")), true);
    assert.strictEqual(isScratchRoot(NON_SCRATCH_PROJECT_DIR), false);
    assert.strictEqual(isScratchRoot("/tmpfoo/x"), false);
  });

  it("returns null for a bare .git clone under /tmp", () => {
    assert.deepStrictEqual(detectProject("projects-memory", "/tmp/ca-boulder.git"), { name: null, memoryDir: null });
  });

  it("returns null for non-repository directories under /private/tmp and os.tmpdir()", () => {
    assert.deepStrictEqual(detectProject("projects-memory", "/private/tmp/x"), { name: null, memoryDir: null });
    assert.deepStrictEqual(
      detectProject("projects-memory", path.join(os.tmpdir(), "pi-live-verify-abc")),
      { name: null, memoryDir: null },
    );
    assert.strictEqual(detectProjectSkills("projects-memory", "/private/tmp/x").skillsDir, null);
  });

  it("returns null for an existing non-repository scratch directory", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hermes-nogit-")));
    try {
      assert.deepStrictEqual(detectProject("projects-memory", dir), { name: null, memoryDir: null });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still resolves a git-initialized working repository under os.tmpdir()", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hermes-scratch-repo-")));
    const repo = path.join(root, "scratch-repo");
    try {
      fs.mkdirSync(path.join(repo, "src"), { recursive: true });
      git(root, "init", "-q", "-b", "main", "scratch-repo");
      assert.strictEqual(detectProject("projects-memory", repo).name, "scratch-repo");
      assert.strictEqual(detectProject("projects-memory", path.join(repo, "src")).name, "scratch-repo");
      assert.strictEqual(
        detectProject("projects-memory", repo).memoryDir,
        path.join(AGENT_ROOT, "projects-memory", "scratch-repo"),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
