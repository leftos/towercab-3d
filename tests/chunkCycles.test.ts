import { describe, expect, it } from 'vitest'
import { findChunkCycles, splitKnownCycles } from '../scripts/dev/chunkCycles'

const chunk = (fileName: string, imports: string[]) => ({ fileName, imports })

describe('findChunkCycles', () => {
  it('finds no cycle in an import tree', () => {
    expect(findChunkCycles([chunk('a.js', ['b.js', 'c.js']), chunk('b.js', ['c.js']), chunk('c.js', [])])).toEqual([])
  })

  it('finds a two-chunk cycle once, starting at the smallest name', () => {
    expect(
      findChunkCycles([chunk('index.js', ['settingsStore.js']), chunk('settingsStore.js', ['index.js'])])
    ).toEqual([['index.js', 'settingsStore.js']])
  })

  it('finds a longer cycle and a separate one', () => {
    expect(
      findChunkCycles([
        chunk('a.js', ['b.js']),
        chunk('b.js', ['c.js']),
        chunk('c.js', ['a.js', 'd.js']),
        chunk('d.js', ['e.js']),
        chunk('e.js', ['d.js'])
      ])
    ).toEqual([
      ['a.js', 'b.js', 'c.js'],
      ['d.js', 'e.js']
    ])
  })

  it('ignores imports of files outside the bundle', () => {
    expect(findChunkCycles([chunk('a.js', ['missing.css'])])).toEqual([])
  })

  it('ignores a self import', () => {
    expect(findChunkCycles([chunk('a.js', ['a.js'])])).toEqual([])
  })
})

const nameOf = (fileName: string): string => (fileName.split('/').pop() ?? '').split('-')[0]
const settingsCycle = ['assets/index-abc.js', 'assets/settingsStore-def.js']

describe('splitKnownCycles', () => {
  it('matches a known cycle', () => {
    expect(splitKnownCycles([settingsCycle], nameOf, [['index', 'settingsStore']])).toEqual({
      known: [['index', 'settingsStore']],
      unknown: [],
      gone: []
    })
  })

  it('reports a new cycle as unknown', () => {
    const split = splitKnownCycles([settingsCycle], nameOf, [['other', 'cycle']])
    expect(split.unknown).toEqual([['index', 'settingsStore']])
    expect(split.known).toEqual([])
  })

  it('reports a known entry that no cycle matches as gone', () => {
    expect(splitKnownCycles([settingsCycle], nameOf, [['other', 'cycle']]).gone).toEqual([['other', 'cycle']])
  })

  it('matches a known entry written in another rotation', () => {
    expect(splitKnownCycles([settingsCycle], nameOf, [['settingsStore', 'index']]).known).toEqual([
      ['index', 'settingsStore']
    ])
  })
})
