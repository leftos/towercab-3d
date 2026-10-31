/**
 * Fails a test file that puts load-sized work under a hook or a test: more than COLD_CPU_BUDGET_MS of thread CPU
 * in the suite hooks preceding a test (a `beforeAll` of any enclosing suite, an `afterAll` of one just left), or in
 * a test that loads modules cold.
 *
 * Vitest wraps every hook in a wall-clock timeout (`hookTimeout`) and runs a file's top level with no timeout at
 * all, so seconds of work under a hook are a bound a passing run must beat on a busy machine, while the same work
 * at the file's top level never is. This check measures the work itself — thread CPU time and the worker's module
 * count, never wall time — so machine load cannot turn it red or green.
 *
 * It reads Vitest's internal `__vitest_worker__` (4.1.5); the guard below names this file when that changes.
 */
import { afterAll, beforeAll, beforeEach } from 'vitest'

const COLD_CPU_BUDGET_MS = 250

interface VitestWorker {
  evaluatedModules: { idToModuleMap: Map<string, unknown> }
}

const worker = (globalThis as unknown as { __vitest_worker__?: VitestWorker }).__vitest_worker__
if (!worker?.evaluatedModules?.idToModuleMap) {
  throw new Error(
    "hookBudget: Vitest's __vitest_worker__.evaluatedModules is missing (Vitest internals changed); update tests/setup/hookBudget.ts",
  )
}
const evaluatedModules = worker.evaluatedModules

function moduleCount(): number {
  return evaluatedModules.idToModuleMap.size
}

function threadCpuMs(): number {
  // Node 22 has no process.threadCpuUsage (Node 23.9 added it), so process CPU stands in there. A forks worker
  // runs one test file per process, so it is that file's work plus the runtime's own threads.
  const usage = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : process.cpuUsage()
  return (usage.user + usage.system) / 1000
}

const problems: string[] = []
let lastMarkCpu = 0

// From a setup file: beforeAll/beforeEach run before the file's own, afterAll after them,
// and onTestFinished after the test's afterEach hooks.
beforeAll(() => {
  lastMarkCpu = threadCpuMs()
})

beforeEach((context) => {
  // Everything since the previous test finished: the suite hooks a test file runs between two tests.
  const suiteCpu = threadCpuMs() - lastMarkCpu
  if (suiteCpu > COLD_CPU_BUDGET_MS) {
    problems.push(`suite hooks before "${context.task.name}" used ${Math.round(suiteCpu)} ms of thread CPU`)
  }
  const unitStartCpu = threadCpuMs()
  const unitStartModules = moduleCount()
  context.onTestFinished(() => {
    const coldLoads = moduleCount() - unitStartModules
    const cpu = threadCpuMs() - unitStartCpu
    if (coldLoads > 0 && cpu > COLD_CPU_BUDGET_MS) {
      problems.push(`"${context.task.name}" loaded ${coldLoads} module(s) cold, using ${Math.round(cpu)} ms of thread CPU`)
    }
    lastMarkCpu = threadCpuMs()
  })
})

afterAll(() => {
  if (problems.length > 0) {
    throw new Error(
      `Load-sized work under a hook or test timeout (budget ${COLD_CPU_BUDGET_MS} ms thread CPU); ` +
        `move it to the file's top level: ${problems.join('; ')}`,
    )
  }
})
