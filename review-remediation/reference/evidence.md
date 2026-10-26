# Evidence

Use this when you are about to rely on a probe, a negative result, a test environment, a
measurement or a default, to write a finding into documentation, or to edit many files by
script. Each rule comes from an observed run.

Contents: [Evidence rules](#evidence-rules) · [Editing many files by script](#editing-many-files-by-script) ·
[Gotchas](#gotchas)

## Evidence rules

- **Open the cited file.** In one review, three false positives became visible only after
  opening the cited source.
- **Trace the mechanism a finding describes before writing it into documentation.** A finding
  said a lost status write would "re-deliver under a new event id"; the code's recovery sweep
  reclaims the same row, so the id never changes and the deduplication advice written from the
  finding was wrong. The finding was right about the risk and wrong about the path, and the
  path was copied (caught by a second, independent review).
- **Check user-facing text that a plan or a fix introduces against what the product lets the user
  do, and against the module's own wording rules, before a worker gets it as an exact string.** A
  plan told users to "ask me here" in the bot's direct message, which the production manifest keeps
  read-only, and named the transport inside a transport-neutral domain; the worker followed the
  strings and rewrote the documented rule to fit them. Both reached the review lanes untouched. A
  worker reporting that it changed a rule sentence to match a brief is the signal to re-read the
  brief.
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

- Agent excludes a finding after one failed reproduction - it reproduces at a larger scale or
  with another configuration.
- Agent trusts an old test that pins the defect - the re-review lane passes the code because the
  test agrees with it.
- Agent documents a finding's description of a mechanism ("a new id on redelivery") without tracing
  it - the risk is real, the path is not, and the documented mitigation targets the wrong path.
- Agent pipes the test run through `tail` before `&&` - the deploy step runs although tests failed.
- Agent edits many files by script without asserting each anchor - a missing anchor does nothing
  and reports success.
