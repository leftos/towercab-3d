import { useMemo } from 'react'
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
        const modelInfo = aircraftModelService.getModelInfo(aircraftType)
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

  // Extract model name from URL (e.g., "./b738.glb" -> "b738")
  const getModelName = (modelUrl: string): string => {
    const match = modelUrl.match(/\.\/(.+)\.glb$/)
    return match ? match[1] : modelUrl
  }

  return (
    <div className="settings-modal-overlay" onClick={onClose}>
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
                  const scale = formatScale(aircraft.modelInfo.scale)
                  return (
                    <tr key={aircraft.callsign}>
                      <td className="callsign">{aircraft.callsign}</td>
                      <td className="type-code">{aircraft.aircraftType}</td>
                      <td className="model-name">{getModelName(aircraft.modelInfo.modelUrl)}</td>
                      <td>
                        <span className={`match-badge ${aircraft.modelInfo.matchType}`}>
                          {aircraft.modelInfo.matchType}
                        </span>
                      </td>
                      <td className={`scale-value ${scale.isScaled ? 'scaled' : ''}`}>
                        {scale.text}
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
