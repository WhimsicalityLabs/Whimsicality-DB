import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'

interface RpcResponse {
  id?: number
  result?: { serverInfo?: { name: string; version: string }; capabilities?: unknown; tools?: { name: string; annotations?: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }[] } }
  error?: unknown
}

class BinProcess {
  private readonly child: ChildProcess
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: RpcResponse) => void; reject: (error: Error) => void }>()
  private stderr = ''

  constructor(storageDir: string) {
    this.child = spawn('node', ['bin/whimsicality-db.js'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, WHIMSICALITY_DB_DIR: storageDir },
    })
    this.child.stdout?.on('data', (data: Buffer) => {
      this.buffer += data.toString()
      const lines = this.buffer.split('\n')
      this.buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line) as RpcResponse & { jsonrpc: string; method?: string }
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const handler = this.pending.get(msg.id)!
            this.pending.delete(msg.id)
            handler.resolve(msg)
          }
        } catch { }
      }
    })
    this.child.stderr?.on('data', (data: Buffer) => { this.stderr += data.toString() })
  }

  async call(method: string, params: unknown): Promise<RpcResponse> {
    const id = this.nextId++
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`no response within 10s. stderr: ${this.stderr}`))
      }, 10000)
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timeout); resolve(r) },
        reject: (e) => { clearTimeout(timeout); reject(e) },
      })
      this.child.stdin?.write(msg + '\n')
    })
  }

  async stopAndWait(): Promise<void> {
    if (this.child.killed || this.child.exitCode !== null) return
    try { this.child.stdin?.end() } catch { }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { this.child.kill() } catch { }
        setTimeout(resolve, 500)
      }, 8000)
      this.child.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
}

describe('bin smoke test — actual entry point', () => {
  let dir: string
  let proc: BinProcess

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'whim-db-smoke-'))
    proc = new BinProcess(dir)
  })

  afterEach(async () => {
    await proc.stopAndWait()
    try { rmSync(dir, { recursive: true, force: true }) } catch { }
  })

  it('responds to initialize via bin/whimsicality-db.js', async () => {
    const response = await proc.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '1.0' },
    })
    expect(response.result?.serverInfo?.name).toBe('whimsicality-db')
    expect(response.result?.serverInfo?.version).toBe('0.3.0')
  })

  it('responds to tools/list with 21 annotated tools', async () => {
    await proc.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '1.0' },
    })
    const response = await proc.call('tools/list', {})
    const tools = response.result?.tools ?? []
    expect(tools.length).toBe(21)
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBeDefined()
      expect(tool.annotations?.destructiveHint).toBeDefined()
      expect(tool.annotations?.idempotentHint).toBeDefined()
      expect(tool.annotations?.openWorldHint).toBeDefined()
    }
  })

  it('handles a full request cycle: init → tools/call → response', async () => {
    await proc.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '1.0' },
    })
    const setResponse = await proc.call('tools/call', { name: 'db_memory_set', arguments: { key: 'smoke', value: 'bin entry point works' } })
    expect(setResponse.result).toBeDefined()
    const getResponse = await proc.call('tools/call', { name: 'db_memory_get', arguments: { key: 'smoke' } }) as RpcResponse & { result?: { content?: { text: string }[] } }
    const text = getResponse.result?.content?.[0]?.text ?? ''
    expect(text).toContain('bin entry point works')
  })
})
