/**
 * Migration service for importing settings from the old Electron version.
 * Reads directly from Electron's LevelDB localStorage storage.
 */

const MIGRATION_FLAG_KEY = 'electron-migration-complete'

interface MigrationResult {
  success: boolean
  message: string
  settingsFound: boolean
}

/**
 * Check if migration has already been completed
 */
export function isMigrationComplete(): boolean {
  return localStorage.getItem(MIGRATION_FLAG_KEY) === 'true'
}

/**
 * Mark migration as complete
 */
export function setMigrationComplete(): void {
  localStorage.setItem(MIGRATION_FLAG_KEY, 'true')
}

/**
 * Extract settings-store value from LevelDB log file content.
 * LevelDB log files contain records with key-value pairs.
 * We search for the 'settings-store' key and extract its JSON value.
 */
function extractSettingsFromLevelDB(data: Uint8Array): string | null {
  // Convert to string for searching (LevelDB stores as UTF-8)
  const text = new TextDecoder('utf-8', { fatal: false }).decode(data)

  // Look for the settings-store key followed by JSON
  // The zustand persist format stores: {"state":{...},"version":0}
  // In LevelDB, keys are prefixed with _https://... or similar origin

  // Search patterns that might contain our settings
  const patterns = [
    /settings-store["']?\s*[:]*\s*(\{"state":\{[^}]+\}[^}]*\})/,
    /settings-store[^{]*(\{"state":\{.*?"version":\d+\})/,
    // Also try looking for the raw JSON structure
    /(\{"state":\{"cesiumIonToken":[^}]+.*?"version":\d+\})/
  ]

  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match && match[1]) {
      try {
        // Try to parse to validate it's JSON
        JSON.parse(match[1])
        return match[1]
      } catch {
        // Not valid JSON, continue searching
      }
    }
  }

  // Try a more aggressive search - find any JSON object with cesiumIonToken
  const jsonPattern = /\{"cesiumIonToken":[^]*?"terrainQuality":\d+[^]*?\}/g
  let jsonMatch
  while ((jsonMatch = jsonPattern.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(jsonMatch[0])
      if (parsed.cesiumIonToken !== undefined) {
        // Found raw settings object (old format without state wrapper)
        return JSON.stringify({ state: parsed, version: 0 })
      }
    } catch {
      // Not valid JSON, continue
    }
  }

  return null
}

/**
 * Attempt to migrate settings from the old Electron version.
 * This reads from Electron's LevelDB localStorage storage.
 */
export async function migrateFromElectron(): Promise<MigrationResult> {
  // Don't run if already migrated
  if (isMigrationComplete()) {
    return { success: true, message: 'Migration already complete', settingsFound: false }
  }

  // Skip migration in browser mode (no filesystem access)
  if (!('__TAURI__' in window)) {
    setMigrationComplete()
    return { success: true, message: 'Browser mode - migration skipped', settingsFound: false }
  }

  try {
    // Import Tauri APIs
    const { appDataDir } = await import('@tauri-apps/api/path')
    const { readDir, readFile, exists } = await import('@tauri-apps/plugin-fs')

    // Get the Tauri app data directory and navigate to Electron's location
    const tauriAppData = await appDataDir()

    // Electron stores data in %APPDATA%/towercab-3d/ (no com. prefix)
    // Tauri stores in %APPDATA%/com.towercab.app/
    // Navigate to the Electron path
    const electronPath = tauriAppData.replace(/[/\\]com\.towercab\.app[/\\]?$/, '/towercab-3d/')
    const leveldbPath = electronPath + 'Local Storage/leveldb/'

    console.log(`Looking for Electron settings in: ${leveldbPath}`)

    // Check if the directory exists
    if (!await exists(leveldbPath)) {
      console.log('Electron LevelDB directory not found')
      setMigrationComplete()
      return { success: true, message: 'No Electron installation found', settingsFound: false }
    }

    // List files in the LevelDB directory
    const files = await readDir(leveldbPath)

    // Look for .log and .ldb files which contain the actual data
    const dataFiles = files
      .filter(f => f.name && (f.name.endsWith('.log') || f.name.endsWith('.ldb')))
      .sort((a, b) => {
        // Sort by file number descending (newer files first)
        const numA = parseInt(a.name?.match(/(\d+)/)?.[1] || '0')
        const numB = parseInt(b.name?.match(/(\d+)/)?.[1] || '0')
        return numB - numA
      })

    console.log(`Found ${dataFiles.length} LevelDB data files`)

    // Try each file until we find settings
    for (const file of dataFiles) {
      if (!file.name) continue

      try {
        const filePath = leveldbPath + file.name
        const data = await readFile(filePath)

        const settingsJson = extractSettingsFromLevelDB(data)
        if (settingsJson) {
          console.log('Found settings in:', file.name)

          // Parse the zustand persist format
          const parsed = JSON.parse(settingsJson)
          const settings = parsed.state || parsed

          // Import the settings
          const { useSettingsStore } = await import('../stores/settingsStore')
          const importResult = useSettingsStore.getState().importSettings(JSON.stringify(settings))

          if (importResult) {
            setMigrationComplete()
            console.log('Successfully migrated settings from Electron')
            return {
              success: true,
              message: 'Settings migrated from Electron version',
              settingsFound: true
            }
          }
        }
      } catch (err) {
        console.warn(`Failed to read ${file.name}:`, err)
        // Continue to next file
      }
    }

    // No settings found in any file
    setMigrationComplete()
    console.log('No settings found in Electron LevelDB files')
    return { success: true, message: 'No settings found to migrate', settingsFound: false }

  } catch (err) {
    console.error('Migration failed:', err)
    // Don't mark as complete on error - let user try again
    return {
      success: false,
      message: `Migration error: ${err instanceof Error ? err.message : 'Unknown error'}`,
      settingsFound: false
    }
  }
}
