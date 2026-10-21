import type * as Cesium from 'cesium'
import { describe, expect, it, vi } from 'vitest'
import { type CesiumLightingSettings, useCesiumLighting } from '@/hooks/useCesiumLighting'
import { DEFAULT_SETTINGS } from '@/types/settings'

// Run the hook's effect at once: the repo has no React renderer for tests, and the effect is the behaviour under test.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useEffect: (effect: () => void) => effect(),
}))

function fakeViewer(): Cesium.Viewer {
  return {
    isDestroyed: () => false,
    scene: { globe: {} },
    shadows: false,
    terrainShadows: undefined,
    shadowMap: { _terrainBias: {}, _primitiveBias: {}, debugCreateRenderStates: () => {}, dirty: false },
  } as unknown as Cesium.Viewer
}

function settings(
  sunElevationDeg: number | null,
  viewMode: '3d' | 'topdown' = '3d',
  insetShadows?: boolean,
): CesiumLightingSettings {
  const g = DEFAULT_SETTINGS.graphics
  return {
    isInset: insetShadows !== undefined,
    insetGraphics: insetShadows === undefined ? g.insetGraphics : { ...g.insetGraphics, shadows: insetShadows },
    viewMode,
    enableLighting: true,
    enableGroundAtmosphere: true,
    enableShadows: true,
    shadowMapSize: g.shadowMapSize,
    shadowMaxDistance: g.shadowMaxDistance,
    shadowDarkness: g.shadowDarkness,
    shadowSoftness: g.shadowSoftness,
    shadowFadingEnabled: g.shadowFadingEnabled,
    shadowNormalOffset: g.shadowNormalOffset,
    aircraftShadowsOnly: false,
    shadowDepthBias: g.shadowDepthBias,
    shadowPolygonOffsetFactor: g.shadowPolygonOffsetFactor,
    shadowPolygonOffsetUnits: g.shadowPolygonOffsetUnits,
    sunElevationDeg,
  }
}

describe('useCesiumLighting sun shadows', () => {
  it('turns sun shadows off once the sun is below the horizon', () => {
    const viewer = fakeViewer()
    useCesiumLighting(viewer, settings(-30))
    expect(viewer.shadows).toBe(false)
  })

  it('turns sun shadows off below the horizon in the top-down view too', () => {
    const viewer = fakeViewer()
    useCesiumLighting(viewer, settings(-30, 'topdown'))
    expect(viewer.shadows).toBe(false)
  })

  it('keeps sun shadows on while the sun is up', () => {
    const viewer = fakeViewer()
    useCesiumLighting(viewer, settings(30))
    expect(viewer.shadows).toBe(true)
  })

  it('keeps the shadow setting while the sun elevation is not known yet', () => {
    const viewer = fakeViewer()
    useCesiumLighting(viewer, settings(null))
    expect(viewer.shadows).toBe(true)
  })

  it('turns sun shadows off below the horizon in an inset viewport that has shadows enabled', () => {
    const viewer = fakeViewer()
    useCesiumLighting(viewer, settings(-30, '3d', true))
    expect(viewer.shadows).toBe(false)
  })

  it('keeps sun shadows on by day in an inset viewport that has shadows enabled', () => {
    const viewer = fakeViewer()
    useCesiumLighting(viewer, settings(30, '3d', true))
    expect(viewer.shadows).toBe(true)
  })
})
