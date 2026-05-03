/**
 * Touch Onboarding
 *
 * One-time guided introduction shown to touch-device users immediately after
 * the DeviceOptimizationPrompt is dismissed. Walks through the gestures and
 * on-screen controls that are not otherwise discoverable on a tablet:
 *
 *  1. Pinch to zoom (with view-mode-specific behavior callout)
 *  2. Two-finger twist to rotate
 *  3. Joystick / command button / airport selector locations
 *
 * Persists `touchOnboardingCompleted: true` on either completion or skip so
 * the sequence never reappears.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIFeedbackStore } from '../../stores/uiFeedbackStore'
import { isTouchDevice } from '../../utils/deviceDetection'
import './TouchOnboarding.css'

const STEPS = ['pinch', 'twist', 'controls'] as const
type Step = (typeof STEPS)[number]

// Wait a beat after the device-optimization prompt disappears before opening
// the onboarding — otherwise back-to-back modals feel jarring.
const SHOW_DELAY_MS = 350

function TouchOnboarding() {
  const [isOpen, setIsOpen] = useState(false)
  const [stepIndex, setStepIndex] = useState(0)
  const overlayRef = useRef<HTMLDivElement>(null)

  const touchOnboardingCompleted = useSettingsStore((state) => state.ui.touchOnboardingCompleted)
  const deviceOptimizationPromptDismissed = useSettingsStore((state) => state.ui.deviceOptimizationPromptDismissed)
  const updateUISettings = useSettingsStore((state) => state.updateUISettings)
  const pushModal = useUIFeedbackStore((state) => state.pushModal)
  const popModal = useUIFeedbackStore((state) => state.popModal)

  // Open the onboarding once the device-optimization prompt has been dismissed,
  // but only on touch devices and only the first time.
  useEffect(() => {
    if (touchOnboardingCompleted) return
    if (!isTouchDevice()) return
    if (!deviceOptimizationPromptDismissed) return
    const timer = setTimeout(() => setIsOpen(true), SHOW_DELAY_MS)
    return () => clearTimeout(timer)
  }, [touchOnboardingCompleted, deviceOptimizationPromptDismissed])

  useEffect(() => {
    if (isOpen) {
      setStepIndex(0)
      pushModal()
      return () => popModal()
    }
  }, [isOpen, pushModal, popModal])

  const finish = useCallback(() => {
    updateUISettings({ touchOnboardingCompleted: true })
    setIsOpen(false)
  }, [updateUISettings])

  // Esc skips the rest of the sequence; the onboarding flag is set on close
  // so the user is not forced to walk through every step.
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        finish()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, finish])

  if (!isOpen) return null

  const step: Step = STEPS[stepIndex] ?? 'pinch'
  const isLast = stepIndex >= STEPS.length - 1

  const handleNext = () => {
    if (isLast) {
      finish()
    } else {
      setStepIndex((i) => i + 1)
    }
  }

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === overlayRef.current) finish()
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: modal overlay backdrop
    <div ref={overlayRef} className="touch-onboarding-overlay" role="presentation" onClick={handleBackdropClick}>
      <div className="touch-onboarding-modal" role="dialog" aria-label="Touch gesture onboarding">
        <div className="touch-onboarding-illustration">
          {step === 'pinch' && <PinchIllustration />}
          {step === 'twist' && <TwistIllustration />}
          {step === 'controls' && <ControlsIllustration />}
        </div>

        <h2 className="touch-onboarding-title">
          {step === 'pinch' && 'Pinch to zoom'}
          {step === 'twist' && 'Twist to rotate'}
          {step === 'controls' && 'On-screen controls'}
        </h2>

        <p className="touch-onboarding-caption">
          {step === 'pinch' &&
            'Pinch with two fingers to zoom. The exact effect depends on your view mode — follow zoom in tower follow, distance in orbit, FOV in free camera.'}
          {step === 'twist' &&
            'Twist two fingers to rotate the view. One-finger drag rotates in tower view and pans in top-down view.'}
          {step === 'controls' &&
            'The joystick walks you forward, back, and side-to-side. Tap the command button for ".NN" bookmark commands. Tap the airport name at the top to switch.'}
        </p>

        <div className="touch-onboarding-dots" aria-hidden="true">
          {STEPS.map((s, i) => (
            <span key={s} className={`touch-onboarding-dot${i === stepIndex ? ' active' : ''}`} />
          ))}
        </div>

        <div className="touch-onboarding-actions">
          <button type="button" className="touch-onboarding-skip" onClick={finish}>
            Skip
          </button>
          <button type="button" className="touch-onboarding-next" onClick={handleNext}>
            {isLast ? 'Got it' : 'Next →'}
          </button>
        </div>
      </div>
    </div>
  )
}

function PinchIllustration() {
  return (
    <svg
      aria-hidden="true"
      width="120"
      height="120"
      viewBox="0 0 120 120"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="60" cy="60" r="36" stroke="rgba(79, 195, 247, 0.35)" strokeDasharray="3 4" />
      <g className="pinch-finger pinch-finger-a">
        <circle cx="32" cy="60" r="9" fill="rgba(79, 195, 247, 0.35)" stroke="rgba(79, 195, 247, 0.9)" />
        <line x1="44" y1="60" x2="54" y2="60" />
      </g>
      <g className="pinch-finger pinch-finger-b">
        <circle cx="88" cy="60" r="9" fill="rgba(79, 195, 247, 0.35)" stroke="rgba(79, 195, 247, 0.9)" />
        <line x1="76" y1="60" x2="66" y2="60" />
      </g>
    </svg>
  )
}

function TwistIllustration() {
  return (
    <svg
      aria-hidden="true"
      width="120"
      height="120"
      viewBox="0 0 120 120"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="60" cy="60" r="36" stroke="rgba(79, 195, 247, 0.35)" strokeDasharray="3 4" />
      <g className="twist-fingers">
        <circle cx="36" cy="48" r="8" fill="rgba(79, 195, 247, 0.35)" stroke="rgba(79, 195, 247, 0.9)" />
        <circle cx="84" cy="72" r="8" fill="rgba(79, 195, 247, 0.35)" stroke="rgba(79, 195, 247, 0.9)" />
      </g>
      <path
        d="M 90 36 A 30 30 0 0 1 96 60"
        stroke="rgba(79, 195, 247, 0.7)"
        strokeWidth="2"
        markerEnd="url(#twist-arrow)"
      />
      <defs>
        <marker id="twist-arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 Z" fill="rgba(79, 195, 247, 0.9)" />
        </marker>
      </defs>
    </svg>
  )
}

function ControlsIllustration() {
  return (
    <svg
      aria-hidden="true"
      width="200"
      height="120"
      viewBox="0 0 200 120"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="2" width="196" height="116" rx="6" stroke="rgba(255, 255, 255, 0.25)" />
      <rect x="2" y="2" width="196" height="14" rx="6" fill="rgba(255, 255, 255, 0.06)" />
      <text x="14" y="12" fill="rgba(255, 255, 255, 0.6)" fontSize="8">
        KJFK
      </text>
      <line x1="36" y1="9" x2="64" y2="9" stroke="rgba(79, 195, 247, 0.7)" />
      <text x="68" y="12" fill="rgba(79, 195, 247, 0.85)" fontSize="7">
        airport
      </text>

      <circle cx="22" cy="90" r="14" fill="rgba(0, 0, 0, 0.5)" stroke="rgba(255, 255, 255, 0.25)" />
      <circle cx="22" cy="90" r="5" fill="rgba(79, 195, 247, 0.6)" stroke="rgba(255, 255, 255, 0.25)" />
      <line x1="40" y1="90" x2="64" y2="90" stroke="rgba(79, 195, 247, 0.7)" />
      <text x="68" y="93" fill="rgba(79, 195, 247, 0.85)" fontSize="7">
        joystick
      </text>

      <rect x="166" y="84" width="22" height="22" rx="4" fill="rgba(0, 0, 0, 0.4)" stroke="rgba(255, 255, 255, 0.25)" />
      <text x="171" y="98" fill="rgba(255, 255, 255, 0.7)" fontSize="9">
        .
      </text>
      <line x1="164" y1="95" x2="146" y2="95" stroke="rgba(79, 195, 247, 0.7)" />
      <text x="100" y="98" fill="rgba(79, 195, 247, 0.85)" fontSize="7" textAnchor="end">
        commands
      </text>
    </svg>
  )
}

export default TouchOnboarding
