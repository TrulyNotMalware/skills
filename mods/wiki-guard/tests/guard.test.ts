import { expect, mock, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

const HOME = '/Users/t'
const ROOT = `${HOME}/workspace/llm_wiki`
const NOW = 1_000_000

type Files = Record<string, string>
type Runs = Record<string, { exitCode: number; stdout: string }>
type World = { files: Files; mtimes: Record<string, number>; runs: Runs; toasts: string[]; bottom: string[]; cwd: string; clock: MockClock }

function world(on: On, files: Files, runs: Runs = {}, cwd = ROOT): World {
  const clock = mock.clock(on, { now: NOW })
  const w: World = { files, mtimes: {}, runs, toasts: [], bottom: [], cwd, clock }
  mock.env(on, { HOME })
  mock.store(on)
  on('session.cwd', () => ({ value: w.cwd }))
  on('fs.exists', ($, e) => ({ value: e.path in w.files }))
  on('fs.read', ($, e) => (e.path in w.files ? { value: w.files[e.path] as string } : { deny: `ENOENT ${e.path}` }))
  on('fs.list', ($, e) => {
    const prefix = `${e.path}/`
    const names = new Map<string, 'file' | 'dir'>()
    for (const path of Object.keys(w.files)) {
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length)
      const [head] = rest.split('/')
      if (head) names.set(head, rest.includes('/') ? 'dir' : 'file')
    }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 1, mtimeMs: 1, isLink: false })) }
  })
  on('fs.stat', ($, e) =>
    e.path in w.files ? { value: { kind: 'file' as const, size: 1, mtimeMs: w.mtimes[e.path] ?? 1, isLink: false } } : { deny: 'ENOENT' },
  )
  on('process.run', ($, e) => {
    const key = e.argv.join(' ')
    for (const [pattern, answer] of Object.entries(w.runs)) {
      if (key.includes(pattern)) return { value: { ...answer, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 127, stdout: '', stderr: `no fake for ${key}`, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('tool.call', async ($, e) => {
    w.bottom.push(e.tool)
    if (e.tool === 'Bash') {
      if (e.command.includes('python3')) {
        // an edit made by the command itself, after the hook read the clock
        await clock.advance(10)
        w.mtimes[`${ROOT}/log.md`] = clock.now()
      }
      const text = e.command.includes('wikilint') ? 'wiki lint: 77 pages, 0 errors (worktree)' : 'ok'
      return { result: { stdout: text, stderr: '', interrupted: false }, text } as never
    }
    return { result: { ran: e.tool } } as never
  })
  return w
}

const deny = (r: unknown): string => (r as { deny?: string }).deny ?? ''

test('raw/: editing or overwriting an existing original is refused; a new note under raw/research is not', async ($, on) => {
  const w = world(on, { [`${ROOT}/raw/clip.md`]: 'orig' })
  expect(deny(await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/raw/clip.md`, old_string: 'orig', new_string: 'x' }))).toMatch(/immutable/)
  expect(deny(await $.tool.call({ tool: 'Write', file_path: `${ROOT}/raw/clip.md`, content: 'x' }))).toMatch(/immutable/)
  expect(deny(await $.tool.call({ tool: 'Write', file_path: `${ROOT}/raw/research/new-report.md`, content: 'x' }))).toBe('')
  expect(deny(await $.tool.call({ tool: 'Edit', file_path: 'raw/clip.md', old_string: 'orig', new_string: 'x' }))).toMatch(/immutable/)
  expect(w.bottom).toEqual(['Write'])
})

test('raw/ through the shell: rm, mv, sed -i and overwriting redirects are refused; a redirect to a new file passes', async ($, on) => {
  world(on, { [`${ROOT}/raw/clip.md`]: 'orig' })
  const bash = (command: string) => $.tool.call({ tool: 'Bash', command })
  expect(deny(await bash('rm raw/clip.md'))).toMatch(/immutable/)
  expect(deny(await bash('cd raw && ls; mv raw/clip.md raw/old.md'))).toMatch(/immutable/)
  expect(deny(await bash("sed -i '' 's/a/b/' raw/clip.md"))).toMatch(/immutable/)
  expect(deny(await bash('echo x >> raw/clip.md'))).toMatch(/immutable/)
  expect(deny(await bash(`cat > ${ROOT}/raw/clip.md <<'X'\nnew\nX`))).toMatch(/immutable/)
  expect(deny(await bash('cat > raw/research/fresh.md <<X\nnew\nX'))).toBe('')
  expect(deny(await bash('grep -n foo raw/clip.md > /tmp/out.txt'))).toBe('')
  expect(deny(await bash('cp raw/clip.md /tmp/copy.md'))).toBe('')
  expect(deny(await bash('rm -rf withdraw/x && ls draw/'))).toBe('')
  // a heredoc body is data: a script that mentions rm raw/… is written, not run
  expect(deny(await bash("cat > /tmp/cleanup.sh <<'SH'\nrm raw/clip.md\nSH"))).toBe('')
})

test('log.md: the committed text is frozen; appending and editing the uncommitted tail pass', async ($, on) => {
  const committed = '# Log\n\n## [2026-10-06] update | a\n- one\n'
  const current = committed + '\n## [2026-10-07] query | b\n- two\n'
  world(on, { [`${ROOT}/log.md`]: current }, { 'git show HEAD:log.md': { exitCode: 0, stdout: committed } })
  const path = `${ROOT}/log.md`
  expect(deny(await $.tool.call({ tool: 'Edit', file_path: path, old_string: '- one', new_string: '- ONE' }))).toMatch(/append-only/)
  expect(deny(await $.tool.call({ tool: 'Edit', file_path: path, old_string: '- two', new_string: '- two, revised' }))).toBe('')
  expect(deny(await $.tool.call({ tool: 'Edit', file_path: path, old_string: '- two\n', new_string: '- two\n\n## [2026-10-07] update | c\n' }))).toBe('')
  expect(deny(await $.tool.call({ tool: 'Write', file_path: path, content: committed + '\n## [2026-10-07] x\n' }))).toBe('')
  expect(deny(await $.tool.call({ tool: 'Write', file_path: path, content: '# Log\n' }))).toMatch(/append-only/)
  expect(deny(await $.tool.call({ tool: 'Edit', file_path: path, old_string: '- one', new_string: '- ONE', replace_all: true }))).toMatch(/append-only/)
})

test('a local log has no HEAD: everything before the last entry is frozen', async ($, on) => {
  const current = '# Personal log\n\n## [2026-10-01] a\n- one\n\n## [2026-10-07] b\n- two\n'
  world(on, { [`${ROOT}/wiki/personal/log.md`]: current })
  const path = `${ROOT}/wiki/personal/log.md`
  expect(deny(await $.tool.call({ tool: 'Edit', file_path: path, old_string: '- one', new_string: '- ONE' }))).toMatch(/append-only/)
  expect(deny(await $.tool.call({ tool: 'Edit', file_path: path, old_string: '- two', new_string: '- two (more)' }))).toBe('')
  expect(deny(await $.tool.call({ tool: 'Write', file_path: path, content: current + '\n## [2026-10-08] c\n' }))).toBe('')
})

test('a committed page may not wikilink a local-only page; public links and local pages themselves are free', async ($, on) => {
  world(on, {
    [`${ROOT}/wiki/tech/kafka.md`]: '',
    [`${ROOT}/wiki/study/java.md`]: '',
    [`${ROOT}/wiki/personal/profile.md`]: '',
    [`${ROOT}/wiki/domain/deep/customer-notes.md`]: '',
    [`${ROOT}/index.md`]: '',
  })
  const edit = (file: string, text: string) => $.tool.call({ tool: 'Edit', file_path: `${ROOT}/${file}`, old_string: 'x', new_string: text })
  expect(deny(await edit('wiki/tech/kafka.md', 'see [[profile]] and [[customer-notes|notes]]'))).toMatch(/\[\[profile\]\], \[\[customer-notes\]\]/)
  expect(deny(await edit('index.md', '- [[wiki/personal/profile]]'))).toMatch(/local-only/)
  expect(deny(await edit('wiki/tech/kafka.md', 'see [[java]] and [[kafka#section]]'))).toBe('')
  expect(deny(await edit('wiki/tech/kafka.md', 'path text: wiki/personal/profile.md'))).toBe('')
  expect(deny(await edit('wiki/personal/profile.md', 'see [[customer-notes]] and [[java]]'))).toBe('')
  expect(deny(await $.tool.call({ tool: 'Write', file_path: `${ROOT}/wiki/tech/new.md`, content: '[[profile]]' }))).toMatch(/local-only/)
  expect(deny(await $.tool.call({ tool: 'Write', file_path: `${ROOT}/scripts/x.sh`, content: '[[profile]]' }))).toBe('')
})

test('git commit waits for a wikilint run newer than every changed file', async ($, on) => {
  const w = world(
    on,
    { [`${ROOT}/wiki/tech/a.md`]: '', [`${ROOT}/log.md`]: '' },
    { 'status --porcelain=v1': { exitCode: 0, stdout: ' M wiki/tech/a.md\n M log.md\n?? wiki/tech/new.md\n' } },
  )
  w.mtimes[`${ROOT}/wiki/tech/a.md`] = NOW - 10
  w.mtimes[`${ROOT}/log.md`] = NOW - 5
  const bash = (command: string) => $.tool.call({ tool: 'Bash', command })
  expect(deny(await bash('git commit -q -m "x"'))).toMatch(/wikilint has not run.*2 newer/)
  expect(deny(await bash('git add -A && git commit -m "x"'))).toMatch(/wikilint/)
  expect(deny(await bash('bin/wikilint 2>&1 | tail -2'))).toBe('')
  expect(deny(await bash('git commit -q -m "x" && git push'))).toBe('')
  w.mtimes[`${ROOT}/log.md`] = NOW + 1 // edited after the lint
  expect(deny(await bash('git commit -q -m "y"'))).toMatch(/1 newer: log.md/)
  expect(deny(await bash('git status'))).toBe('')
  // a lint chained before the commit in one command passes the gate (the lint's own exit decides)
  expect(deny(await bash('bin/wikilint | tail -1 && git add -A && git commit -q -m "z" && git push'))).toBe('')
  expect(deny(await bash('git commit -q -m "w" && bin/wikilint'))).toMatch(/1 newer: log.md/)
  // the words in a heredoc body or a quoted string are data, not a commit
  expect(deny(await bash("python3 - <<'PY'\ns = 'run git commit later'\nPY"))).toBe('')
  expect(deny(await bash('echo "git commit" >> notes.md'))).toBe('')
  expect(deny(await bash('git commit -m "wikilint later"'))).toMatch(/1 newer: log.md/)
  // `edit && lint` in one command: the file is touched after the command starts, the lint still saw it
  expect(deny(await bash('python3 -I fix.py && bin/wikilint 2>&1 | tail -1'))).toBe('')
  expect(deny(await bash('git commit -q -m "v"'))).toBe('')
  // but a lint that ran BEFORE an edit in the same command is marked at the start, so the edit counts as newer
  expect(deny(await bash('bin/wikilint && python3 -I fix.py'))).toBe('')
  expect(deny(await bash('git commit -q -m "u"'))).toMatch(/1 newer: log.md/)
})

test('outside the wiki nothing is checked', async ($, on) => {
  const w = world(on, { [`${HOME}/other/raw/clip.md`]: 'orig' }, {}, `${HOME}/other`)
  expect(deny(await $.tool.call({ tool: 'Edit', file_path: `${HOME}/other/raw/clip.md`, old_string: 'orig', new_string: 'x' }))).toBe('')
  expect(deny(await $.tool.call({ tool: 'Bash', command: 'rm raw/clip.md && git commit -m x' }))).toBe('')
  expect(w.bottom).toEqual(['Edit', 'Bash'])
})

test('session.start toasts when log.md or index.md is already modified in the wiki', async ($, on) => {
  const w = world(on, {}, { 'status --porcelain=v1': { exitCode: 0, stdout: ' M index.md\n M log.md\n M wiki/tech/a.md\n' } })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect(w.toasts.join('\n')).toMatch(/index\.md, log\.md.*another session/)
})

test('wiki-guard.enabled = false: every call passes through, nothing is checked', { options: { enabled: false } }, async ($, on) => {
  const w = world(on, { [`${ROOT}/raw/clip.md`]: 'orig', [`${ROOT}/wiki/personal/profile.md`]: '' })
  expect(deny(await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/raw/clip.md`, old_string: 'orig', new_string: 'x' }))).toBe('')
  expect(deny(await $.tool.call({ tool: 'Write', file_path: `${ROOT}/wiki/tech/a.md`, content: '[[profile]]' }))).toBe('')
  expect(deny(await $.tool.call({ tool: 'Bash', command: 'rm raw/clip.md; git commit -m x' }))).toBe('')
  expect(w.bottom).toEqual(['Edit', 'Write', 'Bash'])
})
