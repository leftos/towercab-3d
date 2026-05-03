/**
 * Cesium Ion access token validation.
 *
 * Two-stage check: a cheap regex pre-check rejects obvious garbage without
 * a network round-trip, then a request to the Cesium Ion `/v1/me` endpoint
 * confirms the token is actually accepted by Ion.
 *
 * Network failures (offline, firewalled, DNS) return `unverified` rather
 * than `invalid` so callers can offer a "save anyway" path.
 */

const ION_ME_ENDPOINT = 'https://api.cesium.com/v1/me'
const VALIDATION_TIMEOUT_MS = 5000

// Cesium Ion tokens are JWTs: three base64url segments separated by dots.
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

export type CesiumTokenValidationStatus = 'valid' | 'invalid' | 'unverified'

export interface CesiumTokenValidationResult {
  status: CesiumTokenValidationStatus
  /** Human-readable explanation suitable for inline UI display. */
  message: string
}

/**
 * Validate a Cesium Ion access token.
 *
 * - Returns `invalid` immediately if the token doesn't match the JWT shape.
 * - Calls `GET https://api.cesium.com/v1/me` with the token; 200 → valid,
 *   401/403 → invalid, anything else (including network errors and timeouts)
 *   → unverified.
 */
export async function validateCesiumIonToken(token: string): Promise<CesiumTokenValidationResult> {
  const trimmed = token.trim()
  if (!trimmed) {
    return { status: 'invalid', message: 'Token is empty.' }
  }
  if (!JWT_SHAPE.test(trimmed)) {
    return {
      status: 'invalid',
      message: "Doesn't look like a Cesium Ion token. Tokens have three dot-separated parts.",
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS)
  try {
    const response = await fetch(ION_ME_ENDPOINT, {
      headers: { Authorization: `Bearer ${trimmed}` },
      signal: controller.signal,
    })
    if (response.ok) {
      return { status: 'valid', message: 'Token verified with Cesium Ion.' }
    }
    if (response.status === 401 || response.status === 403) {
      return {
        status: 'invalid',
        message: 'Cesium Ion rejected this token. Check that you copied the full token.',
      }
    }
    return {
      status: 'unverified',
      message: `Cesium Ion returned ${response.status}. Couldn't verify the token.`,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error'
    return {
      status: 'unverified',
      message: `Couldn't reach Cesium Ion (${reason}).`,
    }
  } finally {
    clearTimeout(timeout)
  }
}
