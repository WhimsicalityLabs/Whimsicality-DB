// Clean-install release check: pack, install in temp dir, spawn bin, verify.
// Run: node scripts/release-check.mjs
// Exits 0 on success, 1 on failure.

import { spawn } from 'node:child_process'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = process.cwd()
const TIMEOUT = 30000

function run(cmd, args, opts = {}) {
  const fullCmd = `${cmd} ${args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ')}`
  const stdout = execSync(fullCmd, { maxBuffer: 10 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...opts })
  return stdout?.toString() ?? ''
}

async function main() {
  console.log('1. Building...')
  run('npm', ['run', 'build'], { cwd: ROOT })

  console.log('2. Packing...')
  const packOutput = run('npm', ['pack'], { cwd: ROOT })
  const tarballMatch = packOutput.match(/^([^\s]+\.tgz)$/m)
  if (!tarballMatch) throw new Error('Could not find tarball name in npm pack output')
  const tarball = tarballMatch[1]
  const tarballPath = join(ROOT, tarball)
  if (!existsSync(tarballPath)) throw new Error(`Tarball not found: ${tarballPath}`)
  console.log(`   Created: ${tarball}`)

  const installDir = mkdtempSync(join(tmpdir(), 'whim-release-'))
  const storageDir = mkdtempSync(join(tmpdir(), 'whim-release-storage-'))
  let tarballCleaned = false
  try {
    console.log(`3. Installing in clean dir: ${installDir}`)
    run('npm', ['init', '-y'], { cwd: installDir })
    const localTarball = join(installDir, tarball)
    copyFileSync(tarballPath, localTarball)
    run('npm', ['install', `./${tarball}`], { cwd: installDir })

    const binPath = join(installDir, 'node_modules', 'whimsicality-db', 'bin', 'whimsicality-db.js')
    if (!existsSync(binPath)) throw new Error(`Binary not found at ${binPath}`)
    console.log('   Installed successfully.')

    console.log('4. Spawning bin and testing initialize + tools/list + tools/call...')
    const child = spawn('node', [binPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: installDir,
      env: { ...process.env, WHIMSICALITY_DB_DIR: storageDir },
    })

    child.on('error', () => {})
    child.stdin?.on('error', () => {})

    await new Promise((resolve, reject) => {
      let buf = ''
      let stderrBuf = ''
      let nextId = 1
      const results = {}
      let done = false

      const finish = (success) => {
        if (done) return
        done = true
        clearTimeout(timer)
        try { child.stdin?.end() } catch {}
        try { child.kill() } catch {}
        if (success) {
          try {
            verify(results)
            resolve()
          } catch (e) { reject(e) }
        } else {
          reject(new Error('verification failed'))
        }
      }

      const send = (method, params) => {
        const id = nextId++
        try { child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') } catch {}
        return id
      }

      const timer = setTimeout(() => {
        if (done) return
        done = true
        try { child.kill() } catch {}
        const errMsg = 'Timed out waiting for responses' + (stderrBuf ? `\nstderr: ${stderrBuf}` : '') + (buf ? `\nstdout: ${buf}` : '')
        reject(new Error(errMsg))
      }, TIMEOUT)

      child.stdout.on('data', (d) => {
        buf += d.toString()
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const m = JSON.parse(line)
            if (m.id !== undefined) results[m.id] = m
            if (Object.keys(results).length >= 3) finish(true)
          } catch {}
        }
      })

      child.stderr.on('data', (d) => { stderrBuf += d.toString() })
      child.on('exit', (code) => {
        if (!done) {
          done = true
          clearTimeout(timer)
          const errMsg = `child exited with code ${code} before all responses received` + (stderrBuf ? `\nstderr: ${stderrBuf}` : '') + (buf ? `\nstdout: ${buf}` : '')
          reject(new Error(errMsg))
        }
      })

      send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'release-check', version: '1.0' } })
      send('tools/list', {})
      send('tools/call', { name: 'db_memory_set', arguments: { key: 'release-test', value: 'clean install works' } })
    })
  } finally {
    try { rmSync(installDir, { recursive: true, force: true }) } catch {}
    try { rmSync(storageDir, { recursive: true, force: true }) } catch {}
    if (!tarballCleaned) { try { rmSync(join(ROOT, tarball), { force: true }) } catch {} }
  }
}

function verify(results) {
  const init = results[1]
  if (!init?.result?.serverInfo) throw new Error('initialize failed')
  console.log(`   initialize: ${init.result.serverInfo.name}@${init.result.serverInfo.version}`)

  const list = results[2]
  const tools = list?.result?.tools ?? []
  if (tools.length !== 21) throw new Error(`Expected 21 tools, got ${tools.length}`)
  console.log(`   tools/list: ${tools.length} tools`)

  const call = results[3]
  if (call?.result?.isError) throw new Error('tools/call returned error')
  const callText = call?.result?.content?.[0]?.text ?? ''
  if (!callText.includes('stored')) throw new Error('tools/call did not store memory')
  console.log('   tools/call: memory stored successfully')

  console.log('\nAll checks passed.')
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('FAIL:', err.message)
  process.exit(1)
})
