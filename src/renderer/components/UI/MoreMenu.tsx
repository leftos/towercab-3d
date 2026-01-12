/**
 * More Menu Component
 *
 * A flyout menu that groups secondary controls to reduce clutter on small screens.
 * Used in the ControlsBar to hide less-frequently-used buttons behind a single "More" button.
 */

import { useState, useRef, useEffect } from 'react'
import './MoreMenu.css'

export interface MoreMenuSubmenuItem {
  id: string
  label: string
  onClick: () => void
}

export interface MoreMenuItem {
  id: string
  label: string
  icon: React.ReactNode
  onClick?: () => void           // Optional if has submenu
  submenu?: MoreMenuSubmenuItem[] // Nested items
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
  const [activeSubmenuId, setActiveSubmenuId] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false)
        setActiveSubmenuId(null)
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
        setActiveSubmenuId(null)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen])

  // Reset submenu when main menu closes
  useEffect(() => {
    if (!isOpen) {
      setActiveSubmenuId(null)
    }
  }, [isOpen])

  const handleItemClick = (item: MoreMenuItem) => {
    if (item.disabled) return

    // If item has a submenu, toggle it
    if (item.submenu && item.submenu.length > 0) {
      setActiveSubmenuId(activeSubmenuId === item.id ? null : item.id)
      return
    }

    // Otherwise execute onClick and close menu
    if (item.onClick) {
      item.onClick()
      setIsOpen(false)
      setActiveSubmenuId(null)
    }
  }

  const handleSubmenuItemClick = (subItem: MoreMenuSubmenuItem) => {
    subItem.onClick()
    setIsOpen(false)
    setActiveSubmenuId(null)
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
          {items.map((item) => {
            const hasSubmenu = item.submenu && item.submenu.length > 0
            const isSubmenuOpen = activeSubmenuId === item.id

            return (
              <div key={item.id} className="more-menu-item-container">
                <button
                  className={`more-menu-item ${item.active ? 'active' : ''} ${item.disabled ? 'disabled' : ''} ${hasSubmenu ? 'has-submenu' : ''} ${isSubmenuOpen ? 'submenu-open' : ''}`}
                  onClick={() => handleItemClick(item)}
                  disabled={item.disabled}
                  title={item.label}
                >
                  <span className="more-menu-item-icon">{item.icon}</span>
                  <span className="more-menu-item-label">{item.label}</span>
                  {item.badge !== undefined && item.badge !== 0 && (
                    <span className="more-menu-item-badge">{item.badge}</span>
                  )}
                  {hasSubmenu && (
                    <span className={`more-menu-chevron ${isSubmenuOpen ? 'open' : ''}`}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </span>
                  )}
                </button>

                {/* Submenu items */}
                {hasSubmenu && isSubmenuOpen && (
                  <div className="more-menu-submenu">
                    {item.submenu!.map((subItem) => (
                      <button
                        key={subItem.id}
                        className="more-menu-submenu-item"
                        onClick={() => handleSubmenuItemClick(subItem)}
                      >
                        {subItem.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default MoreMenu
