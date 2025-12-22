import { useEffect, useRef, useCallback } from 'react'
import * as BABYLON from '@babylonjs/core'
import { useWeatherStore } from '../stores/weatherStore'
import { useSettingsStore } from '../stores/settingsStore'
import type { PrecipitationType } from '@/types'
import {
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
  SNOW_PARTICLE_LIFETIME,
  SNOW_PARTICLE_SIZE_MIN,
  SNOW_PARTICLE_SIZE_MAX,
  SNOW_VELOCITY,
  SNOW_DRIFT_RANGE,
  SNOW_PARTICLE_CAPACITY,
  SNOW_WIND_GRAVITY,
  // Emitter
  EMITTER_BOX_SIZE,
  EMITTER_HEIGHT_ABOVE_CAMERA,
  EMITTER_HEIGHT_RANGE,
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
  VARIABLE_WIND_VARIANCE
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

  // Find hemispheric light from scene (for lightning effects)
  const hemisphericLight = scene?.lights.find(
    (l): l is BABYLON.HemisphericLight => l instanceof BABYLON.HemisphericLight
  ) ?? null

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

  // Babylon render observer reference for cleanup
  const renderObserverRef = useRef<BABYLON.Observer<BABYLON.Scene> | null>(null)

  // Weather store subscriptions
  const precipitation = useWeatherStore((state) => state.precipitation)
  const wind = useWeatherStore((state) => state.wind)

  // Settings subscriptions
  const showWeatherEffects = useSettingsStore((state) => state.weather.showWeatherEffects)
  const showPrecipitation = useSettingsStore((state) => state.weather.showPrecipitation)
  const precipitationIntensity = useSettingsStore((state) => state.weather.precipitationIntensity)
  const showLightning = useSettingsStore((state) => state.weather.showLightning)

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

      // Use a simple procedural texture for rain drops
      const texture = new BABYLON.Texture('https://assets.babylonjs.com/textures/flare.png', scene)
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

      // Ensure particles render on top
      ps.renderingGroupId = 1

      return ps
    } catch (error) {
      console.error('[Precip] Failed to create rain system:', error)
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

      // Use a simple procedural texture for snowflakes
      const texture = new BABYLON.Texture('https://assets.babylonjs.com/textures/flare.png', scene)
      ps.particleTexture = texture

      // Configure emitter box above camera
      ps.emitter = new BABYLON.Vector3(0, EMITTER_HEIGHT_ABOVE_CAMERA, 0)
      ps.minEmitBox = new BABYLON.Vector3(-EMITTER_BOX_SIZE / 2, 0, -EMITTER_BOX_SIZE / 2)
      ps.maxEmitBox = new BABYLON.Vector3(EMITTER_BOX_SIZE / 2, EMITTER_HEIGHT_RANGE, EMITTER_BOX_SIZE / 2)

      // Adjust particle properties for our scale
      ps.minLifeTime = SNOW_PARTICLE_LIFETIME * 0.8
      ps.maxLifeTime = SNOW_PARTICLE_LIFETIME * 1.2
      ps.minSize = SNOW_PARTICLE_SIZE_MIN
      ps.maxSize = SNOW_PARTICLE_SIZE_MAX

      // Set velocity for falling snow with drift
      ps.direction1 = new BABYLON.Vector3(-SNOW_DRIFT_RANGE, SNOW_VELOCITY, -SNOW_DRIFT_RANGE)
      ps.direction2 = new BABYLON.Vector3(SNOW_DRIFT_RANGE, SNOW_VELOCITY * 0.8, SNOW_DRIFT_RANGE)
      ps.minEmitPower = 0.5
      ps.maxEmitPower = 1.0

      // Snow colors - white with slight transparency
      ps.color1 = new BABYLON.Color4(1.0, 1.0, 1.0, 0.9)
      ps.color2 = new BABYLON.Color4(0.95, 0.95, 1.0, 0.7)
      ps.colorDead = new BABYLON.Color4(1.0, 1.0, 1.0, 0.0)

      // Additive blending for visibility
      ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD

      // Add rotation for tumbling effect
      ps.minAngularSpeed = -Math.PI
      ps.maxAngularSpeed = Math.PI

      // Set emit rate
      ps.emitRate = SNOW_EMIT_RATE_BASE

      // Render on top
      ps.renderingGroupId = 1

      return ps
    } catch (error) {
      console.error('[Precip] Failed to create snow system:', error)
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
    const horizontalSpeed = ws.currentSpeed * WIND_EFFECT_SCALE

    // Get type-specific values
    const isSnowType = type === 'snow' || type === 'ice'
    const baseVelocity = isSnowType ? SNOW_VELOCITY : RAIN_VELOCITY
    const drift = isSnowType ? SNOW_DRIFT_RANGE : RAIN_DRIFT_RANGE
    const gravityStrength = isSnowType ? SNOW_WIND_GRAVITY : RAIN_WIND_GRAVITY

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
    ps.gravity = new BABYLON.Vector3(
      windVec.x * horizontalSpeed * 0.5,
      gravityStrength,
      windVec.z * horizontalSpeed * 0.5
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
   * Handle lightning flash effect
   */
  const updateLightning = useCallback(() => {
    if (!hemisphericLight || !precipitation.hasThunderstorm || !showLightning) {
      return
    }

    const ls = lightningStateRef.current
    const now = performance.now()

    if (ls.isFlashing) {
      // Currently flashing - check if flash duration elapsed
      // Flash is handled by setTimeout, this is just for state tracking
      return
    }

    if (now >= ls.nextFlashTime) {
      // Time for a flash
      ls.isFlashing = true
      ls.originalIntensity = hemisphericLight.intensity
      ls.flashCount = 0

      const doFlash = () => {
        if (!hemisphericLight) return

        // Flash bright
        hemisphericLight.intensity = LIGHTNING_FLASH_INTENSITY

        setTimeout(() => {
          if (!hemisphericLight) return

          // Return to normal
          hemisphericLight.intensity = ls.originalIntensity
          ls.flashCount++

          // Check for multi-flash
          if (
            Math.random() < LIGHTNING_MULTI_FLASH_PROBABILITY &&
            ls.flashCount < LIGHTNING_MULTI_FLASH_MAX
          ) {
            setTimeout(doFlash, LIGHTNING_MULTI_FLASH_DELAY_MS)
          } else {
            ls.isFlashing = false
            // Schedule next flash
            ls.nextFlashTime = now + (LIGHTNING_INTERVAL_MIN + Math.random() * (LIGHTNING_INTERVAL_MAX - LIGHTNING_INTERVAL_MIN)) * 1000
          }
        }, LIGHTNING_FLASH_DURATION_MS)
      }

      doFlash()
    }
  }, [hemisphericLight, precipitation.hasThunderstorm, showLightning])

  /**
   * Main update function - called by Babylon's render observable for perfect sync
   */
  const updatePrecipitation = useCallback(() => {
    if (!scene || !camera) return

    const deltaTime = scene.getEngine().getDeltaTime() / 1000

    // Update wind state (gust simulation)
    updateWindState(deltaTime)

    // Update particle emitter positions to follow camera
    particleSystemsRef.current.forEach((data) => {
      // Update emitter position - above camera
      const newPos = new BABYLON.Vector3(
        camera.position.x,
        camera.position.y + 50, // 50m above camera
        camera.position.z
      )
      data.system.emitter = newPos

      // Apply wind effects
      applyWindToSystem(data.system, data.type)
    })

    // Update lightning
    updateLightning()
  }, [scene, camera, updateWindState, applyWindToSystem, updateLightning])

  /**
   * Main effect: create/update/dispose particle systems based on weather
   */
  useEffect(() => {
    if (!scene || !camera) return

    // Capture ref value for cleanup (React hooks exhaustive-deps best practice)
    const systems = particleSystemsRef.current

    const shouldShowPrecip = showWeatherEffects && showPrecipitation && precipitation.active && !isTopDownView

    // Dispose existing systems if precipitation should be hidden
    if (!shouldShowPrecip) {
      particleSystemsRef.current.forEach((data) => {
        data.system.stop()
        data.system.dispose()
      })
      particleSystemsRef.current.clear()

      // Remove render observer
      if (renderObserverRef.current) {
        scene.onBeforeRenderObservable.remove(renderObserverRef.current)
        renderObserverRef.current = null
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
        data.system.stop()
        data.system.dispose()
        particleSystemsRef.current.delete(key)
      }
    })

    // Create or update systems for each precipitation type (async)
    const createSystems = async () => {
      for (const precip of precipitation.types) {
        // Determine system key (rain vs snow)
        const systemKey = (precip.type === 'snow' || precip.type === 'ice') ? 'snow' : 'rain'

        let data = particleSystemsRef.current.get(systemKey)

        if (!data) {
          // Create new system asynchronously
          const system = systemKey === 'snow'
            ? await createSnowSystemAsync()
            : await createRainSystemAsync()

          if (system) {
            const baseEmitRate = getBaseEmitRate(precip.type)
            data = { system, type: precip.type, baseEmitRate }
            particleSystemsRef.current.set(systemKey, data)
            system.start()
          }
        }

        if (data) {
          // Update emit rate based on intensity, visibility, and user setting
          const intensityMult = getIntensityMultiplier(precip.intensity)
          const newEmitRate = data.baseEmitRate * intensityMult * precipitation.visibilityFactor * precipitationIntensity
          data.system.emitRate = newEmitRate
        }
      }

      // Register render observer if not already running
      if (!renderObserverRef.current && particleSystemsRef.current.size > 0) {
        renderObserverRef.current = scene.onBeforeRenderObservable.add(updatePrecipitation)
      }
    }

    createSystems()

    // Cleanup on unmount
    return () => {
      if (renderObserverRef.current && scene && !scene.isDisposed) {
        scene.onBeforeRenderObservable.remove(renderObserverRef.current)
        renderObserverRef.current = null
      }

      systems.forEach((data) => {
        data.system.stop()
        data.system.dispose()
      })
      systems.clear()
    }
  }, [
    scene,
    camera,
    showWeatherEffects,
    showPrecipitation,
    precipitation,
    precipitationIntensity,
    isTopDownView,
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
