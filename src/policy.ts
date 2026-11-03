import { PolicyError } from './errors.js'
import type { PolicyErrorReason } from './errors.js'
import type { Middleware } from './types.js'

/**
 * `allow` keeps the library usable out of the box: only explicit `deny` rules
 * block. Switch to `deny` to turn the allow list into a closed whitelist where
 * anything that does not match is rejected.
 */
export type PolicyMode = 'allow' | 'deny'

/**
 * A policy rule is either:
 * - `*` (everything),
 * - `scheme://host[/path]` (matches that origin, optionally path-prefixed),
 * - a bare `host` / `hostname` (port-aware for `host`, port-agnostic for
 *   `hostname`),
 * - or a `RegExp` tested against the full URL.
 */
export type PolicyRule = string | RegExp

export interface PolicyOptions {
  /** `allow` (default) or `deny` (unlisted URLs are rejected). */
  mode?: PolicyMode
  /** Allow list. In `deny` mode this is the closed whitelist. */
  allow?: readonly PolicyRule[]
  /** Hard deny list. Evaluated before `allowSameOrigin` and `allow`. */
  deny?: readonly PolicyRule[]
  /** Schemes rejected outright, with or without a trailing colon. */
  denySchemes?: readonly string[]
  /**
   * Allow requests whose origin equals the browser `location.origin`. This is
   * an OR with the allow list, but still subject to `deny` / `denySchemes`.
   * No-op outside a browser (Node has no `location`).
   */
  allowSameOrigin?: boolean
}

export interface PolicyDecision {
  allowed: boolean
  /** Target origin, as computed by {@link originOf}. */
  origin: string
  /** Set when `allowed` is `false`. */
  reason: PolicyErrorReason | undefined
}

const SCHEME_RULE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//

/**
 * `URL.origin` is `"null"` for non-special schemes (`ipc:`), so rebuild the
 * origin from the protocol and host for those.
 */
export function originOf(url: URL): string {
  if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin
  return `${url.protocol}//${url.host}`
}

function schemeOf(url: URL): string {
  return url.protocol.replace(/:$/, '').toLowerCase()
}

function stripTrailingSlash(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, '') : value
}

function matchesRule(rule: PolicyRule, url: URL, origin: string): boolean {
  if (rule instanceof RegExp) {
    // Global/sticky regexes carry state; always start from zero.
    rule.lastIndex = 0
    return rule.test(url.href)
  }

  const text = rule.trim()
  if (!text) return false
  if (text === '*') return true

  if (SCHEME_RULE.test(text)) {
    let parsed: URL
    try {
      parsed = new URL(text)
    } catch {
      return false
    }
    if (originOf(parsed) !== origin) return false

    const rulePath = parsed.pathname
    if (rulePath === '' || rulePath === '/') return true
    return stripTrailingSlash(url.pathname).startsWith(stripTrailingSlash(rulePath))
  }

  const host = text.toLowerCase()
  return url.host.toLowerCase() === host || url.hostname.toLowerCase() === host
}

function isDeniedScheme(url: URL, denySchemes: readonly string[]): boolean {
  const scheme = schemeOf(url)
  return denySchemes.some((item) => item.trim().replace(/:$/, '').toLowerCase() === scheme)
}

function isSameOrigin(origin: string): boolean {
  if (typeof location === 'undefined') return false
  return location.origin === origin
}

/**
 * Evaluate a URL against the unified policy.
 *
 * Order: `denySchemes` -> `deny` -> `allowSameOrigin` (OR) `allow` ->
 * `mode === 'deny'` rejects anything unlisted. With the default `allow` mode
 * an unmatched URL is still permitted.
 */
export function evaluatePolicy(url: URL, policy: PolicyOptions): PolicyDecision {
  const origin = originOf(url)

  if (policy.denySchemes && isDeniedScheme(url, policy.denySchemes)) {
    return { allowed: false, origin, reason: 'denied-scheme' }
  }

  if (policy.deny?.some((rule) => matchesRule(rule, url, origin))) {
    return { allowed: false, origin, reason: 'denied' }
  }

  if (policy.allowSameOrigin && isSameOrigin(origin)) {
    return { allowed: true, origin, reason: undefined }
  }

  if (policy.allow?.some((rule) => matchesRule(rule, url, origin))) {
    return { allowed: true, origin, reason: undefined }
  }

  if ((policy.mode ?? 'allow') === 'deny') {
    return { allowed: false, origin, reason: 'not-allowlisted' }
  }

  return { allowed: true, origin, reason: undefined }
}

/**
 * Build the middleware that enforces a policy. Register it as the first
 * middleware so no later hook can bypass the decision. `PolicyError` keeps the
 * caller's `context` (for example an import chain) untouched.
 */
export function createPolicyMiddleware(policy: PolicyOptions): Middleware {
  return async (request, next) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      // Leave URL validation to the executor so the existing `EINVALID`
      // behaviour is preserved.
      return next()
    }

    const decision = evaluatePolicy(url, policy)
    if (decision.allowed) return next()

    throw new PolicyError(decision.reason ?? 'denied', {
      url: request.url,
      method: request.method,
      origin: decision.origin,
      context: request.context,
    })
  }
}
