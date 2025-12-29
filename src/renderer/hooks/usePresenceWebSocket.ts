/**
 * Presence WebSocket Hook
 *
 * Connects to the server's presence WebSocket when running in remote mode.
 * This allows the desktop app to track how many remote clients are connected.
 */

import { useEffect, useRef } from 'react'
import { isRemoteMode } from '../utils/remoteMode'

/**
 * Connect to the presence WebSocket to register this client with the server.
 * Only active in remote mode (browser accessing the desktop app's server).
 */
export function usePresenceWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // Only connect in remote mode
    if (!isRemoteMode()) {
      console.log('[Presence] Not in remote mode, skipping WebSocket connection')
      return
    }

    console.log('[Presence] Remote mode detected, connecting to presence WebSocket...')

    const connect = () => {
      // Build WebSocket URL from current location
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const wsUrl = `${protocol}//${window.location.host}/api/presence`
      console.log('[Presence] Connecting to:', wsUrl)

      try {
        const ws = new WebSocket(wsUrl)
        wsRef.current = ws

        ws.onopen = () => {
          console.log('[Presence] Connected to server successfully')
        }

        ws.onclose = (event) => {
          console.log('[Presence] Disconnected from server, code:', event.code, 'reason:', event.reason)
          wsRef.current = null
          // Attempt to reconnect after 5 seconds
          reconnectTimeoutRef.current = setTimeout(connect, 5000)
        }

        ws.onerror = (error) => {
          console.error('[Presence] WebSocket error:', error)
        }
      } catch (error) {
        console.error('[Presence] Failed to connect:', error)
        // Retry after 5 seconds
        reconnectTimeoutRef.current = setTimeout(connect, 5000)
      }
    }

    connect()

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, [])
}
