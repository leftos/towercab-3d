/**
 * FSLTL Tauri API Wrapper
 *
 * Provides TypeScript bindings for FSLTL-related Tauri commands.
 * These functions call the Rust backend for file system operations,
 * folder picking, and conversion process management.
 *
 * In browser mode, most functions return empty/default values since
 * FSLTL conversion is a host-only feature.
 *
 * @see lib.rs - Rust backend implementation
 * @see FSLTLService - Frontend service that uses this API
 */

import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '../utils/tauriApi'
import type { ConversionProgress } from '../types/fsltl'

/**
 * Open a native folder picker dialog
 * @returns Selected folder path, or null if cancelled
 * Note: Not available in browser mode
 */
export async function pickFolder(): Promise<string | null> {
  if (!isTauri()) {
    console.warn('[fsltlApi] pickFolder not available in browser mode')
    return null
  }
  return invoke<string | null>('pick_folder')
}

/**
 * Read a text file from disk
 * @param path - Absolute path to the file
 * @returns File contents as string
 * Note: Not available in browser mode
 */
export async function readTextFile(path: string): Promise<string> {
  if (!isTauri()) {
    throw new Error('[fsltlApi] readTextFile not available in browser mode')
  }
  return invoke<string>('read_text_file', { path })
}

/**
 * Write a text file to disk (creates parent directories if needed)
 * @param path - Absolute path to the file
 * @param content - Content to write
 * Note: Not available in browser mode
 */
export async function writeTextFile(path: string, content: string): Promise<void> {
  if (!isTauri()) {
    throw new Error('[fsltlApi] writeTextFile not available in browser mode')
  }
  return invoke<void>('write_text_file', { path, content })
}

/**
 * Get the default FSLTL models output path
 * Creates the directory if it doesn't exist
 * @returns Path to mods/aircraft/fsltl directory
 */
export async function getFsltlOutputPath(): Promise<string> {
  if (!isTauri()) {
    return ''
  }
  return invoke<string>('get_fsltl_output_path')
}

/**
 * Get smart default output path for FSLTL models
 * Tries mods folder first, falls back to APPDATA if not writable
 * @returns Tuple of [path, isWritable]
 */
export async function getFsltlDefaultOutputPath(): Promise<[string, boolean]> {
  if (!isTauri()) {
    return ['', false]
  }
  return invoke<[string, boolean]>('get_fsltl_default_output_path')
}

/**
 * Validate that a path is a valid FSLTL source directory
 * Checks for FSLTL_Rules.vmr and SimObjects/Airplanes folder
 * @param sourcePath - Path to check
 * @returns true if valid FSLTL source
 * Note: Not available in browser mode
 */
export async function validateFsltlSource(sourcePath: string): Promise<boolean> {
  if (!isTauri()) {
    return false
  }
  return invoke<boolean>('validate_fsltl_source', { sourcePath })
}

/**
 * List all FSLTL aircraft folders in the source directory
 * @param sourcePath - Path to fsltl-traffic-base
 * @returns Array of folder names (e.g., ["FSLTL_B738_AAL", "FSLTL_A320_UAL"])
 * Note: Not available in browser mode
 */
export async function listFsltlAircraft(sourcePath: string): Promise<string[]> {
  if (!isTauri()) {
    return []
  }
  return invoke<string[]>('list_fsltl_aircraft', { sourcePath })
}

/**
 * Get the path to the bundled converter executable
 * @returns Path to fsltl_converter.exe
 * Note: Not available in browser mode
 */
export async function getConverterPath(): Promise<string> {
  if (!isTauri()) {
    return ''
  }
  return invoke<string>('get_converter_path')
}

/**
 * Start the FSLTL conversion process in the background
 * @param sourcePath - Path to fsltl-traffic-base
 * @param outputPath - Path where converted models will be saved
 * @param textureScale - Texture quality ('full', '2k', '1k', '512')
 * @param models - Array of model names to convert
 * @param progressFile - Path where progress JSON will be written
 * Note: Not available in browser mode
 */
export async function startFsltlConversion(
  sourcePath: string,
  outputPath: string,
  textureScale: string,
  models: string[],
  progressFile: string
): Promise<void> {
  if (!isTauri()) {
    throw new Error('[fsltlApi] startFsltlConversion not available in browser mode')
  }
  return invoke<void>('start_fsltl_conversion', {
    sourcePath,
    outputPath,
    textureScale,
    models,
    progressFile
  })
}

/**
 * Cancel the running FSLTL conversion process
 * Kills the converter subprocess if one is running
 * @throws Error if no conversion is in progress
 * Note: Not available in browser mode
 */
export async function cancelFsltlConversion(): Promise<void> {
  if (!isTauri()) {
    throw new Error('[fsltlApi] cancelFsltlConversion not available in browser mode')
  }
  return invoke<void>('cancel_fsltl_conversion')
}

/**
 * Read the current conversion progress from the progress file
 * @param progressFile - Path to the progress JSON file
 * @returns Current conversion progress
 * Note: Not available in browser mode
 */
export async function readConversionProgress(progressFile: string): Promise<ConversionProgress> {
  if (!isTauri()) {
    return { status: 'idle', total: 0, completed: 0, current: null, errors: [] }
  }
  return invoke<ConversionProgress>('read_conversion_progress', { progressFile })
}

/**
 * Check if a specific FSLTL model has been converted
 * @param outputPath - FSLTL output directory
 * @param modelName - Model name (e.g., "FSLTL_B738_AAL")
 * @returns true if model.glb exists
 * Note: Not available in browser mode
 */
export async function checkFsltlModelExists(
  outputPath: string,
  modelName: string
): Promise<boolean> {
  if (!isTauri()) {
    return false
  }
  return invoke<boolean>('check_fsltl_model_exists', { outputPath, modelName })
}

/**
 * Delete a file from disk
 * @param path - Absolute path to the file to delete
 * Note: Not available in browser mode
 */
export async function deleteFile(path: string): Promise<void> {
  if (!isTauri()) {
    throw new Error('[fsltlApi] deleteFile not available in browser mode')
  }
  return invoke<void>('delete_file', { path })
}

/**
 * Read the FSLTL_Rules.vmr file from an FSLTL source directory
 * @param sourcePath - Path to fsltl-traffic-base
 * @returns VMR file contents as string
 * Note: Not available in browser mode
 */
export async function readVmrFile(sourcePath: string): Promise<string> {
  if (!isTauri()) {
    throw new Error('[fsltlApi] readVmrFile not available in browser mode')
  }
  const vmrPath = `${sourcePath}\\FSLTL_Rules.vmr`
  return invoke<string>('read_text_file', { path: vmrPath })
}

/**
 * Scanned model info returned from scan_fsltl_models
 */
export interface ScannedFSLTLModel {
  modelName: string
  modelPath: string
  aircraftType: string
  airlineCode: string | null
  hasAnimations: boolean
  fileSize: number
}

/**
 * Scan an FSLTL output directory for existing converted models
 * @param outputPath - Path to scan for model.glb files
 * @returns Array of scanned model info
 * In browser mode, fetches from HTTP API
 */
export async function scanFsltlModels(outputPath: string): Promise<ScannedFSLTLModel[]> {
  if (!isTauri()) {
    // In browser mode, fetch from server API
    const response = await fetch('/api/fsltl/models')
    if (!response.ok) {
      console.warn('[fsltlApi] Failed to fetch FSLTL models:', response.status)
      return []
    }
    return response.json()
  }
  return invoke<ScannedFSLTLModel[]>('scan_fsltl_models', { outputPath })
}
