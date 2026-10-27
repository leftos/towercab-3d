import { describe, expect, it } from 'vitest'
import { urlWithoutQuery } from '../src/renderer/utils/redactUrl'

describe('urlWithoutQuery', () => {
  it('drops the query, including the authorization code', () => {
    const redacted = urlWithoutQuery('tc3d://oauth/callback?code=SECRET123&state=s')
    expect(redacted).toBe('tc3d://oauth/callback')
    expect(redacted).not.toContain('SECRET123')

    const queryThenFragment = urlWithoutQuery('tc3d://oauth/callback?code=SECRET#frag')
    expect(queryThenFragment).toBe('tc3d://oauth/callback')
    expect(queryThenFragment).not.toContain('SECRET')

    const fragmentThenQuery = urlWithoutQuery('tc3d://oauth/callback#a?code=SECRET')
    expect(fragmentThenQuery).toBe('tc3d://oauth/callback')
    expect(fragmentThenQuery).not.toContain('SECRET')
  })

  it('drops a fragment', () => {
    expect(urlWithoutQuery('tc3d://oauth/callback#code=X')).toBe('tc3d://oauth/callback')
  })

  it('keeps a plain URL unchanged', () => {
    expect(urlWithoutQuery('tc3d://oauth/callback')).toBe('tc3d://oauth/callback')
    expect(urlWithoutQuery('')).toBe('')
  })
})
