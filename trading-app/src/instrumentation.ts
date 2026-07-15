// Next.js instrumentation hook — runs once when the server boots.
// Starts the real-time trade-scoring worker (no-op without its secrets).
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startScoreWorker } = await import('./server/scoreWorker')
    startScoreWorker()
  }
}
