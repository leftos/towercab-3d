/**
 * Shared VMR (Visual Model Rules) utilities
 *
 * Common functionality used by both UserVMRService and CustomVMRService
 * for parsing and managing VMR rules.
 */

/** Parsed VMR rule from API/Rust backend */
export interface ParsedApiRule {
  typeCode: string
  modelName: string
  callsignPrefix?: string | null
  sourceVmr: string
}

/** Normalized VMR rule for storage */
export interface VMRRule {
  typeCode: string
  modelNames: string[]
  callsignPrefix?: string
}

/** Rule entry with source tracking */
export interface RuleEntry<T = VMRRule> {
  rule: T
  sourceVmr: string
}

/**
 * Generate a lookup key for airline-specific rules
 */
export function createAirlineRuleKey(callsignPrefix: string, typeCode: string): string {
  return `${callsignPrefix}_${typeCode}`
}

/**
 * Parse model name string into array of alternatives
 * VMR files use // to separate alternative model names
 */
export function parseModelNames(modelName: string): string[] {
  return modelName.split('//').filter(name => name.trim())
}

/**
 * Normalize type code to uppercase for consistent lookups
 */
export function normalizeTypeCode(code: string): string {
  return code.toUpperCase()
}

/**
 * Normalize callsign prefix to uppercase for consistent lookups
 */
export function normalizeCallsignPrefix(prefix: string | null | undefined): string | undefined {
  return prefix?.toUpperCase() || undefined
}

/**
 * Process parsed API rules into default and airline rule maps
 * Uses first-rule-wins for conflicts (higher priority files should be processed first)
 *
 * @param rules Parsed rules from API/Rust backend
 * @param defaultRules Map to populate with default (type-only) rules
 * @param airlineRules Map to populate with airline-specific rules
 * @param createEntry Factory function to create rule entries (allows custom data per service)
 */
export function processApiRules<T extends RuleEntry>(
  rules: ParsedApiRule[],
  defaultRules: Map<string, T>,
  airlineRules: Map<string, T>,
  createEntry: (rule: VMRRule, sourceVmr: string) => T
): void {
  for (const apiRule of rules) {
    const typeCode = normalizeTypeCode(apiRule.typeCode)
    const modelNames = parseModelNames(apiRule.modelName)
    const callsignPrefix = normalizeCallsignPrefix(apiRule.callsignPrefix)

    if (modelNames.length === 0) continue

    const rule: VMRRule = { typeCode, modelNames, callsignPrefix }
    const entry = createEntry(rule, apiRule.sourceVmr)

    if (callsignPrefix) {
      const key = createAirlineRuleKey(callsignPrefix, typeCode)
      // First rule wins for conflicts
      if (!airlineRules.has(key)) {
        airlineRules.set(key, entry)
      }
    } else {
      // First rule wins for conflicts
      if (!defaultRules.has(typeCode)) {
        defaultRules.set(typeCode, entry)
      }
    }
  }
}

/**
 * Get unique source VMR files from parsed rules
 */
export function getUniqueSourceFiles(rules: ParsedApiRule[]): string[] {
  const uniqueFiles = new Set(rules.map(r => r.sourceVmr))
  return Array.from(uniqueFiles)
}

/**
 * Find a rule match for aircraft type and optional airline
 * Tries airline-specific rule first, then falls back to default
 *
 * @param aircraftType ICAO aircraft type code
 * @param airlineCode Optional airline ICAO code
 * @param defaultRules Map of default rules by type code
 * @param airlineRules Map of airline rules by composite key
 * @returns Matched entry or null
 */
export function findRuleMatch<T>(
  aircraftType: string,
  airlineCode: string | null,
  defaultRules: Map<string, T>,
  airlineRules: Map<string, T>
): { entry: T; isAirlineSpecific: boolean } | null {
  const normalizedType = normalizeTypeCode(aircraftType)
  const normalizedAirline = airlineCode?.toUpperCase()

  // 1. Try airline-specific rule
  if (normalizedAirline) {
    const airlineKey = createAirlineRuleKey(normalizedAirline, normalizedType)
    const entry = airlineRules.get(airlineKey)
    if (entry) {
      return { entry, isAirlineSpecific: true }
    }
  }

  // 2. Try default rule for type
  const defaultEntry = defaultRules.get(normalizedType)
  if (defaultEntry) {
    return { entry: defaultEntry, isAirlineSpecific: false }
  }

  return null
}
