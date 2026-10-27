import type { CreditDisplay } from 'cesium'

/** A credit line the app always shows, whatever the viewer rendered. */
export interface FixedMapCredit {
  /** Text shown to the user. */
  text: string
  /** Page the text links to. */
  href: string
}

/** One entry of the map data credit list shown on the About tab. */
export type MapCreditEntry =
  | { kind: 'fixed'; text: string; href: string }
  | { kind: 'cesium'; html: string; text: string }

/**
 * Credit lines the app always shows, in display order.
 *
 * Fixed entries are data so a new map source adds one entry here (the Overture Maps line arrives
 * with its places hint) instead of changing the About tab.
 */
export const FIXED_MAP_CREDITS: readonly FixedMapCredit[] = [
  { text: '© OpenStreetMap contributors', href: 'https://www.openstreetmap.org/copyright' },
]

/** One entry of a credit list, in Cesium's own CreditDisplayElement shape. */
interface CreditDisplayEntry {
  credit?: { html?: unknown }
  count?: number
}

/** The private CreditDisplay state that holds the credits of the last rendered frame. */
interface CreditDisplayCurrentFrameCredits {
  screenCredits?: { values?: readonly CreditDisplayEntry[] }
  lightboxCredits?: { values?: readonly CreditDisplayEntry[] }
}

interface CreditDisplayInternals {
  _currentFrameCredits?: CreditDisplayCurrentFrameCredits
}

/** The main viewer's credit display, or null while no viewer is registered. */
let creditSource: CreditDisplay | null = null

/**
 * Registers the display whose last frame's credits the About tab reads, or clears it with null.
 *
 * Only the main viewer registers: insets show the same terrain and imagery.
 *
 * @param display the main viewer's credit display, or null when its viewer is gone.
 */
export function setMapCreditSource(display: CreditDisplay | null): void {
  creditSource = display
}

/**
 * Reads the html of every credit the registered display collected in its last rendered frame.
 *
 * @returns the screen credits' html followed by the lightbox credits' html, or an empty array when
 *   no display is registered.
 * @throws {Error} when the display's frame credits are missing, which means Cesium changed the
 *   private internals this module reads.
 */
export function readCesiumCreditHtml(): string[] {
  if (!creditSource) return []

  const frameCredits = (creditSource as unknown as CreditDisplayInternals)._currentFrameCredits
  const screenCredits = frameCredits?.screenCredits?.values
  const lightboxCredits = frameCredits?.lightboxCredits?.values
  if (!screenCredits || !lightboxCredits) {
    throw new Error(
      'Cesium CreditDisplay._currentFrameCredits is missing; map credits cannot be read (Cesium version changed?)',
    )
  }

  return [...screenCredits, ...lightboxCredits].map((entry) => {
    const html = entry?.credit?.html
    if (typeof html !== 'string') {
      throw new Error('Cesium credit entry has no html; map credits cannot be read (Cesium version changed?)')
    }
    return html
  })
}

/** Collapses whitespace, trims and lower-cases a credit text into its de-duplication key. */
function creditKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Merges the app's fixed credit lines with the credits Cesium collected, dropping duplicates.
 *
 * @param fixed the app's own credit lines, shown first in their own order.
 * @param cesiumHtml the html of each collected Cesium credit, in the order read.
 * @param toText extracts a credit's text from its html.
 * @returns the fixed entries, then the Cesium entries. The first occurrence of a duplicate wins, and
 *   a Cesium credit with no text is kept only when its html holds an image, keyed by that html.
 */
export function buildMapCreditList(
  fixed: readonly FixedMapCredit[],
  cesiumHtml: readonly string[],
  toText: (html: string) => string,
): MapCreditEntry[] {
  const entries: MapCreditEntry[] = []
  const seen = new Set<string>()

  for (const credit of fixed) {
    const key = creditKey(credit.text)
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({ kind: 'fixed', text: credit.text, href: credit.href })
  }

  for (const html of cesiumHtml) {
    const text = toText(html)
    const isLogoCredit = text.trim() === '' && html.includes('<img')
    if (text.trim() === '' && !isLogoCredit) continue

    const key = isLogoCredit ? html : creditKey(text)
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({ kind: 'cesium', html, text })
  }

  return entries
}
