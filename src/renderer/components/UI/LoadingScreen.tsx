import { useEffect, useState } from 'react'
import './LoadingScreen.css'

export interface LoadingStep {
  id: string
  label: string
  weight: number
}

export interface LoadingProgress {
  currentStep: number
  totalSteps: number
  stepProgress: number
  status: string
}

interface LoadingScreenProps {
  progress: LoadingProgress
  steps: LoadingStep[]
}

const STALLED_HINT_DELAY_MS = 10_000

function CompassRose() {
  const cx = 64
  const cy = 64
  const ringR = 60
  const longSpoke = 56
  const shortSpoke = 40
  const spokes: { x: number; y: number; long: boolean }[] = []
  for (let i = 0; i < 16; i++) {
    const angle = (i * Math.PI) / 8
    const long = i % 2 === 0
    const r = long ? longSpoke : shortSpoke
    spokes.push({ x: Math.sin(angle) * r, y: -Math.cos(angle) * r, long })
  }
  return (
    <svg className="loading-compass" viewBox="0 0 128 128" aria-hidden="true" focusable="false" role="presentation">
      <circle cx={cx} cy={cy} r={ringR} fill="none" stroke="currentColor" strokeWidth="0.6" />
      <circle cx={cx} cy={cy} r={ringR - 14} fill="none" stroke="currentColor" strokeWidth="0.4" />
      {spokes.map((s) => (
        <line
          key={`${s.x.toFixed(2)}-${s.y.toFixed(2)}`}
          x1={cx}
          y1={cy}
          x2={cx + s.x}
          y2={cy + s.y}
          stroke="currentColor"
          strokeWidth={s.long ? 0.8 : 0.4}
        />
      ))}
      <polygon
        points={`${cx},${cy - longSpoke - 4} ${cx - 4},${cy - longSpoke + 6} ${cx + 4},${cy - longSpoke + 6}`}
        fill="currentColor"
      />
      <text x={cx} y={cy - longSpoke - 8} textAnchor="middle" fontSize="10" fontWeight="600" fill="currentColor">
        N
      </text>
    </svg>
  )
}

function LoadingScreen({ progress, steps }: LoadingScreenProps) {
  const { currentStep } = progress
  const [isStalled, setIsStalled] = useState(false)

  useEffect(() => {
    // Reset stall hint whenever the current step changes; reading currentStep
    // here makes the dependency explicit to lint.
    void currentStep
    setIsStalled(false)
    const timer = setTimeout(() => setIsStalled(true), STALLED_HINT_DELAY_MS)
    return () => clearTimeout(timer)
  }, [currentStep])

  const totalWeight = steps.reduce((sum, step) => sum + step.weight, 0)

  let completedWeight = 0
  for (let i = 0; i < progress.currentStep; i++) {
    completedWeight += steps[i]?.weight || 0
  }

  const currentStepWeight = steps[progress.currentStep]?.weight || 0
  const currentStepContribution = (currentStepWeight * progress.stepProgress) / 100

  const overallProgress = Math.min(100, Math.round(((completedWeight + currentStepContribution) / totalWeight) * 100))

  return (
    <div className="loading-screen">
      <div className="loading-content">
        <div className="loading-logo-stack">
          <CompassRose />
          <img src="/logo.png" alt="TowerCab 3D" className="loading-logo" />
        </div>

        <div className="loading-progress-container">
          <div className="loading-progress-bar" style={{ width: `${overallProgress}%` }} />
        </div>

        <div className="loading-progress-text">
          <span className="loading-percentage">{overallProgress}%</span>
          <span className="loading-step-count">
            Step {progress.currentStep + 1} of {progress.totalSteps}
          </span>
        </div>

        <p className="loading-status">{progress.status}</p>
        {isStalled && <p className="loading-stalled-hint">This is taking longer than usual…</p>}
      </div>
    </div>
  )
}

export default LoadingScreen
