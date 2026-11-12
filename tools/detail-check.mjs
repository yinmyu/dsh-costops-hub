/**
 * Detail-page resource check (no browser).
 *
 * The Plugin Manager shows `meta.detail` from the locale file and the one image
 * the document references. This suite checks what the page will read, mirroring
 * the Host's rules: a relative Markdown path inside the package, a document of
 * one image line with meaningful alternative text, and a self-contained SVG
 * that stays within the size limits.
 *
 * Run: node tools/detail-check.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const IMAGE_TYPES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg'])
const DOC_LIMIT = 1024 * 1024
const IMAGE_LIMIT = 5 * 1024 * 1024

const checks = []
function check(name, fn) {
  checks.push({ name, fn })
}

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), 'utf8'))
}

const manifest = readJson('package.json')

for (const locale of ['en', 'zh']) {
  check(`locale/${locale}.json declares a detail document that exists`, () => {
    const meta = readJson(`locale/${locale}.json`).meta
    assert.ok(typeof meta.title === 'string' && meta.title.trim() !== '', 'title')
    assert.ok(typeof meta.description === 'string' && meta.description.length > 40, 'description explains the capability')
    assert.ok(!/(工具调用|plugin row|README)/u.test(meta.description), 'description stays user-facing')
    const detail = meta.detail
    assert.equal(typeof detail, 'string', 'meta.detail')
    assert.ok(!detail.includes('\\') && !/^[A-Za-z][A-Za-z\d+.-]*:/u.test(detail), 'relative path')
    assert.ok(detail.split('/').every((part) => part !== '' && part !== '.' && part !== '..'), 'inside the package')
    assert.match(detail, /\.(?:md|markdown)$/iu)
    const path = join(root, detail)
    const size = statSync(path).size
    assert.ok(size > 0 && size <= DOC_LIMIT, `document size ${size}`)
  })
}

check('each detail document is exactly one image line with alt text', () => {
  for (const locale of ['en', 'zh']) {
    const detail = readJson(`locale/${locale}.json`).meta.detail
    const markdown = readFileSync(join(root, detail), 'utf8').trim()
    const lines = markdown.split('\n').filter((line) => line.trim() !== '')
    assert.equal(lines.length, 1, `${detail} has ${lines.length} lines`)
    const match = /^!\[(.+)\]\(([^)\s]+)\)$/u.exec(lines[0])
    assert.ok(match !== null, `${detail} is one image line`)
    assert.ok(match[1].length >= 20, `${detail} has meaningful alt text`)
  }
})

check('the image resolves beside the document and is a supported type', () => {
  for (const locale of ['en', 'zh']) {
    const detail = readJson(`locale/${locale}.json`).meta.detail
    const markdown = readFileSync(join(root, detail), 'utf8').trim()
    const match = /^!\[(.+)\]\(([^)\s]+)\)$/u.exec(markdown)
    const authored = match[2]
    assert.ok(!authored.includes('\\'), 'no backslashes')
    const imagePath = posix.normalize(posix.join(posix.dirname(detail), authored))
    assert.ok(!imagePath.startsWith('../') && !posix.isAbsolute(imagePath), 'image inside the package')
    const extension = posix.extname(imagePath).toLowerCase()
    assert.ok(IMAGE_TYPES.has(extension), `supported type (${extension})`)
    const size = statSync(join(root, imagePath)).size
    assert.ok(size > 0 && size <= IMAGE_LIMIT, `image size ${size}`)
  }
})

check('the SVG is self-contained and readable in both themes', () => {
  const svg = readFileSync(join(root, 'docs/preview.svg'), 'utf8')
  assert.match(svg, /width="640" height="300"/u)
  assert.doesNotMatch(svg, /<text[\s>]/u, 'no text elements')
  assert.doesNotMatch(svg, /font-family|<script|xlink:href/u, 'no fonts, scripts, or xlink references')
  // The xmlns declaration is the one allowed absolute URL.
  assert.doesNotMatch(svg, /(?:href|src|url)\s*[=(]\s*["']?[a-z]+:/iu, 'no remote references')
  assert.doesNotMatch(svg, /<foreignObject/u)
  assert.match(svg, /<title>[^<]+<\/title>/u, 'an accessible title')
  assert.doesNotMatch(svg, /fill="#fff(?:fff)?"/iu, 'no theme-baked white panels')
})

check('the manifest ships the detail resources', () => {
  const files = manifest.files
  assert.ok(files.includes('docs'), 'docs directory is packaged')
  for (const path of ['docs/DETAIL.md', 'docs/DETAIL.zh.md', 'docs/preview.svg']) {
    assert.ok(statSync(join(root, path)).isFile(), path)
  }
})

let failed = 0
for (const { name, fn } of checks) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}`)
    console.log(`     ${error instanceof Error ? error.message : String(error)}`)
  }
}
console.log(`\n${checks.length - failed}/${checks.length} detail checks passed`)
process.exit(failed === 0 ? 0 : 1)
