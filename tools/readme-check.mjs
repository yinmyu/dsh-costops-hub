/**
 * README check: every relative link and image must resolve, and every table of
 * contents anchor must match a heading.
 *
 * GitHub renders Markdown from the repository root, so a broken `docs/x.png`
 * or a stale `#anchor` is only visible after the push. This suite catches both
 * before the push, for both READMEs.
 *
 * Run: node tools/readme-check.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const DOCUMENTS = ['README.md', 'README.zh.md']

/** GitHub's heading slugger: lowercase, keep letters/digits/CJK/space/hyphen. */
function slug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/gu, '')
    .replace(/[`*_~]/gu, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/[^\p{Letter}\p{Number}\u4e00-\u9fff \-_]/gu, '')
    .replace(/ /gu, '-')
}

function headings(markdown) {
  const found = []
  let fenced = false
  for (const line of markdown.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const match = /^(#{1,6})\s+(.*)$/u.exec(line)
    if (match === null) continue
    found.push(slug(match[2]))
  }
  return found
}

function destinations(markdown) {
  const links = []
  let fenced = false
  for (const line of markdown.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    // Markdown links/images and the raw HTML the centered headers use.
    const patterns = [/!?\[[^\]]*\]\(([^)\s]+)\)/gu, /(?:href|src)="([^"]+)"/gu]
    for (const pattern of patterns) {
      let match
      while ((match = pattern.exec(line)) !== null) links.push(match[1])
    }
  }
  return links
}

const checks = []
function check(name, fn) {
  checks.push({ name, fn })
}

for (const document of DOCUMENTS) {
  const path = join(root, document)
  const markdown = readFileSync(path, 'utf8')
  const slugs = headings(markdown)

  check(`${document} links to the other language`, () => {
    const other = document === 'README.md' ? 'README.zh.md' : 'README.md'
    assert.ok(destinations(markdown).includes(other), `missing link to ${other}`)
    assert.ok(existsSync(join(root, other)), `${other} exists`)
  })

  check(`${document} relative links and images resolve`, () => {
    const broken = []
    for (const target of destinations(markdown)) {
      if (/^(?:https?:|mailto:|#)/u.test(target)) continue
      const [file] = target.split('#')
      if (file === '') continue
      const resolved = posix.normalize(file)
      assert.ok(!resolved.startsWith('../'), `link leaves the repository: ${file}`)
      if (!existsSync(join(root, resolved))) broken.push(file)
    }
    assert.deepEqual(broken, [], `broken: ${broken.join(', ')}`)
  })

  check(`${document} table-of-contents anchors resolve`, () => {
    const anchors = destinations(markdown).filter((target) => target.startsWith('#')).map((target) => target.slice(1))
    const missing = anchors.filter((anchor) => slugs.includes(anchor) === false)
    assert.deepEqual(missing, [], `missing anchors: ${missing.join(', ')}`)
  })

  check(`${document} has the expected sections`, () => {
    for (const required of ['为什么', '接口', '安装', '价格', '许可证']) {
      if (document === 'README.zh.md') {
        assert.ok(markdown.includes(required), `missing section: ${required}`)
      }
    }
    assert.ok(slugs.length >= 10, `only ${slugs.length} headings`)
    assert.ok(markdown.includes('docs/screenshot-bill.png'), 'hero screenshot')
  })
}

check('the language switchers point at each other', () => {
  const en = readFileSync(join(root, 'README.md'), 'utf8')
  const zh = readFileSync(join(root, 'README.zh.md'), 'utf8')
  const linked = (markdown, file) => markdown.includes(`href="${file}"`) || markdown.includes(`](${file})`)
  assert.ok(linked(en, 'README.zh.md'), 'English page links to Chinese')
  assert.ok(linked(zh, 'README.md'), 'Chinese page links to English')
})

check('every screenshot referenced by the docs exists', () => {
  const names = new Set()
  for (const document of DOCUMENTS) {
    for (const target of destinations(readFileSync(join(root, document), 'utf8'))) {
      if (target.startsWith('docs/')) names.add(target)
    }
  }
  assert.ok(names.size >= 5, `only ${names.size} docs assets referenced`)
  for (const name of names) assert.ok(existsSync(join(root, name)), name)
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
console.log(`\n${checks.length - failed}/${checks.length} README checks passed`)
process.exit(failed === 0 ? 0 : 1)
