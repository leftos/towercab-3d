import { AssociativeArray, Credit, CreditDisplay } from 'cesium'
import { describe, expect, it } from 'vitest'
import {
  buildMapCreditList,
  FIXED_MAP_CREDITS,
  readCesiumCreditHtml,
  setMapCreditSource,
} from '../src/renderer/utils/mapCredits'

/** Stands in for the DOMParser-based text extraction the About tab passes in. */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

function fakeDisplay(frameCredits: unknown): CreditDisplay {
  return { _currentFrameCredits: frameCredits } as unknown as CreditDisplay
}

/** A stand-in for a rendered display, whose lists Cesium's own addCreditToNextFrame fills. */
function emptyDisplay(): CreditDisplay {
  return {
    _currentFrameCredits: { screenCredits: new AssociativeArray(), lightboxCredits: new AssociativeArray() },
    _creditDisplayElementPool: [],
    _creditDisplayElementPoolIndex: 0,
  } as unknown as CreditDisplay
}

describe('buildMapCreditList', () => {
  it('fixed lines come first and keep their order', () => {
    const fixed = [
      { text: 'First source', href: 'https://first.example/copyright' },
      { text: 'Second source', href: 'https://second.example/copyright' },
    ]

    const list = buildMapCreditList(fixed, ['<a href="https://third.example">Third source</a>'], stripTags)

    expect(list).toEqual([
      { kind: 'fixed', text: 'First source', href: 'https://first.example/copyright' },
      { kind: 'fixed', text: 'Second source', href: 'https://second.example/copyright' },
      { kind: 'cesium', html: '<a href="https://third.example">Third source</a>', text: 'Third source' },
    ])
  })

  it('a Cesium credit with the same text as a fixed line is dropped', () => {
    const list = buildMapCreditList(FIXED_MAP_CREDITS, ['© OpenStreetMap contributors'], stripTags)

    expect(list).toEqual([
      { kind: 'fixed', text: '© OpenStreetMap contributors', href: 'https://www.openstreetmap.org/copyright' },
    ])
  })

  it('duplicates differing only in case and whitespace collapse to the first', () => {
    const list = buildMapCreditList([], ['<a>Bing  Maps</a>', '<a>  bing\tmaps </a>'], stripTags)

    expect(list).toEqual([{ kind: 'cesium', html: '<a>Bing  Maps</a>', text: 'Bing  Maps' }])
  })

  it('an image-only Cesium credit is kept, keyed by its html', () => {
    const logo = '<a href="https://www.bing.com/maps"><img src="bing-logo.png" alt="Bing"></a>'
    const otherLogo = '<a href="https://www.google.com/maps"><img src="google-logo.png" alt="Google"></a>'

    const list = buildMapCreditList([], [logo, logo, otherLogo], stripTags)

    expect(list).toEqual([
      { kind: 'cesium', html: logo, text: '' },
      { kind: 'cesium', html: otherLogo, text: '' },
    ])
  })

  it('an empty text-only Cesium credit is dropped', () => {
    const list = buildMapCreditList([], ['<a href="https://example.com"></a>', '   '], stripTags)

    expect(list).toEqual([])
  })
})

describe('readCesiumCreditHtml', () => {
  it('readCesiumCreditHtml returns [] with no source and reads both lists from a registered display', () => {
    setMapCreditSource(null)
    expect(readCesiumCreditHtml()).toEqual([])

    const display = emptyDisplay()
    CreditDisplay.prototype.addCreditToNextFrame.call(display, new Credit('<a>Screen credit</a>', true))
    CreditDisplay.prototype.addCreditToNextFrame.call(display, new Credit('<a>Lightbox credit</a>', false))
    setMapCreditSource(display)

    expect(readCesiumCreditHtml()).toEqual(['<a>Screen credit</a>', '<a>Lightbox credit</a>'])

    setMapCreditSource(null)
    expect(readCesiumCreditHtml()).toEqual([])
  })

  it('readCesiumCreditHtml throws a named error when _currentFrameCredits is missing', () => {
    setMapCreditSource(fakeDisplay(undefined))

    expect(() => readCesiumCreditHtml()).toThrow(
      'Cesium CreditDisplay._currentFrameCredits is missing; map credits cannot be read (Cesium version changed?)',
    )
  })

  it('readCesiumCreditHtml throws a named error when a credit entry has no html', () => {
    const display = emptyDisplay() as unknown as {
      _currentFrameCredits: { screenCredits: AssociativeArray; lightboxCredits: AssociativeArray }
    }
    display._currentFrameCredits.screenCredits.values.push({ credit: {}, count: 1 })

    setMapCreditSource(display as unknown as CreditDisplay)

    expect(() => readCesiumCreditHtml()).toThrow(
      'Cesium credit entry has no html; map credits cannot be read (Cesium version changed?)',
    )
  })
})
