/** Ediciones de texto Markdown como funciones puras: reciben el texto y la selección, y dicen qué cambiar. */

export type Edit = { start: number; end: number; text: string; selStart: number; selEnd: number }

export type Block = 'heading' | 'bullet' | 'number' | 'task' | 'quote'

const BLOCK_PREFIX = /^(\s*)(#{1,6} |[-*+] \[[ xX]\] |[-*+] |\d+\. |> )?/
const LIST_LINE = /^(\s*)([-*+] \[[ xX]\] |[-*+] |\d+\. |> )(.*)$/

function lineRange(value: string, start: number, end: number) {
  const from = value.lastIndexOf('\n', start - 1) + 1
  // Una selección que acaba justo al empezar una línea no incluye esa línea.
  const last = end > start && value[end - 1] === '\n' ? end - 1 : end
  const next = value.indexOf('\n', last)
  return { from, to: next === -1 ? value.length : next }
}

/** Negrita, cursiva o código en línea. Si el texto ya lo tiene, se lo quita. */
export function toggleInline(value: string, start: number, end: number, mark: string, placeholder: string): Edit {
  // Los espacios de los extremos quedan fuera: `**texto **` no sería negrita en Markdown.
  const selected = value.slice(start, end)
  const from = start + (selected.length - selected.trimStart().length)
  const to = from + selected.trim().length
  const inner = value.slice(from, to)
  const n = mark.length

  if (inner.length >= n * 2 && inner.startsWith(mark) && inner.endsWith(mark)) {
    const text = inner.slice(n, -n)
    return { start: from, end: to, text, selStart: from, selEnd: from + text.length }
  }
  const around = value.slice(from - n, from) === mark && value.slice(to, to + n) === mark
  // Un `*` junto a otro `*` es parte de una negrita, no una cursiva.
  const isBold = n === 1 && (value[from - n - 1] === mark || value[to + n] === mark)
  if (from >= n && around && !isBold) {
    return { start: from - n, end: to + n, text: inner, selStart: from - n, selEnd: to - n }
  }
  const text = inner || placeholder
  return { start: from, end: to, text: mark + text + mark, selStart: from + n, selEnd: from + n + text.length }
}

/** Título, lista o cita en las líneas seleccionadas. Si ya lo son, vuelven a ser texto normal. */
export function toggleBlock(value: string, start: number, end: number, block: Block): Edit {
  const { from, to } = lineRange(value, start, end)
  const lines = value.slice(from, to).split('\n')
  const matches = (prefix: string) => {
    if (block === 'heading') return prefix.startsWith('#')
    if (block === 'quote') return prefix === '> '
    if (block === 'number') return /^\d/.test(prefix)
    if (block === 'task') return /\[/.test(prefix)
    return /^[-*+] $/.test(prefix)
  }
  const parts = lines.map((line) => {
    const m = line.match(BLOCK_PREFIX)!
    return { indent: m[1], prefix: m[2] ?? '', rest: line.slice(m[0].length) }
  })
  const filled = parts.filter((p) => p.rest.trim() || p.prefix)
  const remove = filled.length > 0 && filled.every((p) => matches(p.prefix))

  let n = 0
  const text = parts
    .map((p) => {
      if (!p.rest.trim() && !p.prefix && lines.length > 1) return ''
      if (remove) return p.indent + p.rest
      n++
      const prefix = { heading: '## ', bullet: '- ', number: `${n}. `, task: '- [ ] ', quote: '> ' }[block]
      return p.indent + prefix + p.rest
    })
    .join('\n')
  const single = lines.length === 1
  return { start: from, end: to, text, selStart: single ? from + text.length : from, selEnd: from + text.length }
}

export function insertLink(value: string, start: number, end: number): Edit {
  const selected = value.slice(start, end)
  if (/^https?:\/\/\S+$/.test(selected)) {
    const text = `[texto](${selected})`
    return { start, end, text, selStart: start + 1, selEnd: start + 6 }
  }
  const label = selected || 'texto'
  const text = `[${label}](https://)`
  const url = start + label.length + 3
  return selected
    ? { start, end, text, selStart: url, selEnd: url + 'https://'.length }
    : { start, end, text, selStart: start + 1, selEnd: start + 1 + label.length }
}

/** Código en línea o, si la selección tiene varias líneas, un bloque de código. */
export function toggleCode(value: string, start: number, end: number): Edit {
  const selected = value.slice(start, end)
  if (!selected.includes('\n')) return toggleInline(value, start, end, '`', 'código')
  const text = '```\n' + selected.replace(/\n$/, '') + '\n```'
  return { start, end, text, selStart: start, selEnd: start + text.length }
}

/** Enter dentro de una lista: sigue la lista; en un elemento vacío, la termina. Null si no aplica. */
export function continueList(value: string, pos: number): Edit | null {
  const { from, to } = lineRange(value, pos, pos)
  const m = value.slice(from, to).match(LIST_LINE)
  if (!m) return null
  const [, indent, prefix, rest] = m
  if (pos < from + indent.length + prefix.length) return null
  if (!rest.trim()) return { start: from, end: to, text: '', selStart: from, selEnd: from }
  const number = prefix.match(/^(\d+)\. $/)
  const next = number ? `${Number(number[1]) + 1}. ` : prefix.includes('[') ? '- [ ] ' : prefix
  const text = `\n${indent}${next}`
  return { start: pos, end: pos, text, selStart: pos + text.length, selEnd: pos + text.length }
}

/**
 * Tab en una lista: anida o desanida los elementos. Null fuera de una lista, para que Tab siga
 * moviendo el foco al campo siguiente (quien usa el teclado no debe quedar atrapado aquí).
 */
export function indentList(value: string, start: number, end: number, outdent: boolean): Edit | null {
  const { from, to } = lineRange(value, start, end)
  const lines = value.slice(from, to).split('\n')
  if (!lines.every((l) => !l.trim() || LIST_LINE.test(l))) return null
  const text = lines.map((l) => (!l.trim() ? l : outdent ? l.replace(/^ {1,2}/, '') : `  ${l}`)).join('\n')
  if (text === value.slice(from, to) && outdent) return { start: from, end: to, text, selStart: start, selEnd: end }
  const delta = text.split('\n')[0].length - lines[0].length
  const selStart = Math.max(from, start + delta)
  return { start: from, end: to, text, selStart, selEnd: start === end ? selStart : from + text.length }
}
