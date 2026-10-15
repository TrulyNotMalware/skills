# Parallel workers

Use this when remediation or its verification is split across subagents, worktrees or
concurrent scripts. The rules are about splitting work, or about running checks at the same
time; each comes from a recorded run.

Contents: [Before spawning](#before-spawning) · [While they run](#while-they-run) ·
[Reports and patches](#reports-and-patches) · [Gotchas](#gotchas)

## Before spawning

- **Fix the base commit and each worker's file ownership.**
- **Do not assume a harness-created worktree starts from your branch.** In the incident the
  isolated worktrees were created from the default branch, so every cited file and line was off.
  Either create the worktrees yourself at the base commit, or make each worker's first action a
  `git rev-parse HEAD` compared with the base, and have it stop (not rebase) on mismatch.
- If the base cannot be fixed, run the workers in the main working tree with disjoint file
  ownership. That is what was done in the incident, and it then needed the build rules below.
- **Do not run on a worker's behalf a command the permission system denied the worker.** In the
  incident two workers had the git command that moves their base denied and stopped; re-plan the
  split instead of executing the denied command from the coordinator.
- **The brief fixes where revert checks run, and the coordinator keeps that true.** "Reverting in
  place is fine" holds only while nothing else reads the tree. In one run the coordinator wrote
  that in a worker's brief and then started a code-review lane and a verifier on the same tree
  before the worker reached its revert loop; the worker moved to a scratch copy on its own, so
  nothing broke, but the brief had been false since the lanes started and the worker had no way
  to know. Put the copy procedure (below) in the brief, and if you start any reader after
  briefing, tell the worker.

## While they run

- **Workers in one working tree run only filtered tests for their own files.** Concurrent Gradle
  runs in one tree broke each other's `build/` output with `EOFException`,
  `NoSuchFileException` and missing class files, which look like test failures. Filtering does
  not isolate compile output either (inference, not observed); if collisions persist, serialize
  the commands or give each worker its own worktree.
- **The coordinator runs the full build once, after all workers finish.**
- **Revert checks run in a throwaway worktree, never in the tree a review lane is reading.** Proving
  that each new test fails with its production hunk reverted means restoring base files and re-applying
  the patch over and over; in the main tree that races a concurrent read-only review lane and any build.
  Create a worktree at the base commit and reproduce the uncommitted state there: `git worktree add
  --detach <dir> <base>`, then `git -C <dir> apply <absolute patch path>` (a relative path resolves inside
  the worktree and fails), copy the git-ignored build settings (`gradle.properties`) by hand, and remember
  that `git diff` omits untracked new files — append them with `git diff --no-index /dev/null <file>` or the
  worktree silently lacks them. Run the revert-and-test loop there one Gradle run at a time, record
  `git diff --stat` before the first revert and compare after every restore, and remove the worktree when
  done: it is stale from the next edit in the main tree. (Six behavioural fixes on one pull request were
  verified this way while a code-review lane read the main tree.)
- **The same holds for one agent, and for a tree that is not a repository.** Anything that reads the tree
  while a fix is reverted is a concurrent reader. In the incident a background `test && build` chain started
  next to an in-place revert loop reported the reverted file as a failing test and went on to build an image;
  the image then had to be compared with the sources file by file (it matched). Without git, copy the tree and
  loop there: `rsync -a --exclude .venv --exclude __pycache__ --exclude .env <tree>/ <copy>/`, then run the
  tests from `<copy>` with the original interpreter. Leave secrets files out of the copy, and first confirm
  that the tests import the copy: with an editable install a plain `import` resolved to the original tree,
  and only the test runner's own path setting (pytest `pythonpath`) put the copy first. (On a Python service
  outside version control the copy procedure was run once: a revert in the copy failed its test there while
  the original file stayed byte-identical.)
- **An in-place revert loop also poisons bytecode caches (Python).** CPython validates a `.pyc` by the
  source's mtime in whole seconds and its size. Restore a file of the same size within the same second as
  the reverted write, and the next run still executes the reverted code. The mirror case: a revert written
  in the same second as the cached original makes the reverted run execute the original, and the check
  reports that the test pins nothing. `-B` on the reverted run avoids only the first case (it stops writing
  bytecode, not reading it); a copy of the tree with its own caches avoids both. (Reproduced on Python
  3.14.7 with fixed mtimes; in the incident a same-size revert that swapped two blocks, restored after a
  sub-second test run, made the next full run fail until `__pycache__` was removed.)
- **Verification that shares mutable state runs in sequence or is isolated.** Parallel probes
  sharing one flag file all broke; agents sharing one database used a table prefix each. Tests
  that change process-global state (Reactor hooks, the logging context) run in separate
  processes.

## Reports and patches

- **Reports go to files, in a durable place.** Long worker messages are truncated, so ask for a
  file path back, and ask for "problems only, short, most important first". Keep results in the
  repository, an artifacts directory or notes rather than only under `/tmp`: a reboot once erased
  the scratch results and the unread rest of truncated reports.
  Put the file request in the brief, before the first report: in one run four reports were
  truncated before the coordinator switched to files.
- **Screen patches before applying them.** `git apply --numstat <patch>` lists the files a patch
  touches without applying it; reject anything outside the worker's ownership. Conflicts land in
  shared documents (`AGENTS.md`, changelogs); merge those by hand.
- **Cross-check the boundaries last.** A configuration key renamed by one worker, or a migration
  added by another, makes a third worker's documentation stale.

## Gotchas

- Agent spawns workers into harness-created worktrees and trusts their base - the base is the
  default branch and the review's line numbers no longer match.
- Agent runs a git command a worker was denied - the coordinator launders the permission
  decision.
- Agent lets several workers build one tree at once - shared build output breaks and looks like
  flaky tests.
- Agent runs revert checks in the tree a review lane is reading - the reviewer judges reverted code,
  or a build picks up a half-restored file.
- Agent runs an in-place revert loop in a Python tree and restores within the same second - the next
  run executes the reverted bytecode and fails for no reason, or the reverted run executes the original
  and the check says the test pins nothing.
- Agent runs verification scripts that share a flag file or the same tables in parallel - the
  results corrupt each other.
- Agent leaves worker reports only in `/tmp` - a reboot loses them.
- Agent writes "revert in place is fine" in a worker's brief and then starts a review lane - the
  brief was true when written, and the worker cannot see that it changed.
