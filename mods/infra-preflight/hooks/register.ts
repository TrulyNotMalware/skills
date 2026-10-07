import type { EngineInterface, Register } from 'claude-code'

const TAILSCALE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
// `docker compose … up|start|restart` (also `docker-compose`), within one simple command.
const COMPOSE_START = /\bdocker(?:\s+compose|-compose)\b[^;&|]*\b(?:up|start|restart)\b/
const FILE_FLAG = /(?:^|\s)(?:-f|--file)(?:\s+|=)['"]?([^\s'"]+)/g

type Engine = EngineInterface

let homeDir: string | undefined
async function home($: Engine): Promise<string> {
  homeDir ??= (await $.env.get('HOME')) ?? '/'
  return homeDir
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

function relOf(root: string, path: string): string | null {
  if (path === root) return ''
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null
}

/** The ~/infra service directories a compose command addresses, by its -f files or its cwd. */
async function servicesOf($: Engine, command: string, cwd: string, infra: string): Promise<Set<string>> {
  const found = new Set<string>()
  const files = [...command.matchAll(FILE_FLAG)].map(m => m[1] ?? '')
  for (const file of files) {
    let path = file
    if (path === '~' || path.startsWith('~/')) path = (await home($)) + path.slice(1)
    const candidates = path.startsWith('/') ? [normalize(path)] : [normalize(`${cwd}/${path}`), normalize(`${infra}/${path}`)]
    for (const candidate of candidates) {
      const rel = relOf(infra, candidate)
      if (rel === null || rel === '') continue
      if (candidate !== candidates[0] && !(await $.fs.exists(candidate))) continue
      found.add(rel.split('/')[0] ?? '')
      break
    }
  }
  if (files.length === 0) {
    const rel = relOf(infra, cwd)
    if (rel) found.add(rel.split('/')[0] ?? '')
  }
  found.delete('')
  return found
}

async function tailscale($: Engine): Promise<{ state: string; ip?: string }> {
  try {
    const ran = await $.process.run([TAILSCALE, 'status', '--json'], { timeoutMs: 8_000 })
    if (ran.exitCode !== 0) return { state: `unavailable (exit ${ran.exitCode})` }
    const parsed = JSON.parse(ran.stdout) as { BackendState?: string; TailscaleIPs?: string[] }
    const ip = (parsed.TailscaleIPs ?? []).find(candidate => /^\d+\.\d+\.\d+\.\d+$/.test(candidate))
    return { state: parsed.BackendState ?? 'unknown', ...(ip ? { ip } : {}) }
  } catch (error) {
    return { state: `unavailable (${String(error).split('\n')[0]})` }
  }
}

/** BIND_IP from a service's .env; only that one line is read into a value, nothing else leaves the file. */
async function bindIpOf($: Engine, envPath: string): Promise<string | undefined> {
  let text: string
  try {
    text = await $.fs.read(envPath)
  } catch {
    return undefined
  }
  const match = /^BIND_IP=["']?([^"'\s#]+)/m.exec(text)
  return match?.[1]
}

export const register: Register = (on, options) => {
  // `/config` → infra-preflight.enabled; off, the check is skipped.
  const enabled = options.enabled !== false

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!enabled) return next(e)
    const command = e.command
    if (!COMPOSE_START.test(command)) return next(e)
    const infra = `${await home($)}/infra`
    const cwd = await $.session.cwd()
    const services = await servicesOf($, command, cwd, infra)
    const mentionsInfra = command.includes(`${infra}/`) || command.includes('~/infra')
    if (services.size === 0 && !mentionsInfra) return next(e)

    const ts = await tailscale($)
    if (ts.state !== 'Running') {
      return {
        deny: `infra-preflight: Tailscale is "${ts.state}", not Running. ~/infra data ports bind to BIND_IP = the Tailscale IP, so a container started now publishes nothing on the host. Run \`open -a Tailscale\`, wait until \`${TAILSCALE} status\` shows it Running, then retry. (A container that was started while it was off needs \`docker compose -f <svc>/docker-compose.yml restart\` afterwards.)`,
      }
    }
    for (const svc of services) {
      const bind = await bindIpOf($, `${infra}/${svc}/.env`)
      if (bind && bind !== '127.0.0.1' && ts.ip && bind !== ts.ip) {
        return {
          deny: `infra-preflight: ${svc}/.env has BIND_IP=${bind} but this machine's Tailscale IPv4 is ${ts.ip}. Clients would be sent to the old address (Kafka advertised host, Redis announce). Run \`~/infra/scripts/set-bind-ip\` (rewrites every service's .env) and retry.`,
        }
      }
    }
    return next(e)
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `infra-preflight: the check failed (${next.error.kind}). Confirm Tailscale is Running (\`${TAILSCALE} status | head -1\`) before starting ~/infra services, then retry.` },
  )
}
