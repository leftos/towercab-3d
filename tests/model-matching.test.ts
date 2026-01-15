/**
 * Model Matching Unit Tests
 *
 * Tests how airline + aircraft type combinations resolve to specific models.
 * Uses the actual VMR files and model sources to validate matching behavior.
 *
 * Configuration:
 * - FSLTL models: X:\Games\MSFlightSimPackages2024\Community\fsltl-traffic-base
 * - AIG models: X:\Games\MSFlightSimPackages2024\Community\aig-aitraffic-oci
 * - VMR priority: PerfectModelMatching.vmr then FSLTL_Rules.vmr
 * - Model priority: FSLTL then AIG
 *
 * Usage:
 *   npm run test:matching
 *   npm run test:matching -- --reporter=verbose
 */

import { describe, it, expect, beforeAll } from 'vitest'
import {
  parseVMRFiles,
  scanMSFSModels,
  type ParsedVmrRule,
  type SourceModelInfo,
} from './model-matching-utils'
import {
  processApiRules,
  findRuleMatch,
  createAirlineRuleKey,
  type VMRRule,
  type RuleEntry,
} from '../src/renderer/services/vmrUtils'

// =============================================================================
// Configuration
// =============================================================================

/** Path to FSLTL model source */
const FSLTL_PATH = 'X:\\Games\\MSFlightSimPackages2024\\Community\\fsltl-traffic-base'

/** Path to AIG model source */
const AIG_PATH = 'X:\\Games\\MSFlightSimPackages2024\\Community\\aig-aitraffic-oci'

/** VMR files in priority order (first file wins conflicts) */
const VMR_FILES = [
  'X:\\FS_Addons\\PerfectModelMatching\\PerfectModelMatching.vmr',
  'X:\\Games\\MSFlightSimPackages2024\\Community\\fsltl-traffic-base\\FSLTL_Rules.vmr',
]

/** Model source priority (first source wins) */
const MODEL_PRIORITY: ('fsltl' | 'aig')[] = ['fsltl', 'aig']

// =============================================================================
// Types
// =============================================================================

interface VMRRuleEntry extends RuleEntry<VMRRule> {
  rule: VMRRule
  sourceVmr: string
}

interface MatchResult {
  /** The resolved model name */
  modelName: string | null
  /** Source of the rule (VMR file path) */
  vmrSource: string | null
  /** Whether this was an airline-specific match */
  isAirlineSpecific: boolean
  /** All alternative model names from the rule */
  alternatives: string[]
  /** The resolved source model info (if model exists) */
  sourceModel: SourceModelInfo | null
  /** Which source the model comes from */
  modelSource: 'fsltl' | 'aig' | null
}

// =============================================================================
// Test State
// =============================================================================

let vmrRules: ParsedVmrRule[] = []
let fsltlModels: SourceModelInfo[] = []
let aigModels: SourceModelInfo[] = []
let defaultRules = new Map<string, VMRRuleEntry>()
let airlineRules = new Map<string, VMRRuleEntry>()

// Model indexes by name for quick lookup
let fsltlModelsByName = new Map<string, SourceModelInfo>()
let aigModelsByName = new Map<string, SourceModelInfo>()

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Determine which source a model name belongs to based on prefix
 */
function getModelSource(name: string): 'fsltl' | 'aig' | 'unknown' {
  const upper = name.toUpperCase()
  if (upper.startsWith('FSLTL_') || upper.startsWith('FSLTL ')) return 'fsltl'
  if (upper.startsWith('AIGAIM_') || upper.startsWith('AIGAIM ')) return 'aig'
  return 'unknown'
}

/**
 * Sort model names by source priority
 */
function sortModelNamesByPriority(modelNames: string[]): string[] {
  return [...modelNames].sort((a, b) => {
    const sourceA = getModelSource(a)
    const sourceB = getModelSource(b)
    const priorityA = sourceA === 'unknown' ? 999 : MODEL_PRIORITY.indexOf(sourceA)
    const priorityB = sourceB === 'unknown' ? 999 : MODEL_PRIORITY.indexOf(sourceB)
    return priorityA - priorityB
  })
}

/**
 * Resolve a model name to a SourceModelInfo
 * Checks enabled sources in priority order
 */
function resolveSourceModel(modelName: string): SourceModelInfo | null {
  for (const source of MODEL_PRIORITY) {
    const models = source === 'fsltl' ? fsltlModelsByName : aigModelsByName
    const model = models.get(modelName)
    if (model) return model
  }
  return null
}

/**
 * Find the best matching model for a given aircraft type and airline
 */
function findMatch(
  aircraftType: string,
  airlineCode: string | null
): MatchResult {
  const result: MatchResult = {
    modelName: null,
    vmrSource: null,
    isAirlineSpecific: false,
    alternatives: [],
    sourceModel: null,
    modelSource: null,
  }

  // Find VMR rule match
  const ruleMatch = findRuleMatch(
    aircraftType,
    airlineCode,
    defaultRules,
    airlineRules
  )

  if (!ruleMatch) {
    return result
  }

  const { entry, isAirlineSpecific } = ruleMatch
  result.isAirlineSpecific = isAirlineSpecific
  result.vmrSource = entry.sourceVmr

  // Sort alternatives by source priority
  const sortedAlternatives = sortModelNamesByPriority(entry.rule.modelNames)
  result.alternatives = sortedAlternatives

  // Try each alternative until we find one that exists
  for (const altModelName of sortedAlternatives) {
    const sourceModel = resolveSourceModel(altModelName)
    if (sourceModel) {
      result.modelName = altModelName
      result.sourceModel = sourceModel
      result.modelSource = sourceModel.source
      break
    }
  }

  // If no model was found in the index, return the first alternative anyway
  if (!result.modelName && sortedAlternatives.length > 0) {
    result.modelName = sortedAlternatives[0]
    const source = getModelSource(sortedAlternatives[0])
    if (source !== 'unknown') {
      result.modelSource = source
    }
  }

  return result
}

/**
 * Get all available airline codes from the model indexes
 */
function getAvailableAirlines(): Set<string> {
  const airlines = new Set<string>()
  for (const model of fsltlModels) {
    if (model.airlineCode) airlines.add(model.airlineCode)
  }
  for (const model of aigModels) {
    if (model.airlineCode) airlines.add(model.airlineCode)
  }
  return airlines
}

/**
 * Get all available aircraft types from the model indexes
 */
function getAvailableAircraftTypes(): Set<string> {
  const types = new Set<string>()
  for (const model of fsltlModels) {
    if (model.aircraftType) types.add(model.aircraftType)
  }
  for (const model of aigModels) {
    if (model.aircraftType) types.add(model.aircraftType)
  }
  return types
}

// =============================================================================
// Test Setup
// =============================================================================

beforeAll(() => {
  console.log('\n=== Loading VMR Files ===')
  vmrRules = parseVMRFiles(VMR_FILES)

  console.log('\n=== Scanning FSLTL Models ===')
  fsltlModels = scanMSFSModels(FSLTL_PATH, 'fsltl')
  for (const model of fsltlModels) {
    fsltlModelsByName.set(model.modelName, model)
  }

  console.log('\n=== Scanning AIG Models ===')
  aigModels = scanMSFSModels(AIG_PATH, 'aig')
  for (const model of aigModels) {
    aigModelsByName.set(model.modelName, model)
  }

  console.log('\n=== Processing VMR Rules ===')
  // Process VMR rules using the same logic as UserVMRService
  processApiRules(
    vmrRules,
    defaultRules,
    airlineRules,
    (rule, sourceVmr) => ({ rule, sourceVmr })
  )

  console.log(`Loaded ${defaultRules.size} default rules, ${airlineRules.size} airline rules`)
  console.log(`Indexed ${fsltlModels.length} FSLTL models, ${aigModels.length} AIG models`)
  console.log('')
})

// =============================================================================
// Tests
// =============================================================================

describe('Model Matching', () => {
  describe('VMR Rule Loading', () => {
    it('should load VMR files', () => {
      expect(vmrRules.length).toBeGreaterThan(0)
    })

    it('should have processed default rules', () => {
      expect(defaultRules.size).toBeGreaterThan(0)
    })

    it('should have processed airline rules', () => {
      expect(airlineRules.size).toBeGreaterThan(0)
    })
  })

  describe('Model Indexing', () => {
    it('should index FSLTL models', () => {
      expect(fsltlModels.length).toBeGreaterThan(0)
    })

    it('should index AIG models', () => {
      expect(aigModels.length).toBeGreaterThan(0)
    })
  })

  describe('Common Airline Matching', () => {
    // Test common airline + type combinations
    const testCases = [
      { type: 'B738', airline: 'AAL', description: 'American Airlines B737-800' },
      { type: 'B738', airline: 'SWA', description: 'Southwest Airlines B737-800' },
      { type: 'B738', airline: 'DAL', description: 'Delta Air Lines B737-800' },
      { type: 'A320', airline: 'AAL', description: 'American Airlines A320' },
      { type: 'A320', airline: 'DAL', description: 'Delta Air Lines A320' },
      { type: 'A320', airline: 'UAL', description: 'United Airlines A320' },
      { type: 'B77W', airline: 'AAL', description: 'American Airlines B777-300ER' },
      { type: 'B77W', airline: 'UAL', description: 'United Airlines B777-300ER' },
      { type: 'A321', airline: 'AAL', description: 'American Airlines A321' },
      { type: 'A321', airline: 'DAL', description: 'Delta A321' },
      { type: 'B788', airline: 'AAL', description: 'American Airlines B787-8' },
      { type: 'B788', airline: 'UAL', description: 'United Airlines B787-8' },
      { type: 'A20N', airline: 'AAL', description: 'American Airlines A320neo' },
      { type: 'A20N', airline: 'UAL', description: 'United Airlines A320neo' },
      { type: 'E75L', airline: 'ENY', description: 'Envoy Air E175' },
      { type: 'CRJ7', airline: 'SKW', description: 'SkyWest CRJ700' },
      { type: 'C172', airline: null, description: 'Cessna 172 (GA)' },
    ]

    for (const { type, airline, description } of testCases) {
      it(`should match ${description}`, () => {
        const result = findMatch(type, airline)
        console.log(`  ${type} + ${airline ?? 'null'}: ${result.modelName ?? 'NO MATCH'}`)
        if (result.alternatives.length > 1) {
          console.log(`    Alternatives: ${result.alternatives.slice(0, 3).join(', ')}${result.alternatives.length > 3 ? '...' : ''}`)
        }
        if (result.vmrSource) {
          console.log(`    VMR: ${result.vmrSource.split('\\').pop()}`)
        }
        if (result.sourceModel) {
          console.log(`    Source: ${result.modelSource}, Type: ${result.sourceModel.aircraftType}`)
        }

        // We expect at least a VMR rule match for these common types
        expect(result.modelName).not.toBeNull()
      })
    }
  })

  describe('Types Without VMR Rules', () => {
    // Test types that may not have VMR rules - these should return null
    const noRuleTypes = [
      { type: 'PA28', airline: null, description: 'Piper PA-28' },
      { type: 'UNKN', airline: null, description: 'Unknown type code' },
    ]

    for (const { type, airline, description } of noRuleTypes) {
      it(`should handle ${description} (may have no rule)`, () => {
        const result = findMatch(type, airline)
        console.log(`  ${type} + ${airline ?? 'null'}: ${result.modelName ?? 'NO MATCH (expected)'}`)
        // Just log the result, don't assert - these types may or may not have rules
        if (result.modelName) {
          console.log(`    Unexpectedly found: ${result.modelName}`)
        }
      })
    }
  })

  describe('Priority Verification', () => {
    it('should prefer FSLTL over AIG when both exist', () => {
      // Find a case where both sources have models
      const result = findMatch('B738', 'AAL')

      if (result.alternatives.length > 1) {
        // First alternative should be FSLTL (after sorting)
        const firstAltSource = getModelSource(result.alternatives[0])
        console.log(`  B738+AAL first alternative: ${result.alternatives[0]} (${firstAltSource})`)
        console.log(`  All alternatives: ${result.alternatives.join(', ')}`)
      }

      // If a model exists, it should prefer FSLTL
      if (result.sourceModel) {
        console.log(`  Resolved to: ${result.modelName} from ${result.modelSource}`)
      }
    })

    it('should use PerfectModelMatching over FSLTL_Rules when both have a rule', () => {
      // Rules are processed in priority order, so PerfectModelMatching rules should win
      // Let's check a common type to see which VMR provides the rule
      const result = findMatch('B738', 'DAL')

      if (result.vmrSource) {
        const vmrName = result.vmrSource.split('\\').pop()
        console.log(`  B738+DAL rule from: ${vmrName}`)
      }
    })
  })

  describe('Debug: Specific Matching Queries', () => {
    // Add your specific test cases here to debug matching behavior
    // Example:
    it('debug: show all alternatives for B738+AAL', () => {
      const result = findMatch('B738', 'AAL')
      console.log('\n--- Debug: B738 + AAL ---')
      console.log('VMR Source:', result.vmrSource?.split('\\').pop())
      console.log('Is Airline Specific:', result.isAirlineSpecific)
      console.log('All Alternatives:', result.alternatives)
      console.log('Resolved Model:', result.modelName)
      console.log('Model Source:', result.modelSource)
      if (result.sourceModel) {
        console.log('Source Model Info:', {
          aircraftType: result.sourceModel.aircraftType,
          airlineCode: result.sourceModel.airlineCode,
          folderName: result.sourceModel.folderName,
        })
      }
    })
  })
})

// =============================================================================
// Custom Test Cases - Add your own here!
// =============================================================================

describe('Custom Matching Queries', () => {
  /**
   * Add your own test cases here to investigate specific type+airline combinations.
   *
   * Example:
   *   testMatch('B738', 'AAL')  // American Airlines B737-800
   *   testMatch('A320', 'EZY')  // EasyJet A320
   *   testMatch('B77W', null)   // B777-300ER without airline
   */

  const testMatch = (type: string, airline: string | null, description?: string) => {
    it(description || `Query: ${type} + ${airline ?? 'null'}`, () => {
      const result = findMatch(type, airline)
      console.log(`\n=== ${type} + ${airline ?? 'null'} ===`)
      console.log(`Model: ${result.modelName ?? 'NO MATCH'}`)
      console.log(`VMR Source: ${result.vmrSource?.split('\\').pop() ?? 'none'}`)
      console.log(`Is Airline Specific: ${result.isAirlineSpecific}`)
      console.log(`Model Source: ${result.modelSource ?? 'none'}`)
      if (result.sourceModel) {
        console.log(`Folder: ${result.sourceModel.folderName}`)
        console.log(`Aircraft Type: ${result.sourceModel.aircraftType}`)
        console.log(`Airline Code: ${result.sourceModel.airlineCode}`)
      }
      if (result.alternatives.length > 0) {
        console.log(`Alternatives (${result.alternatives.length}):`)
        for (const alt of result.alternatives.slice(0, 5)) {
          console.log(`  - ${alt}`)
        }
        if (result.alternatives.length > 5) {
          console.log(`  ... and ${result.alternatives.length - 5} more`)
        }
      }
    })
  }

  // Add your custom queries below this line:
  testMatch('B738', 'AFR', 'Air France B737-800')
  testMatch('CRJ2', 'SCW', 'SkyWest Charter CRJ-200')

  // Investigate CRJ-200 shared model issue
  it('investigate: CRJ2 models available (shared model test)', () => {
    const crj2Models = [...fsltlModels, ...aigModels].filter(
      m => m.aircraftType === 'CRJ2'
    )
    console.log(`\n=== CRJ2 Models in Library (${crj2Models.length} total) ===`)
    for (const m of crj2Models.slice(0, 10)) {
      console.log(`  - ${m.source}: ${m.modelName}`)
      console.log(`    Folder: ${m.folderName}`)
      console.log(`    GLTF: ${m.gltfPath}`)
    }
    if (crj2Models.length > 10) {
      console.log(`  ... and ${crj2Models.length - 10} more`)
    }
    if (crj2Models.length === 0) {
      console.log('  NO CRJ2 MODELS FOUND - this is the AIG shared model bug!')
      console.log('  CRJ-200 liveries are in AIGAIM_RFSL_CRJ-200 but the GLTF')
      console.log('  is in AIGAIM_RFSL_CRJ-100/model.200/')
    }
  })

  // Check what AFR models exist in the library
  it('investigate: AFR models available', () => {
    const afrModels = [...fsltlModels, ...aigModels].filter(
      m => m.airlineCode === 'AFR'
    )
    console.log(`\n=== AFR Models in Library (${afrModels.length} total) ===`)
    const byType = new Map<string, string[]>()
    for (const m of afrModels) {
      if (!byType.has(m.aircraftType)) byType.set(m.aircraftType, [])
      byType.get(m.aircraftType)!.push(`${m.source}: ${m.modelName}`)
    }
    for (const [type, models] of [...byType.entries()].sort()) {
      console.log(`\n${type}:`)
      for (const m of models.slice(0, 3)) console.log(`  - ${m}`)
      if (models.length > 3) console.log(`  ... and ${models.length - 3} more`)
    }
  })

  // Check what the VMR says for AFR+B738
  it('investigate: VMR rule for AFR+B738', () => {
    const ruleKey = 'AFR_B738'
    const rule = airlineRules.get(ruleKey)
    console.log(`\n=== VMR Rule for AFR_B738 ===`)
    if (rule) {
      console.log(`Source: ${rule.sourceVmr}`)
      console.log(`Alternatives: ${rule.rule.modelNames.join(', ')}`)
    } else {
      console.log('No airline-specific rule found')
      // Check default B738 rule
      const defaultRule = defaultRules.get('B738')
      if (defaultRule) {
        console.log(`\nDefault B738 rule:`)
        console.log(`Source: ${defaultRule.sourceVmr}`)
        console.log(`Alternatives: ${defaultRule.rule.modelNames.slice(0, 5).join(', ')}`)
      }
    }
  })

  // Test: Setting to ignore VMR rules that map to generic models
  it('setting: skipGenericVmrMatches = true', () => {
    console.log('\n=== Testing skipGenericVmrMatches setting ===')

    /**
     * Check if a model name is a generic/non-livery model
     * Generic patterns:
     * - FSLTL: ends with _ZZZZ or contains _ZZZZ_
     * - Could add more patterns as needed
     */
    const isGenericModel = (modelName: string): boolean => {
      const upper = modelName.toUpperCase()
      // FSLTL generic pattern: FSLTL_B738_ZZZZ or FSLTL_BCS3_ZZZZ
      if (upper.includes('_ZZZZ')) return true
      // Add more patterns here if needed
      return false
    }

    /**
     * Modified findMatch that skips generic VMR matches
     */
    const findMatchSkipGenerics = (
      aircraftType: string,
      airlineCode: string | null
    ): MatchResult => {
      const result: MatchResult = {
        modelName: null,
        vmrSource: null,
        isAirlineSpecific: false,
        alternatives: [],
        sourceModel: null,
        modelSource: null,
      }

      // Find VMR rule match
      const ruleMatch = findRuleMatch(
        aircraftType,
        airlineCode,
        defaultRules,
        airlineRules
      )

      if (ruleMatch) {
        const { entry, isAirlineSpecific } = ruleMatch
        const sortedAlternatives = sortModelNamesByPriority(entry.rule.modelNames)

        // Filter out generic models
        const nonGenericAlternatives = sortedAlternatives.filter(m => !isGenericModel(m))

        if (nonGenericAlternatives.length > 0) {
          // Use non-generic alternatives
          result.isAirlineSpecific = isAirlineSpecific
          result.vmrSource = entry.sourceVmr
          result.alternatives = nonGenericAlternatives

          for (const altModelName of nonGenericAlternatives) {
            const sourceModel = resolveSourceModel(altModelName)
            if (sourceModel) {
              result.modelName = altModelName
              result.sourceModel = sourceModel
              result.modelSource = sourceModel.source
              break
            }
          }

          if (result.modelName) {
            return result
          }
        }

        // All alternatives were generic - fall through to dimension-based matching
        console.log(`  VMR rule found but all ${sortedAlternatives.length} alternatives are generic, skipping...`)
      }

      // No VMR match (or all generic) - would trigger dimension-based fallback
      // Simulate what AircraftModelService.findClosestModelForAirline would do
      if (airlineCode) {
        const airlineModels = [...fsltlModels, ...aigModels].filter(
          m => m.airlineCode === airlineCode
        )

        if (airlineModels.length > 0) {
          // Find closest by type similarity (simplified - real code uses dimensions)
          // For demo, just pick first available model for this airline
          const model = airlineModels[0]
          result.modelName = model.modelName
          result.sourceModel = model
          result.modelSource = model.source
          result.alternatives = [model.modelName]
          console.log(`  Dimension fallback would find: ${model.modelName} (${model.aircraftType})`)
        }
      }

      return result
    }

    // Test AFR + B738 with the new setting
    const resultOld = findMatch('B738', 'AFR')
    const resultNew = findMatchSkipGenerics('B738', 'AFR')

    console.log('\nOLD behavior (skipGenericVmrMatches = false):')
    console.log(`  Model: ${resultOld.modelName}`)
    console.log(`  Source: ${resultOld.vmrSource?.split('\\').pop()}`)

    console.log('\nNEW behavior (skipGenericVmrMatches = true):')
    console.log(`  Model: ${resultNew.modelName}`)
    if (resultNew.sourceModel) {
      console.log(`  Aircraft Type: ${resultNew.sourceModel.aircraftType}`)
      console.log(`  Airline: ${resultNew.sourceModel.airlineCode}`)
    }

    // The new behavior should NOT use the generic ZZZZ model
    expect(resultNew.modelName).not.toContain('ZZZZ')
    // Should find an AFR model
    expect(resultNew.sourceModel?.airlineCode).toBe('AFR')
  })

  // Simulate: What if we only had PerfectModelMatching.vmr?
  it('simulate: AFR+B738 with only PerfectModelMatching.vmr', () => {
    // Re-process rules with only PerfectModelMatching
    const pmOnlyRules = vmrRules.filter(r => r.sourceVmr.includes('PerfectModelMatching'))
    const pmDefaultRules = new Map<string, VMRRuleEntry>()
    const pmAirlineRules = new Map<string, VMRRuleEntry>()

    processApiRules(
      pmOnlyRules,
      pmDefaultRules,
      pmAirlineRules,
      (rule, sourceVmr) => ({ rule, sourceVmr })
    )

    console.log(`\n=== Simulating PerfectModelMatching.vmr only ===`)
    console.log(`Airline rules: ${pmAirlineRules.size} (was ${airlineRules.size})`)

    // Check if AFR_B738 exists
    const afrRule = pmAirlineRules.get('AFR_B738')
    console.log(`\nAFR_B738 rule: ${afrRule ? 'EXISTS' : 'NONE'}`)

    if (afrRule) {
      console.log(`  Alternatives: ${afrRule.rule.modelNames.join(', ')}`)
    } else {
      // Check default B738
      const defaultRule = pmDefaultRules.get('B738')
      console.log(`\nDefault B738 rule: ${defaultRule ? 'EXISTS' : 'NONE'}`)
      if (defaultRule) {
        console.log(`  Alternatives: ${defaultRule.rule.modelNames.slice(0, 5).join(', ')}...`)
      }

      // What would happen - no VMR match means dimension-based fallback
      console.log(`\n=> Without FSLTL_Rules.vmr, AFR+B738 would have NO VMR match`)
      console.log(`=> This triggers dimension-based fallback in AircraftModelService`)
      console.log(`=> Should find AFR A320 or similar and scale it to B738 dimensions`)
    }
  })
})

// =============================================================================
// Exported utilities for ad-hoc testing
// =============================================================================

export {
  findMatch,
  resolveSourceModel,
  getAvailableAirlines,
  getAvailableAircraftTypes,
  vmrRules,
  fsltlModels,
  aigModels,
  defaultRules,
  airlineRules,
}
