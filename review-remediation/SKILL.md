---
name: review-remediation
description: >
  How to apply review findings without breaking things: triage each finding against the source,
  treat every fix snippet (the reviewer's and your own) as a hypothesis, prove that tests pin the
  fix, re-check each batch of fixes, and report what is verified versus inferred. Use when the
  task is to act on a review that already exists: a review document (review.md, audit or
  security report), PR review comments, Codex or other agent findings, re-checking fixes that
  were already applied, or splitting the fixes across parallel worker agents. Triggers include
  "apply the review", "fix the review findings", "address the PR comments", "리뷰 반영해줘",
  "review.md 반영", "Codex 리뷰 결과 반영", "지적사항 수정", "반영한 수정 재검수". Also use it for
  documentation corrections driven by a review. Not for writing a new review from scratch or
  for rewriting the review's findings; recording remediation status in the review is in scope.
  Stack-specific pitfalls live in the stack skills (for example kotlin-spring-boot); load them
  alongside this one.
---

# Review remediation

A review is a list of hypotheses. Some were reproduced by the reviewer, under the reviewer's
configuration, which may not match your current commit. Applying them is new work with its
own defects: fix snippets that break when pasted, quotes from another commit, replacement code
written in a hurry, tests that pass because they cannot see the bug, and fixes that are each
right but wrong together. This skill is the order of work that catches those before commit.

## Workflow

1. **Pin the baseline.** Record your current commit (`git rev-parse HEAD`) and find the commit
   the review was written against (the review's header, the PR head at review time, or ask).
   If they differ, or the review's commit is unknown, say so and re-locate every cited
   `file:line` before judging it. Quoted code can come from an older commit or from another
   machine's configuration.
2. **Triage each finding from the source.** Open the cited file, its callers and the documented
   intent next to it (comments, migrations, `AGENTS.md`/`CLAUDE.md`, ADRs). Record a verdict with
   one line of evidence: *confirmed*, *confirmed with a narrower condition*, *conclusion right but
   mechanism wrong*, *false positive*, *stale*, or *needs a run*. A finding nobody can run stays
   *unverified*: do not act on it as fact and do not write it into documentation as fact.
3. **Judge the fix separately from the finding.** A correct finding often comes with a fix that
   breaks something the reviewer did not see. Before applying a suggested change, check:
   - Does removing this leave zero implementations in some profile or mode? (Two mutually
     exclusive configuration classes can mean that none loads in production.)
   - Does a new constraint contradict a documented intent, such as a one-to-many design?
   - Does narrowing a dependency or a visibility break a caller that compiles today?
   - Does the fix cover the whole failure path? (A timeout on the request may not bound reading
     the response body.)
   - Does it change delivery, retry or transaction semantics? Read
     [interactions](reference/interactions.md).
   - Does it bind the right parties? For an identity or account-linking flaw, list who controls each
     party (the requester, the browser that completes the flow, the account that consents) before
     accepting any binding, the reviewer's or your own. A binding between two parties the attacker
     controls closes nothing: against a forwarded OAuth consent link, a browser cookie/PKCE binding
     and a "confirm in chat" step for the requester both failed, because the attacker was the
     requester and could forward the start link as easily as the consent link.
4. **Treat your own replacement code as a hypothesis too.** Every snippet you write while
   remediating (a different fix, an alternative suggested in passing, an example in a document)
   is compiled or run once before it is committed, even a one-liner.
5. **Decide disagreements by source or execution.** When reviewers conflict, or a finding rests
   on memory ("the SDK already retries 429"), read the library source or run it; a reviewer's
   self-reported confidence is not evidence. A reviewer that could not reach the real database or
   broker (and fell back to SQLite or to reading code) needs its finding re-run on the real one.
   The same goes for a vendor API behind an existing client call: before a fix reuses that call for
   a security decision, read the vendor's documentation for the method *and the token type* in use
   (a profile endpoint that returns an e-mail for user tokens promised nothing for bot tokens, and
   the scope it needed had to be requested together with another one).
6. **Apply in small batches and re-check each batch.** Run an independent review lane and the
   execution checks on each batch's diff. Fixes interact with each other and with existing code,
   and a defect created by the remediation cannot be in the original review.
7. **Prove the tests pin the fix.** Revert the fix (or restore the old condition) and watch the
   new test fail; a test that passes either way pins nothing. Ask whether the test environment
   can see the defect at all (Evidence rules). Besides fakes, add one run of the real component
   against a fake upstream (for example the real CLI against a fake model API). Run the revert
   loop in a copy of the tree, never in place, even when you work alone: a background build or
   test run is a concurrent reader too. See [parallel-workers](reference/parallel-workers.md).
8. **Report honestly.** "Done (unverified)" is *not done*: list it as open with what is needed
   to verify it. Keep measured facts and inferences in separate sections, especially in text
   that another agent or worker will act on; it treats everything in a "facts" list as measured.
9. **Propagate corrections.** When a finding changes a claim in documentation, fix every place
   the claim appears (summary, headings, tables, checklists, Gotchas, index pages), not only the
   paragraph the reviewer cited. Hold the correction to the same evidence standard as the
   original claim: state the condition you verified, not its opposite generalization.

## References

| Read | When |
|---|---|
| [interactions](reference/interactions.md) | A fix changes acknowledgement, retries, attempt refunds or requeues, deduplication, transactions, persistence-context clearing, counters, or behavior in only some modes or profiles |
| [parallel-workers](reference/parallel-workers.md) | Remediation or verification is split across subagents, worktrees or concurrent scripts, or you are about to run revert checks while anything else (a background build, a test run, a review lane) reads the tree |

## Evidence rules

- **Open the cited file.** In one review, three false positives became visible only after
  opening the cited source.
- **Know who answered an external probe.** Check `server`, `WWW-Authenticate` and similar
  headers, and probe a path that does not exist as a control. A 401 from an auth proxy in front
  of the app says nothing about the app.
- **A negative result describes one configuration.** "Not reproduced", "no tool catches it" and
  "that property does not exist" depend on the scale, classpath, database, event loop and data
  shape you used. Vary the configuration before excluding a finding.
- **Check what the test environment can see.**
  - An embedded database that shares the application's clock hides mismatches between
    database-generated and application-computed timestamps (zone-less columns, a production
    database in another time zone).
  - A mocked transaction manager checks call order, not transaction boundaries. It also never sets
    `TransactionSynchronizationManager.isActualTransactionActive()`: a guard you add to a repository
    method (refuse or require an active transaction) is invisible to a mocked-manager spec of its
    caller. Pin the guard through the real caller with a real transaction manager, and check that the
    spec fails with the guard removed (Spring; any guard that reads the synchronization state).
  - Tests that never start the application/DI context never test wiring; tests that commit per
    call model a boundary that production does not have.
  - An in-process test client is not a client on a real socket: it can re-raise server errors
    and wait for background work that a real client never waits for, and it accepted a 204
    response with a body on which the real server dropped the connection.
  - A stub that returns a ready-made SDK response object skips the SDK's own response handling.
    A structured-output `parse` helper validated the body inside the call, so a refusal that
    carried text (anthropic 1.13 `messages.parse`) and an incomplete response with partial text
    (openai 2.53 `responses.parse`) surfaced as schema errors before the caller could read the
    stop reason or status. Stubbed tests could not see it; a test that drove the real client
    over an in-memory transport did.
- **When an old test fails after your fix, check its expected value before reverting the fix.**
  A test that pins the defect (for example `verify(exactly = 1)` on a resend) fails on the
  correct fix, and while it passes it tells the next reviewer the defect is intended.
- **A gate you pipe is no gate.** In `run-tests | tail -1 && deploy` the `&&` sees the status of
  `tail`, so the deploy runs on failing tests (zsh and bash without `pipefail`). Run the gate
  unpiped and trim its output afterwards, or set `pipefail`.
- **Verify the measurement too.** A timer started after the blocking call measured nothing (it
  reported zero delay); when a number contradicts the expectation, suspect the harness first.
- **Measure defaults; do not read them from a configuration object.** A value absent from a
  settings dict can still have an effective default elsewhere. Confirm a "fails fast" claim by
  starting without the value: some binders keep an unresolved placeholder as a literal string,
  and for a secret that placeholder text becomes the key.
- **One observation supports "under this condition, this result", nothing wider.**

## Editing many files by script

- `assert old in text` before every replacement. A replacement whose anchor is missing does
  nothing and reports success.
- Formatters (ktlint, ruff format, prettier) reflow lines and silently move anchors. Re-read the
  file after formatting and re-anchor.
- When a multi-step script fails midway, find which steps already applied (`git diff --stat`,
  `grep`) and rerun only the rest.

## Gotchas

- Agent pastes the review's fix snippet as written - the finding was right, the fix removes the
  only implementation or breaks a caller.
- Agent judges a finding from the review's quoted code - the quote is from another commit.
- Agent writes a replacement snippet while fixing a finding and commits it unrun - it does not
  compile.
- Agent marks an item done because the suite is green - the test environment could not see the
  defect, or the new test passes with the fix reverted.
- Agent trusts an old test that pins the defect - the re-review lane passes the code because the
  test agrees with it.
- Agent hands a worker an inference listed as a measured fact - the worker copies it into code
  comments and documents as truth.
- Agent excludes a finding after one failed reproduction - it reproduces at a larger scale or
  with another configuration.
- Agent fixes the sentence the reviewer quoted - the same claim survives in the summary, a table
  and a Gotcha.
- Agent corrects an overstatement with the opposite overstatement - the correction is not held to
  the evidence standard of the original claim.
- Agent reviews each fix alone - a fix meets an existing branch or another fix and produces a
  duplicate send or a lost event. See [interactions](reference/interactions.md).
- Agent's new test sets up the mechanism it is meant to check (a deferral scope, a transaction, a
  wrapper) and then calls the component - the test still passes when a production call site drops
  that mechanism. Drive the test through the real caller, and check that it fails with the mechanism
  removed from that call site.
- Agent wraps a whole method in a new catch for a broad type (`RuntimeException`, NPE) to classify
  one library failure - the catch also reclassifies the agent's own exceptions of that type. Wrap only
  the library call, and only in the state where that failure can happen.
- Agent sums a budget (shutdown time, pool size) from the settings it knows - a stage or code path it
  did not know about waits too. Find the stages in the framework source (lifecycle phases, blocking
  `stop()`/`destroy()`, nested transactions), measure with every one held busy and small timeouts, and
  pin the sum in a test.
- Agent adds a transaction guard to a repository method and re-runs the callers' mocked-manager specs -
  they stay green while the production caller throws from inside its own `TransactionTemplate`; one
  spec must go through the real caller with a real manager.

- Agent reverts a fix in place because it works alone - a background build or test run reads the
  reverted file and reports the revert as a failure (or builds an image from it), and a restore of
  the same size within the same second leaves the reverted bytecode in the cache.
- Agent rejects the reviewer's fix and proposes its own in the same breath - the alternative shares
  the blind spot (both bind parties the attacker controls). Enumerate the parties first.
- Agent reuses an existing client call for a new security check - the vendor documents the field
  only for another method or token type, and the check fails closed for every user.
- Agent's test fixture for a secret (a 32-character minimum, a key) trips the repository's secret
  scanner on the pull request - its entropy rule reads the fixture as a credential. Use a
  repetitive, obviously fake value and run the scanner on the diff before pushing.
- Agent pipes the test run through `tail` before `&&` - the deploy step runs although tests failed.
- Agent follows this file but does not open the reference the table routes to - it rebuilds a
  defect that interactions already lists (in the incident, one counter used as both ownership token
  and give-up budget).

## Maintaining this skill

Every rule here came from a recorded incident; the incidents and their dates are kept outside
this directory, in the author's wiki. Add a rule only with its incident, and state the condition
under which it applies.
