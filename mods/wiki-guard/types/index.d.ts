/** Milliseconds since the epoch when `bin/wikilint` last started and ended with 0 errors; 0 when it has not run this session. */
export type WikiGuardLintAt = number

declare module 'claude-code' {
  interface PluginState {
    'wiki-guard': { lintAt: WikiGuardLintAt }
  }
}
