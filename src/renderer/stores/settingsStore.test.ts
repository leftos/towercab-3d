import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultWeatherQuality, SETTINGS_PRESETS, useSettingsStore } from '@/stores/settingsStore'
import { DEFAULT_SETTINGS } from '@/types/settings'
import { deviceSettingsPreset } from '@/utils/deviceDetection'

// The persist middleware attaches `persist` (and its migrate option) only when `window.localStorage` exists at store creation.
vi.hoisted(() => {
  const items = new Map<string, string>()
  const storage: Storage = {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, String(value))
    },
    removeItem: (key) => {
      items.delete(key)
    },
    clear: () => items.clear(),
    key: (index) => [...items.keys()][index] ?? null,
    get length() {
      return items.size
    },
  }
  Object.defineProperty(globalThis, 'window', { value: { localStorage: storage }, configurable: true, writable: true })
})

interface DeviceStub {
  userAgent: string
  maxTouchPoints: number
  hardwareConcurrency: number
  innerWidth: number
  touch: boolean
  /** Whether the page runs inside the Tauri desktop app */
  tauri?: boolean
}

const DESKTOP: DeviceStub = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
  maxTouchPoints: 0,
  hardwareConcurrency: 16,
  innerWidth: 1920,
  touch: false,
}

const IPAD: DeviceStub = {
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  maxTouchPoints: 5,
  hardwareConcurrency: 8,
  innerWidth: 1366,
  touch: true,
}

const PHONE: DeviceStub = {
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  maxTouchPoints: 5,
  hardwareConcurrency: 6,
  innerWidth: 390,
  touch: true,
}

const LOW_END_TABLET: DeviceStub = {
  userAgent:
    'Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
  maxTouchPoints: 5,
  hardwareConcurrency: 2,
  innerWidth: 1340,
  touch: true,
}

const TOUCH_LAPTOP: DeviceStub = {
  userAgent: DESKTOP.userAgent,
  maxTouchPoints: 10,
  hardwareConcurrency: 8,
  innerWidth: 1920,
  touch: true,
}

function stubDevice(device: DeviceStub): void {
  vi.stubGlobal('navigator', {
    userAgent: device.userAgent,
    maxTouchPoints: device.maxTouchPoints,
    hardwareConcurrency: device.hardwareConcurrency,
    platform: device.userAgent.includes('Macintosh') ? 'MacIntel' : 'Win32',
  })
  vi.stubGlobal('window', {
    innerWidth: device.innerWidth,
    ...(device.touch ? { ontouchstart: null } : {}),
    ...(device.tauri ? { __TAURI__: {} } : {}),
  })
}

/** A settings state as version 38 persisted it: no `weather.stageQuality` */
function v38State(): Record<string, unknown> {
  const { stageQuality: _dropped, ...weather } = DEFAULT_SETTINGS.weather
  return { ...structuredClone(DEFAULT_SETTINGS), weather: { ...weather, fogIntensity: 1.6 } }
}

function migrate(state: unknown, version: number): typeof DEFAULT_SETTINGS {
  const migrateFn = useSettingsStore.persist.getOptions().migrate
  if (!migrateFn) throw new Error('settings store has no migrate function')
  return migrateFn(state, version) as typeof DEFAULT_SETTINGS
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('deviceSettingsPreset', () => {
  it.each([
    ['a desktop', 'desktop', DESKTOP],
    ['an iPad', 'ipad', IPAD],
    ['a phone', 'mobile', PHONE],
    ['a low-end touch tablet', 'mobile', LOW_END_TABLET],
    ['an unknown large touch device', 'ipad', TOUCH_LAPTOP],
  ] as const)('maps %s to the %s preset', (_name, expected, device) => {
    stubDevice(device)
    expect(deviceSettingsPreset()).toBe(expected)
  })
})

describe('defaultWeatherQuality', () => {
  it.each([
    ['an iPad', 'ipad', IPAD],
    ['a phone', 'mobile', PHONE],
  ] as const)('stays High in the desktop app on %s', (_name, deviceClass, device) => {
    stubDevice({ ...device, tauri: true })
    expect(deviceSettingsPreset()).toBe(deviceClass)
    expect(defaultWeatherQuality()).toBe('high')
  })

  it.each([
    ['a desktop', 'high', DESKTOP],
    ['an iPad', 'medium', IPAD],
    ['a phone', 'low', PHONE],
  ] as const)('gives a remote browser on %s the %s preset', (_name, expected, device) => {
    stubDevice(device)
    expect(defaultWeatherQuality()).toBe(expected)
  })
})

describe('SETTINGS_PRESETS weather quality', () => {
  it('gives desktop High, iPad Medium and phones Low', () => {
    expect(SETTINGS_PRESETS.desktop.weather.stageQuality).toBe('high')
    expect(SETTINGS_PRESETS.ipad.weather.stageQuality).toBe('medium')
    expect(SETTINGS_PRESETS.mobile.weather.stageQuality).toBe('low')
  })
})

describe('applyPreset', () => {
  it('sets the iPad weather quality and keeps the other weather settings', () => {
    useSettingsStore.getState().updateWeatherSettings({ stageQuality: 'high', fogIntensity: 1.7, showClouds: false })
    useSettingsStore.getState().applyPreset('ipad')
    const { weather } = useSettingsStore.getState()
    expect(weather.stageQuality).toBe('medium')
    expect(weather.fogIntensity).toBe(1.7)
    expect(weather.showClouds).toBe(false)
  })
})

describe('resetToDefaults', () => {
  it('resets the weather quality to the device default in a remote browser', () => {
    stubDevice(IPAD)
    useSettingsStore.getState().updateWeatherSettings({ stageQuality: 'high', fogIntensity: 1.7 })
    useSettingsStore.getState().resetToDefaults()
    const { weather } = useSettingsStore.getState()
    expect(weather.stageQuality).toBe('medium')
    expect(weather.fogIntensity).toBe(DEFAULT_SETTINGS.weather.fogIntensity)
  })
})

describe('settings migration to version 39', () => {
  it('defaults new installs to High', () => {
    expect(DEFAULT_SETTINGS.weather.stageQuality).toBe('high')
  })

  it.each([
    ['a desktop', 'high', DESKTOP],
    ['an iPad', 'medium', IPAD],
    ['a phone', 'low', PHONE],
  ] as const)('gives a version 38 install on %s the %s weather quality', (_name, expected, device) => {
    stubDevice(device)
    const migrated = migrate(v38State(), 38)
    expect(migrated.weather.stageQuality).toBe(expected)
    expect(migrated.weather.fogIntensity).toBe(1.6)
  })

  it('keeps High for a touch-screen desktop in the desktop app', () => {
    stubDevice({ ...TOUCH_LAPTOP, tauri: true })
    expect(deviceSettingsPreset()).toBe('ipad')
    expect(migrate(v38State(), 38).weather.stageQuality).toBe('high')
  })

  it('leaves a version 39 weather quality alone', () => {
    stubDevice(PHONE)
    const state = {
      ...structuredClone(DEFAULT_SETTINGS),
      weather: { ...DEFAULT_SETTINGS.weather, stageQuality: 'high' },
    }
    expect(migrate(state, 39).weather.stageQuality).toBe('high')
  })
})
