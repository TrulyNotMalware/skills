# Parallel workers

Use this when remediation or its verification is split across subagents, worktrees or
concurrent scripts. The rules are about splitting work, or about running checks at the same
time; each comes from a recorded run.

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

## While they run

- **Workers in one working tree run only filtered tests for their own files.** Concurrent Gradle
  runs in one tree broke each other's `build/` output with `EOFException`,
  `NoSuchFileException` and missing class files, which look like test failures. Filtering does
  not isolate compile output either (inference, not observed); if collisions persist, serialize
  the commands or give each worker its own worktree.
- **The coordinator runs the full build once, after all workers finish.**
- **Verification that shares mutable state runs in sequence or is isolated.** Parallel probes
  sharing one flag file all broke; agents sharing one database used a table prefix each. Tests
  that change process-global state (Reactor hooks, the logging context) run in separate
  processes.

## Reports and patches

- **Reports go to files, in a durable place.** Long worker messages are truncated, so ask for a
  file path back, and ask for "problems only, short, most important first". Keep results in the
  repository, an artifacts directory or notes rather than only under `/tmp`: a reboot once erased
  the scratch results and the unread rest of truncated reports.
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
- Agent runs verification scripts that share a flag file or the same tables in parallel - the
  results corrupt each other.
- Agent leaves worker reports only in `/tmp` - a reboot loses them.
