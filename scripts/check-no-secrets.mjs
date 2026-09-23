#!/usr/bin/env node
// Build gate: the packaged app is uploaded to the Even Hub portal, so dist/ must
// never contain a sign-in bundle or any token from .secrets/.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const SECRETS = join(ROOT, '.secrets')

const needles = []
if (existsSync(SECRETS)) {
  for (const file of readdirSync(SECRETS).filter(f => f.endsWith('.json'))) {
    const json = JSON.parse(readFileSync(join(SECRETS, file), 'utf8'))
    for (const key of ['refreshToken', 'accessToken', 'client_id', 'clientId']) {
      if (typeof json[key] === 'string' && json[key].length >= 8) needles.push(json[key])
    }
  }
}

const files = []
const walk = dir => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path)
    else files.push(path)
  }
}
if (!existsSync(DIST)) {
  console.error('check-no-secrets: dist/ not found, run the build first')
  process.exit(1)
}
walk(DIST)

const problems = []
for (const path of files) {
  const text = readFileSync(path, 'latin1')
  if (/es1\.[A-Za-z0-9_-]{24,}/.test(text)) problems.push(`${path}: contains a sign-in bundle`)
  for (const needle of needles) if (text.includes(needle)) problems.push(`${path}: contains a value from .secrets/`)
}

if (problems.length) {
  console.error(`✗ Secrets found in the build output:\n  ${[...new Set(problems)].join('\n  ')}`)
  console.error('  Sign-in bundles belong in .env.development.local (dev server only), never in .env or .env.local.')
  process.exit(1)
}
console.log(`✓ No secrets in dist/ (${files.length} files checked)`)
