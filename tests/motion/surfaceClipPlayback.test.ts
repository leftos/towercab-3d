// @vitest-environment node
/**
 * How spoiler, reverser and wheel clips play. A wheel clip is driven only when its rotation keys make one revolution
 * in one direction about one axis; every clip plays over its own key range, which in some models starts mid-timeline;
 * and the gear's progress cache does not answer for another class of clip on the same model.
 */
import * as Cesium from 'cesium'
import { describe, expect, it, vi } from 'vitest'
import {
  type Animation,
  type AnimationSet,
  applyClipAnimationsPercent,
  applyWheelSpin,
  clipTimeAtPercent,
  isOneRevolutionClip,
} from '@/utils/gltfAnimationParser'

/** A quaternion turning `deg` degrees about the Y axis, after a base orientation of `baseDeg` about X. */
function yRotation(deg: number, baseDeg = 0): number[] {
  const base = Cesium.Quaternion.fromAxisAngle(Cesium.Cartesian3.UNIT_X, Cesium.Math.toRadians(baseDeg))
  const spin = Cesium.Quaternion.fromAxisAngle(Cesium.Cartesian3.UNIT_Y, Cesium.Math.toRadians(deg))
  const q = Cesium.Quaternion.multiply(base, spin, new Cesium.Quaternion())
  return [q.x, q.y, q.z, q.w]
}

/** A clip on one node whose rotation keys pass through the given angles about Y, one key per `step` seconds. */
function rotationClip(name: string, node: string, anglesDeg: number[], start = 0, step = 0.25, baseDeg = 0): Animation {
  const rotationKeys = anglesDeg.map((deg, i) => ({ time: start + i * step, value: yRotation(deg, baseDeg) }))
  const end = rotationKeys[rotationKeys.length - 1].time
  return {
    name,
    duration: end,
    tracks: new Map([[node, { translationKeys: [], rotationKeys, scaleKeys: [] }]]),
  }
}

const quarterSteps = (from: number, to: number, step = 90): number[] => {
  const out: number[] = []
  for (let a = from; a <= to + 1e-9; a += step) out.push(a)
  return out
}

describe('isOneRevolutionClip', () => {
  it('accepts one revolution in 90 degree keys', () => {
    expect(isOneRevolutionClip(rotationClip('c_tire_blurred_key', 'n', [0, 90, 180, 270, 360]))).toBe(true)
  })

  it('accepts one revolution in many small keys about a tilted axle', () => {
    const angles = Array.from({ length: 2401 }, (_, i) => (360 * i) / 2400)
    expect(isOneRevolutionClip(rotationClip('WHEEL_ROLL_left', 'n', angles, 0, 1 / 24, 30))).toBe(true)
  })

  it('accepts a clip whose wheel turns the other way, one revolution', () => {
    expect(isOneRevolutionClip(rotationClip('l_tire', 'n', [0, -90, -180, -270, -360]))).toBe(true)
  })

  it('rejects a clip that reverses partway (Dash8 r_tire: forward 180, back 270, forward 90)', () => {
    expect(isOneRevolutionClip(rotationClip('r_tire', 'n', [0, 90, 180, 90, 0, -90, 0]))).toBe(false)
  })

  it('rejects a clip that stops 23 degrees short of a turn (B78X WHEEL_ROLL at 337 degrees)', () => {
    const angles = Array.from({ length: 101 }, (_, i) => (337 * i) / 100)
    expect(isOneRevolutionClip(rotationClip('WHEEL_ROLL_left', 'n', angles))).toBe(false)
  })

  it('rejects a clip with a 180 degree step, whose direction between keys is undefined', () => {
    expect(isOneRevolutionClip(rotationClip('r_tire_anim', 'n', [0, 90, 270, 360]))).toBe(false)
  })

  it('rejects two revolutions', () => {
    expect(isOneRevolutionClip(rotationClip('c_tire', 'n', quarterSteps(0, 720)))).toBe(false)
  })

  it('rejects a clip without rotation keys', () => {
    const clip: Animation = {
      name: 'c_tire',
      duration: 1,
      tracks: new Map([['n', { translationKeys: [{ time: 0, value: [0, 0, 0] }], rotationKeys: [], scaleKeys: [] }]]),
    }
    expect(isOneRevolutionClip(clip)).toBe(false)
  })
})

describe('clipTimeAtPercent', () => {
  it('maps progress onto the clip key range, so a clip starting at 4.17 s plays from its first key', () => {
    const clip = rotationClip('spoilers', 'n', [0, 20, 40], 4.17, 0.5)
    expect(clipTimeAtPercent(clip, 0)).toBeCloseTo(4.17, 9)
    expect(clipTimeAtPercent(clip, 0.5)).toBeCloseTo(4.67, 9)
    expect(clipTimeAtPercent(clip, 1)).toBeCloseTo(5.17, 9)
  })

  it('clamps progress outside 0..1', () => {
    const clip = rotationClip('engine_rev', 'n', [0, 20], 100, 1)
    expect(clipTimeAtPercent(clip, -0.5)).toBe(100)
    expect(clipTimeAtPercent(clip, 1.5)).toBe(101)
  })
})

/** A model whose nodes start at the identity, with the node data the parser would hold for them. */
function fakeModel(nodeNames: string[]): {
  model: Cesium.Model
  set: (animations: Animation[]) => AnimationSet
  writes: (node: string) => number
} {
  const writeCounts = new Map<string, number>()
  const nodes = new Map(
    nodeNames.map((n) => {
      let matrix = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY)
      const node = {
        get matrix() {
          return matrix
        },
        set matrix(value: Cesium.Matrix4) {
          matrix = value
          writeCounts.set(n, (writeCounts.get(n) ?? 0) + 1)
        },
      }
      return [n, node] as const
    }),
  )
  const model = { getNode: (name: string) => nodes.get(name) } as unknown as Cesium.Model
  const nodeData = new Map(
    nodeNames.map((name) => [
      name,
      {
        name,
        translation: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        invRotation: new Cesium.Quaternion(0, 0, 0, 1),
        invRotationMatrix: Cesium.Matrix3.clone(Cesium.Matrix3.IDENTITY),
      },
    ]),
  )
  return {
    model,
    set: (animations) => ({ animations, nodes: nodeData }),
    writes: (node) => writeCounts.get(node) ?? 0,
  }
}

/** The rotation angle, in degrees, of a node's matrix in a fake model. */
function nodeAngleDeg(model: Cesium.Model, node: string): number {
  const m = Cesium.Matrix4.getMatrix3(model.getNode(node).matrix, new Cesium.Matrix3())
  const q = Cesium.Quaternion.fromRotationMatrix(m)
  return Cesium.Math.toDegrees(Cesium.Quaternion.computeAngle(q))
}

describe('applyClipAnimationsPercent', () => {
  it('keeps one progress cache per class, so spoilers at the gear progress are not drawn from the gear cache', () => {
    const { model, set } = fakeModel(['GearNode', 'SpoilerNode'])
    const animSet = set([
      rotationClip('c_gear', 'GearNode', [0, 90]),
      rotationClip('l_spoiler_key', 'SpoilerNode', [0, 50]),
    ])
    const url = 'test://cache-namespaces.glb'
    expect(applyClipAnimationsPercent(model, animSet, 'gear', 0.5, url)).toBe(1)
    expect(nodeAngleDeg(model, 'GearNode')).toBeCloseTo(45, 3)
    expect(nodeAngleDeg(model, 'SpoilerNode')).toBeCloseTo(0, 3)
    expect(applyClipAnimationsPercent(model, animSet, 'spoiler', 0.5, url)).toBe(1)
    expect(nodeAngleDeg(model, 'SpoilerNode')).toBeCloseTo(25, 3)
    // The cached gear pose is still the gear's own
    applyClipAnimationsPercent(model, animSet, 'gear', 1, url)
    applyClipAnimationsPercent(model, animSet, 'gear', 0.5, url)
    expect(nodeAngleDeg(model, 'GearNode')).toBeCloseTo(45, 3)
  })

  it('plays a mid-timeline reverser clip over its own keys', () => {
    const { model, set } = fakeModel(['Sleeve'])
    const animSet = set([rotationClip('engine_rev', 'Sleeve', [0, 40], 4.17, 1)])
    applyClipAnimationsPercent(model, animSet, 'reverser', 0.5, 'test://mid-timeline.glb')
    expect(nodeAngleDeg(model, 'Sleeve')).toBeCloseTo(20, 3)
  })
})

describe('applyClipAnimationsPercent return and repeat', () => {
  /** A gear clip moving two nodes, the strut and its door, with one track. */
  const twoNodeGear = (): Animation => {
    const clip = rotationClip('c_gear', 'GearNode', [0, 90])
    clip.tracks.set('DoorNode', clip.tracks.get('GearNode') as Animation['tracks'] extends Map<string, infer T> ? T : never)
    return clip
  }

  it('returns the nodes written, the same on a cache miss and a hit, and 0 for a class the model lacks', () => {
    const { model, set } = fakeModel(['GearNode', 'DoorNode'])
    const animSet = set([twoNodeGear()])
    const url = 'test://return-value.glb'
    expect(applyClipAnimationsPercent(model, animSet, 'gear', 0.3, url)).toBe(2)
    const second = fakeModel(['GearNode', 'DoorNode']).model
    expect(applyClipAnimationsPercent(second, animSet, 'gear', 0.3, url)).toBe(2)
    expect(applyClipAnimationsPercent(model, animSet, 'reverser', 0.3, url)).toBe(0)
  })

  it('writes a node once for two frames at the same progress', () => {
    const { model, set, writes } = fakeModel(['GearNode', 'DoorNode'])
    const animSet = set([twoNodeGear()])
    const url = 'test://repeat.glb'
    applyClipAnimationsPercent(model, animSet, 'gear', 0.5, url)
    applyClipAnimationsPercent(model, animSet, 'gear', 0.5, url)
    expect(writes('GearNode')).toBe(1)
    applyClipAnimationsPercent(model, animSet, 'gear', 0.6, url)
    expect(writes('GearNode')).toBe(2)
  })
})

describe('applyWheelSpin', () => {
  it('does not rewrite the wheels while the phase is unchanged (parked or held)', () => {
    const { model, set, writes } = fakeModel(['Wheel'])
    const animSet = set([rotationClip('c_tire', 'Wheel', [0, 90, 180, 270, 360])])
    applyWheelSpin(model, animSet, 0.25)
    applyWheelSpin(model, animSet, 0.25)
    expect(writes('Wheel')).toBe(1)
    applyWheelSpin(model, animSet, 0.5)
    expect(writes('Wheel')).toBe(2)
  })

  it('does not drive a wheel clip on a node a gear clip moves, and says so once per model', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { model, set } = fakeModel(['Strut', 'LWheel'])
    const animSet = set([
      rotationClip('c_gear', 'Strut', [0, 90]),
      rotationClip('c_tire', 'Strut', [0, 90, 180, 270, 360]),
      rotationClip('l_tire', 'LWheel', [0, 90, 180, 270, 360]),
    ])
    expect(applyWheelSpin(model, animSet, 0.25)).toBe(1)
    applyWheelSpin(model, animSet, 0.5)
    expect(nodeAngleDeg(model, 'Strut')).toBeCloseTo(0, 6)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('turns a one-revolution wheel clip to the phase, over its own key range', () => {
    const { model, set } = fakeModel(['Wheel'])
    const animSet = set([rotationClip('c_tire_anim', 'Wheel', [0, 90, 180, 270, 360], 4.17)])
    applyWheelSpin(model, animSet, 0.25)
    expect(nodeAngleDeg(model, 'Wheel')).toBeCloseTo(90, 3)
    applyWheelSpin(model, animSet, 0.5)
    expect(nodeAngleDeg(model, 'Wheel')).toBeCloseTo(180, 3)
  })

  it('leaves a reversing wheel clip and the steering clip alone', () => {
    const { model, set } = fakeModel(['RockingWheel', 'NoseSteer'])
    const animSet = set([
      rotationClip('r_tire', 'RockingWheel', [0, 90, 180, 90, 0, -90, 0]),
      rotationClip('custom_anim_C_WHEEL_LR', 'NoseSteer', [0, 90, 180, 270, 360]),
    ])
    expect(applyWheelSpin(model, animSet, 0.25)).toBe(0)
    expect(nodeAngleDeg(model, 'RockingWheel')).toBeCloseTo(0, 6)
    expect(nodeAngleDeg(model, 'NoseSteer')).toBeCloseTo(0, 6)
  })
})
