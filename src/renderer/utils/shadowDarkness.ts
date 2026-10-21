/**
 * Conversion between the app's shadow darkness setting and Cesium's `ShadowMap.darkness`.
 *
 * The two run in opposite directions. The setting is how dark a shadow is drawn:
 * 0 makes shadows invisible and 1 makes them black. Cesium's value is the light left
 * in a shadowed pixel, its shader taking `max(visibility, darkness)`: 0 is black and
 * 1 is no shadow at all.
 */

/**
 * Converts the app's shadow darkness setting to Cesium's `ShadowMap.darkness`.
 *
 * Args:
 *   shadowDarkness: The setting, 0 (invisible shadows) to 1 (black shadows). A value
 *     outside that range is clamped to it.
 *
 * Returns:
 *   Cesium's darkness, 1 (no shadow) to 0 (black).
 */
export function toCesiumShadowDarkness(shadowDarkness: number): number {
  return Math.min(1, Math.max(0, 1 - shadowDarkness))
}
