/**
 * More Menu Component
 *
 * A flyout menu that groups secondary controls to reduce clutter on small screens.
 * Used in the ControlsBar to hide less-frequently-used buttons behind a single "More" button.
 */

import { useState, useRef, useEffect } from 'react'
import './MoreMenu.css'

interface MoreMenuItem {
  id: string
  label: string
  icon: React.ReactNode
  onClick: () => void
  active?: boolean
  disabled?: boolean
  badge?: string | number
}

interface MoreMenuProps {
  items: MoreMenuItem[]
  position?: 'left' | 'right'
}

function MoreMenu({ items, position = 'right' }: MoreMenuProps) {
  const [isOpen, setIsOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  // Close menu on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen])

  const handleItemClick = (item: MoreMenuItem) => {
    if (!item.disabled) {
      item.onClick()
      setIsOpen(false)
    }
  }

  return (
    <div className={`more-menu more-menu-${position}`} ref={menuRef}>
      <button
        className={`more-menu-toggle control-button ${isOpen ? 'active' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        title="More options"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="1" />
          <circle cx="12" cy="5" r="1" />
          <circle cx="12" cy="19" r="1" />
        </svg>
      </button>

      {isOpen && (
        <div className="more-menu-dropdown">
          {items.map((item) => (
            <button
              key={item.id}
              className={`more-menu-item ${item.active ? 'active' : ''} ${item.disabled ? 'disabled' : ''}`}
              onClick={() => handleItemClick(item)}
              disabled={item.disabled}
              title={item.label}
            >
              <span className="more-menu-item-icon">{item.icon}</span>
              <span className="more-menu-item-label">{item.label}</span>
              {item.badge !== undefined && item.badge !== 0 && (
                <span className="more-menu-item-badge">{item.badge}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default MoreMenu
