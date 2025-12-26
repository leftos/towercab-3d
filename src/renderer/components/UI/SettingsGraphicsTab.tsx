import TerrainSettings from './settings/TerrainSettings'
import LightingSettings from './settings/LightingSettings'
import WeatherSettings from './settings/WeatherSettings'
import AdvancedGraphicsSettings from './settings/AdvancedGraphicsSettings'
import './ControlsBar.css'

function SettingsGraphicsTab() {
  return (
    <>
      <TerrainSettings />
      <LightingSettings />
      <WeatherSettings />
      <AdvancedGraphicsSettings />
    </>
  )
}

export default SettingsGraphicsTab
