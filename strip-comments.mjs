import fs from 'node:fs'

const WORD = /[A-Za-z0-9_$]/
const REGEX_KEYWORDS = [
  'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void',
  'instanceof', 'do', 'else', 'yield', 'await',
]

const strip = (src) => {
  const out = []
  const n = src.length
  let i = 0
  let lastSig = ''
  let lastWord = ''
  const stack = [{ kind: 'code', depth: 0 }]

  const push = (ch) => {
    out.push(ch)
    if (!/\s/.test(ch)) {
      lastSig = ch
      lastWord = WORD.test(ch) ? lastWord + ch : ''
    }
  }

  const lineStart = (at) => {
    let k = at
    while (k > 0 && src[k - 1] !== '\n') k--
    return k
  }

  const drop = (start, end) => {
    const ls = lineStart(start)
    let eol = end
    while (eol < n && src[eol] !== '\n') eol++
    const before = /^[ \t]*$/.test(src.slice(ls, start))
    const after = /^[ \t]*$/.test(src.slice(end, eol))
    if (before && after && eol < n) return eol + 1
    return end
  }

  while (i < n) {
    const top = stack[stack.length - 1]
    const c = src[i]
    const d = src[i + 1]

    if (top.kind === 'template') {
      if (c === '\\') {
        out.push(c, d ?? '')
        i += 2
        continue
      }
      if (c === '`') {
        stack.pop()
        out.push(c)
        i++
        continue
      }
      if (c === '$' && d === '{') {
        out.push('$', '{')
        i += 2
        stack.push({ kind: 'code', depth: 0 })
        continue
      }
      out.push(c)
      i++
      continue
    }

    if (c === '/' && d === '/') {
      let e = i
      while (e < n && src[e] !== '\n') e++
      i = drop(i, e)
      continue
    }

    if (c === '/' && d === '*') {
      let e = i + 2
      while (e < n && !(src[e] === '*' && src[e + 1] === '/')) e++
      e = Math.min(n, e + 2)
      i = drop(i, e)
      continue
    }

    if (c === '"' || c === "'") {
      push(c)
      i++
      while (i < n) {
        if (src[i] === '\\') {
          push(src[i])
          i++
          if (i < n) push(src[i])
          i++
          continue
        }
        push(src[i])
        if (src[i] === c) {
          i++
          break
        }
        i++
      }
      continue
    }

    if (c === '`') {
      stack.push({ kind: 'template' })
      push(c)
      i++
      continue
    }

    if (c === '{') {
      top.depth++
      push(c)
      i++
      continue
    }

    if (c === '}') {
      if (top.depth === 0 && stack.length > 1) {
        stack.pop()
        out.push(c)
        i++
        continue
      }
      top.depth--
      push(c)
      i++
      continue
    }

    if (c === '/') {
      const regexOk =
        lastSig === '' ||
        '([{,;:=!&|?+-*%^~<>'.includes(lastSig) ||
        REGEX_KEYWORDS.includes(lastWord)
      if (regexOk) {
        push(c)
        i++
        let inClass = false
        while (i < n) {
          const e = src[i]
          if (e === '\\') {
            push(e)
            i++
            if (i < n) push(src[i])
            i++
            continue
          }
          if (e === '[') inClass = true
          else if (e === ']') inClass = false
          push(e)
          i++
          if (e === '\n') break
          if (e === '/' && !inClass) break
        }
        continue
      }
    }

    push(c)
    i++
  }

  return out
    .join('')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
}

let before = 0
let after = 0
for (const f of process.argv.slice(2)) {
  const text = fs.readFileSync(f, 'utf8')
  const next = strip(text)
  if (next === text) continue
  fs.writeFileSync(f, next)
  const b = text.split('\n').length
  const a = next.split('\n').length
  before += b
  after += a
  console.log(`${f}  ${b} → ${a}`)
}
console.log(`total ${before} → ${after}`)
