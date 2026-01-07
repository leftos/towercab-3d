import { useMemo, useEffect, useState, useCallback } from 'react'
import { useVatsimStore } from '../../stores/vatsimStore'
import { useRealTrafficStore } from '../../stores/realTrafficStore'
import { useGlobalSettingsStore } from '../../stores/globalSettingsStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { aircraftModelService, type ModelInfo } from '../../services/AircraftModelService'
import { userVMRService } from '../../services/UserVMRService'
import { ModelPreviewModal } from './ModelPreviewModal'
import './ModelMatchingModal.css'

interface ModelMatchingModalProps {
  onClose: () => void
}

interface AircraftModelData {
  callsign: string
  aircraftType: string
  modelInfo: ModelInfo
}

/** Test result for manual model matching lookup */
interface TestResult {
  callsign: string
  aircraftType: string
  modelInfo: ModelInfo
  vmrAlternatives: string[]
}

function ModelMatchingModal({ onClose }: ModelMatchingModalProps) {
  const dataSource = useGlobalSettingsStore((state) => state.realtraffic.dataSource)
  const pilots = useVatsimStore((state) => state.pilots)
  const rtAircraftStates = useRealTrafficStore((state) => state.aircraftStates)
  const aircraftDataRadiusNM = useSettingsStore((state) => state.memory.aircraftDataRadiusNM)

  // Counter to force re-render when model conversions complete
  const [conversionVersion, setConversionVersion] = useState(0)

  // Test panel state
  const [testAirline, setTestAirline] = useState('')
  const [testType, setTestType] = useState('')
  const [testResult, setTestResult] = useState<TestResult | null>(null)

  // Preview modal state
  const [previewModel, setPreviewModel] = useState<ModelInfo | null>(null)

  // Listen for model conversion completions to refresh the table
  useEffect(() => {
    const handleConversionComplete = () => {
      // Increment version to trigger useMemo recalculation
      setConversionVersion(v => v + 1)
    }

    window.addEventListener('model-conversion-complete', handleConversionComplete)
    return () => {
      window.removeEventListener('model-conversion-complete', handleConversionComplete)
    }
  }, [])

  // Run test lookup
  const runTest = useCallback(async () => {
    if (!testType.trim()) return

    const airlineCode = testAirline.trim().toUpperCase() || null
    const aircraftType = testType.trim().toUpperCase()
    // Create a fake callsign for model matching (airline + flight number)
    const fakeCallsign = airlineCode ? `${airlineCode}999` : 'N12345'

    // Clear the cache for this lookup to get fresh results
    aircraftModelService.clearCache()

    let modelInfo = aircraftModelService.getModelInfo(aircraftType, fakeCallsign)
    const vmrAlternatives = userVMRService.getAlternatives(aircraftType, airlineCode)

    // If model is pending conversion, wait for it to complete
    if (modelInfo.matchType === 'pending') {
      try {
        const result = await aircraftModelService.waitForConversion(
          aircraftType,
          fakeCallsign
        )
        if (result.success && result.glbPath) {
          // Get the updated model info after conversion
          modelInfo = aircraftModelService.getModelInfo(aircraftType, fakeCallsign)
        }
      } catch (error) {
        console.warn('[ModelMatch] Conversion wait failed:', error)
        // Continue with the pending model info
      }
    }

    setTestResult({
      callsign: fakeCallsign,
      aircraftType,
      modelInfo,
      vmrAlternatives
    })
    // Open preview modal only if model is ready or converted
    if (modelInfo.matchType !== 'pending') {
      setPreviewModel(modelInfo)
    }
  }, [testAirline, testType])

  // Build model matching data for all aircraft in range
  const aircraftData = useMemo<AircraftModelData[]>(() => {
    if (dataSource === 'realtraffic') {
      // RealTraffic mode: use aircraftStates from realTrafficStore
      return Array.from(rtAircraftStates.values())
        .map((state) => {
          const aircraftType = state.aircraftType
          const modelInfo = aircraftModelService.getModelInfo(aircraftType, state.callsign)
          return {
            callsign: state.callsign,
            aircraftType: aircraftType || 'N/A',
            modelInfo
          }
        })
        .sort((a, b) => a.callsign.localeCompare(b.callsign))
    }

    // VATSIM mode: use pilots from vatsimStore
    return pilots
      .map((pilot) => {
        const aircraftType = pilot.flight_plan?.aircraft_faa || null
        // Pass callsign to enable FSLTL airline-specific livery matching
        const modelInfo = aircraftModelService.getModelInfo(aircraftType, pilot.callsign)
        return {
          callsign: pilot.callsign,
          aircraftType: aircraftType || 'N/A',
          modelInfo
        }
      })
      .sort((a, b) => a.callsign.localeCompare(b.callsign))
  // eslint-disable-next-line react-hooks/exhaustive-deps -- conversionVersion triggers refresh when models finish converting
  }, [dataSource, pilots, rtAircraftStates, conversionVersion])

  // Format scale for display
  const formatScale = (scale: { x: number; y: number; z: number }): { text: string; isScaled: boolean } => {
    const isUniform = Math.abs(scale.x - 1) < 0.001 &&
                      Math.abs(scale.y - 1) < 0.001 &&
                      Math.abs(scale.z - 1) < 0.001

    if (isUniform) {
      return { text: '1.00', isScaled: false }
    }

    // Show non-uniform scale
    return {
      text: `${scale.x.toFixed(2)}×${scale.y.toFixed(2)}×${scale.z.toFixed(2)}`,
      isScaled: true
    }
  }

  // Extract display-friendly model name from ModelInfo
  // MSFS models: Use matchedModel directly (e.g., "FSLTL_FAIB_B738_American")
  // FSLTL: "...fsltl/B738/AAL/model.glb" -> "B738/AAL"
  // Built-in: "./b738.glb" -> "b738"
  const getModelName = (modelInfo: ModelInfo): { name: string; variationName?: string } => {
    // For FSLTL/MSFS converted models, use matchedModel directly
    // This contains the clean model name like "FSLTL_FAIB_B738_American"
    if (modelInfo.isFsltl && modelInfo.matchedModel) {
      return { name: modelInfo.matchedModel }
    }

    const modelUrl = modelInfo.modelUrl

    // Decode URL-encoded characters (e.g., %5C -> \, %3A -> :)
    const decodedUrl = decodeURIComponent(modelUrl)

    // Check for FSLTL path pattern (contains fsltl folder)
    // Handle both forward and back slashes, and asset:// protocol URLs
    const fsltlMatch = decodedUrl.match(/fsltl[/\\]([^/\\]+)[/\\]([^/\\]+)[/\\]model\.glb$/i)
    if (fsltlMatch) {
      const [, aircraftType, variant] = fsltlMatch
      // If variant is "base", just show the type
      const name = variant.toLowerCase() === 'base' ? aircraftType : `${aircraftType}/${variant}`
      return { name, variationName: modelInfo.vmrVariationName }
    }

    // Built-in model pattern
    const builtInMatch = decodedUrl.match(/\.\/(.+)\.glb$/)
    return { name: builtInMatch ? builtInMatch[1] : modelUrl }
  }

  // Map internal match types to user-friendly display names
  const getMatchTypeDisplay = (matchType: string): { label: string; className: string } => {
    switch (matchType) {
      case 'exact':
        return { label: 'exact', className: 'exact' }
      case 'closest':
        return { label: 'closest', className: 'closest' }
      case 'pending':
        return { label: 'converting...', className: 'pending' }
      case 'fallback':
      default:
        return { label: 'fallback', className: 'fallback' }
    }
  }

  // Check if scale should be shown (only for 'closest' matches that have non-uniform scaling)
  const shouldShowScale = (modelInfo: ModelInfo): boolean => {
    return modelInfo.matchType === 'closest'
  }

  // Close modal on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div className="settings-modal-overlay">
      <div className="settings-modal model-matching-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Model Matching</h2>
          <button className="close-button" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="model-matching-summary">
          {aircraftData.length} aircraft within data radius ({aircraftDataRadiusNM} NM)
        </div>

        {/* Model Matching Tester */}
        <div className="model-test-panel">
          <div className="model-test-inputs">
            <input
              type="text"
              placeholder="Airline (e.g., UAL)"
              value={testAirline}
              onChange={(e) => setTestAirline(e.target.value)}
              className="model-test-input"
              maxLength={4}
            />
            <input
              type="text"
              placeholder="Type (e.g., B738)"
              value={testType}
              onChange={(e) => setTestType(e.target.value)}
              className="model-test-input"
              maxLength={4}
              onKeyDown={(e) => e.key === 'Enter' && runTest()}
            />
            <button
              onClick={runTest}
              disabled={!testType.trim()}
              className="model-test-button"
            >
              Test
            </button>
          </div>
          {testResult && (
            <div className="model-test-result">
              <div className="model-test-result-row">
                <span className="model-test-label">Callsign:</span>
                <span className="model-test-value">{testResult.callsign}</span>
              </div>
              <div className="model-test-result-row">
                <span className="model-test-label">Type:</span>
                <span className="model-test-value">{testResult.aircraftType}</span>
              </div>
              <div className="model-test-result-row">
                <span className="model-test-label">Model:</span>
                <span className="model-test-value model-name">
                  {getModelName(testResult.modelInfo).name}
                </span>
              </div>
              <div className="model-test-result-row">
                <span className="model-test-label">Match:</span>
                <span className={`match-badge ${getMatchTypeDisplay(testResult.modelInfo.matchType).className}`}>
                  {getMatchTypeDisplay(testResult.modelInfo.matchType).label}
                </span>
              </div>
              {testResult.modelInfo.matchType === 'closest' && (
                <div className="model-test-result-row">
                  <span className="model-test-label">Scale:</span>
                  <span className="model-test-value scale-value scaled">
                    {formatScale(testResult.modelInfo.scale).text}
                  </span>
                </div>
              )}
              {testResult.vmrAlternatives.length > 0 && (
                <div className="model-test-result-row">
                  <span className="model-test-label">VMR Options:</span>
                  <span className="model-test-value vmr-alternatives">
                    {testResult.vmrAlternatives.join(', ')}
                  </span>
                </div>
              )}
              <div className="model-test-result-row">
                <span className="model-test-label">URL:</span>
                <span className="model-test-value model-url" title={testResult.modelInfo.modelUrl}>
                  {testResult.modelInfo.modelUrl}
                </span>
              </div>
            </div>
          )}
        </div>

        <div className="model-matching-table-container">
          {aircraftData.length === 0 ? (
            <div className="model-matching-empty">
              No aircraft in range
            </div>
          ) : (
            <table className="model-matching-table">
              <thead>
                <tr>
                  <th>Callsign</th>
                  <th>Type</th>
                  <th>Model</th>
                  <th>Match</th>
                  <th>Scale</th>
                </tr>
              </thead>
              <tbody>
                {aircraftData.map((aircraft) => {
                  const matchDisplay = getMatchTypeDisplay(aircraft.modelInfo.matchType)
                  const modelDisplay = getModelName(aircraft.modelInfo)
                  const showScale = shouldShowScale(aircraft.modelInfo)
                  const scale = showScale ? formatScale(aircraft.modelInfo.scale) : null
                  return (
                    <tr
                      key={aircraft.callsign}
                      onClick={() => setPreviewModel(aircraft.modelInfo)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td className="callsign">{aircraft.callsign}</td>
                      <td className="type-code">{aircraft.aircraftType}</td>
                      <td
                        className="model-name"
                        title={modelDisplay.variationName ? `VMR: ${modelDisplay.variationName}` : undefined}
                      >
                        {modelDisplay.name}
                        {modelDisplay.variationName && (
                          <span className="variation-indicator" title={modelDisplay.variationName}>*</span>
                        )}
                      </td>
                      <td>
                        <span className={`match-badge ${matchDisplay.className}`}>
                          {matchDisplay.label}
                        </span>
                      </td>
                      <td className={`scale-value ${scale?.isScaled ? 'scaled' : ''}`}>
                        {scale ? scale.text : ''}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Model Preview Modal */}
        {previewModel && (
          <ModelPreviewModal
            modelInfo={previewModel}
            onClose={() => setPreviewModel(null)}
          />
        )}
      </div>
    </div>
  )
}

export default ModelMatchingModal
