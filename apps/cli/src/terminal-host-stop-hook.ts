/** Deliver a private supervisor stop signal through Node IPC on Windows and POSIX. @module @deepseek-ai/dsh/terminal-host-stop-hook */

process.on('message', (message: unknown) => {
  if (message !== 'ds-cli-terminal-stop') return
  process.emit('SIGTERM', 'SIGTERM')
})
