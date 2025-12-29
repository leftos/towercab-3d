/**
 * Remote Clients Indicator
 *
 * Shows the number of remote clients (browsers/tablets/phones) connected to the server.
 * Only visible on the desktop app when the server is running and clients are connected.
 */

import { useState, useEffect } from 'react'
import { isRemoteMode } from '../../utils/remoteMode'
import { isTauri } from '../../utils/tauriApi'
import './RemoteClientsIndicator.css'

function RemoteClientsIndicator() {
  const [clientCount, setClientCount] = useState(0)

  useEffect(() => {
    // Only show on desktop app (not in remote/browser mode)
    const inRemote = isRemoteMode()
    const inTauri = isTauri()
    console.log('[RemoteClientsIndicator] isRemoteMode:', inRemote, 'isTauri:', inTauri)

    if (inRemote || !inTauri) {
      console.log('[RemoteClientsIndicator] Not showing - remote or not Tauri')
      return
    }

    console.log('[RemoteClientsIndicator] Setting up Tauri event listener...')
    let unlisten: (() => void) | null = null

    const setupListener = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        console.log('[RemoteClientsIndicator] Got listen function, subscribing to remote-clients-changed...')
        unlisten = await listen<number>('remote-clients-changed', (event) => {
          console.log('[RemoteClientsIndicator] Received event, payload:', event.payload)
          setClientCount(event.payload)
        })
        console.log('[RemoteClientsIndicator] Listener setup complete')
      } catch (error) {
        console.error('[RemoteClientsIndicator] Failed to setup listener:', error)
      }
    }

    setupListener()

    return () => {
      console.log('[RemoteClientsIndicator] Cleaning up listener')
      if (unlisten) {
        unlisten()
      }
    }
  }, [])

  // Don't render in remote mode or if no clients connected
  if (isRemoteMode() || clientCount === 0) return null

  return (
    <div className="remote-clients-indicator" title={`${clientCount} remote ${clientCount === 1 ? 'client' : 'clients'} connected`}>
      <svg
        className="remote-clients-icon"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <rect x="5" y="2" width="14" height="16" rx="2" />
        <line x1="12" y1="18" x2="12" y2="22" />
        <line x1="8" y1="22" x2="16" y2="22" />
      </svg>
      <span className="remote-clients-count">{clientCount}</span>
    </div>
  )
}

export default RemoteClientsIndicator
