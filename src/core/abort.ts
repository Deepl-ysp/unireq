export interface Deadline {
  readonly signal: AbortSignal
  /** True when this deadline fired because of the timeout, not the caller. */
  timedOut(): boolean
  dispose(): void
}

/**
 * Combine the caller's signal with a per-attempt timer. The resulting signal
 * aborts when either source aborts; `timedOut()` distinguishes the two.
 */
export function createDeadline(timeoutMs: number | undefined, outer: AbortSignal | undefined): Deadline {
  const controller = new AbortController()
  let timedOut = false
  let timer: NodeJS.Timeout | undefined

  const onOuterAbort = (): void => {
    controller.abort(outer?.reason)
  }

  if (outer) {
    if (outer.aborted) {
      controller.abort(outer.reason)
    } else {
      outer.addEventListener('abort', onOuterAbort, { once: true })
    }
  }

  if (timeoutMs !== undefined && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error(`timeout after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref()
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      if (timer) clearTimeout(timer)
      outer?.removeEventListener('abort', onOuterAbort)
    },
  }
}

/** Abortable sleep used between retry attempts. */
export function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }

    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      cleanup()
      reject(signal?.reason ?? new Error('Aborted'))
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
