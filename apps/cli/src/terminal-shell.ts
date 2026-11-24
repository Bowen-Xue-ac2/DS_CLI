/** Stream one official user shell attachment through the physical terminal. @module @deepseek-ai/dsh/terminal-shell */
import { StringDecoder } from 'node:string_decoder'
import { addAbortListener } from 'node:events'
import type { TerminalHost } from './terminal-host.ts'
import type { TerminalShellInput } from './terminal-automation-remote.ts'

type Input = TerminalShellInput extends infer Action
  ? Action extends TerminalShellInput ? Omit<Action, 'sequence'> : never
  : never

/** Detaching closes only the stream. The Host keeps the actual shell and bounded screen. */
export async function streamTerminalShell(host: TerminalHost, sessionId: string, id: string): Promise<void> {
  const lifetime = new AbortController()
  const signal = AbortSignal.any([host.signal, lifetime.signal])
  const { stdin, stdout } = process
  const decoder = new StringDecoder('utf8')
  const queued: Input[] = []
  const stream = host.remote.terminal.attach(sessionId, id, signal)
  const frames = stream[Symbol.asyncIterator]()
  let sequence = 0
  let acknowledged = 0
  let accepting = false
  let inputFailure: unknown
  const flush = (): void => {
    if (!accepting || signal.aborted || acknowledged !== sequence) return
    const next = queued.shift()
    if (next === undefined) return
    try { stream.send({ ...next, sequence: ++sequence }) } catch (error) {
      inputFailure = error
      lifetime.abort(error)
    }
  }
  const enqueue = (input: Input): void => {
    if (!accepting || signal.aborted) return
    if (queued.length >= 64) {
      inputFailure = new Error('Shell input exceeded the terminal buffer')
      lifetime.abort(inputFailure)
      return
    }
    queued.push(input)
    flush()
  }
  let pendingTilde = ''
  let pendingSequence = ''
  let pendingOutput = ''
  let sequenceTimer: ReturnType<typeof setTimeout> | undefined
  const writeOutput = (data: string): void => {
    const raw = pendingOutput + data
    pendingOutput = /\x1b(?:\[\??[\d;]{0,48})?$/u.exec(raw)?.[0] ?? ''
    // Browser terminals ignore the Win32 keyboard-mode request sent by a
    // nested ConPTY. Leave the outer CLI's keyboard encoding unchanged too.
    const text = raw.slice(0, raw.length - pendingOutput.length).replace(/\x1b\[\?9001[hl]/gu, '')
    stdout.write(text)
  }
  const type = (text: string): void => {
    const characters = Array.from(text)
    for (let at = 0; at < characters.length; at += 1024) {
      enqueue({ type: 'write', data: characters.slice(at, at + 1024).join(''), typed: true })
    }
  }
  const handleKeys = (raw: string): void => {
    const typed = raw.replace(/\x1b\[\d+;\d+;(\d+);([01]);\d+;\d+_/gu,
      (_packet, character: string, down: string) => down === '1' && Number(character) > 0 ? String.fromCharCode(Number(character)) : '')
    const text = (pendingTilde === '' ? '' : '~') + typed
    const bytes = pendingTilde + raw
    pendingTilde = text === '~' && bytes.length < 1_024 ? bytes : ''
    if (pendingTilde !== '') return
    if (text === '~.' || text.includes('\x07') || text.includes('\x1d')) {
      lifetime.abort()
      return
    }
    type(bytes)
  }
  const key = (data: Buffer | string): void => {
    clearTimeout(sequenceTimer)
    const raw = pendingSequence + (typeof data === 'string' ? data : decoder.write(data))
    // Windows ConPTY may divide a Win32 input packet across reads. Keep the
    // original bytes when forwarding keys, including the modifier transitions.
    pendingSequence = /\x1b(?:\[[\d;]{0,48})?$/u.exec(raw)?.[0] ?? ''
    handleKeys(raw.slice(0, raw.length - pendingSequence.length))
    if (pendingSequence !== '') sequenceTimer = setTimeout(() => {
      handleKeys(pendingSequence)
      pendingSequence = ''
    }, 60)
  }
  const resize = (): void => { enqueue({ type: 'resize', cols: stdout.columns || 80, rows: stdout.rows || 24 }) }
  const read = (): void => {
    while (!signal.aborted) {
      const chunk: unknown = stdin.read()
      if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) break
      key(chunk)
    }
  }
  const raw = stdin.isRaw
  stdin.setRawMode(true)
  stdin.on('readable', read)
  stdin.read(0)
  stdout.on('resize', resize)
  stdout.write('\x1b[?1049h\x1b[2J\x1b[HAttaching shell. Type ~. to return to chat.\r\n')
  try {
    while (!signal.aborted) {
      const detached = Promise.withResolvers<null>()
      const abort = addAbortListener(signal, () => { detached.resolve(null) })
      const next = await Promise.race([frames.next(), detached.promise]).finally(() => { abort[Symbol.dispose]() })
      if (next === null || next.done === true) break
      const frame = next.value
      if (frame.type === 'snapshot') {
        accepting = frame.writable
        writeOutput(frame.screen)
        if (frame.info.state !== 'running') break
        resize()
      } else if (frame.type === 'output') {
        writeOutput(frame.data)
      } else if (frame.type === 'ack') {
        acknowledged = frame.sequence
        if (frame.refusal !== undefined) stdout.write(`\r\nShell input refused: ${frame.refusal}\r\n`)
        flush()
      } else {
        accepting = frame.writable
        if (frame.info.state !== 'running') break
      }
    }
  } catch (error) {
    if (!signal.aborted) throw error
  } finally {
    lifetime.abort()
    clearTimeout(sequenceTimer)
    void frames.return?.().catch(() => {})
    stdin.off('readable', read)
    stdout.off('resize', resize)
    stdin.setRawMode(raw)
    // The remote shell can change input encoding and paste mode in the
    // physical terminal. Restore the chat's VT input before remounting Ink.
    stdout.write('\x1b[?9001l\x1b[?2004l\x1b[?1004l\x1b[0m\x1b[?25h\x1b[?1049l')
  }
  if (inputFailure !== undefined) throw inputFailure
}
