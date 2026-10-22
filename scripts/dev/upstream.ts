/** The one upstream `/api/proxy` forwards to. */
const METAR_HOST = 'aviationweather.gov'
const METAR_PATH = '/api/data/metar'
const METAR_PARAMS = new Set(['ids', 'bbox', 'format'])
/** The one `format` the proxy asks for, so an upstream reply is never HTML or script. */
const METAR_FORMAT = 'json'

/** An upstream call that did not give a usable reply: a redirect, too large a body, or no answer. */
export class UpstreamError extends Error {}

/** An upstream reply, read whole. */
export interface UpstreamReply {
  status: number
  contentType: string
  body: Buffer
}

/** Bounds on one upstream call. */
export interface UpstreamLimits {
  timeoutMs: number
  maxBytes: number
}

/**
 * The METAR API URL in a `/api/proxy?url=` value, or null for anything else: only
 * `https://aviationweather.gov/api/data/metar` on the default port, without credentials, with no
 * query parameter but `ids`, `bbox` and `format`, and `format=json` given exactly once.
 */
export function metarTarget(raw: string): URL | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    // Not a URL at all: refused like any URL that is not the METAR API.
    return null
  }
  const isMetarApi =
    url.protocol === 'https:' &&
    url.hostname === METAR_HOST &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === METAR_PATH &&
    url.hash === ''
  if (!isMetarApi) return null
  const formats = url.searchParams.getAll('format')
  if (formats.length !== 1 || formats[0] !== METAR_FORMAT) return null
  return [...url.searchParams.keys()].every((key) => METAR_PARAMS.has(key)) ? url : null
}

async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new UpstreamError('upstream body over the size limit')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/**
 * GETs `url` with only `headers`, never following a redirect, within `limits`.
 *
 * Raises:
 *     UpstreamError: The upstream answered with a redirect or a body over `limits.maxBytes`.
 *     Error: The call failed or timed out (from `fetchImpl`).
 */
export async function fetchCapped(
  fetchImpl: typeof fetch,
  url: URL,
  headers: Record<string, string>,
  limits: UpstreamLimits,
): Promise<UpstreamReply> {
  const response = await fetchImpl(url.href, {
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(limits.timeoutMs),
  })
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel()
    throw new UpstreamError('upstream answered with a redirect')
  }
  const body = await readCapped(response, limits.maxBytes)
  return { status: response.status, contentType: response.headers.get('content-type') ?? 'application/octet-stream', body }
}
