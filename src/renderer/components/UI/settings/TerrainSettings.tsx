import { useSettingsStore } from '../../../stores/settingsStore'
import CollapsibleSection from './CollapsibleSection'
import '../ControlsBar.css'
import type { BuildingQuality } from '../../../types'

function TerrainSettings() {
  const terrainQuality = useSettingsStore((state) => state.cesium.terrainQuality)
  const show3DBuildings = useSettingsStore((state) => state.cesium.show3DBuildings)
  const buildingQuality = useSettingsStore((state) => state.cesium.buildingQuality)
  const updateCesiumSettings = useSettingsStore((state) => state.updateCesiumSettings)

  return (
    <CollapsibleSection title="Terrain">
      <div className="setting-item">
        <label>Terrain Quality</label>
        <div className="slider-with-value">
          <input
            type="range"
            min="1"
            max="5"
            step="1"
            value={terrainQuality}
            onChange={(e) => updateCesiumSettings({ terrainQuality: Number(e.target.value) as 1 | 2 | 3 | 4 | 5 })}
          />
          <span>{['Low', 'Medium', 'High', 'Very High', 'Ultra'][terrainQuality - 1]}</span>
        </div>
        <p className="setting-hint">
          Lower quality loads faster. Higher quality shows more detail at distance.
        </p>
      </div>

      <div className="setting-item">
        <label>
          <input
            type="checkbox"
            checked={show3DBuildings}
            onChange={(e) => updateCesiumSettings({ show3DBuildings: e.target.checked })}
          />
          Show 3D Buildings (OSM)
        </label>
        <p className="setting-hint">
          Display OpenStreetMap 3D buildings. May impact performance.
        </p>
      </div>

      {show3DBuildings && (
        <div className="setting-item">
          <label>Building Quality</label>
          <select
            value={buildingQuality ?? 'low'}
            onChange={(e) => updateCesiumSettings({ buildingQuality: e.target.value as BuildingQuality })}
          >
            <option value="low">Low (save memory)</option>
            <option value="medium">Medium (balanced)</option>
            <option value="high">High (stay visible when zoomed out)</option>
          </select>
          <p className="setting-hint">
            Higher quality keeps buildings visible at greater zoom distances but uses more memory.
          </p>
        </div>
      )}
    </CollapsibleSection>
  )
}

export default TerrainSettings
