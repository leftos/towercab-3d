/**
 * Removes a URL's query and fragment, keeping only the part before them.
 *
 * A vNAS OAuth callback URL carries a one-time authorization code in its query,
 * so anything that logs such a URL logs it through this function.
 *
 * @param url - The URL to redact.
 * @returns The URL up to the first `?` or `#`, or the whole URL when it has neither.
 */
export function urlWithoutQuery(url: string): string {
  const end = url.search(/[?#]/)
  return end === -1 ? url : url.slice(0, end)
}
