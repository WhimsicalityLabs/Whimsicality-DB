#!/usr/bin/env node
import('../lib/index.js').catch((error) => {
  process.stderr.write(`whimsicality-db: failed to start.\n${error instanceof Error ? error.message : String(error)}\n\nDid you run \`npm run build\` first?\n`)
  process.exit(1)
})
