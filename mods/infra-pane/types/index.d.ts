/** One service directory of ~/infra (a folder holding docker-compose.yml) and its compose project, if any. */
export type InfraService = {
  svc: string
  /** The compose project name, when docker knows the service. */
  project?: string
  /** docker's own status text, `running(3)`, `exited(3)`, or `absent` when never created. */
  status: string
  running: boolean
}

/** A compose project that does not live under ~/infra. */
export type InfraOther = {
  name: string
  status: string
  running: boolean
  dir: string
}

export type InfraTailscale = {
  /** Tailscale's BackendState (`Running`, `Stopped`, `NeedsLogin`), `unknown` when the CLI failed. */
  state: string
  ip?: string
}

/** How a pod reads: all containers ready (`running`), a failure (`error`), still coming up or not ready (`pending`), a finished job (`done`). */
export type InfraK8sPodKind = 'running' | 'error' | 'pending' | 'done'

/** One pod as `kubectl get pods` prints it. */
export type InfraK8sPod = {
  name: string
  kind: InfraK8sPodKind
  /** kubectl's STATUS column: `Error`, `CrashLoopBackOff`, `ImagePullBackOff`, `Pending`, ... */
  status: string
  /** kubectl's READY column, `1/2`. */
  ready: string
  restarts: number
  /** kubectl's AGE column. */
  age: string
}

export type InfraK8sNamespace = {
  name: string
  /** Pods whose STATUS is Running with every container ready. */
  running: number
  /** Pods in any state but Completed (finished jobs are left out). */
  total: number
  /** Every pod, finished jobs included, in the order errors, pending, running, done. */
  pods: InfraK8sPod[]
}

export type InfraK8s = {
  /** OrbStack's `k8s.enable` as `orb config show` prints it. */
  enabled: boolean
  /** Whether the API server answered `/readyz` under the `orbstack` kube context. */
  reachable: boolean
  /** Namespaces other than `kube-*`, with their pod counts; empty while off or unreachable. */
  namespaces: InfraK8sNamespace[]
}

export type InfraSnapshot = {
  /** When this snapshot was taken, ms since the epoch. */
  at: number
  /** Whether `docker compose ls` answered. */
  docker: 'ok' | 'down'
  dockerError?: string
  infra: InfraService[]
  others: InfraOther[]
  tailscale: InfraTailscale
  /** Whether something listens on 127.0.0.1:8480 (the wiki read-only web). */
  wikiServe: boolean
  k8s: InfraK8s
}

declare module 'claude-code' {
  interface PluginState {
    'infra-pane': {
      snapshot: InfraSnapshot | null
      /** Namespaces whose full pod list is shown in the pane. */
      expanded: string[]
    }
  }
}
