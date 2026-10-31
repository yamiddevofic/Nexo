import { describe, expect, it } from 'vitest'
import { continueList, indentList, insertLink, toggleBlock, toggleCode, toggleInline, type Edit } from './markdownEdit'

const run = (value: string, e: Edit | null) => (e ? value.slice(0, e.start) + e.text + value.slice(e.end) : value)

describe('formato en línea', () => {
  it('envuelve la selección y deja los espacios fuera', () => {
    expect(run('una idea clara', toggleInline('una idea clara', 4, 9, '**', 'negrita'))).toBe('una **idea** clara')
  })

  it('sin selección inserta un texto de ejemplo ya seleccionado', () => {
    const e = toggleInline('', 0, 0, '**', 'negrita')
    expect(e.text).toBe('**negrita**')
    expect([e.selStart, e.selEnd]).toEqual([2, 9])
  })

  it('quita el formato si ya lo tiene, dentro o fuera de la selección', () => {
    expect(run('**idea**', toggleInline('**idea**', 0, 8, '**', 'x'))).toBe('idea')
    expect(run('**idea**', toggleInline('**idea**', 2, 6, '**', 'x'))).toBe('idea')
  })

  it('no confunde una negrita con una cursiva', () => {
    expect(run('**idea**', toggleInline('**idea**', 2, 6, '*', 'x'))).toBe('***idea***')
  })
})

describe('bloques', () => {
  it('convierte en lista todas las líneas seleccionadas y lo deshace', () => {
    const text = 'uno\ndos'
    const list = run(text, toggleBlock(text, 0, 7, 'bullet'))
    expect(list).toBe('- uno\n- dos')
    expect(run(list, toggleBlock(list, 0, list.length, 'bullet'))).toBe(text)
  })

  it('numera, respeta las líneas en blanco y cambia de un tipo de lista a otro', () => {
    expect(run('a\n\nb', toggleBlock('a\n\nb', 0, 4, 'number'))).toBe('1. a\n\n2. b')
    expect(run('- a', toggleBlock('- a', 1, 1, 'quote'))).toBe('> a')
  })

  it('actúa sobre la línea del cursor aunque no haya selección', () => {
    expect(run('uno\ndos', toggleBlock('uno\ndos', 5, 5, 'heading'))).toBe('uno\n## dos')
  })

  it('no toca la línea siguiente si la selección acaba al empezarla', () => {
    expect(run('uno\ndos', toggleBlock('uno\ndos', 0, 4, 'quote'))).toBe('> uno\ndos')
  })
})

describe('enlaces y código', () => {
  it('deja seleccionada la parte que falta por escribir', () => {
    const e = insertLink('ver esto', 4, 8)
    expect(run('ver esto', e)).toBe('ver [esto](https://)')
    expect(run('ver esto', e).slice(e.selStart, e.selEnd)).toBe('https://')
    const url = insertLink('https://nexo.org', 0, 16)
    expect(run('https://nexo.org', url).slice(url.selStart, url.selEnd)).toBe('texto')
  })

  it('usa un bloque de código si hay varias líneas', () => {
    expect(run('a b', toggleCode('a b', 0, 1))).toBe('`a` b')
    expect(run('a\nb', toggleCode('a\nb', 0, 3))).toBe('```\na\nb\n```')
  })
})

describe('listas al escribir', () => {
  it('Enter sigue la lista con su numeración e indentación', () => {
    expect(run('- uno', continueList('- uno', 5))).toBe('- uno\n- ')
    expect(run('3. uno', continueList('3. uno', 6))).toBe('3. uno\n4. ')
    expect(run('  - [x] uno', continueList('  - [x] uno', 11))).toBe('  - [x] uno\n  - [ ] ')
  })

  it('Enter en un elemento vacío termina la lista', () => {
    expect(run('- uno\n- ', continueList('- uno\n- ', 8))).toBe('- uno\n')
  })

  it('fuera de una lista no hace nada', () => {
    expect(continueList('texto', 5)).toBeNull()
    expect(indentList('texto', 2, 2, false)).toBeNull()
  })

  it('Tab anida y Mayús+Tab desanida', () => {
    expect(run('- a', indentList('- a', 3, 3, false))).toBe('  - a')
    expect(run('  - a', indentList('  - a', 5, 5, true))).toBe('- a')
  })
})
