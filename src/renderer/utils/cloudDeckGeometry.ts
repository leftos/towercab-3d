/**
 * Geometry of the weather stage's cloud deck against the earth's curvature.
 *
 * The cloud shader models the deck as a slab that follows the earth down with
 * the parabola z + d^2 / (2R) at horizontal distance d. These helpers mirror
 * that model on the CPU so tests can check where the deck's far edge sits
 * against the geometric horizon seen from the camera.
 */

/** Mean earth radius in meters; the cloud shader's `EARTH_R` must equal it. */
export const EARTH_RADIUS_M = 6_371_000

const RAD_TO_DEG = 180 / Math.PI

/**
 * How far the earth's surface falls below the local horizontal plane.
 *
 * Args:
 *   distanceM: Horizontal distance from the tangent point, in meters.
 *
 * Returns:
 *   The drop in meters, d^2 / (2R).
 */
export function curvatureDropM(distanceM: number): number {
  return (distanceM * distanceM) / (2 * EARTH_RADIUS_M)
}

/**
 * Angle of the geometric horizon below level, seen from a height above the ground.
 *
 * Args:
 *   cameraAglM: Camera height above the ground in meters (0 or more).
 *
 * Returns:
 *   The dip in degrees, sqrt(2h / R), positive downward.
 */
export function horizonDipDeg(cameraAglM: number): number {
  return Math.sqrt((2 * cameraAglM) / EARTH_RADIUS_M) * RAD_TO_DEG
}

/**
 * Elevation of the deck base's far edge seen from the camera.
 *
 * Args:
 *   cameraAglM: Camera height above the ground in meters.
 *   baseAglM: Deck base height above the ground in meters.
 *   deckRadiusM: Horizontal distance to the deck's edge in meters.
 *   curved: Whether the deck follows the earth's curvature (false is a flat plane).
 *
 * Returns:
 *   The elevation in degrees above level (negative below level).
 */
export function deckEdgeElevationDeg(
  cameraAglM: number,
  baseAglM: number,
  deckRadiusM: number,
  curved: boolean,
): number {
  const baseZ = curved ? baseAglM - curvatureDropM(deckRadiusM) : baseAglM
  return Math.atan2(baseZ - cameraAglM, deckRadiusM) * RAD_TO_DEG
}

/**
 * Order in which a ray from the camera meets the cloud layers, as the cloud shader marches them.
 *
 * Layers under the camera come first, highest down, then the layers over it, lowest up. The
 * ray's slope does not change the order: on the curved deck a ray that starts downward still
 * rises into the layers above the camera.
 *
 * Args:
 *   cameraDeckZM: Camera height above the curved deck datum in meters.
 *   layerBasesM: Layer bases in meters, sorted lowest first.
 *
 * Returns:
 *   Layer indices in march order.
 */
export function cloudLayerMarchOrder(cameraDeckZM: number, layerBasesM: readonly number[]): number[] {
  const below = layerBasesM.filter((base) => base <= cameraDeckZM).length
  return layerBasesM.map((_base, k) => (k < below ? below - 1 - k : k))
}

/**
 * Smallest curved-deck radius whose base edge reaches the geometric horizon.
 *
 * Solves (base - d^2 / (2R) - camera) / d = -sqrt(2 camera / R) for d, in the
 * small-angle form the deck model uses.
 *
 * Args:
 *   cameraAglM: Camera height above the ground in meters (0 or more).
 *   baseAglM: Deck base height above the ground in meters (0 or more).
 *
 * Returns:
 *   The radius in meters.
 */
export function minDeckRadiusForHorizonM(cameraAglM: number, baseAglM: number): number {
  const a = 1 / (2 * EARTH_RADIUS_M)
  const dip = Math.sqrt((2 * cameraAglM) / EARTH_RADIUS_M)
  const rise = baseAglM - cameraAglM
  return (dip + Math.sqrt(dip * dip + 4 * a * rise)) / (2 * a)
}
