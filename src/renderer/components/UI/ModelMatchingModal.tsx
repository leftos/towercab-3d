import { useMemo, useEffect } from 'react'
import { useVatsimStore } from '../../stores/vatsimStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { aircraftModelService, type ModelInfo } from '../../services/AircraftModelService'
import './ModelMatchingModal.css'

interface ModelMatchingModalProps {
  onClose: () => void
}

interface AircraftModelData {
  callsign: string
  aircraftType: string
  modelInfo: ModelInfo
}

function ModelMatchingModal({ onClose }: ModelMatchingModalProps) {
  const pilots = useVatsimStore((state) => state.pilots)
  const aircraftDataRadiusNM = useSettingsStore((state) => state.memory.aircraftDataRadiusNM)

  // Build model matching data for all pilots in range
  const aircraftData = useMemo<AircraftModelData[]>(() => {
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
  }, [pilots])

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

  // Extract display-friendly model name from URL
  // Built-in: "./b738.glb" -> "b738"
  // FSLTL: "...fsltl/B738/AAL/model.glb" or "...fsltl%5CB738%5CAAL%5Cmodel.glb" -> "B738/AAL"
  // FSLTL base: "...fsltl/B738/base/model.glb" -> "B738"
  const getModelName = (modelInfo: ModelInfo): { name: string; variationName?: string } => {
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
      case 'fsltl':
        return { label: 'exact', className: 'exact' }
      case 'mapped':
      case 'fsltl-base':
        return { label: 'mapped', className: 'mapped' }
      case 'fsltl-vmr':
        return { label: 'vmr', className: 'mapped' }
      case 'closest':
        return { label: 'closest', className: 'closest' }
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
                    <tr key={aircraft.callsign}>
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
      </div>
    </div>
  )
}

export default ModelMatchingModal
