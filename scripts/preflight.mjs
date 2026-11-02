#!/usr/bin/env node
// Release preflight: everything that is cheap to check here is expensive to
// discover after publishing. Run with `npm run preflight`.
//
// Exit code 0 = publishable. Non-zero = fix the ✗ lines first.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const warnings = []

const ok = (message) => console.log(`  ✓ ${message}`)
const bad = (message) => { failures.push(message); console.log(`  ✗ ${message}`) }
const warn = (message) => { warnings.push(message); console.log(`  ! ${message}`) }

function section(title) {
  console.log(`\n${title}`)
}

// ── manifest ────────────────────────────────────────────────────────────────
section('manifest')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

if (/^\d+\.\d+\.\d+$/.test(manifest.version)) ok(`version ${manifest.version}`)
else bad(`version "${manifest.version}" is not a plain x.y.z semver`)

for (const field of ['author', 'homepage', 'repository', 'bugs']) {
  const value = typeof manifest[field] === 'string' ? manifest[field] : JSON.stringify(manifest[field] ?? '')
  if (value.includes('TODO')) bad(`${field} still contains the TODO placeholder`)
  else ok(`${field} filled in`)
}

if (manifest.os?.includes('darwin')) ok('os is darwin-only')
else bad('package.json must declare "os": ["darwin"]')

const required = ['lib', 'native/bin/dsh-audio-rail-tap', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE']
const missing = required.filter((entry) => !manifest.files?.includes(entry))
if (missing.length === 0) ok(`files covers all ${required.length} required entries`)
else bad(`files is missing: ${missing.join(', ')}`)

// ── native binary ───────────────────────────────────────────────────────────
section('native binary')
const binary = join(ROOT, 'native', 'bin', 'dsh-audio-rail-tap')
if (!existsSync(binary)) {
  bad('native/bin/dsh-audio-rail-tap is missing — run `npm run build:native`')
} else {
  if (statSync(binary).mode & 0o111) ok('binary is executable')
  else bad('binary is not executable (chmod +x)')

  let arch = ''
  try {
    arch = execFileSync('lipo', ['-info', binary], { encoding: 'utf8' })
  } catch {
    bad('lipo could not read the binary')
  }
  const universal = arch.includes('arm64') && arch.includes('x86_64')
  if (universal) ok('binary is universal (arm64 + x86_64)')
  else bad(`binary is not universal: ${arch.trim() || 'unknown'}`)
}

// ── sources ─────────────────────────────────────────────────────────────────
section('sources')
for (const entry of ['lib/index.js', 'lib/client.js']) {
  const path = join(ROOT, entry)
  if (!existsSync(path)) { bad(`${entry} missing`); continue }
  try {
    execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' })
    ok(`${entry} parses`)
  } catch (error) {
    bad(`${entry} has a syntax error: ${String(error).slice(0, 200)}`)
  }
}

const patch = join(ROOT, 'cordis.patch.yml')
if (existsSync(patch)) {
  const text = readFileSync(patch, 'utf8')
  if (text.includes(manifest.name)) ok('cordis.patch.yml references the package name')
  else bad('cordis.patch.yml does not mention the package name')
} else {
  bad('cordis.patch.yml missing')
}

// ── docs ────────────────────────────────────────────────────────────────────
section('docs')
const readme = existsSync(join(ROOT, 'README.md')) ? readFileSync(join(ROOT, 'README.md'), 'utf8') : ''
if (readme.length > 500) ok('README present')
else bad('README is missing or too thin')

if (readme.includes('Credits')) ok('README keeps the Credits section')
else warn('README has no Credits section — double-check the MIT attributions')

const changelog = existsSync(join(ROOT, 'CHANGELOG.md')) ? readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8') : ''
if (changelog.includes(manifest.version)) ok(`CHANGELOG mentions ${manifest.version}`)
else bad(`CHANGELOG does not mention version ${manifest.version}`)

// ── registry (best effort, network) ─────────────────────────────────────────
section('registry')
try {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(manifest.name)}`, {
    signal: AbortSignal.timeout(8_000),
  })
  if (response.status === 404) ok(`name "${manifest.name}" is free on npm`)
  else if (response.ok) {
    const published = await response.json()
    warn(`"${manifest.name}" already exists on npm (latest ${published['dist-tags']?.latest ?? '?'}) — publishing will need to be an update, or pick another name`)
  } else {
    warn(`registry check returned HTTP ${response.status}`)
  }
} catch {
  warn('registry check skipped (offline or npm unreachable)')
}

// ── verdict ─────────────────────────────────────────────────────────────────
console.log('')
if (failures.length > 0) {
  console.log(`✗ ${failures.length} blocking issue(s):`)
  for (const item of failures) console.log(`   - ${item}`)
}
if (warnings.length > 0) {
  console.log(`! ${warnings.length} warning(s):`)
  for (const item of warnings) console.log(`   - ${item}`)
}
if (failures.length === 0) console.log('✓ ready to publish')

process.exit(failures.length === 0 ? 0 : 1)
