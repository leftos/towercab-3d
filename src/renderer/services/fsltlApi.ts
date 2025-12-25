/**
 * FSLTL Tauri API Wrapper
 *
 * Provides TypeScript bindings for FSLTL-related Tauri commands.
 * These functions call the Rust backend for file system operations,
 * folder picking, and conversion process management.
 *
 * @see lib.rs - Rust backend implementation
 * @see FSLTLService - Frontend service that uses this API
 */

import { invoke } from '@tauri-apps/api/core'
import type { ConversionProgress } from '../types/fsltl'

/**
 * Open a native folder picker dialog
 * @returns Selected folder path, or null if cancelled
 */
export async function pickFolder(): Promise<string | null> {
  return invoke<string | null>('pick_folder')
}

/**
 * Read a text file from disk
 * @param path - Absolute path to the file
 * @returns File contents as string
 */
export async function readTextFile(path: string): Promise<string> {
  return invoke<string>('read_text_file', { path })
}

/**
 * Write a text file to disk (creates parent directories if needed)
 * @param path - Absolute path to the file
 * @param content - Content to write
 */
export async function writeTextFile(path: string, content: string): Promise<void> {
  return invoke<void>('write_text_file', { path, content })
}

/**
 * Get the default FSLTL models output path
 * Creates the directory if it doesn't exist
 * @returns Path to mods/aircraft/fsltl directory
 */
export async function getFsltlOutputPath(): Promise<string> {
  return invoke<string>('get_fsltl_output_path')
}

/**
 * Get smart default output path for FSLTL models
 * Tries mods folder first, falls back to APPDATA if not writable
 * @returns Tuple of [path, isWritable]
 */
export async function getFsltlDefaultOutputPath(): Promise<[string, boolean]> {
  return invoke<[string, boolean]>('get_fsltl_default_output_path')
}

/**
 * Validate that a path is a valid FSLTL source directory
 * Checks for FSLTL_Rules.vmr and SimObjects/Airplanes folder
 * @param sourcePath - Path to check
 * @returns true if valid FSLTL source
 */
export async function validateFsltlSource(sourcePath: string): Promise<boolean> {
  return invoke<boolean>('validate_fsltl_source', { sourcePath })
}

/**
 * List all FSLTL aircraft folders in the source directory
 * @param sourcePath - Path to fsltl-traffic-base
 * @returns Array of folder names (e.g., ["FSLTL_B738_AAL", "FSLTL_A320_UAL"])
 */
export async function listFsltlAircraft(sourcePath: string): Promise<string[]> {
  return invoke<string[]>('list_fsltl_aircraft', { sourcePath })
}

/**
 * Get the path to the bundled converter executable
 * @returns Path to fsltl_converter.exe
 */
export async function getConverterPath(): Promise<string> {
  return invoke<string>('get_converter_path')
}

/**
 * Start the FSLTL conversion process in the background
 * @param sourcePath - Path to fsltl-traffic-base
 * @param outputPath - Path where converted models will be saved
 * @param textureScale - Texture quality ('full', '2k', '1k', '512')
 * @param models - Array of model names to convert
 * @param progressFile - Path where progress JSON will be written
 */
export async function startFsltlConversion(
  sourcePath: string,
  outputPath: string,
  textureScale: string,
  models: string[],
  progressFile: string
): Promise<void> {
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
 */
export async function cancelFsltlConversion(): Promise<void> {
  return invoke<void>('cancel_fsltl_conversion')
}

/**
 * Read the current conversion progress from the progress file
 * @param progressFile - Path to the progress JSON file
 * @returns Current conversion progress
 */
export async function readConversionProgress(progressFile: string): Promise<ConversionProgress> {
  return invoke<ConversionProgress>('read_conversion_progress', { progressFile })
}

/**
 * Check if a specific FSLTL model has been converted
 * @param outputPath - FSLTL output directory
 * @param modelName - Model name (e.g., "FSLTL_B738_AAL")
 * @returns true if model.glb exists
 */
export async function checkFsltlModelExists(
  outputPath: string,
  modelName: string
): Promise<boolean> {
  return invoke<boolean>('check_fsltl_model_exists', { outputPath, modelName })
}

/**
 * Delete a file from disk
 * @param path - Absolute path to the file to delete
 */
export async function deleteFile(path: string): Promise<void> {
  return invoke<void>('delete_file', { path })
}

/**
 * Read the FSLTL_Rules.vmr file from an FSLTL source directory
 * @param sourcePath - Path to fsltl-traffic-base
 * @returns VMR file contents as string
 */
export async function readVmrFile(sourcePath: string): Promise<string> {
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
 */
export async function scanFsltlModels(outputPath: string): Promise<ScannedFSLTLModel[]> {
  return invoke<ScannedFSLTLModel[]>('scan_fsltl_models', { outputPath })
}
