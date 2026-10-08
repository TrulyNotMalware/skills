import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const HOME = '/Users/t'
const INFRA = `${HOME}/infra`
const TS = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
const PLIST = `${HOME}/Library/LaunchAgents/com.junho.wiki-serve.plist`
const plistFor = (full: boolean) =>
  `<dict><key>EnvironmentVariables</key><dict><key>WIKI_PORT</key><string>8480</string>${full ? '<key>WIKI_FULL</key><string>1</string>' : ''}</dict></dict>`

const COMPOSE = JSON.stringify([
  { Name: 'local-kafka', Status: 'running(3)', ConfigFiles: `${INFRA}/kafka/docker-compose.yml` },
  { Name: 'local-postgresql', Status: 'exited(3)', ConfigFiles: `${INFRA}/postgresql/docker-compose.yml` },
  // a one-shot init container exited beside three live replicas: docker sums per state, comma-joined
  { Name: 'local-mongodb', Status: 'exited(1), running(3)', ConfigFiles: `${INFRA}/mongodb/docker-compose.yml` },
  { Name: 'news_tracker', Status: 'running(3)', ConfigFiles: `${HOME}/workspace/news_tracker/compose.yaml` },
])

type World = { argv: string[]; statuses: string[]; toasts: string[]; commands: string[]; opened: string[]; closed: string[]; lsof: number; k8s: boolean; plist: string | null }

function world(on: On): World {
  const w: World = { argv: [], statuses: [], toasts: [], commands: [], opened: [], closed: [], lsof: 1, k8s: false, plist: null }
  mock.env(on, { HOME })
  mock.clock(on, { now: 1_700_000_000_000 })
  on('fs.list', ($, e) => ({
    value: e.path === INFRA
      ? ['kafka', 'postgresql', 'gateway', 'mongodb', 'scripts', '.git'].map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }))
      : [],
  }))
  on('fs.read', ($, e) => {
    if (e.path === PLIST && w.plist !== null) return { value: w.plist }
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('fs.exists', ($, e) => ({ value: [`${INFRA}/kafka/docker-compose.yml`, `${INFRA}/postgresql/docker-compose.yml`, `${INFRA}/gateway/docker-compose.yml`, `${INFRA}/mongodb/docker-compose.yml`].includes(e.path) }))
  on('process.run', ($, e) => {
    const key = e.argv.join(' ')
    w.argv.push(key)
    const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (key.startsWith('docker compose ls')) return ok(COMPOSE)
    if (e.argv[0] === TS) return ok(JSON.stringify({ BackendState: 'Running', TailscaleIPs: ['100.64.0.1'] }))
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

const PANE_PROPS = { title: 'infra', isFocused: false, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} }

test('/infra polls, opens the pane, sets the status line and summarises', async ($, on) => {
  const w = world(on)
  const ran = await $.command.run({ command: 'infra', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(ran.text).toMatch(/up: kafka, mongodb; tailscale Running; wiki-serve off/)
  expect(w.opened).toEqual(['infra'])
  expect(w.statuses.at(-1)).toMatch(/infra ↑ kafka/)
  expect(w.argv.some(a => a.startsWith('docker compose ls -a --format json'))).toBe(true)
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
    const off = await ui.find({ type: 'Text', text: /○ off: gateway · postgresql/ })
    expect(off?.props).toMatchObject({ dimColor: true }) // stopped ones are one dim line
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
