import { Ion } from 'cesium'
import { isRemoteMode } from '@/utils/remoteMode'

/**
 * Sets Cesium's default ion access token. In a dev build whose page the headless dev server
 * (`pnpm run vite:headless`, scripts/dev/devApi.ts) serves, the token is that server's placeholder
 * (`ION_PLACEHOLDER` in scripts/dev/settingsView.ts): Cesium's ion server is then pointed at the dev
 * server's `/api/ion/` route, which forwards asset-endpoint calls to ion with the real token, so the
 * browser only ever holds the per-asset tokens ion returns. The placeholder is written inline so a
 * production build drops it with the branch.
 */
export function setIonAccessToken(token: string): void {
  Ion.defaultAccessToken = token
  if (import.meta.env.DEV && isRemoteMode() && token === 'tc3d-dev-api-ion-placeholder') {
    Ion.defaultServer = `${window.location.origin}/api/ion/`
  }
}
