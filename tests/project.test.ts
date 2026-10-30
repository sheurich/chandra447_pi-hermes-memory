import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectProject, detectProjectSkills } from "../src/project.js";
import { AGENT_ROOT } from "../src/paths.js";

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
    const cwd = "/tmp/demo-repo";
    const result = detectProject("projects-memory", cwd);

    assert.strictEqual(result.name, "demo-repo");
    assert.strictEqual(
      result.memoryDir,
      path.join(AGENT_ROOT, "projects-memory", "demo-repo"),
    );
  });

  it("detectProjectSkills appends the skills directory for dynamic discovery", () => {
    const cwd = "/tmp/demo-repo";
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
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hermes-nogit-")));
    try {
      assert.strictEqual(detectProject("projects-memory", dir).name, path.basename(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
    const prevScope = process.env.PI_INTERCOM_SCOPE_ID;
    try {
      fs.mkdirSync(wsDir, { recursive: true });
      fs.symlinkSync(externalRepo, path.join(wsDir, "member-repo"));
      process.env.PI_INTERCOM_SCOPE_ID = wsDir;
      assert.strictEqual(detectProject("projects-memory", externalRepo).name, path.basename(wsDir));
    } finally {
      if (prevScope === undefined) delete process.env.PI_INTERCOM_SCOPE_ID;
      else process.env.PI_INTERCOM_SCOPE_ID = prevScope;
      fs.rmSync(wsDir, { recursive: true, force: true });
      fs.rmSync(externalRepo, { recursive: true, force: true });
    }
  });

  it("strips trailing .git suffix from bare-repo directory names and rejects tmp.* dirs", () => {
    const bareDir = "/tmp/ca-boulder.git";
    assert.strictEqual(detectProject("projects-memory", bareDir).name, "ca-boulder");
    assert.strictEqual(detectProject("projects-memory", "/tmp/tmp.M23k7be8TF").name, null);
    assert.strictEqual(detectProject("projects-memory", "/tmp").name, null);
  });
});
