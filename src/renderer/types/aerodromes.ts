/**
 * Aerodrome boundary types
 *
 * The shapes of `aerodromes.json.gz`: the OSM `aeroway=aerodrome` polygons of the towered
 * airports. A ring is a closed list of `[lon, lat]` pairs in degrees, as the data file holds it.
 */

/** One closed ring of `[lon, lat]` pairs, its last pair equal to its first. */
export type AerodromeRing = [number, number][]

/** One polygon of an aerodrome boundary: an outer ring and the holes cut out of it. */
export interface AerodromePolygon {
  /** The polygon's outer ring. */
  outer: AerodromeRing
  /** Holes cut out of the outer ring. */
  holes?: AerodromeRing[]
}

/**
 * An airport's aerodrome boundary: its polygons, each with its own holes.
 *
 * A position is inside the aerodrome when it is inside one polygon's outer ring and inside none of
 * that polygon's holes. A polygon inside another polygon's hole is a polygon of its own, so a
 * position on it is inside; a polygon inside another's outer ring with no hole cuts nothing out.
 */
export interface AerodromeBoundary {
  /** The airport's polygons. */
  polygons: AerodromePolygon[]
}

/** Metadata of the aerodromes file. */
export interface AerodromeMeta {
  /** The script that generated the file. */
  generator: string
  /** Licence of the data. */
  licence: string
  /** Data source. */
  source: string
}

/** Root structure of the `aerodromes.json.gz` file. */
export interface AerodromeData {
  /** File metadata */
  _meta: AerodromeMeta
  /** Aerodrome boundaries indexed by ICAO code */
  airports: Record<string, AerodromeBoundary>
}
