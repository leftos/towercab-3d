import * as Cesium from 'cesium'
import { type MouseEvent, useState } from 'react'
import {
  buildMapCreditList,
  FIXED_MAP_CREDITS,
  type MapCreditEntry,
  readCesiumCreditHtml,
} from '../../utils/mapCredits'
import { shellApi } from '../../utils/tauriApi'
import CollapsibleSection from './settings/CollapsibleSection'
import './SettingsAboutTab.css'

/** Extracts a credit's visible text from its html. */
function htmlToText(html: string): string {
  return new DOMParser().parseFromString(html, 'text/html').body.textContent ?? ''
}

/** The merged credit list, and whether Cesium's own credits could be read. */
interface ReadCreditsResult {
  credits: MapCreditEntry[]
  creditsUnavailable: boolean
}

/**
 * Reads the credit list once, when the tab opens.
 *
 * The credits belong to the viewer's last rendered frame, so this is a snapshot of what the app is
 * showing right now rather than a live subscription.
 */
function readCredits(): ReadCreditsResult {
  try {
    return {
      credits: buildMapCreditList(FIXED_MAP_CREDITS, readCesiumCreditHtml(), htmlToText),
      creditsUnavailable: false,
    }
  } catch (error) {
    console.error('Failed to read the Cesium imagery and terrain credits:', error)
    return { credits: buildMapCreditList(FIXED_MAP_CREDITS, [], htmlToText), creditsUnavailable: true }
  }
}

/** Opens a credit link in the system browser, the way every other external link in the app does. */
function openCreditLink(event: MouseEvent<HTMLUListElement>) {
  const anchor = (event.target as Element).closest('a[href]')
  if (!(anchor instanceof HTMLAnchorElement)) return

  const { href } = anchor
  if (!href.startsWith('http://') && !href.startsWith('https://')) return

  event.preventDefault()
  void shellApi.openExternal(href)
}

/** One Cesium credit, rendered as Cesium's own sanitized element. */
function CesiumCredit({ html }: { html: string }) {
  return (
    <li
      ref={(element) => {
        if (!element) return
        element.replaceChildren(new Cesium.Credit(html).element.cloneNode(true))
      }}
    />
  )
}

function SettingsAboutTab() {
  const [{ credits, creditsUnavailable }] = useState(readCredits)

  return (
    <>
      <CollapsibleSection title="TowerCab 3D" defaultExpanded>
        <div className="setting-item">
          <p className="setting-hint">Version {APP_VERSION}</p>
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Map data" defaultExpanded>
        <img className="about-ion-logo" src={Cesium.buildModuleUrl('Assets/Images/ion-credit.png')} alt="Cesium ion" />
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: the links inside are the focusable elements; this only routes their clicks to the system browser */}
        <ul className="about-credit-list" onClick={openCreditLink}>
          {credits.map((credit) =>
            credit.kind === 'fixed' ? (
              <li key={credit.href}>
                <a href={credit.href} target="_blank" rel="noopener noreferrer">
                  {credit.text}
                </a>
              </li>
            ) : (
              <CesiumCredit key={credit.html} html={credit.html} />
            ),
          )}
        </ul>
        {creditsUnavailable && <p className="setting-hint">Imagery and terrain credits are unavailable.</p>}
      </CollapsibleSection>
    </>
  )
}

export default SettingsAboutTab
