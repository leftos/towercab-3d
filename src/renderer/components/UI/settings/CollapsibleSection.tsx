import { useState, type ReactNode } from 'react'
import '../ControlsBar.css'

interface CollapsibleSectionProps {
  title: string
  children: ReactNode
  defaultExpanded?: boolean
}

function CollapsibleSection({ title, children, defaultExpanded = false }: CollapsibleSectionProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)

  return (
    <div className={`settings-section collapsible ${isExpanded ? 'expanded' : 'collapsed'}`}>
      <h3
        className="collapsible-header"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <span className="collapsible-chevron">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
        {title}
      </h3>
      {isExpanded && (
        <div className="collapsible-content">
          {children}
        </div>
      )}
    </div>
  )
}

export default CollapsibleSection
