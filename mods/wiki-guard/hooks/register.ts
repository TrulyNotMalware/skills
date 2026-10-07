import type { EngineInterface, Register } from 'claude-code'

// The wiki this guard protects, relative to $HOME (CLAUDE.md of that repo holds the rules).
const WIKI_REL = 'workspace/llm_wiki'
// Local-only areas (git-ignored): never linked from a committed page.
const LOCAL_DIRS = ['wiki/domain/', 'wiki/personal/', 'raw/private/', 'canvas/', 'backups/'] as const
const LOG_PATHS = ['log.md', 'wiki/domain/log.md', 'wiki/personal/log.md'] as const
const LINT_AT = { plugin: 'wiki-guard', key: 'lintAt' } as const

const WIKILINK = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g
// A shell verb that changes a file in place, with the rest of its simple command.
const SHELL_VERB =
  /(?:^|[;&|(]\s*|\bthen\s+|\bdo\s+)(?:sudo\s+)?(rm|mv|cp|tee|git\s+rm|git\s+mv|sed\s+-i\S*)\b([^;&|]*)/g
// A path token that is, or lies under, a `raw/` directory.
const RAW_TOKEN = /(?<![\w.-])(?:[\w~./-]*\/)?raw\//
// `> file` or `>> file`, not `2>&1`, `&>`, `<`.
const REDIRECT = /(?<![<>&\d])>{1,2}\s*['"]?([^\s'"|;&<>]+)/g

type GuardEngine = EngineInterface

let homeDir: string | undefined
async function home($: GuardEngine): Promise<string> {
  homeDir ??= (await $.env.get('HOME')) ?? '/'
  return homeDir
}
async function wikiRoot($: GuardEngine): Promise<string> {
  return `${await home($)}/${WIKI_REL}`
}

function normalize(path: string): string {
  const isAbsolute = path.startsWith('/')
  const parts: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return (isAbsolute ? '/' : '') + parts.join('/')
}

async function absolute($: GuardEngine, path: string, cwd?: string): Promise<string> {
  let p = path
  if (p === '~' || p.startsWith('~/')) p = (await home($)) + p.slice(1)
  if (!p.startsWith('/')) p = `${cwd ?? (await $.session.cwd())}/${p}`
  return normalize(p)
}

/** The path relative to `root`, or null when it is not under it. */
function relOf(root: string, path: string): string | null {
  if (path === root) return ''
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null
}

function isLocal(rel: string): boolean {
  return LOCAL_DIRS.some(dir => rel.startsWith(dir))
}

// --- page index: stems of local-only pages and of public pages, cached briefly ---

type PageIndex = { local: Set<string>; pub: Set<string>; at: number }
let pageIndex: PageIndex | undefined

async function walk($: GuardEngine, dir: string, out: string[]): Promise<void> {
  let entries
  try {
    entries = await $.fs.list(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const path = `${dir}/${entry.name}`
    if (entry.kind === 'dir') await walk($, path, out)
    else if (entry.kind === 'file' && entry.name.endsWith('.md')) out.push(path)
  }
}

async function pagesOf($: GuardEngine, root: string): Promise<PageIndex> {
  const now = await $.clock.now()
  if (pageIndex && now - pageIndex.at < 30_000) return pageIndex
  const files: string[] = []
  await walk($, `${root}/wiki`, files)
  const local = new Set<string>()
  const pub = new Set<string>()
  for (const file of files) {
    const rel = relOf(root, file) ?? ''
    const stem = (file.split('/').pop() ?? '').replace(/\.md$/, '')
    ;(isLocal(rel) ? local : pub).add(stem)
  }
  pageIndex = { local, pub, at: now }
  return pageIndex
}

/** Wikilinks in `text` that resolve only to a local-only page. */
async function localLinksIn($: GuardEngine, root: string, text: string): Promise<string[]> {
  if (!text.includes('[[')) return []
  const { local, pub } = await pagesOf($, root)
  const bad = new Set<string>()
  for (const match of text.matchAll(WIKILINK)) {
    const target = (match[1] ?? '').trim()
    const stem = (target.split('/').pop() ?? '').replace(/\.md$/, '')
    if (stem && local.has(stem) && !pub.has(stem)) bad.add(stem)
  }
  return [...bad]
}

// --- log.md: committed text (or, for an untracked local log, every entry but the last) is frozen ---

type EditLike = { tool: 'Edit'; old_string: string; new_string: string; replace_all?: boolean }
type WriteLike = { tool: 'Write'; content: string }

async function logViolation(
  $: GuardEngine,
  root: string,
  rel: string,
  path: string,
  e: EditLike | WriteLike,
): Promise<string | undefined> {
  let current: string
  try {
    current = await $.fs.read(path)
  } catch {
    return undefined // no file yet: nothing frozen
  }
  let proposed: string
  if (e.tool === 'Edit') {
    const at = current.indexOf(e.old_string)
    if (at < 0) return undefined // the tool refuses this itself
    proposed = e.replace_all
      ? current.split(e.old_string).join(e.new_string)
      : current.slice(0, at) + e.new_string + current.slice(at + e.old_string.length)
  } else {
    proposed = e.content
  }
  let frozen: string
  if (rel === 'log.md') {
    const shown = await $.process.run(['git', 'show', 'HEAD:log.md'], { cwd: root, timeoutMs: 15_000 })
    if (shown.exitCode !== 0) {
      return 'wiki-guard: could not read the committed log.md (git show failed), so the append-only check cannot run. Append with `cat >> log.md <<EOF` instead.'
    }
    frozen = shown.stdout
  } else {
    const lastEntry = current.lastIndexOf('\n## [')
    frozen = lastEntry < 0 ? '' : current.slice(0, lastEntry + 1)
  }
  if (proposed.startsWith(frozen)) return undefined
  return rel === 'log.md'
    ? 'wiki-guard: log.md is append-only (CLAUDE.md). The committed part cannot change; edit only text after the last committed line, or append a new entry. A past entry is corrected by a new entry that links to it.'
    : `wiki-guard: ${rel} is append-only. Only the last entry may change; append a new entry instead of editing older ones.`
}

// --- raw/ through the shell ---

type ShellHit = { verb: string; path: string; onlyIfExists: boolean }

function shellHits(command: string): ShellHit[] {
  const hits: ShellHit[] = []
  const isRaw = (token: string) => RAW_TOKEN.test(token)
  for (const match of command.matchAll(SHELL_VERB)) {
    const verb = (match[1] ?? '').replace(/\s+/g, ' ')
    const tokens = (match[2] ?? '')
      .trim()
      .split(/\s+/)
      .map(token => token.replace(/^['"]|['"]$/g, ''))
      .filter(token => token !== '' && !token.startsWith('-'))
    const last = tokens[tokens.length - 1] ?? ''
    const sources = tokens.slice(0, -1)
    if (verb === 'cp') {
      // copying INTO raw/ over an existing original; copying out of it is reading
      if (isRaw(last)) hits.push({ verb, path: last, onlyIfExists: true })
    } else if (verb === 'mv' || verb === 'git mv') {
      for (const token of sources) if (isRaw(token)) hits.push({ verb, path: token, onlyIfExists: false })
      if (isRaw(last)) hits.push({ verb, path: last, onlyIfExists: true })
    } else if (verb === 'tee') {
      for (const token of tokens) if (isRaw(token)) hits.push({ verb, path: token, onlyIfExists: true })
    } else {
      // rm, git rm, sed -i: any raw/ argument is a mutation
      for (const token of tokens) if (isRaw(token)) hits.push({ verb, path: token, onlyIfExists: false })
    }
  }
  for (const match of command.matchAll(REDIRECT)) {
    const target = match[1] ?? ''
    if (isRaw(target)) hits.push({ verb: '>', path: target, onlyIfExists: true })
  }
  return hits
}

// --- reading a shell command without its data ---

/** The command with every heredoc body dropped (the `<<WORD` line itself stays). */
function withoutHeredocs(command: string): string {
  return command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, m => m.split('\n')[0] ?? '')
}

/** Heredoc bodies and quoted strings dropped: a `git commit` in a commit message or a script's text is not a commit. */
function withoutLiterals(command: string): string {
  return withoutHeredocs(command)
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
}

// --- lint gate ---

async function changedSinceLint($: GuardEngine, root: string): Promise<string[]> {
  const { value: lintAt = 0 } = await $.state.get(LINT_AT)
  const status = await $.process.run(
    ['git', '-c', 'core.quotepath=false', 'status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: root, timeoutMs: 15_000 },
  )
  if (status.exitCode !== 0) return ['(git status failed)']
  const newer: string[] = []
  for (const line of status.stdout.split('\n')) {
    if (line.length < 4) continue
    let rel = line.slice(3)
    const arrow = rel.indexOf(' -> ')
    if (arrow >= 0) rel = rel.slice(arrow + 4)
    if (rel.startsWith('"') && rel.endsWith('"')) rel = rel.slice(1, -1)
    try {
      const stat = await $.fs.stat(`${root}/${rel}`)
      if (stat.mtimeMs > lintAt) newer.push(rel)
    } catch {
      // deleted: nothing left to lint
    }
  }
  return newer
}

export const register: Register = (on, options) => {
  // `/config` → wiki-guard.enabled; off, every hook passes the call through unchanged.
  const enabled = options.enabled !== false

  // Edits and writes under the wiki, from any project.
  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    if (!enabled) return next(e)
    const root = await wikiRoot($)
    const path = await absolute($, e.file_path)
    const rel = relOf(root, path)
    if (rel === null || rel === '') return next(e)

    if (rel.startsWith('raw/')) {
      if (e.tool === 'Edit' || (await $.fs.exists(path))) {
        return {
          deny: `wiki-guard: ${rel} is under raw/, which is immutable (CLAUDE.md: LLM reads raw/, never edits it). Put a new note in raw/research/ or raw/notes/, and record a correction in wiki/meta/source-corrections.md.`,
        }
      }
      return next(e)
    }

    if ((LOG_PATHS as readonly string[]).includes(rel)) {
      const violation = await logViolation($, root, rel, path, e)
      if (violation) return { deny: violation }
    }

    if (rel.endsWith('.md') && !isLocal(rel)) {
      const text = e.tool === 'Edit' ? e.new_string : e.content
      const bad = await localLinksIn($, root, text)
      if (bad.length > 0) {
        return {
          deny: `wiki-guard: ${rel} is a committed file but links to local-only page(s) ${bad.map(s => `[[${s}]]`).join(', ')} (wiki/domain or wiki/personal). Write the path as plain text, e.g. \`wiki/personal/${bad[0]}.md\` (CLAUDE.md link rule, 2026-07-30).`,
        }
      }
    }

    return next(e)
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `wiki-guard: the guard failed (${next.error.kind}); refusing this write to be safe. Retry, or check the debug log.` },
  )

  // Shell commands: raw/ mutations, the lint gate before commit, and lint runs.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!enabled) return next(e)
    const root = await wikiRoot($)
    const cwd = await $.session.cwd()
    const command = e.command
    const inWiki = relOf(root, cwd) !== null || command.includes(root) || command.includes(`~/${WIKI_REL}`)
    if (!inWiki) return next(e)

    for (const hit of shellHits(withoutHeredocs(command))) {
      const target = await absolute($, hit.path, cwd)
      const rel = relOf(root, target)
      if (rel === null || !rel.startsWith('raw/')) continue
      if (hit.onlyIfExists && !(await $.fs.exists(target))) continue
      return {
        deny: `wiki-guard: \`${hit.verb}\` would change ${rel}, and raw/ is immutable (CLAUDE.md). New files under raw/research/ or raw/notes/ are fine; existing originals are never edited, moved or deleted.`,
      }
    }

    const code = withoutLiterals(command)
    const commitAt = code.search(/\bgit\b[^;&|]*\bcommit\b/)
    const lintAt = code.search(/\bwikilint\b/)
    // `bin/wikilint && git commit …` runs the lint first in the same command: let the lint's own exit decide.
    if (commitAt >= 0 && !(lintAt >= 0 && lintAt < commitAt)) {
      const newer = await changedSinceLint($, root)
      if (newer.length > 0) {
        const shown = newer.slice(0, 5).join(', ') + (newer.length > 5 ? `, +${newer.length - 5}` : '')
        return {
          deny: `wiki-guard: bin/wikilint has not run since the last change (${newer.length} newer: ${shown}). Run \`bin/wikilint\` in the wiki, then commit (CLAUDE.md: lint after every change).`,
        }
      }
      return next(e)
    }

    if (lintAt >= 0) {
      // `edit && bin/wikilint`: the lint is the command's last stage, so it saw every edit the command made and
      // the end time is the honest mark. A lint that ran earlier in the chain is marked at the start instead.
      const stages = code.split(/&&|\|\||;|\n/)
      const lintIsLast = /\bwikilint\b/.test(stages[stages.length - 1] ?? '')
      const startedAt = await $.clock.now()
      const ran = await next(e)
      if (ran.deny === undefined && ran.isError !== true && /\b0 errors\b/.test(ran.text ?? '')) {
        await $.state.set(LINT_AT, lintIsLast ? await $.clock.now() : startedAt)
      }
      return ran
    }

    return next(e)
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `wiki-guard: the guard failed (${next.error.kind}); refusing this command to be safe. Retry, or check the debug log.` },
  )

  // One editor at a time: a dirty log/index at start means another session may be writing.
  on('session.start', async ($, e, next) => {
    if (!enabled) return next(e)
    const root = await wikiRoot($)
    if (relOf(root, e.cwd) !== null) {
      const status = await $.process.run(['git', 'status', '--porcelain=v1'], { cwd: root, timeoutMs: 15_000 })
      const busy = status.stdout
        .split('\n')
        .filter(line => /^.M (?:log|index)\.md$/.test(line))
        .map(line => line.slice(3))
      if (status.exitCode === 0 && busy.length > 0) {
        $.ui.toast(`wiki-guard: ${busy.join(', ')} already modified — another session may be writing the wiki (one editor at a time).`, { timeoutMs: 12_000 })
      }
    }
    return next(e)
  })
}
