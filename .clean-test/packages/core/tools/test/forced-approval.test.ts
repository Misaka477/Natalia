import { expect, test } from "bun:test";
import {
  requiresForcedGitApproval,
  requiresForcedGitApprovalAst,
} from "../src";

function forced(command: string) {
  return requiresForcedGitApproval(command);
}

test("git forced approval ignores read-only commands", () => {
  for (const command of [
    "git status",
    "git log --oneline -5",
    "git branch -l",
    "git tag -l",
    "git tag --list v1",
    "git diff",
    "git show HEAD",
  ])
    expect(forced(command)).toBeUndefined();
});

test("git forced approval covers write subcommands", () => {
  for (const [command, subcommand] of [
    ["git commit -m test", "commit"],
    ["git push origin main", "push"],
    ["git merge feature", "merge"],
    ["git rebase main", "rebase"],
    ["git reset --hard", "reset"],
    ["git cherry-pick abc123", "cherry-pick"],
    ["git revert HEAD", "revert"],
    ["git clean -fd", "clean"],
    ["git tag v1", "tag"],
    ["git branch -D old", "branch"],
  ] as const) {
    expect(forced(command)).toMatchObject({
      ruleID: "C-REL-001",
      subcommand,
    });
  }
});

test("git forced approval sees through common wrapper and option forms", () => {
  for (const command of [
    "echo x && git commit",
    "git status && git commit -m test",
    "bash -lc 'git commit'",
    'sh -c "git commit -m test"',
    "git -C /repo commit",
    "git --git-dir=/repo commit",
    "git --work-tree /repo commit",
    "git.exe commit",
    "env GIT_AUTHOR_NAME=x git commit",
  ])
    expect(forced(command)).toMatchObject({
      ruleID: "C-REL-001",
      subcommand: "commit",
    });
});

test("git forced approval does not match non-git commands", () => {
  for (const command of ["xgit commit", "git-commit", "github commit"])
    expect(forced(command)).toBeUndefined();
});

test("git forced approval AST resolves aliases, functions, eval and assignments", async () => {
  for (const command of [
    "alias g=git; g commit",
    "alias g='git commit'; g",
    "g=git; $g commit",
    "f() { git commit; }; f",
    "f() { local g=git; $g commit; }; f",
    "eval 'git commit'",
    "bash -lc 'alias g=git; g commit'",
    "sh -c 'g=git; $g commit'",
  ])
    await expect(requiresForcedGitApprovalAst(command)).resolves.toMatchObject({
      ruleID: "C-REL-001",
      subcommand: "commit",
    });
});

test("git forced approval AST leaves read-only aliases and assignments alone", async () => {
  for (const command of [
    "alias g=git; g status",
    "alias g='git diff'; g",
    "g=git; $g status",
    "eval 'git status'",
    "bash -lc 'alias g=git; g log --oneline'",
  ])
    await expect(
      requiresForcedGitApprovalAst(command),
    ).resolves.toBeUndefined();
});
