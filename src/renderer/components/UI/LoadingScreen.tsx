import './LoadingScreen.css'

export interface LoadingStep {
  id: string
  label: string
  weight: number // Relative weight for progress calculation
}

export interface LoadingProgress {
  currentStep: number
  totalSteps: number
  stepProgress: number // 0-100 within current step
  status: string
}

interface LoadingScreenProps {
  progress: LoadingProgress
  steps: LoadingStep[]
}

/**
 * Loading screen with progress bar shown during app initialization.
 * Shows overall progress percentage calculated from step weights.
 */
function LoadingScreen({ progress, steps }: LoadingScreenProps) {
  // Calculate overall percentage based on step weights
  const totalWeight = steps.reduce((sum, step) => sum + step.weight, 0)

  // Sum weight of completed steps
  let completedWeight = 0
  for (let i = 0; i < progress.currentStep; i++) {
    completedWeight += steps[i]?.weight || 0
  }

  // Add partial weight of current step
  const currentStepWeight = steps[progress.currentStep]?.weight || 0
  const currentStepContribution = (currentStepWeight * progress.stepProgress) / 100

  const overallProgress = Math.min(100, Math.round(((completedWeight + currentStepContribution) / totalWeight) * 100))

  return (
    <div className="loading-screen">
      <div className="loading-content">
        <img src="/logo.png" alt="TowerCab 3D" className="loading-logo" />

        {/* Progress bar */}
        <div className="loading-progress-container">
          <div className="loading-progress-bar" style={{ width: `${overallProgress}%` }} />
        </div>

        {/* Percentage and step count */}
        <div className="loading-progress-text">
          <span className="loading-percentage">{overallProgress}%</span>
          <span className="loading-step-count">
            Step {progress.currentStep + 1} of {progress.totalSteps}
          </span>
        </div>

        {/* Status text */}
        <p className="loading-status">{progress.status}</p>
      </div>
    </div>
  )
}

export default LoadingScreen
