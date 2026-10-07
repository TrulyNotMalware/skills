import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const HOME = '/Users/t'
const INFRA = `${HOME}/infra`
const TS = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'

type World = { tailscale: { exitCode: number; stdout: string }; files: Record<string, string>; argv: string[]; bottom: string[]; cwd: string }

function world(on: On, state: string, ip = '100.64.0.1', cwd = `${HOME}/proj`): World {
  const w: World = {
    tailscale: { exitCode: 0, stdout: JSON.stringify({ BackendState: state, TailscaleIPs: [ip, 'fd7a::1'] }) },
    files: {
      [`${INFRA}/kafka/.env`]: 'KAFKA_X=secret\nBIND_IP=100.64.0.1\nKAFKA_ADVERTISED_HOST=100.64.0.1\n',
      [`${INFRA}/kafka/docker-compose.yml`]: '',
      [`${INFRA}/gateway/.env`]: 'UI_BIND_IP=127.0.0.1\n',
      [`${INFRA}/gateway/docker-compose.yml`]: '',
    },
    argv: [],
    bottom: [],
    cwd,
  }
  mock.env(on, { HOME })
  mock.clock(on)
  on('session.cwd', () => ({ value: w.cwd }))
  on('fs.exists', ($, e) => ({ value: e.path in w.files }))
  on('fs.read', ($, e) => (e.path in w.files ? { value: w.files[e.path] as string } : { deny: `ENOENT ${e.path}` }))
  on('process.run', ($, e) => {
    w.argv.push(e.argv.join(' '))
    if (e.argv[0] === TS) return { value: { ...w.tailscale, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 127, stdout: '', stderr: 'no fake', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', ($, e) => {
    w.bottom.push(e.tool)
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' } as never
  })
  return w
}

const deny = (r: unknown): string => (r as { deny?: string }).deny ?? ''
const UP = `docker compose -f ${INFRA}/kafka/docker-compose.yml up -d`

test('Tailscale not Running: starting an infra service is refused with the fix', async ($, on) => {
  const w = world(on, 'Stopped')
  expect(deny(await $.tool.call({ tool: 'Bash', command: UP }))).toMatch(/Tailscale is "Stopped".*open -a Tailscale/)
  expect(deny(await $.tool.call({ tool: 'Bash', command: `docker compose -f ~/infra/kafka/docker-compose.yml restart` }))).toMatch(/Tailscale/)
  expect(deny(await $.tool.call({ tool: 'Bash', command: `cd ~/infra && docker compose -f kafka/docker-compose.yml start` }))).toMatch(/Tailscale/)
  expect(w.bottom).toEqual([])
})

test('Tailscale Running and BIND_IP matching: the command passes', async ($, on) => {
  const w = world(on, 'Running')
  expect(deny(await $.tool.call({ tool: 'Bash', command: UP }))).toBe('')
  expect(deny(await $.tool.call({ tool: 'Bash', command: `docker compose -f ${INFRA}/gateway/docker-compose.yml up -d` }))).toBe('')
  expect(w.bottom).toEqual(['Bash', 'Bash'])
})

test('BIND_IP drifted from the Tailscale IPv4: refused, naming set-bind-ip', async ($, on) => {
  world(on, 'Running', '100.64.9.9')
  expect(deny(await $.tool.call({ tool: 'Bash', command: UP }))).toMatch(/BIND_IP=100\.64\.0\.1 .*100\.64\.9\.9.*set-bind-ip/)
  expect(deny(await $.tool.call({ tool: 'Bash', command: `docker compose -f ${INFRA}/gateway/docker-compose.yml up -d` }))).toBe('')
})

test('compose commands outside ~/infra, and non-start verbs, never consult Tailscale', async ($, on) => {
  const w = world(on, 'Stopped')
  expect(deny(await $.tool.call({ tool: 'Bash', command: 'docker compose -f ~/proj/compose.yaml up -d' }))).toBe('')
  expect(deny(await $.tool.call({ tool: 'Bash', command: 'docker compose up -d' }))).toBe('')
  expect(deny(await $.tool.call({ tool: 'Bash', command: `docker compose -f ${INFRA}/kafka/docker-compose.yml ps` }))).toBe('')
  expect(deny(await $.tool.call({ tool: 'Bash', command: `docker compose -f ${INFRA}/kafka/docker-compose.yml down` }))).toBe('')
  expect(w.argv).toEqual([])
  expect(w.bottom.length).toBe(4)
})

test('a bare `docker compose up` run inside ~/infra/<svc> is that service', async ($, on) => {
  world(on, 'Stopped', '100.64.0.1', `${INFRA}/kafka`)
  expect(deny(await $.tool.call({ tool: 'Bash', command: 'docker compose up -d' }))).toMatch(/Tailscale/)
})

test('infra-preflight.enabled = false: no check, Tailscale is not even asked', { options: { enabled: false } }, async ($, on) => {
  const w = world(on, 'Stopped')
  expect(deny(await $.tool.call({ tool: 'Bash', command: UP }))).toBe('')
  expect(w.argv).toEqual([])
  expect(w.bottom).toEqual(['Bash'])
})
