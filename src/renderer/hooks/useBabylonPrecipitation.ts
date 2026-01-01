import { useEffect, useRef, useCallback, useState } from 'react'
import * as BABYLON from '@babylonjs/core'
import { useWeatherStore } from '../stores/weatherStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useAirportStore } from '../stores/airportStore'
import type { PrecipitationType } from '@/types'
// Flare texture URL - using Babylon's CDN
const FLARE_TEXTURE_URL = 'https://assets.babylonjs.com/textures/flare.png'
import {
  // Pre-warm jump detection
  PARTICLE_PREWARM_JUMP_THRESHOLD,
  // Rain
  RAIN_EMIT_RATE_BASE,
  RAIN_PARTICLE_LIFETIME_MIN,
  RAIN_PARTICLE_LIFETIME_MAX,
  RAIN_PARTICLE_SIZE_MIN,
  RAIN_PARTICLE_SIZE_MAX,
  RAIN_SCALE_X_MIN,
  RAIN_SCALE_X_MAX,
  RAIN_VELOCITY,
  RAIN_VELOCITY_VARIANCE,
  RAIN_GRAVITY,
  RAIN_EMIT_POWER_MIN,
  RAIN_EMIT_POWER_MAX,
  RAIN_COLOR_1,
  RAIN_COLOR_2,
  RAIN_PARTICLE_CAPACITY,
  RAIN_EMITTER_BOX_HALF_SIZE,
  RAIN_EMITTER_BOX_HEIGHT,
  RAIN_DRIFT_RANGE,
  RAIN_WIND_GRAVITY,
  // Snow
  SNOW_EMIT_RATE_BASE,
  SNOW_PARTICLE_SIZE_MIN,
  SNOW_PARTICLE_SIZE_MAX,
  SNOW_VELOCITY,
  SNOW_DRIFT_RANGE,
  SNOW_PARTICLE_CAPACITY,
  SNOW_WIND_GRAVITY,
  SNOW_EMITTER_HEIGHT,
  SNOW_EMITTER_BOX_HEIGHT,
  // Emitter
  EMITTER_BOX_SIZE,
  EMITTER_HEIGHT_ABOVE_CAMERA,
  // Intensity
  INTENSITY_LIGHT,
  INTENSITY_MODERATE,
  INTENSITY_HEAVY,
  // Lightning
  LIGHTNING_INTERVAL_MIN,
  LIGHTNING_INTERVAL_MAX,
  LIGHTNING_FLASH_DURATION_MS,
  LIGHTNING_FLASH_INTENSITY,
  LIGHTNING_MULTI_FLASH_PROBABILITY,
  LIGHTNING_MULTI_FLASH_DELAY_MS,
  LIGHTNING_MULTI_FLASH_MAX,
  // Wind
  KNOTS_TO_MS,
  WIND_EFFECT_SCALE,
  GUST_INTERVAL_MIN,
  GUST_INTERVAL_MAX,
  GUST_DURATION_MIN,
  GUST_DURATION_MAX,
  GUST_RAMP_FRACTION,
  VARIABLE_WIND_VARIANCE,
  // Precipitation smoothing
  PRECIPITATION_FADE_TIME,
  PRECIPITATION_ONSET_DELAY,
  PRECIPITATION_CESSATION_DELAY,
  THUNDERSTORM_ONSET_DELAY,
  THUNDERSTORM_CESSATION_DELAY
} from '@/constants'

interface UseBabylonPrecipitationOptions {
  scene: BABYLON.Scene | null
  camera: BABYLON.FreeCamera | null
  isTopDownView?: boolean
}

interface ParticleSystemData {
  system: BABYLON.ParticleSystem
  type: PrecipitationType
  baseEmitRate: number
}

/**
 * Manages METAR-based precipitation effects (rain, snow, lightning)
 *
 * Creates and manages Babylon.js particle systems for precipitation that:
 * - Follow the camera position
 * - Scale intensity based on METAR precipitation codes
 * - Apply wind effects based on METAR wind data
 * - Simulate gusty conditions with variable wind speeds
 * - Flash lightning during thunderstorms
 */
export function useBabylonPrecipitation(options: UseBabylonPrecipitationOptions) {
  const { scene, camera, isTopDownView = false } = options

  // Lightning flash plane reference
  const lightningPlaneRef = useRef<BABYLON.Mesh | null>(null)

  // Particle system references
  const particleSystemsRef = useRef<Map<string, ParticleSystemData>>(new Map())

  // Wind state for gust simulation
  const windStateRef = useRef({
    currentSpeed: 0,        // Current wind speed being applied
    baseSpeed: 0,           // Base wind speed from METAR
    gustSpeed: 0,           // Gust speed from METAR
    direction: 0,           // Wind direction in radians
    isGusting: false,       // Whether currently in a gust
    gustStartTime: 0,       // When current gust started
    gustDuration: 0,        // Duration of current gust
    nextGustTime: 0,        // When next gust should start
    isVariable: false       // Whether wind is variable direction
  })

  // Lightning state
  const lightningStateRef = useRef({
    nextFlashTime: 0,
    isFlashing: false,
    flashCount: 0,
    originalIntensity: 1.0
  })

  // Lightning timeout refs for cleanup
  const lightningTimeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())

  // Babylon render observer reference for cleanup
  const renderObserverRef = useRef<BABYLON.Observer<BABYLON.Scene> | null>(null)

  // Track previous camera position for jump detection
  const lastCameraPosRef = useRef<BABYLON.Vector3 | null>(null)

  // Counter to force particle system recreation (incremented when camera jumps)
  // Using state so that changing it triggers the effect to re-run
  const [recreateCounter, setRecreateCounter] = useState(0)

  // Track the last recreateCounter value to detect changes within the effect
  const lastRecreateCounterRef = useRef(0)

  // Precipitation smoothing state - smooth transitions for fade in/out
  const precipSmoothingRef = useRef({
    // Current smoothed intensity factor (0 = off, 1 = full)
    currentIntensity: 0,
    // Target intensity (0 or 1 based on active state)
    targetIntensity: 0,
    // Hysteresis timers for onset/cessation delay
    precipOnsetTime: null as number | null,
    precipCessationTime: null as number | null,
    // Whether precipitation is logically active (after hysteresis)
    precipActive: false,
    // Thunderstorm smoothing
    thunderstormOnsetTime: null as number | null,
    thunderstormCessationTime: null as number | null,
    thunderstormActive: false,
    thunderstormFactor: 0,
    // Initialization flag
    initialized: false
  })

  // Track current airport to detect airport switches (reset smoothing on switch)
  const currentAirportIcao = useAirportStore((state) => state.currentAirport?.icao ?? null)
  const prevAirportIcaoRef = useRef<string | null>(null)

  // Track camera position to detect position jumps (reset smoothing on teleport)
  const cameraPosition = useWeatherStore((state) => state.cameraPosition)
  const prevCameraPositionRef = useRef<{ lat: number; lon: number } | null>(null)

  // Weather store subscriptions
  const precipitation = useWeatherStore((state) => state.precipitation)
  const wind = useWeatherStore((state) => state.wind)

  // Settings subscriptions
  const showWeatherEffects = useSettingsStore((state) => state.weather.showWeatherEffects)
  const showPrecipitation = useSettingsStore((state) => state.weather.showPrecipitation)
  const precipitationIntensity = useSettingsStore((state) => state.weather.precipitationIntensity)
  const showLightning = useSettingsStore((state) => state.weather.showLightning) ?? true

  // Detect airport changes and reset smoothing (instant weather changes when switching airports)
  useEffect(() => {
    if (currentAirportIcao !== prevAirportIcaoRef.current) {
      prevAirportIcaoRef.current = currentAirportIcao

      // Reset precipitation smoothing - snap to current state (no transition)
      const smoothing = precipSmoothingRef.current
      smoothing.precipActive = precipitation.active
      smoothing.currentIntensity = precipitation.active ? 1 : 0
      smoothing.targetIntensity = smoothing.currentIntensity
      smoothing.precipOnsetTime = null
      smoothing.precipCessationTime = null

      // Reset thunderstorm smoothing
      smoothing.thunderstormActive = precipitation.hasThunderstorm
      smoothing.thunderstormFactor = precipitation.hasThunderstorm ? 1 : 0
      smoothing.thunderstormOnsetTime = null
      smoothing.thunderstormCessationTime = null
    }
  }, [currentAirportIcao, precipitation.active, precipitation.hasThunderstorm])

  // Detect camera position jumps and reset smoothing (instant weather when teleporting)
  // Threshold: ~5 nautical miles (0.083 degrees latitude ≈ 5nm)
  const POSITION_JUMP_THRESHOLD_DEG = 0.083
  useEffect(() => {
    if (!cameraPosition) return

    const prev = prevCameraPositionRef.current
    if (prev) {
      const latDiff = Math.abs(cameraPosition.lat - prev.lat)
      const lonDiff = Math.abs(cameraPosition.lon - prev.lon) * Math.cos((cameraPosition.lat * Math.PI) / 180)
      const distance = Math.sqrt(latDiff * latDiff + lonDiff * lonDiff)

      if (distance > POSITION_JUMP_THRESHOLD_DEG) {
        // Position jumped significantly - reset precipitation smoothing
        const smoothing = precipSmoothingRef.current
        smoothing.precipActive = precipitation.active
        smoothing.currentIntensity = precipitation.active ? 1 : 0
        smoothing.targetIntensity = smoothing.currentIntensity
        smoothing.precipOnsetTime = null
        smoothing.precipCessationTime = null
        smoothing.thunderstormActive = precipitation.hasThunderstorm
        smoothing.thunderstormFactor = precipitation.hasThunderstorm ? 1 : 0
        smoothing.thunderstormOnsetTime = null
        smoothing.thunderstormCessationTime = null
      }
    }

    prevCameraPositionRef.current = { ...cameraPosition }
  }, [cameraPosition, precipitation.active, precipitation.hasThunderstorm])

  /**
   * Convert meteorological wind direction to particle velocity direction
   * Meteorological: direction wind is FROM (0 = North, 90 = East)
   * We want particles to move WITH the wind, so add 180°
   */
  const windDirToVelocity = useCallback((dirDegrees: number): { x: number; z: number } => {
    // Convert to radians and adjust (meteorological to mathematical)
    const radians = ((dirDegrees + 180) * Math.PI) / 180
    return {
      x: Math.sin(radians),
      z: Math.cos(radians)
    }
  }, [])

  /**
   * Create a rain particle system with proper capacity
   */
  const createRainSystemAsync = useCallback(async (): Promise<BABYLON.ParticleSystem | null> => {
    if (!scene) return null

    try {
      // Create particle system with proper capacity for dense rain
      const ps = new BABYLON.ParticleSystem('rain', RAIN_PARTICLE_CAPACITY, scene)

      // Load texture from CDN
      const texture = new BABYLON.Texture(FLARE_TEXTURE_URL, scene)
      ps.particleTexture = texture

      // Configure emitter - box above camera
      ps.emitter = new BABYLON.Vector3(0, EMITTER_HEIGHT_ABOVE_CAMERA, 0)
      ps.minEmitBox = new BABYLON.Vector3(-RAIN_EMITTER_BOX_HALF_SIZE, 0, -RAIN_EMITTER_BOX_HALF_SIZE)
      ps.maxEmitBox = new BABYLON.Vector3(RAIN_EMITTER_BOX_HALF_SIZE, RAIN_EMITTER_BOX_HEIGHT, RAIN_EMITTER_BOX_HALF_SIZE)

      // Particle sizes - height of the rain streak
      ps.minSize = RAIN_PARTICLE_SIZE_MIN
      ps.maxSize = RAIN_PARTICLE_SIZE_MAX

      // Make particles thin (narrow width) for rain streak appearance
      ps.minScaleX = RAIN_SCALE_X_MIN
      ps.maxScaleX = RAIN_SCALE_X_MAX

      // Short lifetime for fast-moving particles
      ps.minLifeTime = RAIN_PARTICLE_LIFETIME_MIN
      ps.maxLifeTime = RAIN_PARTICLE_LIFETIME_MAX

      // Set velocity with variance
      ps.direction1 = new BABYLON.Vector3(-0.5, RAIN_VELOCITY - RAIN_VELOCITY_VARIANCE, -0.5)
      ps.direction2 = new BABYLON.Vector3(0.5, RAIN_VELOCITY + RAIN_VELOCITY_VARIANCE, 0.5)
      ps.minEmitPower = RAIN_EMIT_POWER_MIN
      ps.maxEmitPower = RAIN_EMIT_POWER_MAX

      // Light gravity - rain is already near terminal velocity
      ps.gravity = new BABYLON.Vector3(0, RAIN_GRAVITY, 0)

      // Rain colors
      ps.color1 = new BABYLON.Color4(...RAIN_COLOR_1)
      ps.color2 = new BABYLON.Color4(...RAIN_COLOR_2)
      ps.colorDead = new BABYLON.Color4(RAIN_COLOR_2[0], RAIN_COLOR_2[1], RAIN_COLOR_2[2], 0.0)

      // Additive blending - more visible against dark backgrounds
      ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD

      // Stretched billboard - particles elongate along their velocity direction
      ps.billboardMode = BABYLON.ParticleSystem.BILLBOARDMODE_STRETCHED

      // No rotation for rain - stretched billboard handles orientation
      ps.minAngularSpeed = 0
      ps.maxAngularSpeed = 0
      ps.minInitialRotation = 0
      ps.maxInitialRotation = 0

      // Set emit rate
      ps.emitRate = RAIN_EMIT_RATE_BASE

      // Pre-warm the particle system so particles appear instantly when enabled
      // (e.g., when switching from 2D to 3D view, or flying to a new location)
      // Rain falls fast at ~450m/s, needs enough cycles to fill the 50m height
      // 150 cycles at 16ms = ~2.4 seconds of simulation (covers full particle volume)
      ps.preWarmCycles = 150
      ps.preWarmStepOffset = 16

      // Ensure particles render on top
      ps.renderingGroupId = 1

      return ps
    } catch (error) {
      if (import.meta.env.DEV) {
        console.error('[Precip] Failed to create rain system:', error)
      }
      return null
    }
  }, [scene])

  /**
   * Create a snow particle system with proper capacity
   */
  const createSnowSystemAsync = useCallback(async (): Promise<BABYLON.ParticleSystem | null> => {
    if (!scene) return null

    try {
      // Create particle system with proper capacity
      const ps = new BABYLON.ParticleSystem('snow', SNOW_PARTICLE_CAPACITY, scene)

      // Load texture from CDN
      const texture = new BABYLON.Texture(FLARE_TEXTURE_URL, scene)
      ps.particleTexture = texture

      // Configure emitter box - MUCH closer to camera than rain
      // Snow is slow (-3 m/s) so needs to start close to be visible
      ps.emitter = new BABYLON.Vector3(0, SNOW_EMITTER_HEIGHT, 0)
      ps.minEmitBox = new BABYLON.Vector3(-EMITTER_BOX_SIZE / 2, 0, -EMITTER_BOX_SIZE / 2)
      ps.maxEmitBox = new BABYLON.Vector3(EMITTER_BOX_SIZE / 2, SNOW_EMITTER_BOX_HEIGHT, EMITTER_BOX_SIZE / 2)

      // Longer lifetime so slow snow can travel the distance
      // At -3 m/s, 15 seconds = 45m of travel (enough for 30m emitter height)
      ps.minLifeTime = 12
      ps.maxLifeTime = 18
      ps.minSize = SNOW_PARTICLE_SIZE_MIN
      ps.maxSize = SNOW_PARTICLE_SIZE_MAX

      // Slow falling snow with drift
      ps.direction1 = new BABYLON.Vector3(-SNOW_DRIFT_RANGE, SNOW_VELOCITY, -SNOW_DRIFT_RANGE)
      ps.direction2 = new BABYLON.Vector3(SNOW_DRIFT_RANGE, SNOW_VELOCITY * 0.8, SNOW_DRIFT_RANGE)
      ps.minEmitPower = 0.8
      ps.maxEmitPower = 1.2

      // Very light gravity for gentle falling
      ps.gravity = new BABYLON.Vector3(0, -0.2, 0)

      // Snow colors - use slight blue tint to be visible against any background
      ps.color1 = new BABYLON.Color4(0.9, 0.95, 1.0, 1.0)
      ps.color2 = new BABYLON.Color4(0.85, 0.9, 1.0, 0.9)
      ps.colorDead = new BABYLON.Color4(0.9, 0.95, 1.0, 0.0)

      // Use additive blending like rain - makes particles glow
      ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD

      // Add rotation for tumbling effect (snow tumbles, rain doesn't)
      ps.minAngularSpeed = -Math.PI * 0.5
      ps.maxAngularSpeed = Math.PI * 0.5

      // Set emit rate
      ps.emitRate = SNOW_EMIT_RATE_BASE

      // Pre-warm the particle system so particles appear instantly when enabled
      // Snow falls much slower than rain (~3m/s), needs many more cycles to fill the volume
      // 300 cycles at 50ms step = ~15 seconds of simulation (fills the 30m emitter height)
      ps.preWarmCycles = 300
      ps.preWarmStepOffset = 50

      // Render on top
      ps.renderingGroupId = 1

      return ps
    } catch (error) {
      if (import.meta.env.DEV) {
        console.error('[Precip] Failed to create snow system:', error)
      }
      return null
    }
  }, [scene])

  /**
   * Get base emit rate for a precipitation type
   */
  const getBaseEmitRate = useCallback((type: PrecipitationType): number => {
    switch (type) {
      case 'rain':
      case 'drizzle':
      case 'hail':
      case 'unknown':
        return RAIN_EMIT_RATE_BASE
      case 'snow':
      case 'ice':
        return SNOW_EMIT_RATE_BASE
      default:
        return RAIN_EMIT_RATE_BASE
    }
  }, [])

  /**
   * Get intensity multiplier from precipitation intensity
   */
  const getIntensityMultiplier = useCallback((intensity: 'light' | 'moderate' | 'heavy'): number => {
    switch (intensity) {
      case 'light':
        return INTENSITY_LIGHT
      case 'heavy':
        return INTENSITY_HEAVY
      default:
        return INTENSITY_MODERATE
    }
  }, [])

  /**
   * Update wind state and simulate gusts
   */
  const updateWindState = useCallback((_deltaTime: number) => {
    const ws = windStateRef.current
    const now = performance.now()

    // Update base wind from METAR (convert knots to m/s)
    ws.baseSpeed = wind.speed * KNOTS_TO_MS
    ws.gustSpeed = (wind.gustSpeed ?? wind.speed) * KNOTS_TO_MS
    ws.direction = (wind.direction * Math.PI) / 180
    ws.isVariable = wind.isVariable

    // Handle gust simulation
    if (wind.gustSpeed && wind.gustSpeed > wind.speed) {
      if (!ws.isGusting && now >= ws.nextGustTime) {
        // Start a new gust
        ws.isGusting = true
        ws.gustStartTime = now
        ws.gustDuration = (GUST_DURATION_MIN + Math.random() * (GUST_DURATION_MAX - GUST_DURATION_MIN)) * 1000
      }

      if (ws.isGusting) {
        const elapsed = now - ws.gustStartTime
        const progress = elapsed / ws.gustDuration

        if (progress >= 1) {
          // Gust ended
          ws.isGusting = false
          ws.nextGustTime = now + (GUST_INTERVAL_MIN + Math.random() * (GUST_INTERVAL_MAX - GUST_INTERVAL_MIN)) * 1000
          ws.currentSpeed = ws.baseSpeed
        } else {
          // During gust - ramp up, sustain, ramp down
          const rampUp = GUST_RAMP_FRACTION
          const rampDown = 1 - GUST_RAMP_FRACTION

          let gustFactor: number
          if (progress < rampUp) {
            // Ramping up
            gustFactor = progress / rampUp
          } else if (progress > rampDown) {
            // Ramping down
            gustFactor = (1 - progress) / GUST_RAMP_FRACTION
          } else {
            // Sustained
            gustFactor = 1
          }

          ws.currentSpeed = ws.baseSpeed + (ws.gustSpeed - ws.baseSpeed) * gustFactor
        }
      } else {
        ws.currentSpeed = ws.baseSpeed
      }
    } else {
      ws.currentSpeed = ws.baseSpeed
      ws.isGusting = false
    }
  }, [wind])

  /**
   * Apply wind to particle system directions
   */
  const applyWindToSystem = useCallback((ps: BABYLON.ParticleSystem, type: PrecipitationType) => {
    const ws = windStateRef.current

    // Calculate wind direction with optional variable variance
    let windDir = ws.direction
    if (ws.isVariable) {
      windDir += (Math.random() - 0.5) * (VARIABLE_WIND_VARIANCE * Math.PI / 180)
    }

    const windVec = windDirToVelocity(windDir * 180 / Math.PI)

    // Get type-specific values
    const isSnowType = type === 'snow' || type === 'ice'
    const baseVelocity = isSnowType ? SNOW_VELOCITY : RAIN_VELOCITY
    const drift = isSnowType ? SNOW_DRIFT_RANGE : RAIN_DRIFT_RANGE
    const gravityStrength = isSnowType ? SNOW_WIND_GRAVITY : RAIN_WIND_GRAVITY

    // Wind effect scale: rain needs high scale (falls fast at -450 m/s)
    // Snow needs low scale (falls slow at -3 m/s) - just use raw wind speed
    const windScale = isSnowType ? 1.0 : WIND_EFFECT_SCALE
    const horizontalSpeed = ws.currentSpeed * windScale

    // Update particle initial directions with wind
    ps.direction1 = new BABYLON.Vector3(
      windVec.x * horizontalSpeed - drift,
      baseVelocity,
      windVec.z * horizontalSpeed - drift
    )
    ps.direction2 = new BABYLON.Vector3(
      windVec.x * horizontalSpeed + drift,
      baseVelocity * 0.9,
      windVec.z * horizontalSpeed + drift
    )

    // Apply wind to gravity so particles curve in the wind direction
    // Snow: minimal gravity wind effect, Rain: stronger
    const gravityWindScale = isSnowType ? 0.3 : 0.5
    ps.gravity = new BABYLON.Vector3(
      windVec.x * horizontalSpeed * gravityWindScale,
      gravityStrength,
      windVec.z * horizontalSpeed * gravityWindScale
    )

    // For rain: no rotation - stretched billboard handles orientation automatically
    // For snow: gentle tumbling is realistic
    if (type === 'snow' || type === 'ice') {
      ps.minAngularSpeed = -Math.PI * 0.5
      ps.maxAngularSpeed = Math.PI * 0.5
    } else {
      // Rain doesn't spin - it stretches along velocity via billboard mode
      ps.minAngularSpeed = 0
      ps.maxAngularSpeed = 0
    }
  }, [windDirToVelocity])

  /**
   * Create lightning flash plane if it doesn't exist
   */
  const ensureLightningPlane = useCallback(() => {
    if (!scene || !camera || lightningPlaneRef.current) return

    // Create a full-screen plane for lightning flash effect
    const plane = BABYLON.MeshBuilder.CreatePlane('lightningFlash', { size: 1000 }, scene)

    // Create unlit material that's pure white
    const material = new BABYLON.StandardMaterial('lightningMat', scene)
    material.emissiveColor = new BABYLON.Color3(1, 1, 1)
    material.disableLighting = true
    material.alpha = 0  // Start invisible

    plane.material = material
    plane.isPickable = false
    plane.renderingGroupId = 2  // Render on top of everything

    // Parent to camera so it always faces the viewer
    plane.parent = camera
    plane.position = new BABYLON.Vector3(0, 0, 50)  // 50 units in front of camera

    lightningPlaneRef.current = plane
  }, [scene, camera])

  /**
   * Handle lightning flash effect - creates visible screen flash
   * Uses smoothed thunderstorm state to prevent sudden lightning changes
   */
  const updateLightning = useCallback(() => {
    if (!scene || !camera) return

    const smoothing = precipSmoothingRef.current

    // Use smoothed thunderstorm state for more gradual onset/cessation
    // Only show lightning if thunderstorm factor is above threshold
    if (smoothing.thunderstormFactor < 0.5 || !showLightning) {
      return
    }

    // Ensure flash plane exists
    ensureLightningPlane()

    const ls = lightningStateRef.current
    const now = performance.now()

    if (ls.isFlashing) {
      // Currently flashing - handled by setTimeout
      return
    }

    if (now >= ls.nextFlashTime) {
      // Time for a flash
      ls.isFlashing = true
      ls.flashCount = 0

      const plane = lightningPlaneRef.current
      const material = plane?.material as BABYLON.StandardMaterial | null
      const timeouts = lightningTimeoutsRef.current

      const doFlash = () => {
        if (!material) return

        // Flash bright - make plane visible
        // Scale intensity by thunderstorm factor for gradual ramp-up
        const scaledIntensity = (LIGHTNING_FLASH_INTENSITY / 10) * smoothing.thunderstormFactor
        material.alpha = scaledIntensity

        const timeout1 = setTimeout(() => {
          timeouts.delete(timeout1)
          if (!material) return

          // Return to invisible
          material.alpha = 0
          ls.flashCount++

          // Check for multi-flash
          if (
            Math.random() < LIGHTNING_MULTI_FLASH_PROBABILITY &&
            ls.flashCount < LIGHTNING_MULTI_FLASH_MAX
          ) {
            const timeout2 = setTimeout(() => {
              timeouts.delete(timeout2)
              doFlash()
            }, LIGHTNING_MULTI_FLASH_DELAY_MS)
            timeouts.add(timeout2)
          } else {
            ls.isFlashing = false
            // Schedule next flash
            ls.nextFlashTime = now + (LIGHTNING_INTERVAL_MIN + Math.random() * (LIGHTNING_INTERVAL_MAX - LIGHTNING_INTERVAL_MIN)) * 1000
          }
        }, LIGHTNING_FLASH_DURATION_MS)
        timeouts.add(timeout1)
      }

      doFlash()
    }
  }, [scene, camera, showLightning, ensureLightningPlane])

  /**
   * Main update function - called by Babylon's render observable for perfect sync
   */
  const updatePrecipitation = useCallback(() => {
    if (!scene || !camera) return

    // Check for camera position jumps (flyTo, following, etc.)
    // When camera moves more than threshold in one update, trigger particle recreation
    const lastPos = lastCameraPosRef.current
    if (lastPos) {
      const distance = BABYLON.Vector3.Distance(camera.position, lastPos)
      if (distance > PARTICLE_PREWARM_JUMP_THRESHOLD) {
        // Large position jump detected - increment counter to trigger effect re-run
        // This disposes and recreates particle systems with pre-warming
        setRecreateCounter(c => c + 1)
      }
    }
    // Update last camera position
    lastCameraPosRef.current = camera.position.clone()

    const deltaTime = scene.getEngine().getDeltaTime() / 1000
    const now = performance.now()
    const smoothing = precipSmoothingRef.current

    // === PRECIPITATION SMOOTHING ===
    // Handle hysteresis for onset/cessation
    if (precipitation.active) {
      // Precipitation is reported
      if (!smoothing.precipActive && smoothing.precipOnsetTime === null) {
        smoothing.precipOnsetTime = now
      }
      smoothing.precipCessationTime = null
    } else {
      // No precipitation reported
      if (smoothing.precipActive && smoothing.precipCessationTime === null) {
        smoothing.precipCessationTime = now
      }
      smoothing.precipOnsetTime = null
    }

    // Check onset delay
    if (smoothing.precipOnsetTime !== null) {
      const elapsed = (now - smoothing.precipOnsetTime) / 1000
      if (elapsed >= PRECIPITATION_ONSET_DELAY) {
        smoothing.precipActive = true
        smoothing.precipOnsetTime = null
      }
    }

    // Check cessation delay
    if (smoothing.precipCessationTime !== null) {
      const elapsed = (now - smoothing.precipCessationTime) / 1000
      if (elapsed >= PRECIPITATION_CESSATION_DELAY) {
        smoothing.precipActive = false
        smoothing.precipCessationTime = null
      }
    }

    // Handle thunderstorm hysteresis
    if (precipitation.hasThunderstorm) {
      if (!smoothing.thunderstormActive && smoothing.thunderstormOnsetTime === null) {
        smoothing.thunderstormOnsetTime = now
      }
      smoothing.thunderstormCessationTime = null
    } else {
      if (smoothing.thunderstormActive && smoothing.thunderstormCessationTime === null) {
        smoothing.thunderstormCessationTime = now
      }
      smoothing.thunderstormOnsetTime = null
    }

    if (smoothing.thunderstormOnsetTime !== null) {
      const elapsed = (now - smoothing.thunderstormOnsetTime) / 1000
      if (elapsed >= THUNDERSTORM_ONSET_DELAY) {
        smoothing.thunderstormActive = true
        smoothing.thunderstormOnsetTime = null
      }
    }

    if (smoothing.thunderstormCessationTime !== null) {
      const elapsed = (now - smoothing.thunderstormCessationTime) / 1000
      if (elapsed >= THUNDERSTORM_CESSATION_DELAY) {
        smoothing.thunderstormActive = false
        smoothing.thunderstormCessationTime = null
      }
    }

    // Set target intensity based on hysteresis-processed active state
    smoothing.targetIntensity = smoothing.precipActive ? 1 : 0

    // Smooth intensity factor toward target (exponential smoothing)
    const fadeLerpFactor = 1 - Math.exp(-deltaTime / (PRECIPITATION_FADE_TIME / 3))
    if (Math.abs(smoothing.currentIntensity - smoothing.targetIntensity) > 0.01) {
      smoothing.currentIntensity += (smoothing.targetIntensity - smoothing.currentIntensity) * fadeLerpFactor
    } else {
      smoothing.currentIntensity = smoothing.targetIntensity
    }

    // Smooth thunderstorm factor
    const targetThunder = smoothing.thunderstormActive ? 1 : 0
    if (Math.abs(smoothing.thunderstormFactor - targetThunder) > 0.01) {
      smoothing.thunderstormFactor += (targetThunder - smoothing.thunderstormFactor) * fadeLerpFactor
    } else {
      smoothing.thunderstormFactor = targetThunder
    }

    smoothing.initialized = true

    // Update wind state (gust simulation)
    updateWindState(deltaTime)

    // Update particle emitter positions and apply smoothed intensity
    particleSystemsRef.current.forEach((data) => {
      // Different heights for different precipitation types
      // Rain: 50m above (falls fast), Snow: 30m above (falls slow)
      const isSnowType = data.type === 'snow' || data.type === 'ice'
      const emitterHeight = isSnowType ? 30 : 50

      const newPos = new BABYLON.Vector3(
        camera.position.x,
        camera.position.y + emitterHeight,
        camera.position.z
      )
      data.system.emitter = newPos

      // Apply wind effects
      applyWindToSystem(data.system, data.type)

      // Apply smoothed intensity to emit rate
      // This creates gradual fade in/out of precipitation
      data.system.emitRate = data.baseEmitRate * smoothing.currentIntensity
    })

    // Update lightning
    updateLightning()
  }, [scene, camera, precipitation.active, precipitation.hasThunderstorm, updateWindState, applyWindToSystem, updateLightning])

  /**
   * Main effect: create/update/dispose particle systems based on weather
   */
  useEffect(() => {
    if (!scene || !camera) return

    // Abort flag for async operations (prevents race conditions)
    let aborted = false

    // Capture ref values for cleanup (React hooks exhaustive-deps best practice)
    const systems = particleSystemsRef.current
    const timeouts = lightningTimeoutsRef.current

    const shouldShowPrecip = showWeatherEffects && showPrecipitation && precipitation.active && !isTopDownView
    const shouldShowLightning = showWeatherEffects && showLightning && precipitation.hasThunderstorm && !isTopDownView

    // Sync smoothing state with store state when effect runs
    // This fixes race conditions where the airport change effect snaps smoothing to false
    // before the weather fetch completes, causing emit rate to be 0 initially
    const smoothing = precipSmoothingRef.current
    if (shouldShowPrecip && !smoothing.precipActive) {
      smoothing.precipActive = true
      smoothing.currentIntensity = 1
      smoothing.targetIntensity = 1
      smoothing.precipOnsetTime = null
      smoothing.precipCessationTime = null
    } else if (!shouldShowPrecip && smoothing.precipActive && !precipitation.active) {
      // Also sync when precipitation becomes inactive
      smoothing.precipActive = false
      smoothing.currentIntensity = 0
      smoothing.targetIntensity = 0
      smoothing.precipOnsetTime = null
      smoothing.precipCessationTime = null
    }

    /**
     * Helper to dispose a particle system and its texture
     */
    const disposeSystem = (data: ParticleSystemData) => {
      data.system.stop()
      // Dispose texture before disposing system
      if (data.system.particleTexture) {
        data.system.particleTexture.dispose()
      }
      data.system.dispose()
    }

    // Check if recreateCounter changed (camera jump detected)
    const counterChanged = recreateCounter !== lastRecreateCounterRef.current
    lastRecreateCounterRef.current = recreateCounter

    // Dispose existing particle systems if:
    // 1) Precipitation should be hidden, OR
    // 2) Counter changed (camera jumped) - forces recreation with pre-warming
    if (!shouldShowPrecip || counterChanged) {
      particleSystemsRef.current.forEach((data) => {
        disposeSystem(data)
      })
      particleSystemsRef.current.clear()
    }

    // Handle case where we only need lightning (no precipitation)
    if (!shouldShowPrecip && !shouldShowLightning) {
      // Remove render observer - nothing to update
      if (renderObserverRef.current) {
        scene.onBeforeRenderObservable.remove(renderObserverRef.current)
        renderObserverRef.current = null
      }
      return
    }

    // Register observer for lightning-only case (no precipitation but has thunderstorm)
    if (!shouldShowPrecip && shouldShowLightning) {
      if (!renderObserverRef.current) {
        renderObserverRef.current = scene.onBeforeRenderObservable.add(updatePrecipitation)
      }
      return
    }

    // Track which types we need
    const neededTypes = new Set<string>()
    precipitation.types.forEach(p => {
      // Map similar types to same particle system
      if (p.type === 'rain' || p.type === 'drizzle' || p.type === 'hail' || p.type === 'unknown') {
        neededTypes.add('rain')
      } else if (p.type === 'snow' || p.type === 'ice') {
        neededTypes.add('snow')
      }
    })

    // Remove systems for types no longer active
    particleSystemsRef.current.forEach((data, key) => {
      if (!neededTypes.has(key)) {
        disposeSystem(data)
        particleSystemsRef.current.delete(key)
      }
    })

    // Create or update systems for each precipitation type (async)
    const createSystems = async () => {
      for (const precip of precipitation.types) {
        // Check abort flag before each async operation
        if (aborted) return

        // Determine system key (rain vs snow)
        const systemKey = (precip.type === 'snow' || precip.type === 'ice') ? 'snow' : 'rain'

        let data = particleSystemsRef.current.get(systemKey)

        if (!data) {
          // Create new system asynchronously
          const system = systemKey === 'snow'
            ? await createSnowSystemAsync()
            : await createRainSystemAsync()

          // Check abort flag after async operation completes
          if (aborted) {
            // Dispose the created system since we're aborting
            if (system) {
              if (system.particleTexture) {
                system.particleTexture.dispose()
              }
              system.dispose()
            }
            return
          }

          if (system) {
            // Calculate effective base emit rate including all intensity factors
            // This is what the render loop will use with smoothing
            const rawBaseEmitRate = getBaseEmitRate(precip.type)
            const intensityMult = getIntensityMultiplier(precip.intensity)
            const effectiveBaseEmitRate = rawBaseEmitRate * intensityMult * precipitation.visibilityFactor * precipitationIntensity

            data = { system, type: precip.type, baseEmitRate: effectiveBaseEmitRate }
            particleSystemsRef.current.set(systemKey, data)
            system.emitRate = effectiveBaseEmitRate
            system.start()
          }
        }

        if (data) {
          // Update emit rate if intensity/visibility changed (already stored in baseEmitRate for new systems)
          const intensityMult = getIntensityMultiplier(precip.intensity)
          const newEmitRate = getBaseEmitRate(precip.type) * intensityMult * precipitation.visibilityFactor * precipitationIntensity
          // Update stored base rate so render loop uses correct value
          data.baseEmitRate = newEmitRate
          data.system.emitRate = newEmitRate
        }
      }

      // Check abort flag before registering observer
      if (aborted) return

      // Register render observer if not already running
      // Need observer for precipitation particles AND/OR lightning
      const needsObserver = particleSystemsRef.current.size > 0 || precipitation.hasThunderstorm
      if (!renderObserverRef.current && needsObserver) {
        renderObserverRef.current = scene.onBeforeRenderObservable.add(updatePrecipitation)
      }
    }

    createSystems()

    // Cleanup on unmount or deps change
    return () => {
      // Set abort flag to cancel any pending async operations
      aborted = true

      if (renderObserverRef.current && scene && !scene.isDisposed) {
        scene.onBeforeRenderObservable.remove(renderObserverRef.current)
        renderObserverRef.current = null
      }

      // Clear all lightning timeouts
      timeouts.forEach((timeout) => clearTimeout(timeout))
      timeouts.clear()

      // Dispose lightning plane and its material
      if (lightningPlaneRef.current) {
        const material = lightningPlaneRef.current.material
        lightningPlaneRef.current.dispose()
        if (material) {
          material.dispose()
        }
        lightningPlaneRef.current = null
      }

      // Dispose particle systems and their textures
      systems.forEach((data) => {
        disposeSystem(data)
      })
      systems.clear()
    }
  }, [
    scene,
    camera,
    showWeatherEffects,
    showPrecipitation,
    showLightning,
    precipitation,
    precipitationIntensity,
    isTopDownView,
    recreateCounter,
    createRainSystemAsync,
    createSnowSystemAsync,
    getBaseEmitRate,
    getIntensityMultiplier,
    updatePrecipitation
  ])

  // Initialize lightning timing
  useEffect(() => {
    lightningStateRef.current.nextFlashTime = performance.now() +
      (LIGHTNING_INTERVAL_MIN + Math.random() * (LIGHTNING_INTERVAL_MAX - LIGHTNING_INTERVAL_MIN)) * 1000
  }, [])

  return {
    particleSystems: particleSystemsRef.current,
    isActive: particleSystemsRef.current.size > 0
  }
}

export default useBabylonPrecipitation
