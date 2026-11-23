import type { SweepObserver } from '../../http/operational-status.ts'

export function startExpiryScheduler(
  sweep: () => Promise<number>,
  onError: () => void,
  observe?: SweepObserver,
  drainBatches = true,
) {
  let running: Promise<void> | undefined
  let stopped = false
  const tick = () => {
    if (running || stopped) return
    observe?.started()
    running = (async () => {
      let backlog = false
      let failed = false
      try {
        while (!stopped) {
          const full = (await sweep()) === 100
          backlog ||= full
          if (!full || !drainBatches) break
        }
      } catch {
        failed = true
        onError()
      } finally {
        observe?.completed(failed ? 'failed' : 'succeeded', backlog)
        running = undefined
      }
    })()
  }
  const timer = setInterval(tick, 60000)
  timer.unref()
  tick()
  return async () => {
    stopped = true
    clearInterval(timer)
    await running
  }
}
