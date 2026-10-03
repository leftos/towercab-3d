// @vitest-environment node
/**
 * What happens in the first seconds after a VATSIM-only aircraft appears.
 *
 * The spawn transient itself is a known defect and is an `it.todo` below. What is asserted here is the
 * quantity that is correct today: the aircraft does converge on truth once its display delay settles.
 */
import { expect, it, vi } from 'vitest'
import { runScenario } from './harness'

vi.mock('react', () => {
  const api = {
    useEffect: (fn: () => unknown) => {
      fn()
    },
    useState: <T>(v: T) => [v, () => {}],
  }
  return { ...api, default: api }
})

const SPAWN_CONVERGED_POS_ERR_M = 15
const SPAWN_DURATION_S = 150

it(`ARR1 converges on truth within ${SPAWN_CONVERGED_POS_ERR_M} m once its delay settles (measured 2 m)`, async () => {
  const res = await runScenario({ fps: 60, useVnas: false, vnasFirst: false, durationS: SPAWN_DURATION_S })
  const recs = res.frames.get('ARR1') ?? []
  expect(recs.length).toBeGreaterThan(0)
  const firstWall = recs[0].frameTime
  const settled = recs.filter((r) => r.frameTime >= firstWall + 20)
  expect(settled.length).toBeGreaterThan(0)
  const maxErr = settled.reduce((m, r) => Math.max(m, Math.hypot(r.x - r.truth.x, r.y - r.truth.y)), 0)
  expect(maxErr).toBeLessThanOrEqual(SPAWN_CONVERGED_POS_ERR_M)
})

it.todo(
  '1.1 a new VATSIM aircraft is not drawn ahead and then pulled back, and its delay ramp does not play it at a fraction of speed (TC3D-49)',
)
