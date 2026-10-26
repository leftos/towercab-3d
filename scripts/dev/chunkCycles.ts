import type { Plugin } from 'vite'

/** The static import edges of one emitted chunk, as the bundle reports them. */
export interface ChunkImports {
  readonly fileName: string
  readonly imports: readonly string[]
}

/** One build's chunk cycles, as chunk-name lists, split by whether a known entry covers them. */
export interface CycleSplit {
  /** The cycles an entry in `known` matched. */
  known: string[][]
  /** The cycles no entry covers; these fail the build. */
  unknown: string[][]
  /** The entries of `known` that no cycle in the build matched. */
  gone: string[][]
}

/**
 * Every elementary cycle among `chunks`' static imports. A cycle is the list of file names in import
 * order, starting at its lexicographically smallest file name; each cycle appears once and the list
 * is sorted. An import naming a file outside `chunks` (an asset, an external) and a self import are
 * not cycles between chunks.
 */
export function findChunkCycles(chunks: ReadonlyArray<ChunkImports>): string[][] {
  const edges = new Map<string, readonly string[]>()
  for (const chunk of chunks) {
    edges.set(chunk.fileName, chunk.imports)
  }
  const cycles: string[][] = []
  const path: string[] = []
  const onPath = new Set<string>()

  // A depth-first search started at each file name, restricted to names at or after the start, finds
  // each cycle exactly once: from its smallest name, whose position in the cycle is unique.
  const walk = (start: string, node: string): void => {
    path.push(node)
    onPath.add(node)
    for (const next of edges.get(node) ?? []) {
      if (!edges.has(next)) {
        continue
      }
      if (next === start) {
        if (path.length > 1) {
          cycles.push([...path])
        }
        continue
      }
      if (next < start || onPath.has(next)) {
        continue
      }
      walk(start, next)
    }
    onPath.delete(node)
    path.pop()
  }

  for (const start of [...edges.keys()].sort()) {
    walk(start, start)
  }
  return cycles.sort(compareCycles)
}

/**
 * Splits `cycles` (file-name lists) into those a known cycle covers and those it does not, naming
 * chunks with `nameOf`. A known entry matches a cycle whatever rotation either is written in; the
 * entries of `known` that match nothing come back as `gone`. Every returned list starts at its
 * lexicographically smallest name, except `gone`, which keeps each entry as it was written.
 */
export function splitKnownCycles(
  cycles: string[][],
  nameOf: (fileName: string) => string,
  known: ReadonlyArray<readonly string[]>
): CycleSplit {
  const entries = known.map((entry) => ({ entry, key: cycleKey(rotateToSmallest(entry)) }))
  const matched = new Set<string>()
  const knownCycles: string[][] = []
  const unknown: string[][] = []
  for (const cycle of cycles) {
    const names = rotateToSmallest(cycle.map(nameOf))
    const key = cycleKey(names)
    if (entries.some((candidate) => candidate.key === key)) {
      matched.add(key)
      knownCycles.push(names)
    } else {
      unknown.push(names)
    }
  }
  const gone = entries.filter((candidate) => !matched.has(candidate.key)).map((candidate) => [...candidate.entry])
  return { known: knownCycles, unknown, gone }
}

function rotateToSmallest(names: readonly string[]): string[] {
  let smallest = 0
  for (let index = 1; index < names.length; index++) {
    if (names[index] < names[smallest]) {
      smallest = index
    }
  }
  return [...names.slice(smallest), ...names.slice(0, smallest)]
}

function cycleKey(names: readonly string[]): string {
  return names.join('\n')
}

function compareCycles(left: readonly string[], right: readonly string[]): number {
  const shared = Math.min(left.length, right.length)
  for (let index = 0; index < shared; index++) {
    if (left[index] !== right[index]) {
      return left[index] < right[index] ? -1 : 1
    }
  }
  return left.length - right.length
}

/**
 * Fails a production build whose emitted chunks statically import each other in a cycle: a module that
 * reads an imported binding while it loads gets `undefined` when the other chunk loads first. Dynamic
 * imports are left out, since a dynamically imported chunk evaluates after its importer. A cycle whose
 * chunk names match an entry of `knownCycles` is warned about instead of failing.
 */
export function chunkCyclePlugin(knownCycles: ReadonlyArray<readonly string[]>): Plugin {
  return {
    name: 'tc3d-chunk-cycles',
    apply: 'build',
    generateBundle(_options, bundle) {
      const chunks: ChunkImports[] = []
      const chunkNames = new Map<string, string>()
      for (const entry of Object.values(bundle)) {
        if (entry.type === 'chunk') {
          chunks.push({ fileName: entry.fileName, imports: entry.imports })
          chunkNames.set(entry.fileName, entry.name)
        }
      }
      const nameOf = (fileName: string): string => {
        const name = chunkNames.get(fileName)
        if (name === undefined) {
          throw new Error(`chunk ${fileName} has no name in the emitted bundle`)
        }
        return name
      }
      const split = splitKnownCycles(findChunkCycles(chunks), nameOf, knownCycles)
      for (const cycle of split.known) {
        this.warn(`known chunk cycle (TC3D-351): ${cycle.join(' -> ')} -> ${cycle[0]}`)
      }
      for (const entry of split.gone) {
        this.warn(`known chunk cycle no longer occurs; remove it from vite.config.ts: ${entry.join(' -> ')}`)
      }
      if (split.unknown.length === 0) {
        return
      }
      const report = split.unknown.map((cycle) => `  ${cycle.join(' -> ')} -> ${cycle[0]}`).join('\n')
      this.error(
        `Production chunks import each other in a cycle; a module-level read across it is undefined at boot ` +
          `(see the zustand and settings-core groups in vite.config.ts):\n${report}`
      )
    }
  }
}
