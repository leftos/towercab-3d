import { realpathSync, statSync } from 'node:fs'
import { extname, join, sep } from 'node:path'

/** Where an untrusted request path leads under a root folder. */
export type ResolvedPath = { kind: 'file'; path: string } | { kind: 'refused' } | { kind: 'missing' }

const REFUSED: ResolvedPath = { kind: 'refused' }
const MISSING: ResolvedPath = { kind: 'missing' }

// Controls and the characters Windows refuses in a name; `:` also rules out drive prefixes and NTFS streams.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what this refuses
const RESERVED_CHARS = /[\u0000-\u001f\u007f<>:"|?*]/
// DOS device names, which Windows opens as devices whatever folder or extension they carry, also
// with spaces before the extension (`CON .glb`) or a trailing dot (`con.`).
const DOS_DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³]) *(\..*)?$/i

/**
 * Whether one path segment is a plain file or folder name that cannot leave its parent: not empty, no
 * leading dot (`.`, `..`, `.git`), no trailing dot or space, no reserved character, no DOS device name.
 */
export function isPlainSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    !segment.startsWith('.') &&
    !/[. ]$/.test(segment) &&
    !RESERVED_CHARS.test(segment) &&
    !DOS_DEVICE.test(segment)
  )
}

function isMissingEntry(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Resolves a URL-encoded path from a request to a file under `root`.
 *
 * The path is decoded once and split on both `/` and `\`; every segment must be a plain name
 * (`isPlainSegment`) and, when `allowedExtensions` is given, the file's extension one of them. The
 * target is then resolved through links and junctions and must still lie under the resolved root.
 *
 * Args:
 *     root: The folder the file must stay inside.
 *     encodedPath: The request path below the route prefix, still URL-encoded.
 *     allowedExtensions: Lower-case extensions with their dot, or null for any.
 *
 * Returns:
 *     The resolved file, `refused` for a path that is malformed or leads outside the root, or
 *     `missing` when the root or the file does not exist.
 *
 * Raises:
 *     Any file system error other than a missing entry.
 */
export function resolveUnderRoot(
  root: string,
  encodedPath: string,
  allowedExtensions: ReadonlySet<string> | null,
): ResolvedPath {
  let decoded: string
  try {
    decoded = decodeURIComponent(encodedPath)
  } catch {
    // A malformed escape is refused like any other path this function will not resolve.
    return REFUSED
  }
  const segments = decoded.split(/[/\\]/)
  if (!segments.every(isPlainSegment)) return REFUSED
  if (allowedExtensions && !allowedExtensions.has(extname(segments[segments.length - 1]).toLowerCase())) {
    return REFUSED
  }

  let realRoot: string
  let target: string
  try {
    realRoot = realpathSync.native(root)
    target = realpathSync.native(join(realRoot, ...segments))
  } catch (error) {
    if (isMissingEntry(error)) return MISSING
    throw error
  }
  if (!target.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) return REFUSED
  return statSync(target).isFile() ? { kind: 'file', path: target } : MISSING
}
