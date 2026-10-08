# skills — 개인 스킬 저작 저장소

준호가 직접 만들고 유지보수하는 Claude Code 스킬의 원본 저장소. 여기서 작성하고 `~/.claude/skills/<skill>` 로 심볼릭 링크해 배포한다(수정이 즉시 반영된다).

**이 저장소는 공개돼 있다(2026-10-07).** 이 파일은 저작자가 스킬을 쓰고 검증하는 절차이며 저작자의 노트북(`~/workspace/llm_wiki`, `~/infra`)을 전제로 한다. 스킬만 쓰는 사람에게는 `README.md`(영어)로 충분하다. 공개 전 점검은 `python3 scripts/check-skill.py`(인자 없이) — 스킬 본문·최상위 md·mods 소스에 홈 경로, 이메일, 위키 경로, `scripts/private-terms.txt`(git 미추적)의 프로젝트·회사 이름이 있으면 실패한다. `references/`, `.omc/`, `claude/`, mod 의 생성물은 `.gitignore` 로 제외된다.

**저작자 노트북이 아닌 기기에서 작업할 때 (2026-10-08)**: 위키와 `~/infra` 는 노트북에만 있다. 그 기기의 전역 지시(CLAUDE.md)와 `local-infra` 스킬이 위키·인프라를 쓰는 법을 정해 두었으면 그쪽이 이 파일보다 우선한다. 「참조 파일 하나를 만드는 절차」 8단계의 위키 기록은 그 기기의 위키 수정 요청 경로로 넘기고(넘길 내용은 8단계와 같다: 참고 자료, 검증 결과, 뒤집힌 주장, 교훈), 「검증 환경」의 "`~/infra` 를 묻지 않고 기동" 대신 사용자에게 노트북에서 켜 달라고 요청한다. 그 기기에 `scripts/private-terms.txt` 가 없으면 `check-skill.py` 가 이름 검사를 경고 없이 건너뛰므로 push 전에 사용자에게 알린다.

## 구조

```
skills/
├── AGENTS.md / CLAUDE.md     # 이 문서 (CLAUDE.md 는 이 파일을 import 만 한다)
├── README.md / LICENSE       # 공개용 설명(영어)·MIT
├── .omc-workspace            # OMC 상태를 루트 .omc/ 한 곳에 모으는 마커 — 지우지 않는다
├── references/               # 웹에서 가져온 참고 저장소(clone). 읽기 전용, 수정·삭제 금지. git 미추적(README 에 목록)
├── claude/                   # 기타 참고 문서(복사본). git 미추적
├── scripts/check-skill.py    # 스킬 구조 검사 (링크·앵커·frontmatter·description 길이·표 열 수·안내표·stray .omc·비공개 문자열)
├── scripts/private-terms.txt # check-skill.py 가 잡을 프로젝트·회사 이름. git 미추적
├── mods/<mod-name>/          # Claude Code mod(함수 훅 플러그인). SKILL.md 없음, check-skill.py 대상 아님 — 아래 「mods」
└── <skill-name>/             # 스킬 하나 = 디렉터리 하나
    ├── SKILL.md              # 핵심(~150줄 이하): 대상 버전 표, 공통 규칙, 참조 안내표, Gotchas
    └── reference/*.md        # 주제별 상세. SKILL.md 의 안내표로만 로드된다
```

- 현재 스킬: `kotlin-spring-boot` (Boot 4.1 / Kotlin 2.4 / Gradle KTS / Kotest+MockK), `kotlin-style` (Kotlin 2.4 / ktlint 1.8 / detekt 1.23·2.0 alpha — null 안전·관용구·클래스·예외, 프레임워크 무관), `python-fastapi` (Python 3.14 / FastAPI 0.142 / Pydantic 2.13 / SQLAlchemy 2.1 async / pytest-asyncio 1.4), `python-style` (Python 3.14 / ruff 0.16 / mypy 2.3 — 타입 어노테이션·관용구·컨벤션, 프레임워크 무관), `review-remediation` (스택 무관 절차 — 리뷰 지적 반영 순서·증거 규칙·병렬 워커. 버전 표 없음, 규칙마다 위키의 사건 기록이 근거).
- 이력 로그는 이 저장소에 두지 않는다. 위키 `~/workspace/llm_wiki/wiki/tech/skills-authoring.md` 에만 남긴다(위키 규칙은 그 저장소의 CLAUDE.md).

## 작성 규칙

- **스킬 본문은 전부 영어.** 참고 자료가 중국어여도 번역·인용하지 않고 내용을 재구성한다. 사용자와의 대화는 한국어.
- 대상 버전은 사용자가 실제로 쓰는 스택을 따른다. 버전 의존 문장에는 버전을 명시하고, `SKILL.md` 상단 표에 한곳으로 모은다.
- 모델이 이미 아는 일반론보다 **그 스택에서 조용히 틀리는 것**(컴파일·기동되고 단위 테스트도 통과하는 결함)을 우선한다. 각 파일 끝에 `## Gotchas` (`- Agent ... - ...` 형식)를 둔다.
- **코드 스니펫은 한 줄이라도 컴파일해 본 뒤에 넣는다.** 리뷰 지적을 반영하며 즉석으로 쓴 스니펫이 컴파일되지 않은 일이 세 번 있었다(nullable 제약·Boot 4 패키지 이동·`T : Any` 제약). Boot 4 는 클래스 위치가 많이 바뀌었으므로 import 경로도 jar 에서 확인한다.
- 규칙마다 **적용 전제**를 붙인다(예: "커스텀 CDC 릴레이일 때", "Kotlin 2.4 미만에서"). 한 설계에서 온 규칙이 다른 설계에 틀린 규칙이 되는 일이 있었다.
- **기준은 보편 관례다(2026-09-30).** 스킬은 어느 프로젝트에나 적용되는 일반 관례로 쓴다. 사용자 프로젝트는 대상 스택·버전을 정하는 데만 쓰고, 그 프로젝트 고유의 방식을 스킬 규칙과 엮지 않는다.
- 사용자의 실제 프로젝트는 관례 확인용으로 **읽기만** 한다. 민감 정보 규칙은 전역 CLAUDE.md 를 따른다(위키 domain/personal 내용을 스킬에 옮기지 않는다). 프로젝트·회사 이름은 `scripts/private-terms.txt` 에 적어 둔다 — 2026-10-07 공개 전 점검에서 프로젝트명이 SKILL.md 한 곳에 새어 있었고, 규칙만으로는 막지 못했다.

## 참조 파일 하나를 만드는 절차 (필수)

사용자가 요청한 흐름이다(2026-09-28·29). 단계를 건너뛰지 않는다.

1. **자료 수집** — `references/` 의 관련 스킬, 위키의 관련 경험 페이지, 사용자 프로젝트의 실제 관례.
2. **초안** — `reference/<topic>.md` 작성, `SKILL.md` 안내표·description 갱신.
3. **실행 검증** — 별도 에이전트가 scratch 프로젝트(Gradle 또는 venv)에서 주장을 실제로 돌린다(아래 "검증 환경").
4. **반영** — 틀린 것·빠진 조건을 고친다.
5. **Codex 리뷰** — `omc ask codex "<프롬프트>"` (raw `codex` CLI 를 직접 조립하지 않는다). 결과는 `.omc/artifacts/ask/` 에 저장된다.
6. **지적 재확인 후 반영** — 지적을 그대로 믿지 않는다. jar 바이트코드·메타데이터·실행으로 판정한다. 리뷰어끼리 결론이 반대면 둘 다 믿지 말고 소스/실행으로 판정한다.
7. **반영분 재검증** — 6단계에서 새로 쓴 문장·코드를 다시 실행 검증한다. 이 단계에서 실제 결함이 여러 번 나왔다(반영 중 쓴 스니펫이 컴파일 안 됨 등).
8. **위키 기록** — `skills-authoring.md` 이력(참고 자료, 검증 결과, 뒤집힌 주장, 교훈) + `log.md`, `bin/wikilint`, 커밋·push. **먼저 위키의 `git status` 를 본다** — `log.md`·`index.md` 가 수정 중이면 다른 세션이 위키를 쓰는 중이니 `skills-authoring.md` 에 자기 절만 추가하고, log·index·커밋은 건드리지 말고 그 세션에 통보한다(넣을 log 한 줄 포함). 위키 CLAUDE.md 「원격 접근」 의 같은 규칙(2026-10-06).

마무리 점검: `python3 scripts/check-skill.py <skill>` — 링크·앵커, frontmatter, description 1,024자 상한(Agent Skills 명세), 표 행의 열 수, 안내표 누락, 스킬 안의 `.omc/`, 비공개 문자열(홈 경로·이메일·위키·`private-terms.txt`)을 검사한다. 0 problem 이어야 끝. 100줄 넘는 reference 에 `Contents:` 목차가 없으면 경고만 낸다. 스크립트로 문서를 고칠 때는 표 행을 통째로 앵커로 잡는다 — 행 일부만 잡아 링크 열이 다음 행으로 밀린 일이 있었다(2026-10-01, 링크 검사는 통과).

## 검증 환경

- scratch 경로는 세션 scratchpad 아래(`.../scratchpad/<name>verify`). `~/workspace` 의 다른 프로젝트를 수정하지 않는다.
- Gradle wrapper 는 기존 scratch 프로젝트나 사용자 프로젝트에서 **복사**해 쓴다(원본 수정 금지). JDK 는 로컬 21(25 는 미설치일 수 있음 — 확인하고 쓴다).
- **클래스패스 변형은 모듈을 분리**한다(예: Reactor 브리지 유무, 보안 스타터 유무). 한 클래스패스에 섞으면 다른 테스트의 결과가 바뀐다.
- **JVM 전역 상태**(Reactor `Hooks`, Logback `LoggerContext`, `ContextRegistry`)를 건드리는 테스트는 JVM 을 분리해 돌린다(`forkEvery = 1` 또는 개별 실행). 같은 JVM 의 앞 테스트가 뒤 테스트를 오염시킨 사례가 있다.
- **설정 조합마다 동작이 갈리는 주제(셧다운, 타임아웃, 전송 구현, 스레드 모델)는 처음부터 행렬로 측정하고 표로 쓴다.** "기다린다/안 기다린다" 같은 한 줄 요약이 가장 자주 틀렸다(2026-10-01: 셧다운 두 문장, read-timeout, watchdog). "모든 전송/모든 경우"는 측정한 범위로만 쓰고, 소스로만 본 칸은 "from source"·"not run" 으로 표시한다.
- **Kotlin 컴파일러 경고는 kotlinc 직접 실행이나 Gradle 기본 출력 + `--rerun-tasks` 로 센다**(특히 "경고 없음" 판정). Gradle 9.7 + Kotlin 2.4 에서 `--warning-mode all` 은 Kotlin 경고를 처음 15개만 보이고(안내 없음), UP-TO-DATE 태스크는 경고를 다시 내지 않으며, 오류가 있는 모듈은 경고를 아예 내지 않는다(`-Xreport-all-warnings` 로 유지). 2026-10-02 kotlin-style 검증에서 발견.
- **부정 판정("없다", "안 된다")은 환경을 함께 확인**한다. Boot 4 는 자동 구성이 모듈로 쪼개져 있어 "메타데이터에 속성이 없음"이 "그 모듈을 안 넣었음"일 수 있다.
- 검증에 DB·Kafka·Redis 가 필요하면 `~/infra` 를 **묻지 않고 기동**해 쓴다(2026-09-30 결정, 절차는 `local-infra` 스킬). 공용 인스턴스에는 검증 전용 DB·토픽 접두어를 만들어 쓰고 끝나면 지운 뒤, 스택을 내릴지 묻는다. `redis-cluster` 는 기동 시 호스트 포트 고갈 이슈가 있다(`~/infra/docs/issue-redis-cluster-bus-port-loop.md`) — 해결 전에는 임시 단일 컨테이너를 쓴다. Testcontainers 류는 컴파일 확인까지만 해도 된다.
- **scratch 는 재부팅에 사라진다**(`/private/tmp`). 검증 결과는 곧바로 스킬 본문·위키에 반영해 두고, 에이전트 보고는 "문제만, 짧게, 중요한 것 먼저"로 요청한다(긴 보고는 잘리고, 세션이 끊기면 나머지를 받을 수 없다).
- 버전·API 사실은 기억이 아니라 조회로: `~/.claude/skills/dependency-bump/scripts/latest-versions.sh`(Maven·Gradle 전용), 캐시된 jar(`~/.gradle/caches/modules-2/files-2.1`)의 `javap`, `META-INF/spring-configuration-metadata.json`. PyPI 는 `https://pypi.org/pypi/<pkg>/json`, 설치된 패키지의 소스와 `importlib.metadata`.

### Python 스킬을 검증할 때

- scratch venv 는 `python3.14 -m venv` + pip. **패키지 조합 변형은 venv 를 분리**한다(extra 유무, httpx 와 httpx2, 구버전 비교). 에이전트가 공용 venv 에 패키지를 추가하면 다른 검증 결과가 바뀐다.
- **"클라이언트가 실제로 받는 것"은 uvicorn 서브프로세스 + 소켓으로 확인**한다. in-process 테스트 클라이언트는 예외를 다시 던지고, 스트림을 버퍼링하고, 타임아웃과 `Content-Length` 를 검사하지 않는다. 종료 동작은 SIGTERM 과 SIGINT 를 둘 다 본다.
- **구현이 갈리는 축은 양쪽을 돌린다**: stdlib 이벤트 루프와 uvloop, httptools 와 h11, 대상 DB 와 SQLite. 한쪽 결과를 일반화해 틀린 일이 여러 번 있었다.
- 기본값은 설정 dict 가 아니라 **동작으로** 확인한다(멈춘 서버에 붙여 타임아웃 재기 등).
- 끝없이 도는 제너레이터·루프를 시험할 때는 서브프로세스로 띄우고 제한 시간 뒤 `kill -9` 한다(이벤트 루프가 점유돼 서버가 멈춘 적이 있다).

### 헤드리스 실전 검증 (트리거·라우팅)

- 세션이 직접 띄운다: `env -u CLAUDECODE claude -p "<프롬프트>" --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools Bash Read Edit Write Glob Grep Skill Agent`. 프롬프트에 스킬을 언급하지 않는다. `--permission-mode bypassPermissions` 는 자동 모드 분류기가 거부한다(2026-10-02). 그때 "사용자만 실행 가능"으로 잘못 결론냈고, 기존 방식은 허용됐다.
- 판정은 트레이스의 도구 호출로 한다. `Skill` 호출과 스킬 파일 읽기를 세는데, 세션이 Read 대신 Bash `grep`/`sed` 로 절만 읽는 경우가 많으니 그것도 센다(`.omc/artifacts/field-2026-10-02/trace.py`).
- 시드 결함은 투입 전에 실행으로 재현한다. **재현되지 않으면 스킬 문장부터 의심한다** — 2026-10-02 Hibernate 7.4 에서 "컬렉션 fetch join + 페이지네이션은 메모리 페이징" 이 이렇게 드러났다.

## Codex 리뷰 프롬프트 요령

- 대상 파일, 스택 버전, 조회 가능한 jar/클래스패스 경로를 준다.
- **이미 실행으로 확인된 사실을 나열**하고 "강한 반대 증거 없이는 다시 다투지 말라"고 적는다 — 토큰과 시간이 줄고 새 지적에 집중한다.
- "바이트코드 전체를 덤프하지 말고 출력은 작게"를 적는다(사용량 한도에 걸려 발견 0건으로 중단된 적이 있다).
- 출력 형식: 번호·심각도(wrong/misleading/missing/nit)·file:line·주장·근거·수정안.
- 한도에 걸리면 리셋 시각을 사용자에게 알리고, 대체 리뷰어로 갈지 기다릴지 묻는다.
- Codex 가 DB·브로커에 접근하지 못해 SQLite 나 소스 판독으로만 확인한 지적은 **대상 인프라에서 다시 실행해** 판정한다.
- 여러 파일을 순차 실행하는 스크립트에서 한도 감지는 오류 문구 전체(`hit your usage limit`)로 한다 — 프롬프트 안의 단어와 겹쳐 배치가 멈춘 적이 있다.

## 버전 올릴 때

1. `SKILL.md` 대상 버전 표 갱신(최신은 `latest-versions.sh` 로 조회).
2. 스킬 디렉터리에서 버전 문자열을 grep 해 해당 문장만 재검증. 찾을 문자열은 각 `SKILL.md` 의 "Maintaining this skill" 절에 있다(Kotlin: `Boot 4`, `4.1`, `Framework 7`, `Hibernate 7`, `Jackson 3`, `Kotlin 2.`, `2.3.20`, `2.4` / Python: `FastAPI 0.`, `Starlette 1.`, `Pydantic 2.`, `SQLAlchemy 2.`, `Python 3.`, `httpx2` 등).
3. 위키 `skills-authoring.md` 의 "검증으로 뒤집힌 주장" 표 항목은 버전 경계에 걸린 것이 많다 — 우선 재실행.
4. 위키 이력에 한 줄.

## 배포

```sh
ln -s ~/workspace/skills/<skill> ~/.claude/skills/<skill>   # 최초 1회
```

심볼릭 링크라 이후 수정은 즉시 반영된다. 새 스킬을 만들면 링크를 만들고 스킬 목록에 뜨는지 확인한다.

## mods — Claude Code 함수 훅 플러그인 (2026-10-07)

`mods/<mod>/` 는 스킬이 아니라 **mod** 다: `.claude-plugin/plugin.json` + `hooks/hooks.json` + `hooks/register.ts(x)` (+ `types/index.d.ts` 상태 계약, `tests/*.test.ts(x)`). 모델이 읽는 절차(스킬)와 달리 하네스가 도구 호출을 **거부·재작성·표시**한다. 현재: `wiki-guard`(위키 편집 규칙 강제), `infra-pane`(`~/infra` 상태 pane·`/infra`), `infra-preflight`(infra 기동 전 Tailscale·BIND_IP 검사). 결정·검증·API 델타는 위키 `wiki/tech/claude-code-mods.md` 에만 기록한다.

- 배포는 스킬과 같다: `ln -s ~/workspace/skills/mods/<mod> ~/.claude/skills/<mod>`. skills 폴더의 플러그인은 매 세션 자동 로드되고 파일 변경 시 리로드된다.
- 켜고 끄기: 각 매니페스트의 `userConfig.enabled`(boolean) 가 `/config` 에 `<mod>.enabled` 행으로 뜬다. 끄면 훅이 통과만 시킨다(mod 마다 꺼진 동작은 `description` 에 적혀 있다).
- 고치는 절차: `claude plugin validate mods/<mod>` → `tsc -p mods/<mod>`(엔진이 로드 때 깔아 둔 `.claude-plugin/types/`·`tsconfig.json` 을 쓴다; 생성물이라 수정·커밋하지 않는다) → `claude plugin test mods/<mod>`(kit 의 모의 바닥 훅 — 실제 git·docker 는 돌지 않으니 실세션에서도 한 번 본다). API 는 early access 라 Claude Code 버전이 오르면 `plugin-authoring` 스킬이 다시 쓰는 타입 파일로 재검사한다.
- 작성 규칙 중 영어 본문·보편 관례 기준은 mod 에도 적용한다. 다만 mod 는 이 노트북의 경로(`~/workspace/llm_wiki`, `~/infra`)를 전제로 하는 개인 도구다 — 경로는 `$HOME` 기준으로만 적는다.
