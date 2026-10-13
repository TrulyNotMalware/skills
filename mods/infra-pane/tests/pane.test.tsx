import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { MockClock } from 'claude-code/testing'

const HOME = '/Users/t'
const INFRA = `${HOME}/infra`
const TS = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
const PLIST = `${HOME}/Library/LaunchAgents/com.junho.wiki-serve.plist`
const plistFor = (full: boolean) =>
  `<dict><key>EnvironmentVariables</key><dict><key>WIKI_PORT</key><string>8480</string>${full ? '<key>WIKI_FULL</key><string>1</string>' : ''}</dict></dict>`

type ComposeRow = { Name: string; Status: string; ConfigFiles: string }
const composeRows = (): ComposeRow[] => [
  { Name: 'local-kafka', Status: 'running(3)', ConfigFiles: `${INFRA}/kafka/docker-compose.yml` },
  { Name: 'local-postgresql', Status: 'exited(3)', ConfigFiles: `${INFRA}/postgresql/docker-compose.yml` },
  // a one-shot init container exited beside three live replicas: docker sums per state, comma-joined
  { Name: 'local-mongodb', Status: 'exited(1), running(3)', ConfigFiles: `${INFRA}/mongodb/docker-compose.yml` },
  { Name: 'news_tracker', Status: 'running(3)', ConfigFiles: `${HOME}/workspace/news_tracker/compose.yaml` },
  // under ~/infra but not a service folder (compose.yaml, not docker-compose.yml): neither a service row nor dropped
  { Name: 'scratch', Status: 'running(1)', ConfigFiles: `${INFRA}/scratch/compose.yaml` },
]

// `docker ps -a` with the pane's template: name, state, status, image, compose project label, k8s namespace label
const PS = [
  ['app-api', 'running', 'Up 20 minutes', 'app-api:local', '', ''],
  ['app-sidecar', 'restarting', 'Restarting (1) 5 seconds ago', 'sidecar:main', '', ''],
  ['old-job', 'exited', 'Exited (0) 3 weeks ago', 'busybox', '', ''],
  ['local-kafka-1', 'running', 'Up 4 hours', 'apache/kafka', 'local-kafka', ''],
  ['k8s_web_web-0_default_1', 'running', 'Up 1 hour', 'nginx', '', 'default'],
]
  .map(row => row.join('\t'))
  .join('\n')

type World = {
  argv: string[]
  statuses: string[]
  toasts: string[]
  commands: string[]
  opened: string[]
  closed: string[]
  lsof: number
  k8s: boolean
  plist: string | null
  /** What `docker compose ls` answers; `up -d` turns a service's row to running, or adds it. */
  compose: ComposeRow[]
  /** Tailscale's BackendState. */
  tailscale: string
  /** `<svc>/.env` files by path; a path not here does not exist. */
  env: Record<string, string>
  /** How long `up -d` takes on the mocked clock; 0 answers at once. */
  upMs: number
  /** stderr of an `up -d` that exits 1 and changes nothing; null, it succeeds. */
  upError: string | null
  /** How long `docker compose ls` takes to answer what it read when asked. */
  lsMs: number
  clock: MockClock
}

function world(on: On): World {
  mock.env(on, { HOME })
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const w: World = { argv: [], statuses: [], toasts: [], commands: [], opened: [], closed: [], lsof: 1, k8s: false, plist: null, compose: composeRows(), tailscale: 'Running', env: {}, upMs: 0, upError: null, lsMs: 0, clock }
  on('fs.list', ($, e) => ({
    value: e.path === INFRA
      ? ['kafka', 'postgresql', 'gateway', 'mongodb', 'scripts', '.git'].map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }))
      : [],
  }))
  on('fs.read', ($, e) => {
    if (e.path === PLIST && w.plist !== null) return { value: w.plist }
    const env = w.env[e.path]
    if (env !== undefined) return { value: env }
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('fs.exists', ($, e) => ({ value: [`${INFRA}/kafka/docker-compose.yml`, `${INFRA}/postgresql/docker-compose.yml`, `${INFRA}/gateway/docker-compose.yml`, `${INFRA}/mongodb/docker-compose.yml`].includes(e.path) }))
  on('process.run', async ($, e) => {
    const key = e.argv.join(' ')
    w.argv.push(key)
    const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (key.startsWith('docker compose ls')) {
      const read = JSON.stringify(w.compose)
      if (w.lsMs > 0) await clock.sleep(w.lsMs)
      return ok(read)
    }
    const up = /^docker compose -f (\S+\/([^/\s]+)\/docker-compose\.yml) up -d$/.exec(key)
    if (up) {
      if (w.upMs > 0) await clock.sleep(w.upMs)
      if (w.upError !== null) return { value: { exitCode: 1, stdout: '', stderr: w.upError, isStdoutTruncated: false, isStderrTruncated: false } }
      const row = w.compose.find(one => one.ConfigFiles === up[1])
      if (row) row.Status = 'running(3)'
      else w.compose.push({ Name: `local-${up[2]}`, Status: 'running(1)', ConfigFiles: up[1] ?? '' })
      return ok('')
    }
    if (key.startsWith('docker ps -a --format')) return ok(`${PS}\n`)
    if (e.argv[0] === TS) return w.tailscale === '' ? ok('', 1) : ok(JSON.stringify({ BackendState: w.tailscale, TailscaleIPs: ['100.64.0.1'] }))
    if (e.argv[0] === 'lsof') return ok('', w.lsof)
    if (key.includes('stop_all')) return ok('[stop_all] stopped')
    if (key === 'orb config show') return ok(`docker.expose_ports_to_lan: false\nk8s.enable: ${w.k8s}\nk8s.expose_services: false\n`)
    if (key.startsWith('orbctl ')) {
      w.k8s = key.includes(' start ')
      return ok('')
    }
    if (key.startsWith('kubectl --context orbstack') && key.includes('/readyz')) return ok('ok')
    if (key.startsWith('kubectl --context orbstack') && key.includes('get pods'))
      return ok(
        [
          'infra                  postgresql-0                        1/1   Running     0            5h',
          'infra                  postgresql-1                        1/1   Running     0            5h',
          'infra                  mongodb-init-abc12                  0/1   Completed   0            5h',
          'kube-system            coredns-7d5b                        1/1   Running     0            5h',
          'code-companion-local   code-companion-545665cf75-vs9mg     1/2   Error       4 (2m ago)   10m',
          'scratch                worker-0                            0/1   Pending     0            1m',
          'scratch                worker-1                            1/1   Running     0            1m',
        ].join('\n') + '\n',
      )
    if (key.includes('scripts/wiki-serve')) {
      // the next poll sees the new state: lsof for listening, the launchd agent for the mode
      const full = key.endsWith(' on --full')
      const turnedOn = full || key.endsWith(' on')
      w.lsof = turnedOn ? 0 : 1
      w.plist = turnedOn ? plistFor(full) : null
      return ok(
        turnedOn
          ? `ON  — wiki-serve running (pid 1), ${full ? 'FULL (local-only areas served)' : 'public only'}\n  https://x.ts.net:8480 -> 127.0.0.1:8480\nturn off with: wiki-serve off`
          : 'OFF — server stopped, launchd agent removed',
      )
    }
    return ok('', 127)
  })
  on('ui.status', ($, e) => {
    w.statuses.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('command.register', ($, e) => {
    w.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.close', ($, e) => {
    w.closed.push(e.id)
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  return w
}

const lastWiki = (w: World) => w.argv.filter(a => a.includes('scripts/wiki-serve')).at(-1)
const ups = (w: World) => w.argv.filter(a => a.endsWith(' up -d'))
const upOf = (svc: string) => `docker compose -f ${INFRA}/${svc}/docker-compose.yml up -d`

const PANE_PROPS = { title: 'infra', isFocused: false, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} }
const INFRA_RUN = { command: 'infra', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } }

test('/infra polls, opens the pane, sets the status line and summarises', async ($, on) => {
  const w = world(on)
  const ran = await $.command.run({ command: 'infra', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(ran.text).toMatch(/up: kafka, mongodb; tailscale Running; wiki-serve off/)
  expect(ran.text).toMatch(/Also up outside ~\/infra: news_tracker \(compose\), scratch \(compose\), app-api \(container\), app-sidecar \(container\)\.$/)
  expect(w.opened).toEqual(['infra'])
  expect(w.statuses.at(-1)).toMatch(/infra ↑ kafka/)
  expect(w.argv.some(a => a.startsWith('docker compose ls -a --format json'))).toBe(true)
  expect(w.argv.some(a => a.startsWith('docker ps -a --format'))).toBe(true)
})

test('containers without a compose project and compose projects in a non-service ~/infra folder are listed', async ($, on) => {
  world(on)
  await $.command.run({ command: 'infra', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'infra-pane', surface, component: 'Pane', props: PANE_PROPS, requestId: 'infra' })
    expect(await ui.find({ type: 'Text', text: /containers \(no compose\)/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /● app-api/ }))?.props).toMatchObject({ color: 'success' })
    expect(await ui.find({ type: 'Text', text: /Up 20 minutes \(app-api:local\)/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /● app-sidecar/ }))?.props).toMatchObject({ color: 'warning' }) // restarting: up, but not well
    expect((await ui.find({ type: 'Text', text: /○ off: old-job/ }))?.props).toMatchObject({ dimColor: true })
    // a compose project's container is its project's row, a k8s pod's container is the k8s section's
    expect(await ui.find({ type: 'Text', text: /local-kafka-1/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /k8s_web/ })).toBeUndefined()
    // the project in ~/infra/scratch is no service row, so it is listed with the other projects
    expect((await ui.find({ type: 'Text', text: /● scratch/ }))?.props).toMatchObject({ color: 'success' })
    expect(await ui.find({ key: 'stop-scratch' })).toBeUndefined()
    await ui.unmount()
  }
})

test('session.start registers /infra, opens the pane unasked and starts polling', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: `${HOME}/proj`, surface: 'terminal', isInteractive: true })
  expect(w.commands).toEqual(['infra'])
  expect(w.opened).toEqual(['infra'])
  // the start hook's own poll is detached; /infra joins the one in flight, so the test ends after it
  const ran = await $.command.run({ command: 'infra', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(ran.text).toMatch(/up: kafka/)
  expect(w.statuses.at(-1)).toMatch(/infra ↑ kafka/)
})

test('the pane lists every ~/infra service with its state, other projects, and a stop button per running service', async ($, on) => {
  const w = world(on)
  await $.command.run({ command: 'infra', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'infra-pane', surface, component: 'Pane', props: PANE_PROPS, requestId: 'infra' })
    const kafka = await ui.find({ type: 'Text', text: /● kafka/ })
    expect(kafka?.props).toMatchObject({ bold: true, color: 'success' }) // running rows are highlighted
    expect(await ui.find({ type: 'Text', text: /running\(3\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /▶ 2 running/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /● mongodb/ }))?.props).toMatchObject({ bold: true, color: 'success' })
    expect(await ui.find({ type: 'Text', text: /exited\(1\), running\(3\)/ })).toBeDefined()
    expect(await ui.find({ key: 'stop-mongodb' })).toBeDefined()
    for (const svc of ['gateway', 'postgresql']) {
      expect((await ui.find({ type: 'Text', text: new RegExp(`○ ${svc}`) }))?.props).toMatchObject({ dimColor: true }) // stopped ones are dim rows
      expect((await ui.find({ key: `start-${svc}` }))?.props).toMatchObject({ label: 'start', dimColor: true })
    }
    expect(await ui.find({ key: 'start-kafka' })).toBeUndefined()
    expect(await ui.find({ key: 'start-mongodb' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /○ .*kafka/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /○ .*mongodb/ })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /● news_tracker/ }))?.props).toMatchObject({ color: 'success' })
    expect(await ui.find({ key: 'stop-kafka' })).toBeDefined()
    expect(await ui.find({ key: 'stop-postgresql' })).toBeUndefined()
    expect(await ui.find({ key: 'stop-all' })).toBeDefined()
    await ui.press({ key: 'stop-kafka' })
    expect(w.argv.some(a => a === `${INFRA}/stop_all --skip-k8s kafka`)).toBe(true)
    expect(w.toasts.join('\n')).toMatch(/kafka stopped/)
    await ui.unmount()
  }
})

test('a stopped service\'s start button runs `up -d` on its compose file, and the row turns running', async ($, on) => {
  const w = world(on)
  await $.command.run(INFRA_RUN)
  // one stopped (`exited`), one never created (`absent`): a surface each, as the first press changes the world
  for (const [surface, svc] of [['terminal', 'postgresql'], ['desktop', 'gateway']] as const) {
    const ui = await $.ui.mount({ plugin: 'infra-pane', surface, component: 'Pane', props: PANE_PROPS, requestId: 'infra' })
    expect((await ui.find({ key: `start-${svc}` }))?.props.hotkey).toBeUndefined() // never one keystroke away
    expect(await ui.find({ key: `stop-${svc}` })).toBeUndefined()
    const before = w.argv.length
    await ui.press({ key: `start-${svc}` })
    expect(ups(w).at(-1)).toBe(upOf(svc))
    // Tailscale is asked again at the press, before docker: the snapshot that drew the button may be 20 s old
    const pressed = w.argv.slice(before)
    expect(pressed.findIndex(a => a.startsWith(TS))).toBeGreaterThanOrEqual(0)
    expect(pressed.findIndex(a => a.startsWith(TS))).toBeLessThan(pressed.indexOf(upOf(svc)))
    expect(w.toasts.join('\n')).toMatch(new RegExp(`infra: ${svc} started\\.`))
    expect((await ui.find({ type: 'Text', text: new RegExp(`● ${svc}`) }))?.props).toMatchObject({ bold: true, color: 'success' })
    expect(await ui.find({ key: `stop-${svc}` })).toBeDefined()
    expect(await ui.find({ key: `start-${svc}` })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /starting…/ })).toBeUndefined()
    expect(w.statuses.at(-1)).toMatch(new RegExp(`infra ↑ .*${svc}`))
    await ui.unmount()
  }
  expect(ups(w)).toEqual([upOf('postgresql'), upOf('gateway')])
  // only ~/infra service folders have the button: not another compose project, not a container
  const ui = await $.ui.mount({ plugin: 'infra-pane', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'infra' })
  for (const name of ['news_tracker', 'scratch', 'old-job', 'app-api']) expect(await ui.find({ key: `start-${name}` })).toBeUndefined()
  await ui.unmount()
})

test('start is refused, and docker never asked, while Tailscale is not Running or BIND_IP is another address', async ($, on) => {
  const w = world(on)
  w.env[`${INFRA}/postgresql/.env`] = 'POSTGRES_PASSWORD=hunter2\nBIND_IP=100.64.0.9\n'
  w.tailscale = 'Stopped'
  await $.command.run(INFRA_RUN)
  const ui = await $.ui.mount({ plugin: 'infra-pane', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'infra' })
  await ui.press({ key: 'start-postgresql' })
  expect(w.toasts.at(-1)).toMatch(/postgresql not started: Tailscale is Stopped, not Running/)
  w.tailscale = '' // the CLI exits 1: unknown is not Running
  await ui.press({ key: 'start-postgresql' })
  expect(w.toasts.at(-1)).toMatch(/postgresql not started: Tailscale is unknown, not Running/)
  w.tailscale = 'Running'
  await ui.press({ key: 'start-postgresql' })
  expect(w.toasts.at(-1)).toMatch(/postgresql not started: postgresql\/\.env has BIND_IP=100\.64\.0\.9, this machine's Tailscale IP is 100\.64\.0\.1/)
  expect(ups(w)).toEqual([])
  expect(w.toasts.join('\n')).not.toMatch(/hunter2/) // BIND_IP is the one line of .env that is read into a value
  // refused, the row is back with its button
  expect(await ui.find({ key: 'start-postgresql' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /starting…/ })).toBeUndefined()
  // the address matches, or is loopback (`set-bind-ip 127.0.0.1`): started
  w.env[`${INFRA}/postgresql/.env`] = 'BIND_IP="100.64.0.1"\n'
  await ui.press({ key: 'start-postgresql' })
  w.env[`${INFRA}/gateway/.env`] = 'BIND_IP=127.0.0.1\n'
  await ui.press({ key: 'start-gateway' })
  expect(ups(w)).toEqual([upOf('postgresql'), upOf('gateway')])
  await ui.unmount()
})

test('while a start runs the row says so without a button, and a second start of the service is refused', async ($, on) => {
  const w = world(on)
  w.upMs = 30_000
  await $.command.run(INFRA_RUN)
  const ui = await $.ui.mount({ plugin: 'infra-pane', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'infra' })
  await ui.press({ key: 'start-postgresql' }) // settles with `up -d` asleep on the clock
  expect(ups(w)).toEqual([upOf('postgresql')])
  expect((await ui.find({ type: 'Text', text: /◐ postgresql starting…/ }))?.props).toMatchObject({ color: 'warning' })
  expect(await ui.find({ key: 'start-postgresql' })).toBeUndefined()
  expect(await ui.find({ key: 'start-gateway' })).toBeDefined() // the others keep theirs
  expect((await $.command.run({ ...INFRA_RUN, args: 'start postgresql' })).text).toMatch(/postgresql is already starting/)
  expect(ups(w)).toEqual([upOf('postgresql')])
  // a poll on the way counts the first container up: the row stays `starting…`, with neither start nor stop
  const row = w.compose.find(one => one.Name === 'local-postgresql')
  if (row) row.Status = 'exited(2), running(1)'
  await $.command.run(INFRA_RUN)
  expect(await ui.find({ type: 'Text', text: /◐ postgresql starting…/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /● postgresql/ })).toBeUndefined()
  expect(await ui.find({ key: 'stop-postgresql' })).toBeUndefined()
  expect(await ui.find({ key: 'start-postgresql' })).toBeUndefined()
  await w.clock.advance(30_000)
  expect(await ui.find({ type: 'Text', text: /starting…/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /● postgresql/ })).toBeDefined()
  expect(await ui.find({ key: 'stop-postgresql' })).toBeDefined()
  await ui.unmount()
})

test('a start that fails says so with docker\'s last line, and the row is back with its button', async ($, on) => {
  const w = world(on)
  w.upError = 'Network local-kafka_kafka  Error\nnetwork local-kafka_kafka declared as external, but could not be found'
  await $.command.run(INFRA_RUN)
  const ui = await $.ui.mount({ plugin: 'infra-pane', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'infra' })
  await ui.press({ key: 'start-gateway' })
  expect(ups(w)).toEqual([upOf('gateway')])
  expect(w.toasts.at(-1)).toMatch(/infra: start gateway failed \(exit 1\): network local-kafka_kafka declared as external, but could not be found/)
  expect(w.toasts.join('\n')).not.toMatch(/gateway started/)
  expect(await ui.find({ type: 'Text', text: /starting…/ })).toBeUndefined()
  expect(await ui.find({ key: 'start-gateway' })).toBeDefined()
  expect(await ui.find({ key: 'stop-gateway' })).toBeUndefined()
  expect((await $.command.run({ ...INFRA_RUN, args: 'start gateway' })).text).toMatch(/start gateway failed \(exit 1\)/)
  await ui.unmount()
})

test('a poll that asked docker before `up -d` returned does not decide the row: it is polled again', async ($, on) => {
  const w = world(on)
  w.upMs = 30_000
  await $.command.run(INFRA_RUN)
  const ui = await $.ui.mount({ plugin: 'infra-pane', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'infra' })
  await ui.press({ key: 'start-postgresql' })
  // 25 s in, a poll asks docker (postgresql still exited) and docker takes 10 s to say so
  await w.clock.advance(25_000)
  w.lsMs = 10_000
  const stale = $.command.run(INFRA_RUN)
  await w.clock.settle()
  w.lsMs = 0
  await w.clock.advance(5_000) // `up -d` returns; the stale poll is still out
  expect(await ui.find({ type: 'Text', text: /◐ postgresql starting…/ })).toBeDefined()
  await w.clock.advance(5_000) // the stale poll lands, then the one made after `up -d`
  await stale
  expect(await ui.find({ type: 'Text', text: /starting…/ })).toBeUndefined()
  expect(await ui.find({ key: 'start-postgresql' })).toBeUndefined() // never `start` over a service that is up
  expect(await ui.find({ key: 'stop-postgresql' })).toBeDefined()
  await ui.unmount()
})

test('/infra start <svc…> starts each named ~/infra service; without a name it asks, and another name never reaches docker', async ($, on) => {
  const w = world(on)
  expect((await $.command.run({ ...INFRA_RUN, args: 'start' })).text).toMatch(/which service/)
  for (const name of ['news_tracker', 'scratch', '../postgresql', 'all']) {
    expect((await $.command.run({ ...INFRA_RUN, args: `start ${name}` })).text).toMatch(/is not a compose service of ~\/infra \(gateway, kafka, mongodb, postgresql\)/)
  }
  expect(ups(w)).toEqual([])
  const started = await $.command.run({ ...INFRA_RUN, args: 'start postgresql gateway' })
  expect(started.text).toBe('infra: postgresql started.\ninfra: gateway started.')
  expect(ups(w)).toEqual([upOf('postgresql'), upOf('gateway')])
  expect(w.statuses.at(-1)).toMatch(/infra ↑ gateway kafka mongodb postgresql/)
})

test('the wiki-serve toggle runs scripts/wiki-serve on|off and the status line follows', async ($, on) => {
  const w = world(on)
  await $.command.run({ command: 'infra', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  const ui = await $.ui.mount({ plugin: 'infra-pane', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'infra' })
  expect((await ui.find({ key: 'wiki-serve-toggle' }))?.props).toMatchObject({ label: 'on' })
  await ui.press({ key: 'wiki-serve-toggle' })
  expect(w.argv).toContain(`${INFRA}/scripts/wiki-serve on`)
  expect(w.toasts.join('\n')).toMatch(/wiki-serve ON \(public only\): ON .*public only/)
  expect(w.statuses.at(-1)).toMatch(/wiki-serve ON/)
  await ui.unmount()
  const off = await $.command.run({ command: 'infra', args: 'wiki off', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(off.text).toMatch(/wiki-serve OFF: OFF/)
  expect(w.argv).toContain(`${INFRA}/scripts/wiki-serve off`)
  expect(w.statuses.at(-1)).not.toMatch(/wiki-serve ON/)
  const asked = await $.command.run({ command: 'infra', args: 'wiki', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(asked.text).toMatch(/wiki on/)
})

test('the wiki-serve mode: public by default, a switch to full and back, /infra wiki full|public', async ($, on) => {
  const w = world(on)
  const RUN = { command: 'infra', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } }
  await $.command.run(RUN)
  const ui = await $.ui.mount({ plugin: 'infra-pane', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'infra' })
  expect((await ui.find({ type: 'Text', text: /wiki-serve off/ }))?.props).toMatchObject({ dimColor: true })
  expect((await ui.find({ key: 'wiki-serve-mode' }))?.props).toMatchObject({ label: 'on full' })
  expect((await ui.find({ key: 'wiki-serve-mode' }))?.props.hotkey).toBeUndefined() // no hotkey: FULL is never one keystroke away
  // on = public only
  await ui.press({ key: 'wiki-serve-toggle' })
  expect(lastWiki(w)).toBe(`${INFRA}/scripts/wiki-serve on`)
  expect((await ui.find({ type: 'Text', text: /wiki-serve ON public/ }))?.props).toMatchObject({ color: 'warning', bold: true })
  expect((await ui.find({ key: 'wiki-serve-mode' }))?.props).toMatchObject({ label: '→ full' })
  expect(w.statuses.at(-1)).toMatch(/wiki-serve ON/)
  // switch to full: red, a warning toast, FULL on the status line
  await ui.press({ key: 'wiki-serve-mode' })
  expect(lastWiki(w)).toBe(`${INFRA}/scripts/wiki-serve on --full`)
  expect(w.toasts.join('\n')).toMatch(/ON FULL: every tailnet device, the mac mini too/)
  expect((await ui.find({ type: 'Text', text: /wiki-serve ON FULL/ }))?.props).toMatchObject({ color: 'error', bold: true })
  expect((await ui.find({ key: 'wiki-serve-mode' }))?.props).toMatchObject({ label: '→ public' })
  expect((await ui.find({ key: 'wiki-serve-toggle' }))?.props).toMatchObject({ label: 'off' })
  expect(w.statuses.at(-1)).toMatch(/wiki-serve FULL/)
  // and back to public
  await ui.press({ key: 'wiki-serve-mode' })
  expect(lastWiki(w)).toBe(`${INFRA}/scripts/wiki-serve on`)
  expect(w.statuses.at(-1)).not.toMatch(/FULL/)
  await ui.unmount()
  // the command: full, public (= on), and the summary names the mode
  const full = await $.command.run({ ...RUN, args: 'wiki full' })
  expect(full.text).toMatch(/wiki-serve ON FULL/)
  expect(lastWiki(w)).toBe(`${INFRA}/scripts/wiki-serve on --full`)
  expect((await $.command.run(RUN)).text).toMatch(/wiki-serve ON \(FULL: local-only areas visible to every tailnet device\)/)
  await $.command.run({ ...RUN, args: 'wiki public' })
  expect(lastWiki(w)).toBe(`${INFRA}/scripts/wiki-serve on`)
  expect((await $.command.run(RUN)).text).toMatch(/wiki-serve ON \(public only\)/)
  expect((await $.command.run({ ...RUN, args: 'wiki everything' })).text).toMatch(/wiki full/)
})

test('wiki-serve listening without its launchd agent: mode unknown, and the switch restarts it public', async ($, on) => {
  const w = world(on)
  w.lsof = 0 // e.g. `wiki-serve run` by hand
  const RUN = { command: 'infra', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } }
  expect((await $.command.run(RUN)).text).toMatch(/wiki-serve ON \(mode unknown\)/)
  expect(w.statuses.at(-1)).toMatch(/wiki-serve ON \(mode\?\)/)
  const ui = await $.ui.mount({ plugin: 'infra-pane', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'infra' })
  expect(await ui.find({ type: 'Text', text: /wiki-serve ON \(mode\?\)/ })).toBeDefined()
  expect((await ui.find({ key: 'wiki-serve-mode' }))?.props).toMatchObject({ label: '→ public' })
  await ui.press({ key: 'wiki-serve-mode' })
  expect(lastWiki(w)).toBe(`${INFRA}/scripts/wiki-serve on`)
  await ui.unmount()
})

test('the k8s section: off with a start button; on with per-namespace pods, a stop button, and the status line', async ($, on) => {
  const w = world(on)
  const RUN = { command: 'infra', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } }
  const off = await $.command.run(RUN)
  expect(off.text).toMatch(/k8s off\./)
  let ui = await $.ui.mount({ plugin: 'infra-pane', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'infra' })
  expect((await ui.find({ type: 'Text', text: /k8s off/ }))?.props).toMatchObject({ dimColor: true })
  expect((await ui.find({ key: 'k8s-toggle' }))?.props).toMatchObject({ label: 'start' })
  expect(w.argv.some(a => a.startsWith('kubectl'))).toBe(false) // nothing asked of kubectl while off
  await ui.press({ key: 'k8s-toggle' })
  expect(w.argv).toContain('orbctl start k8s')
  await ui.unmount()
  const on_ = await $.command.run(RUN)
  expect(on_.text).toMatch(/k8s on, 1 error pod\./)
  expect(w.statuses.at(-1)).toMatch(/k8s on \(3 ready, 1 error\)/)
  ui = await $.ui.mount({ plugin: 'infra-pane', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'infra' })
  expect((await ui.find({ type: 'Text', text: /▶ k8s on/ }))?.props).toMatchObject({ bold: true, color: 'success' })
  expect((await ui.find({ type: 'Text', text: /● infra/ }))?.props).toMatchObject({ color: 'success' })
  expect(await ui.find({ type: 'Text', text: /2\/2 ready/ })).toBeDefined() // the Completed job is not counted
  // a failing pod paints its namespace red and is listed under it with status and restarts
  expect((await ui.find({ type: 'Text', text: /✖ code-companion-local/ }))?.props).toMatchObject({ color: 'error', bold: true })
  expect((await ui.find({ type: 'Text', text: /✖ code-companion-545665cf75-vs9mg 1\/2 Error ↻4 10m/ }))?.props).toMatchObject({ color: 'error', bold: true })
  expect(await ui.find({ type: 'Text', text: /· 1 error/ })).toBeDefined()
  // a pod still coming up paints its namespace yellow
  expect((await ui.find({ type: 'Text', text: /◐ scratch/ }))?.props).toMatchObject({ color: 'warning' })
  expect((await ui.find({ type: 'Text', text: /◐ worker-0 0\/1 Pending 1m/ }))?.props).toMatchObject({ color: 'warning' })
  expect(await ui.find({ type: 'Text', text: /kube-system/ })).toBeUndefined()
  // collapsed: healthy pods and finished jobs are not listed, only counted
  expect(await ui.find({ type: 'Text', text: /postgresql-0/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /mongodb-init/ })).toBeUndefined()
  expect((await ui.find({ key: 'ns-toggle-infra' }))?.props).toMatchObject({ label: '▸ 3 pods' })
  // open one namespace: every pod, each in its own colour, finished jobs dim
  await ui.press({ key: 'ns-toggle-infra' })
  expect((await ui.find({ type: 'Text', text: /● postgresql-0 1\/1 Running 5h/ }))?.props).toMatchObject({ color: 'success' })
  expect((await ui.find({ type: 'Text', text: /✔ mongodb-init-abc12 0\/1 Completed 5h/ }))?.props).toMatchObject({ dimColor: true })
  expect(await ui.find({ type: 'Text', text: /worker-1/ })).toBeUndefined() // scratch is still collapsed
  expect((await ui.find({ key: 'ns-toggle-infra' }))?.props).toMatchObject({ label: '▾ hide' })
  await ui.press({ key: 'ns-toggle-infra' })
  expect(await ui.find({ type: 'Text', text: /postgresql-0/ })).toBeUndefined()
  // expand all / collapse all
  await ui.press({ key: 'k8s-expand-all' })
  expect(await ui.find({ type: 'Text', text: /● worker-1 1\/1 Running 1m/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /postgresql-1/ })).toBeDefined()
  expect((await ui.find({ key: 'k8s-expand-all' }))?.props).toMatchObject({ label: '▾ collapse all' })
  await ui.press({ key: 'k8s-expand-all' })
  expect(await ui.find({ type: 'Text', text: /postgresql-1/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /✖ code-companion-545665cf75-vs9mg/ })).toBeDefined() // errors stay visible when collapsed
  expect((await ui.find({ key: 'k8s-toggle' }))?.props).toMatchObject({ label: 'stop' })
  await ui.unmount()
  const stopped = await $.command.run({ ...RUN, args: 'k8s stop' })
  expect(stopped.text).toMatch(/k8s stopped/)
  expect(w.argv).toContain('orbctl stop k8s')
  expect(w.statuses.at(-1) ?? '').not.toMatch(/k8s on/)
})

test('/infra stop <svc> runs stop_all for that service; without a name it asks', async ($, on) => {
  const w = world(on)
  const asked = await $.command.run({ command: 'infra', args: 'stop', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(asked.text).toMatch(/which service/)
  const stopped = await $.command.run({ command: 'infra', args: 'stop all', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(stopped.text).toMatch(/all stopped/)
  expect(w.argv).toContain(`${INFRA}/stop_all --skip-k8s all`)
})

test('with nothing running and wiki-serve off the status line is cleared; wiki-serve on shows it', async ($, on) => {
  const w = world(on)
  w.lsof = 0
  const ran = await $.command.run({ command: 'infra', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(ran.text).toMatch(/wiki-serve ON/)
  expect(w.statuses.at(-1)).toMatch(/wiki-serve ON/)
})

test('infra-pane.enabled = false: no polling, the pane is closed, the status line cleared, /infra says it is off', { options: { enabled: false } }, async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: `${HOME}/proj`, surface: 'terminal', isInteractive: true })
  expect(w.commands).toEqual(['infra'])
  expect(w.opened).toEqual([])
  expect(w.closed).toEqual(['infra'])
  expect(w.statuses.length).toBe(1) // cleared once at start
  expect(w.statuses[0]).not.toMatch(/infra ↑/)
  const ran = await $.command.run({ command: 'infra', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(ran.text).toMatch(/off/)
  expect(w.argv).toEqual([])
  const ui = await $.ui.mount({ plugin: 'infra-pane', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'infra' })
  expect(await ui.find({ type: 'Text', text: /off/ })).toBeDefined()
  await ui.unmount()
})
