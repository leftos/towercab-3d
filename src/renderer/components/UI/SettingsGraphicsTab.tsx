import TerrainSettings from './settings/TerrainSettings'
import LightingSettings from './settings/LightingSettings'
import WeatherSettings from './settings/WeatherSettings'
import RenderingSettings from './settings/RenderingSettings'
import ModelAppearanceSettings from './settings/ModelAppearanceSettings'
import ShadowSettings from './settings/ShadowSettings'
import './ControlsBar.css'

function SettingsGraphicsTab() {
  return (
    <>
      <TerrainSettings />
      <LightingSettings />
      <WeatherSettings />
      <RenderingSettings />
      <ModelAppearanceSettings />
      <ShadowSettings />
    </>
  )
}

export default SettingsGraphicsTab
