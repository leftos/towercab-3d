/**
 * Aircraft Broadcast SharedWorker
 *
 * Bridges the main TowerCab app with inset iframes for efficient aircraft
 * position broadcasting. This worker:
 * - Maintains connections to both the main app and all inset consumers
 * - Routes broadcasts from main app to registered consumers
 * - Forwards feedback from consumers back to main app
 * - Handles consumer lifecycle (connect/disconnect)
 *
 * @see docs/plans/unified-aircraft-broadcasting.md
 */

/// <reference lib="webworker" />

declare const self: SharedWorkerGlobalScope

/** Connected main app port (singleton - only one main app) */
let mainPort: MessagePort | null = null

/** Connected inset consumer ports */
const consumers = new Map<string, MessagePort>()

/** Counter for generating unique consumer IDs */
let nextConsumerId = 1

/**
 * Handle new connections to the SharedWorker.
 * Both the main app and insets connect through this entry point.
 */
self.onconnect = (event: MessageEvent) => {
  const port = event.ports[0]

  port.onmessage = (e: MessageEvent) => {
    handleMessage(port, e.data)
  }

  port.start()
}

/**
 * Handle incoming messages from connected ports.
 */
function handleMessage(
  port: MessagePort,
  message: { type: string; consumerId?: string; data?: unknown; logMessage?: string }
): void {
  switch (message.type) {
    case 'inset-log':
      // Forward log message from inset to main app
      if (mainPort && message.logMessage) {
        mainPort.postMessage({
          type: 'inset-log',
          logMessage: message.logMessage,
          consumerId: message.consumerId,
        })
      }
      break

    case 'register-main':
      // Main app registering itself
      mainPort = port
      console.log('[BroadcastWorker] Main app registered')
      break

    case 'register-inset':
      // Inset iframe registering as a consumer
      registerConsumer(port)
      break

    case 'broadcast':
      // Main app sending broadcast to a specific consumer or all
      if (message.consumerId) {
        // Send to specific consumer
        const consumer = consumers.get(message.consumerId)
        if (consumer) {
          consumer.postMessage({
            type: 'aircraft-update',
            data: message.data,
          })
        } else {
          console.warn(`[BroadcastWorker] Consumer not found: ${message.consumerId}`)
        }
      } else {
        // Broadcast to all consumers
        for (const consumer of consumers.values()) {
          consumer.postMessage({
            type: 'aircraft-update',
            data: message.data,
          })
        }
      }
      break

    case 'feedback':
      // Consumer sending feedback to main app
      if (mainPort && message.consumerId) {
        mainPort.postMessage({
          type: 'feedback',
          consumerId: message.consumerId,
          data: message.data,
        })
      }
      break

    case 'disconnect':
      // Consumer explicitly disconnecting
      if (message.consumerId) {
        unregisterConsumer(message.consumerId)
      } else {
        // No consumerId provided - find by port (handles StrictMode cleanup race)
        unregisterConsumerByPort(port)
      }
      break
  }
}

/**
 * Register a new inset consumer.
 */
function registerConsumer(port: MessagePort): void {
  const consumerId = `inset-${nextConsumerId++}`
  consumers.set(consumerId, port)

  // Notify the consumer of their ID
  port.postMessage({
    type: 'registered',
    consumerId,
  })

  // Notify main app of new consumer
  if (mainPort) {
    mainPort.postMessage({
      type: 'consumer-connected',
      consumerId,
    })
  }

  console.log(`[BroadcastWorker] Consumer registered: ${consumerId}`)

  // Handle port disconnection (when inset closes/navigates away)
  // Note: There's no direct 'close' event on MessagePort, so we rely on
  // the consumer sending 'disconnect' or the main app detecting missed feedback
}

/**
 * Unregister a consumer by ID.
 */
function unregisterConsumer(consumerId: string): void {
  consumers.delete(consumerId)

  // Notify main app
  if (mainPort) {
    mainPort.postMessage({
      type: 'consumer-disconnected',
      consumerId,
    })
  }

  console.log(`[BroadcastWorker] Consumer disconnected: ${consumerId}`)
}

/**
 * Unregister a consumer by port (for cleanup race conditions).
 */
function unregisterConsumerByPort(port: MessagePort): void {
  for (const [consumerId, consumerPort] of consumers.entries()) {
    if (consumerPort === port) {
      unregisterConsumer(consumerId)
      return
    }
  }
  // Port not found in consumers - might not have been registered yet
  console.log('[BroadcastWorker] Disconnect request for unregistered port')
}

export {}
