# skills

Claude Code skills and function-hook mods, written and maintained by one person for the stacks
they work on. Each skill states general practice for a pinned version of a stack and leads with
the mistakes that compile, start and pass unit tests anyway. Every claim was run on the pinned
versions before it was written down; the version table at the top of each `SKILL.md` says what
was verified and when.

## Skills

| Skill | Scope |
| --- | --- |
| [kotlin-spring-boot](kotlin-spring-boot/SKILL.md) | Kotlin + Spring Boot 4 backends: beans and configuration, JPA and Hibernate 7, transactions, web and ProblemDetail, security, HTTP clients, scheduling and executors, coroutines, Kafka and outbox, Modulith, observability, tests, Gradle. |
| [kotlin-style](kotlin-style/SKILL.md) | How to write Kotlin on the JVM, framework-independent: null safety, idioms, classes, collections, exceptions, ktlint and detekt findings. |
| [python-fastapi](python-fastapi/SKILL.md) | Python + FastAPI backends: dependencies and lifespan, Pydantic v2, SQLAlchemy 2 async, asyncio, errors, streaming, security, observability, Kafka and Redis, tests, packaging. |
| [python-style](python-style/SKILL.md) | How to write Python, framework-independent: complete type annotations, idioms, conventions, ruff and mypy configuration. |
| [review-remediation](review-remediation/SKILL.md) | Stack-independent: how to act on an existing review without breaking things, including fix interactions and parallel workers. |

Each skill is one directory: `SKILL.md` (the version table, the always-on rules, a routing table,
and a `Gotchas` list) plus `reference/*.md` with the details, which Claude loads through the
routing table only.

## Install

Symlink a skill into `~/.claude/skills/` (user scope) or copy it into a project's
`.claude/skills/`. A symlink picks up edits immediately.

```sh
git clone https://github.com/TrulyNotMalware/skills ~/workspace/skills
ln -s ~/workspace/skills/kotlin-spring-boot ~/.claude/skills/kotlin-spring-boot
```

## Checking a skill

```sh
python3 scripts/check-skill.py                 # every skill, plus a privacy scan of README, AGENTS.md and mods/
python3 scripts/check-skill.py python-fastapi  # one skill
```

The script checks relative links and anchors, the frontmatter, the description length limit of
the Agent Skills specification, table column counts, the routing table, stray `.omc/` state, and
that nothing machine-specific (home directory paths, e-mail addresses, the author's wiki) or
project-specific (names listed in the git-ignored `scripts/private-terms.txt`) appears in the
text.

## Mods

`mods/` holds Claude Code plugins made of function hooks. Unlike a skill, which the model reads,
a mod runs in the harness and refuses, rewrites or displays tool calls.

| Mod | What it does |
| --- | --- |
| [wiki-guard](mods/wiki-guard) | Enforces a personal wiki's edit rules at tool-call time: `raw/` is immutable, `log.md` is append-only, public pages never link local-only pages, commits wait for the linter. |
| [infra-pane](mods/infra-pane) | A live pane and status line for a local infra testbed: compose services, the OrbStack k8s cluster, Tailscale, with stop buttons and toggles. |
| [infra-preflight](mods/infra-preflight) | Refuses `docker compose up` on an infra service while Tailscale is down or the service's `BIND_IP` has drifted from the Tailscale address. |

They are bound to the author's machine (`~/workspace/llm_wiki`, `~/infra`, Tailscale, OrbStack)
and are published as working examples of the hook API, not as drop-in tools. The hook API is
early access; `.claude-plugin/types/` and each mod's `tsconfig.json` are generated when the mod
loads and are not committed. Each mod has an `enabled` switch in `/config`.

## Reading list

The skills were written after reading these repositories. They are cloned under `references/`
for reading and are not part of this repository:

- https://github.com/piomin/claude-ai-spring-boot (Apache-2.0)
- https://github.com/rrezartprebreza/spring-boot-skills (MIT)
- https://github.com/yalishevant/kotlin-backend-agent-skills (MIT)
- https://github.com/rishapgandhi/python-skills (MIT)
- https://github.com/manikosto/claude-code-python-stack (no license file)
- https://github.com/awesome-skills/code-review-skill (MIT)

## AGENTS.md

`AGENTS.md` is the author's working procedure for writing and verifying these skills. It is in
Korean and assumes the author's machine; `CLAUDE.md` imports it so that Claude Code follows it in
this checkout. If you clone the repository to use the skills, you can ignore or delete both.

## License

MIT, see [LICENSE](LICENSE).
