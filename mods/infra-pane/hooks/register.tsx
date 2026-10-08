import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { InfraK8s, InfraK8sNamespace, InfraK8sPod, InfraK8sPodKind, InfraOther, InfraService, InfraSnapshot, InfraTailscale, InfraWikiMode } from '../types'

const PANE = 'infra'
const POLL_MS = 20_000
const TAILSCALE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
const WIKI_SERVE_PORT = 8480
// the launchd agent `scripts/wiki-serve on [--full]` writes; WIKI_FULL is in it only for --full
const WIKI_SERVE_PLIST = 'Library/LaunchAgents/com.junho.wiki-serve.plist'
const snapshot = atom({ plugin: 'infra-pane', key: 'snapshot' } as const, null)
const expanded = atom({ plugin: 'infra-pane', key: 'expanded' } as const, [])

type Engine = EngineInterface
type Ran = { exitCode: number; stdout: string; stderr: string }

let homeDir: string | undefined
async function infraDir($: Engine): Promise<string> {
  homeDir ??= (await $.env.get('HOME')) ?? '/'
  return `${homeDir}/infra`
}

async function run($: Engine, argv: readonly string[], timeoutMs: number, cwd?: string): Promise<Ran> {
  try {
    const ran = await $.process.run(argv, { timeoutMs, cwd })
    return { exitCode: ran.exitCode, stdout: ran.stdout, stderr: ran.stderr }
  } catch (error) {
    return { exitCode: -1, stdout: '', stderr: String(error) }
  }
}

let services: { at: number; names: string[] } | undefined
async function serviceDirs($: Engine, infra: string): Promise<string[]> {
  const now = await $.clock.now()
  if (services && now - services.at < 300_000) return services.names
  const names: string[] = []
  try {
    for (const entry of await $.fs.list(infra)) {
      if (entry.kind !== 'dir' || entry.name.startsWith('.')) continue
      if (await $.fs.exists(`${infra}/${entry.name}/docker-compose.yml`)) names.push(entry.name)
    }
  } catch {
    // ~/infra missing: an empty catalog
  }
  names.sort()
  services = { at: now, names }
  return names
}

type ComposeRow = { Name?: string; Status?: string; ConfigFiles?: string }

function parseCompose(stdout: string): ComposeRow[] {
  try {
    const parsed: unknown = JSON.parse(stdout)
    return Array.isArray(parsed) ? (parsed as ComposeRow[]) : []
  } catch {
    return []
  }
}

/**
 * `docker compose ls` sums containers per state and joins the states with commas: `running(3)`, `exited(3)`,
 * `exited(1), running(3)` (a one-shot init container beside three live ones). Running means any live container.
 */
function isRunning(status: string): boolean {
  const match = /\brunning\((\d+)\)/.exec(status)
  return match !== null && Number(match[1]) > 0
}

function parseTailscale(stdout: string): InfraTailscale {
  try {
    const parsed = JSON.parse(stdout) as { BackendState?: string; TailscaleIPs?: string[] }
    const ip = (parsed.TailscaleIPs ?? []).find(candidate => /^\d+\.\d+\.\d+\.\d+$/.test(candidate))
    return { state: parsed.BackendState ?? 'unknown', ...(ip ? { ip } : {}) }
  } catch {
    return { state: 'unknown' }
  }
}

/**
 * Which half of the wiki the read-only web serves (owner decision 2026-10-08): `wiki-serve on` hides what git ignores
 * (the local-only areas), `on --full` serves everything to every tailnet device, the mac mini's other Claude account too.
 */
async function wikiMode($: Engine, listening: boolean): Promise<InfraWikiMode> {
  if (!listening) return 'off'
  homeDir ??= (await $.env.get('HOME')) ?? '/'
  try {
    const plist = await $.fs.read(`${homeDir}/${WIKI_SERVE_PLIST}`)
    return typeof plist === 'string' && plist.includes('<key>WIKI_FULL</key>') ? 'full' : 'public'
  } catch {
    return 'unknown' // listening without the agent: started by hand (`wiki-serve run`), its environment unknown here
  }
}

const WIKI_LABEL: Record<InfraWikiMode, string> = { off: 'off', public: 'ON public', full: 'ON FULL', unknown: 'ON (mode?)' }

// The OrbStack cluster: only ever addressed by its own kube context, never the current one (which may be a remote cluster).
const KUBE = ['kubectl', '--context', 'orbstack'] as const

// kubectl's STATUS column, not `.status.phase`: a pod whose phase is still Running shows `Error` or
// `CrashLoopBackOff` there once a container fails (code-companion, 2026-10-07).
const POD_FAILED = /Error|BackOff|Failed|Evicted|OOMKilled|CreateContainer|RunContainer|InvalidImage|Unknown/

const KIND_ORDER: Record<InfraK8sPodKind, number> = { error: 0, pending: 1, running: 2, done: 3 }
const KIND_GLYPH: Record<InfraK8sPodKind, string> = { error: '✖', pending: '◐', running: '●', done: '✔' }

function podsOf(ns: InfraK8sNamespace, kind: InfraK8sPodKind): InfraK8sPod[] {
  return ns.pods.filter(pod => pod.kind === kind)
}

function classifyPod(ready: string, status: string): InfraK8sPodKind {
  if (status === 'Completed' || status === 'Succeeded') return 'done'
  if (POD_FAILED.test(status)) return 'error'
  const [have, want] = ready.split('/').map(Number)
  if (status === 'Running' && have !== undefined && have === want) return 'running'
  return 'pending'
}

async function collectK8s($: Engine): Promise<InfraK8s> {
  const config = await run($, ['orb', 'config', 'show'], 5_000)
  const enabled = config.exitCode === 0 && /^k8s\.enable:\s*true\s*$/m.test(config.stdout)
  if (!enabled) return { enabled: false, reachable: false, namespaces: [] }
  const ready = await run($, [...KUBE, '--request-timeout=4s', 'get', '--raw', '/readyz'], 8_000)
  if (ready.exitCode !== 0 || ready.stdout.trim() !== 'ok') return { enabled, reachable: false, namespaces: [] }
  // NAMESPACE NAME READY STATUS RESTARTS AGE (RESTARTS may read `4 (2m ago)`)
  const pods = await run($, [...KUBE, '--request-timeout=5s', 'get', 'pods', '-A', '--no-headers'], 10_000)
  const byNamespace = new Map<string, InfraK8sNamespace>()
  if (pods.exitCode === 0) {
    for (const line of pods.stdout.split('\n')) {
      const tokens = line.trim().split(/\s+/)
      const [namespace, name, ready, status, restarts] = tokens
      if (!namespace || !name || !ready || !status || namespace.startsWith('kube-')) continue
      const kind = classifyPod(ready, status)
      const row = byNamespace.get(namespace) ?? { name: namespace, running: 0, total: 0, pods: [] }
      if (kind !== 'done') row.total += 1 // a finished job (infra has three init jobs) is shown, not counted
      if (kind === 'running') row.running += 1
      row.pods.push({ name, kind, status, ready, restarts: Number.parseInt(restarts ?? '0', 10) || 0, age: tokens[tokens.length - 1] ?? '' })
      byNamespace.set(namespace, row)
    }
  }
  for (const row of byNamespace.values()) row.pods.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name))
  const namespaces = [...byNamespace.values()].sort((a, b) => a.name.localeCompare(b.name))
  return { enabled, reachable: true, namespaces }
}

async function collect($: Engine): Promise<InfraSnapshot> {
  const infra = await infraDir($)
  const [at, compose, tailscale, serve, dirs, k8s] = await Promise.all([
    $.clock.now(),
    run($, ['docker', 'compose', 'ls', '-a', '--format', 'json'], 10_000),
    run($, [TAILSCALE, 'status', '--json'], 5_000),
    run($, ['lsof', '-nP', `-iTCP:${WIKI_SERVE_PORT}`, '-sTCP:LISTEN'], 5_000),
    serviceDirs($, infra),
    collectK8s($),
  ])
  const rows = compose.exitCode === 0 ? parseCompose(compose.stdout) : []
  const projects = rows.map(row => {
    const file = (row.ConfigFiles ?? '').split(',')[0] ?? ''
    const status = row.Status ?? 'unknown'
    return { name: row.Name ?? '?', status, running: isRunning(status), dir: file.replace(/\/[^/]*$/, '') }
  })
  const infraServices: InfraService[] = dirs.map(svc => {
    const project = projects.find(p => p.dir === `${infra}/${svc}`)
    return {
      svc,
      ...(project ? { project: project.name } : {}),
      status: project?.status ?? 'absent',
      running: project?.running ?? false,
    }
  })
  const others: InfraOther[] = projects.filter(p => !p.dir.startsWith(`${infra}/`))
  const mode = await wikiMode($, serve.exitCode === 0)
  return {
    at,
    docker: compose.exitCode === 0 ? 'ok' : 'down',
    ...(compose.exitCode === 0 ? {} : { dockerError: compose.stderr.trim().split('\n')[0] ?? '' }),
    infra: infraServices,
    others,
    tailscale: tailscale.exitCode === 0 ? parseTailscale(tailscale.stdout) : { state: 'unknown' },
    wikiServe: serve.exitCode === 0,
    wikiMode: mode,
    k8s,
  }
}

function statusLine(snap: InfraSnapshot): string | undefined {
  const up = snap.infra.filter(s => s.running).map(s => s.svc)
  const parts: string[] = []
  if (up.length > 0) parts.push(`infra ↑ ${up.join(' ')}`)
  if (snap.wikiServe) parts.push(snap.wikiMode === 'full' ? 'wiki-serve FULL' : snap.wikiMode === 'unknown' ? 'wiki-serve ON (mode?)' : 'wiki-serve ON')
  if (snap.k8s.enabled) {
    const pods = snap.k8s.namespaces.reduce((n, ns) => n + ns.running, 0)
    const errors = snap.k8s.namespaces.reduce((n, ns) => n + podsOf(ns, 'error').length, 0)
    parts.push(`k8s on${pods > 0 ? ` (${pods} ready` : ' ('}${errors > 0 ? `, ${errors} error` : ''})`.replace(' ()', ''))
  }
  if (up.length > 0 && snap.tailscale.state !== 'Running') parts.push(`tailscale ${snap.tailscale.state}`)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

function summary(snap: InfraSnapshot): string {
  const up = snap.infra.filter(s => s.running).map(s => s.svc)
  const docker = snap.docker === 'ok' ? '' : ' (docker not answering)'
  const k8sErrors = snap.k8s.namespaces.reduce((n, ns) => n + podsOf(ns, 'error').length, 0)
  const k8s = snap.k8s.enabled ? (snap.k8s.reachable ? `on${k8sErrors > 0 ? `, ${k8sErrors} error pod${k8sErrors > 1 ? 's' : ''}` : ''}` : 'on, API not answering') : 'off'
  const wiki = { off: 'off', public: 'ON (public only)', full: 'ON (FULL: local-only areas visible to every tailnet device)', unknown: 'ON (mode unknown)' }[snap.wikiMode]
  return `infra: ${up.length > 0 ? `up: ${up.join(', ')}` : 'all services off'}${docker}; tailscale ${snap.tailscale.state}; wiki-serve ${wiki}; k8s ${k8s}.`
}

let polling: Promise<InfraSnapshot | undefined> | undefined
/** One poll at a time; a poll that fails (the engine tearing down, a refused call) resolves undefined and never rejects. */
function poll($: Engine): Promise<InfraSnapshot | undefined> {
  polling ??= (async () => {
    try {
      const snap = await collect($)
      await update($, snapshot, () => snap)
      $.ui.status(statusLine(snap))
      return snap
    } catch {
      return undefined
    } finally {
      polling = undefined
    }
  })()
  return polling
}

async function stop($: Engine, svc: string): Promise<string> {
  const infra = await infraDir($)
  $.ui.toast(`infra: stopping ${svc}…`)
  const ran = await run($, [`${infra}/stop_all`, '--skip-k8s', svc], 300_000, infra)
  const text = ran.exitCode === 0 ? `infra: ${svc} stopped (volumes kept).` : `infra: stop ${svc} failed (exit ${ran.exitCode}): ${ran.stderr.trim().split('\n').pop() ?? ''}`
  $.ui.toast(text)
  await poll($)
  return text
}

type WikiWant = 'on' | 'full' | 'off'
const WIKI_ARGS: Record<WikiWant, readonly string[]> = { on: ['on'], full: ['on', '--full'], off: ['off'] }
const WIKI_DOING: Record<WikiWant, string> = { on: 'turning on (public only)', full: 'turning on FULL (local-only areas too)', off: 'turning off' }
const WIKI_DONE: Record<WikiWant, string> = {
  on: 'wiki-serve ON (public only)',
  full: 'wiki-serve ON FULL: every tailnet device, the mac mini too, can read the local-only areas; switch back to public when done',
  off: 'wiki-serve OFF',
}

/**
 * `~/infra/scripts/wiki-serve on [--full] | off`: the wiki's read-only web (launchd agent + tailscale serve), host
 * process only. `on` while on restarts it in the new mode.
 */
async function wikiServe($: Engine, want: WikiWant): Promise<string> {
  const infra = await infraDir($)
  $.ui.toast(`wiki-serve: ${WIKI_DOING[want]}…`)
  const ran = await run($, [`${infra}/scripts/wiki-serve`, ...WIKI_ARGS[want]], 60_000, infra)
  const said = (ran.exitCode === 0 ? ran.stdout : ran.stderr || ran.stdout).trim().split('\n').filter(Boolean)
  const text =
    ran.exitCode === 0
      ? `${WIKI_DONE[want]}: ${said[0] ?? ''}`
      : `wiki-serve ${WIKI_ARGS[want].join(' ')} failed (exit ${ran.exitCode}): ${said[said.length - 1] ?? ''}`
  $.ui.toast(text)
  await poll($)
  return text
}

/** `orbctl start|stop k8s` (the OrbStack cluster; `orb` is the same binary under another name). */
async function k8s($: Engine, want: 'start' | 'stop'): Promise<string> {
  $.ui.toast(`k8s: ${want}ing…`)
  let ran = await run($, ['orbctl', want, 'k8s'], 180_000)
  if (ran.exitCode === -1) ran = await run($, ['orb', want, 'k8s'], 180_000)
  const said = (ran.exitCode === 0 ? ran.stdout : ran.stderr || ran.stdout).trim().split('\n').filter(Boolean)
  const text = ran.exitCode === 0 ? `k8s ${want === 'start' ? 'started' : 'stopped'}.` : `k8s ${want} failed (exit ${ran.exitCode}): ${said[said.length - 1] ?? ''}`
  $.ui.toast(text)
  await poll($)
  return text
}

function clock(at: number): string {
  const d = new Date(at)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

const OFF = 'infra-pane is off. Turn it on in /config (infra-pane.enabled).'

export const register: Register = (on, options) => {
  // `/config` → infra-pane.enabled; a change reloads the module, so session.start runs again with the new value.
  const enabled = options.enabled !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'infra',
      description: enabled
        ? 'Local infra (~/infra): show the pane, `stop <svc|all>`, `wiki on|full|off` (on = public only), `k8s start|stop`'
        : 'Local infra pane (off; enable in /config)',
      argumentHint: '[stop <svc|all> | wiki on|full|off | k8s start|stop]',
    })
    if (!enabled) {
      $.ui.status(undefined)
      try {
        await $.ui.close({ id: PANE })
      } catch {
        // not open, or a hook kept it: nothing to do
      }
    } else if (e.surface !== null) {
      void $.ui.open({ id: PANE, title: 'infra' })
      void poll($)
      $.clock.every(POLL_MS, () => void poll($))
    }
    return next(e)
  })

  on('command.run', { command: 'infra' }, async ($, e) => {
    if (!enabled) return { text: OFF }
    const [verb, target] = e.args.trim().split(/\s+/)
    if (verb === 'k8s') {
      if (target !== 'start' && target !== 'stop') return { text: 'infra: say `/infra k8s start` or `/infra k8s stop`.' }
      return { text: await k8s($, target) }
    }
    if (verb === 'wiki') {
      const want = target === 'public' ? 'on' : target
      if (want !== 'on' && want !== 'full' && want !== 'off')
        return { text: 'infra: say `/infra wiki on` (public only), `/infra wiki full` (local-only areas too) or `/infra wiki off`.' }
      return { text: await wikiServe($, want) }
    }
    if (verb === 'stop') {
      if (!target) return { text: 'infra: say which service, e.g. `/infra stop kafka` or `/infra stop all`.' }
      return { text: await stop($, target) }
    }
    await $.ui.open({ id: PANE, title: 'infra' })
    const snap = await poll($)
    return { text: snap ? summary(snap) : 'infra: the poll failed; see the debug log.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    if (!enabled) {
      return (
        <Box>
          <Text dimColor>{OFF}</Text>
        </Box>
      )
    }
    const snap = await read($, snapshot)
    const opened = await read($, expanded)
    if (snap === null) {
      return (
        <Box>
          <Text dimColor>infra: polling…</Text>
        </Box>
      )
    }
    const running = snap.infra.filter(s => s.running)
    const stopped = snap.infra.filter(s => !s.running)
    const othersRunning = snap.others.filter(o => o.running)
    const othersStopped = snap.others.filter(o => !o.running)
    const tailscaleOk = snap.tailscale.state === 'Running'
    return (
      <Box flexDirection="column">
        {/* header: each signal in its own color */}
        <Box>
          <Text color={snap.docker === 'ok' ? 'success' : 'error'}>docker {snap.docker === 'ok' ? '✓' : '✗'}</Text>
          <Text dimColor> · </Text>
          <Text color={tailscaleOk ? 'success' : 'warning'}>
            tailscale {snap.tailscale.state}
            {snap.tailscale.ip ? ` ${snap.tailscale.ip}` : ''}
          </Text>
        </Box>
        {/* wiki-serve: on/off (w, on = public only) and the mode switch. The switch has no hotkey: FULL shows the
            local-only areas to every tailnet device, the mac mini's other Claude account included. */}
        <Box>
          <Text
            color={snap.wikiMode === 'full' ? 'error' : snap.wikiServe ? 'warning' : undefined}
            bold={snap.wikiServe}
            dimColor={!snap.wikiServe}
          >
            wiki-serve {WIKI_LABEL[snap.wikiMode]}{' '}
          </Text>
          <Button
            key="wiki-serve-toggle"
            label={snap.wikiServe ? 'off' : 'on'}
            hotkey="w"
            plain
            onPress={() => void wikiServe($, snap.wikiServe ? 'off' : 'on')}
          />
          <Text dimColor> · </Text>
          <Button
            key="wiki-serve-mode"
            label={snap.wikiMode === 'off' ? 'on full' : snap.wikiMode === 'public' ? '→ full' : '→ public'}
            plain
            dimColor={snap.wikiMode !== 'full'}
            onPress={() => void wikiServe($, snap.wikiMode === 'full' || snap.wikiMode === 'unknown' ? 'on' : 'full')}
          />
        </Box>
        {snap.docker !== 'ok' && <Text color="error">{snap.dockerError || 'docker compose ls failed (OrbStack off?)'}</Text>}

        {/* running: one bright row each, with its stop button */}
        <Box>
          <Text bold color={running.length > 0 ? 'success' : undefined} dimColor={running.length === 0}>
            {running.length > 0 ? `▶ ${running.length} running` : 'nothing running'}
          </Text>
          <Text dimColor> · {stopped.length} off</Text>
        </Box>
        {running.map(s => (
          <Box key={`row-${s.svc}`}>
            <Text bold color="success" wrap="truncate">
              {'  '}● {s.svc}
            </Text>
            <Text dimColor> {s.status} </Text>
            <Button key={`stop-${s.svc}`} label="stop" plain onPress={() => void stop($, s.svc)} />
          </Box>
        ))}

        {/* stopped: one dim line, names only */}
        {stopped.length > 0 && (
          <Text dimColor wrap="wrap">
            {'  '}○ off: {stopped.map(s => s.svc).join(' · ')}
          </Text>
        )}

        {/* the OrbStack cluster: on/off with its toggle, then each namespace's pods */}
        <Box>
          <Text bold={snap.k8s.enabled} color={snap.k8s.enabled ? 'success' : undefined} dimColor={!snap.k8s.enabled}>
            {snap.k8s.enabled ? '▶ k8s on' : 'k8s off'}
            {snap.k8s.enabled && !snap.k8s.reachable ? ' (API not answering)' : ''}{' '}
          </Text>
          <Button key="k8s-toggle" label={snap.k8s.enabled ? 'stop' : 'start'} hotkey="k" plain onPress={() => void k8s($, snap.k8s.enabled ? 'stop' : 'start')} />
          {snap.k8s.namespaces.length > 0 && <Text dimColor> · </Text>}
          {snap.k8s.namespaces.length > 0 && (
            <Button
              key="k8s-expand-all"
              label={snap.k8s.namespaces.every(ns => opened.includes(ns.name)) ? '▾ collapse all' : '▸ expand all'}
              hotkey="e"
              plain
              onPress={() =>
                update($, expanded, list =>
                  snap.k8s.namespaces.every(ns => list.includes(ns.name)) ? [] : snap.k8s.namespaces.map(ns => ns.name),
                )
              }
            />
          )}
        </Box>
        {snap.k8s.namespaces.map(ns => {
          const errors = podsOf(ns, 'error')
          const pending = podsOf(ns, 'pending')
          const open = opened.includes(ns.name)
          // collapsed: only what needs attention; open: every pod, errors first, finished jobs last
          const shown = open ? ns.pods : ns.pods.filter(pod => pod.kind === 'error' || pod.kind === 'pending')
          return (
            <Box key={`ns-${ns.name}`} flexDirection="column">
              <Box>
                <Text
                  bold={errors.length > 0}
                  color={errors.length > 0 ? 'error' : pending.length > 0 ? 'warning' : ns.running > 0 ? 'success' : undefined}
                  dimColor={errors.length === 0 && pending.length === 0 && ns.running === 0}
                  wrap="truncate"
                >
                  {'  '}{errors.length > 0 ? '✖' : pending.length > 0 ? '◐' : ns.running > 0 ? '●' : '○'} {ns.name}
                </Text>
                <Text dimColor>
                  {' '}{ns.running}/{ns.total} ready
                </Text>
                {errors.length > 0 && <Text color="error"> · {errors.length} error</Text>}
                {pending.length > 0 && <Text color="warning"> · {pending.length} pending</Text>}
                <Text dimColor> </Text>
                <Button
                  key={`ns-toggle-${ns.name}`}
                  label={open ? '▾ hide' : `▸ ${ns.pods.length} pods`}
                  plain
                  dimColor
                  onPress={() => update($, expanded, list => (list.includes(ns.name) ? list.filter(name => name !== ns.name) : [...list, ns.name]))}
                />
              </Box>
              {shown.map(pod => (
                <Text
                  key={`pod-${ns.name}-${pod.name}`}
                  bold={pod.kind === 'error'}
                  color={pod.kind === 'error' ? 'error' : pod.kind === 'pending' ? 'warning' : pod.kind === 'running' ? 'success' : undefined}
                  dimColor={pod.kind === 'done'}
                  wrap="truncate"
                >
                  {'      '}{KIND_GLYPH[pod.kind]} {pod.name} {pod.ready} {pod.status}
                  {pod.restarts > 0 ? ` ↻${pod.restarts}` : ''} {pod.age}
                </Text>
              ))}
            </Box>
          )
        })}

        {/* compose projects outside ~/infra: running ones bright, the rest dim */}
        {snap.others.length > 0 && <Text dimColor>other compose projects</Text>}
        {othersRunning.map(o => (
          <Box key={`other-${o.name}`}>
            <Text color="success" wrap="truncate">
              {'  '}● {o.name}
            </Text>
            <Text dimColor wrap="truncate">
              {' '}{o.status} ({o.dir})
            </Text>
          </Box>
        ))}
        {othersStopped.length > 0 && (
          <Text dimColor wrap="wrap">
            {'  '}○ off: {othersStopped.map(o => o.name).join(' · ')}
          </Text>
        )}

        <Box>
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => void poll($)} />
          {running.length > 0 && <Button key="stop-all" label="Stop all infra" hotkey="s" onPress={() => void stop($, 'all')} />}
        </Box>
        <Text dimColor>updated {clock(snap.at)} · every {POLL_MS / 1000}s</Text>
      </Box>
    )
  })
}
