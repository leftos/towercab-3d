/**
 * Aerodrome boundary types
 *
 * The shapes of `aerodromes.json.gz`: the OSM `aeroway=aerodrome` polygons of the towered
 * airports. A ring is a closed list of `[lon, lat]` pairs in degrees, as the data file holds it.
 */

/** One closed ring of `[lon, lat]` pairs, its last pair equal to its first. */
export type AerodromeRing = [number, number][]

/**
 * An airport's aerodrome boundary: the outer rings, and the holes cut out of them.
 *
 * The holes are one flat list per airport, not tied to an outer ring: a position is inside the
 * aerodrome when it is inside any outer ring and inside no hole.
 */
export interface AerodromeBoundary {
  /** Outer rings. */
  p: AerodromeRing[]
  /** Holes. */
  h?: AerodromeRing[]
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
