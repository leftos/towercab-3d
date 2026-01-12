/**
 * Test utilities for model matching tests
 *
 * These utilities replicate the Rust backend functionality for use in Node.js tests:
 * - VMR file parsing (from vmr.rs)
 * - MSFS model directory scanning (from msfs.rs)
 *
 * This allows running model matching tests without the Tauri runtime.
 */

import { XMLParser } from 'fast-xml-parser'
import * as fs from 'fs'
import * as path from 'path'

// =============================================================================
// Types (matching the TypeScript types used in the app)
// =============================================================================

/** Parsed VMR rule - matches ParsedApiRule from vmrUtils.ts */
export interface ParsedVmrRule {
  typeCode: string
  modelName: string
  callsignPrefix: string | null
  sourceVmr: string
}

/** Source model info - matches SourceModelInfo from MSFSModelConversionService.ts */
export interface SourceModelInfo {
  source: 'fsltl' | 'aig'
  modelName: string
  folderName: string
  aircraftFolderPath: string
  gltfPath: string
  textureDirs: string[]
  aircraftType: string
  airlineCode: string | null
}

// =============================================================================
// VMR PARSING (replicates vmr.rs logic)
// =============================================================================

/**
 * Parse a VMR file and extract model matching rules
 * Replicates the parse_vmr_file function from vmr.rs
 */
export function parseVMRFile(filePath: string): ParsedVmrRule[] {
  if (!fs.existsSync(filePath)) {
    console.error(`[VMR] File not found: ${filePath}`)
    return []
  }

  const content = fs.readFileSync(filePath, 'utf-8')
  const rules: ParsedVmrRule[] = []

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    allowBooleanAttributes: true,
    parseAttributeValue: false, // Keep as strings
    trimValues: true,
  })

  try {
    const result = parser.parse(content)

    // VMR files have structure: ModelMatchRuleSet > ModelMatchRule[]
    const ruleSet = result?.ModelMatchRuleSet?.ModelMatchRule

    if (!ruleSet) {
      console.warn(`[VMR] No ModelMatchRule elements found in ${filePath}`)
      return []
    }

    // Handle both single rule and array of rules
    const rulesArray = Array.isArray(ruleSet) ? ruleSet : [ruleSet]

    for (const rule of rulesArray) {
      const typeCode = rule['@_TypeCode']
      const modelName = rule['@_ModelName']
      const callsignPrefix = rule['@_CallsignPrefix'] || null

      if (typeCode && modelName) {
        rules.push({
          typeCode: typeCode.toUpperCase(),
          modelName,
          callsignPrefix: callsignPrefix?.toUpperCase() ?? null,
          sourceVmr: filePath,
        })
      }
    }
  } catch (error) {
    console.error(`[VMR] XML parse error in ${filePath}:`, error)
  }

  return rules
}

/**
 * Parse multiple VMR files (in order of priority - first file wins conflicts)
 */
export function parseVMRFiles(filePaths: string[]): ParsedVmrRule[] {
  const allRules: ParsedVmrRule[] = []

  for (const filePath of filePaths) {
    const rules = parseVMRFile(filePath)
    console.log(`[VMR] Parsed ${rules.length} rules from ${path.basename(filePath)}`)
    // Use concat instead of spread to avoid stack overflow with large arrays
    for (const rule of rules) {
      allRules.push(rule)
    }
  }

  console.log(`[VMR] Total: ${allRules.length} rules from ${filePaths.length} file(s)`)
  return allRules
}

// =============================================================================
// AIRCRAFT.CFG PARSING (replicates msfs.rs logic)
// =============================================================================

interface AircraftCfgLivery {
  title: string
  textureFolder: string
  icaoAirline: string | null
}

/**
 * Parse icao_type_designator from aircraft.cfg [General] section
 */
function parseAircraftCfgIcaoType(aircraftDir: string): string | null {
  const cfgPath = path.join(aircraftDir, 'aircraft.cfg')
  if (!fs.existsSync(cfgPath)) return null

  const content = fs.readFileSync(cfgPath, 'utf-8')
  let inGeneralSection = false

  for (const line of content.split('\n')) {
    const trimmed = line.trim()

    // Check for section headers
    if (trimmed.startsWith('[')) {
      inGeneralSection = trimmed.toUpperCase() === '[GENERAL]'
      continue
    }

    // Look for icao_type_designator in [General] section
    if (inGeneralSection && trimmed.toLowerCase().startsWith('icao_type_designator')) {
      const eqPos = trimmed.indexOf('=')
      if (eqPos !== -1) {
        let value = trimmed.slice(eqPos + 1)
        // Remove comment
        const semiPos = value.indexOf(';')
        if (semiPos !== -1) value = value.slice(0, semiPos)
        value = value.trim().replace(/^"|"$/g, '').trim()
        if (value) return value.toUpperCase()
      }
    }
  }

  return null
}

/**
 * Parse all FLTSIM sections from aircraft.cfg
 */
function parseAircraftCfgAllLiveries(aircraftDir: string): AircraftCfgLivery[] {
  const cfgPath = path.join(aircraftDir, 'aircraft.cfg')
  if (!fs.existsSync(cfgPath)) return []

  const content = fs.readFileSync(cfgPath, 'utf-8')
  const liveries: AircraftCfgLivery[] = []

  let inFltsimSection = false
  let currentTitle: string | null = null
  let currentTexture: string | null = null
  let currentIcaoAirline: string | null = null

  for (const line of content.split('\n')) {
    const trimmed = line.trim()

    // Check for section headers
    if (trimmed.startsWith('[')) {
      // Save previous livery if complete
      if (inFltsimSection && currentTitle !== null && currentTexture !== null) {
        liveries.push({
          title: currentTitle,
          textureFolder: currentTexture,
          icaoAirline: currentIcaoAirline,
        })
      }

      inFltsimSection = trimmed.toUpperCase().startsWith('[FLTSIM')
      currentTitle = null
      currentTexture = inFltsimSection ? '' : null
      currentIcaoAirline = null
      continue
    }

    if (!inFltsimSection) continue

    const lower = trimmed.toLowerCase()

    if (lower.startsWith('title')) {
      const eqPos = trimmed.indexOf('=')
      if (eqPos !== -1) {
        let value = trimmed.slice(eqPos + 1)
        const semiPos = value.indexOf(';')
        if (semiPos !== -1) value = value.slice(0, semiPos)
        value = value.trim().replace(/^"|"$/g, '').trim()
        if (value) currentTitle = value
      }
    } else if (lower.startsWith('texture') && !lower.startsWith('texture.')) {
      const eqPos = trimmed.indexOf('=')
      if (eqPos !== -1) {
        let value = trimmed.slice(eqPos + 1)
        const semiPos = value.indexOf(';')
        if (semiPos !== -1) value = value.slice(0, semiPos)
        value = value.trim().replace(/^"|"$/g, '').trim()
        currentTexture = value
      }
    } else if (lower.startsWith('icao_airline')) {
      const eqPos = trimmed.indexOf('=')
      if (eqPos !== -1) {
        let value = trimmed.slice(eqPos + 1)
        const semiPos = value.indexOf(';')
        if (semiPos !== -1) value = value.slice(0, semiPos)
        value = value.trim().replace(/^"|"$/g, '').trim()
        if (value) currentIcaoAirline = value.toUpperCase()
      }
    }
  }

  // Don't forget the last section
  if (inFltsimSection && currentTitle !== null && currentTexture !== null) {
    liveries.push({
      title: currentTitle,
      textureFolder: currentTexture,
      icaoAirline: currentIcaoAirline,
    })
  }

  return liveries
}

/**
 * Parse aircraft type from folder name
 */
function parseAircraftType(folderName: string, prefix: string): string {
  const withoutPrefix = folderName.replace(prefix, '')
  const parts = withoutPrefix.split('_')

  if (prefix === 'FSLTL_') {
    // FSLTL: FSLTL_{TYPE}_{AIRLINE} -> TYPE is first part
    return parts[0] || ''
  } else {
    // AIG: AIGAIM_{SOURCE}_{TYPE} -> TYPE is second part, before any hyphen
    if (parts.length >= 2) {
      return parts[1].split('-')[0]
    }
    return withoutPrefix.split('-')[0]
  }
}

/**
 * Find GLTF file in an aircraft directory
 */
function findGltfInDir(aircraftDir: string): string | null {
  const entries = fs.readdirSync(aircraftDir, { withFileTypes: true })
  const modelDirs = entries.filter(
    (e) => e.isDirectory() && e.name.toLowerCase().startsWith('model')
  )

  for (const modelDirEntry of modelDirs) {
    const modelDir = path.join(aircraftDir, modelDirEntry.name)
    const gltfFiles = fs.readdirSync(modelDir, { withFileTypes: true }).filter(
      (e) => e.isFile() && e.name.toLowerCase().endsWith('.gltf')
    )

    // Prefer exterior model: exclude cockpit/interior, prefer lower LOD
    const exteriorFiles = gltfFiles.filter((e) => {
      const name = e.name.toLowerCase()
      return !name.includes('cockpit') && !name.includes('interior')
    })

    if (exteriorFiles.length > 0) {
      // Sort by LOD level
      exteriorFiles.sort((a, b) => {
        const getLod = (name: string) => {
          const n = name.toLowerCase()
          if (n.includes('lod00')) return 0
          if (n.includes('lod01')) return 1
          if (n.includes('lod02')) return 2
          if (n.includes('lod03')) return 3
          if (n.includes('lod04')) return 4
          return 5
        }
        return getLod(a.name) - getLod(b.name)
      })
      return path.join(modelDir, exteriorFiles[0].name)
    }
  }

  return null
}

// =============================================================================
// MODEL SCANNING (replicates msfs.rs logic)
// =============================================================================

interface SourceConfig {
  source: 'fsltl' | 'aig'
  folderPrefix: string
}

/**
 * Scan an MSFS model source directory and build a model index
 * Replicates list_models_unified from msfs.rs
 */
export function scanMSFSModels(
  basePath: string,
  source: 'fsltl' | 'aig'
): SourceModelInfo[] {
  const config: SourceConfig = source === 'fsltl'
    ? { source: 'fsltl', folderPrefix: 'FSLTL_' }
    : { source: 'aig', folderPrefix: 'AIGAIM_' }

  const airplanesDir = path.join(basePath, 'SimObjects', 'Airplanes')
  if (!fs.existsSync(airplanesDir)) {
    console.warn(`[MSFS] Airplanes directory not found: ${airplanesDir}`)
    return []
  }

  const models: SourceModelInfo[] = []

  // PASS 1: Build base model index (for FSLTL base model fallback)
  const baseModels = new Map<string, { gltfPath: string; textureDirs: string[] }>()

  const entries = fs.readdirSync(airplanesDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!entry.name.startsWith(config.folderPrefix)) continue

    const aircraftDir = path.join(airplanesDir, entry.name)
    const parts = entry.name.split('_')

    // Check if this is a base model
    const isBaseModel = config.source === 'fsltl'
      ? parts.length === 2 || (parts.length >= 3 && parts[2] === 'ZZZZ')
      : true // AIG folders are always "base models"

    if (isBaseModel) {
      const gltfPath = findGltfInDir(aircraftDir)
      if (gltfPath) {
        const aircraftType = parseAircraftCfgIcaoType(aircraftDir)
          || parseAircraftType(entry.name, config.folderPrefix)

        // Collect texture directories
        const textureDirs = fs.readdirSync(aircraftDir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && (
            e.name.toLowerCase().startsWith('texture') ||
            e.name.toLowerCase().startsWith('oci')
          ))
          .map((e) => path.join(aircraftDir, e.name))

        if (!baseModels.has(aircraftType)) {
          baseModels.set(aircraftType, { gltfPath, textureDirs })
        }
      }
    }
  }

  // PASS 2: Create entries for all liveries
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!entry.name.startsWith(config.folderPrefix)) continue

    const aircraftDir = path.join(airplanesDir, entry.name)
    const folderName = entry.name

    // Get ICAO type from aircraft.cfg, fall back to folder name parsing
    const aircraftType = parseAircraftCfgIcaoType(aircraftDir)
      || parseAircraftType(folderName, config.folderPrefix)

    // Find GLTF - either in this folder or from base model
    const gltfPath = findGltfInDir(aircraftDir)
      || baseModels.get(aircraftType)?.gltfPath

    if (!gltfPath) continue // Skip if no GLTF found

    // Parse all liveries from aircraft.cfg
    const liveries = parseAircraftCfgAllLiveries(aircraftDir)

    if (liveries.length === 0) continue

    // Collect shared texture directories
    const sharedTextureDirs = fs.readdirSync(aircraftDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.toLowerCase().startsWith('oci'))
      .map((e) => path.join(aircraftDir, e.name))

    // Add base model texture directories as fallback
    const baseTexDirs = baseModels.get(aircraftType)?.textureDirs || []
    for (const baseDir of baseTexDirs) {
      if (!sharedTextureDirs.includes(baseDir)) {
        sharedTextureDirs.push(baseDir)
      }
    }

    for (const livery of liveries) {
      // Collect texture directories
      const textureDirs = fs.readdirSync(aircraftDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.toLowerCase().startsWith('texture'))
        .map((e) => path.join(aircraftDir, e.name))

      // Add shared texture directories
      textureDirs.push(...sharedTextureDirs)

      // Use icao_airline from aircraft.cfg, fall back to texture folder parsing
      const airlineCode = livery.icaoAirline || (() => {
        const parsed = livery.textureFolder.split('-')[0].toUpperCase()
        return (parsed.length === 3 || parsed.length === 4) ? parsed : null
      })()

      models.push({
        source: config.source,
        modelName: livery.title,
        folderName,
        aircraftFolderPath: aircraftDir,
        gltfPath,
        textureDirs,
        aircraftType,
        airlineCode,
      })
    }
  }

  console.log(`[MSFS] Indexed ${models.length} ${config.source.toUpperCase()} models`)
  return models
}
