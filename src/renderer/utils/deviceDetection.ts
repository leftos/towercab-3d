/**
 * Device Detection Utilities
 *
 * Provides functions to detect device capabilities and platform for
 * adapting UI and performance settings.
 */

/**
 * Check if the current device supports touch input
 */
export function isTouchDevice(): boolean {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0
}

/**
 * Check if the current device is an iPad
 * Handles both old Safari UA (contains "iPad") and new Safari UA (macOS with touch)
 */
export function isIPad(): boolean {
  // Old Safari UA string check
  if (/iPad/.test(navigator.userAgent)) {
    return true
  }

  // New Safari on iPadOS 13+ reports as Mac but has touch support
  if (/Macintosh/.test(navigator.userAgent) && isTouchDevice()) {
    return true
  }

  return false
}

/**
 * Check if running on iOS (iPhone/iPad)
 */
export function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && isTouchDevice())
}

/**
 * Check if running on a mobile device (phone or tablet)
 */
export function isMobileDevice(): boolean {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
    (isTouchDevice() && window.innerWidth < 1024)
}

/**
 * Check if running in a standalone PWA mode (added to home screen)
 */
export function isStandalonePWA(): boolean {
  return (
    ('standalone' in window.navigator && (window.navigator as unknown as { standalone: boolean }).standalone) ||
    window.matchMedia('(display-mode: standalone)').matches
  )
}

/**
 * Get device performance tier based on hardware and platform
 * Used to set appropriate default graphics settings
 */
export function getDevicePerformanceTier(): 'high' | 'medium' | 'low' {
  // Check for low-end indicators
  const isLowEnd =
    // Limited memory (< 4GB)
    ('deviceMemory' in navigator && (navigator as unknown as { deviceMemory: number }).deviceMemory < 4) ||
    // Limited CPU cores (< 4)
    (navigator.hardwareConcurrency && navigator.hardwareConcurrency < 4) ||
    // Older mobile devices
    (/Android [1-6]\./.test(navigator.userAgent))

  if (isLowEnd) {
    return 'low'
  }

  // iPad and most modern mobile devices are medium tier
  if (isIPad() || isMobileDevice()) {
    return 'medium'
  }

  // Desktop devices are high tier by default
  return 'high'
}

/**
 * Check if the device prefers reduced motion
 */
export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Get recommended settings for the current device
 */
export function getRecommendedSettings() {
  const tier = getDevicePerformanceTier()
  const touchDevice = isTouchDevice()

  return {
    // Graphics settings based on performance tier
    graphics: {
      shadows: tier === 'high',
      msaa: tier === 'high' ? 4 : tier === 'medium' ? 2 : 1,
      terrainQuality: tier === 'high' ? 4 : tier === 'medium' ? 2 : 1,
      buildings: tier === 'high',
      maxModelPoolSize: tier === 'high' ? 200 : tier === 'medium' ? 100 : 50,
      tileCacheSize: tier === 'high' ? 2000 : tier === 'medium' ? 1000 : 500
    },
    // UI settings based on input method
    ui: {
      // Minimum touch target size (Apple HIG recommends 44x44pt)
      minTouchTarget: touchDevice ? 44 : 32,
      // Show keyboard hints only on non-touch devices
      showKeyboardHints: !touchDevice,
      // Larger fonts on touch devices for readability
      fontSize: touchDevice ? 'large' : 'normal'
    }
  }
}
