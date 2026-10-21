/**
 * Environment-map options for Cesium primitives.
 *
 * Cesium's dynamic environment map tints image-based lighting with the colour of the
 * ground below it, and its default ground colour (`#717145`) is an olive that casts a
 * green tint over OSM buildings and aircraft models. A neutral grey of the same
 * luminance removes the tint without changing how bright the scene is lit.
 */

import * as Cesium from 'cesium'
import { ENVIRONMENT_MAP_GROUND_COLOR } from '@/constants'

/**
 * Environment-map options with a neutral grey ground colour.
 *
 * `groundColor` is required here because this helper always sets it, which spares callers
 * and tests a check Cesium's own option type asks for.
 */
export interface NeutralEnvironmentMapOptions extends Cesium.DynamicEnvironmentMapManager.ConstructorOptions {
  groundColor: Cesium.Color
}

/**
 * Options that give a Cesium tileset or model an untinted environment map.
 *
 * Every call returns a new object holding a new colour, since Cesium keeps the colour on
 * the primitive's own environment map manager.
 *
 * @returns The `environmentMapOptions` creation option for a tileset or model
 */
export function neutralEnvironmentMapOptions(): NeutralEnvironmentMapOptions {
  return {
    groundColor: Cesium.Color.fromCssColorString(ENVIRONMENT_MAP_GROUND_COLOR),
  }
}
