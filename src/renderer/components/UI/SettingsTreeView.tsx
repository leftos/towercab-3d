/**
 * Settings Tree View Component
 *
 * A reusable tree view with tri-state checkboxes for the Export/Import Settings Wizard.
 * Supports hierarchical selection with parent-child state propagation.
 */

import { useState, useCallback, useMemo, memo } from 'react'
import type { TreeNodeData, CheckState } from '@/types'
import { getAllLeafIds } from '../../services/SettingsTreeBuilder'
import './SettingsTreeView.css'

interface SettingsTreeViewProps {
  /** Tree nodes to display */
  nodes: TreeNodeData[]
  /** Set of selected leaf node IDs */
  selectedIds: Set<string>
  /** Callback when selection changes */
  onSelectionChange: (selectedIds: Set<string>) => void
  /** Mode affects visual styling */
  mode: 'export' | 'import'
  /** Maximum height of the tree container */
  maxHeight?: string
}

/**
 * Compute the check state for a node based on its children
 */
function computeCheckState(node: TreeNodeData, selectedIds: Set<string>): CheckState {
  if (node.isLeaf) {
    return selectedIds.has(node.id) ? 'checked' : 'unchecked'
  }

  if (!node.children || node.children.length === 0) {
    return 'unchecked'
  }

  const childStates = node.children.map(child => computeCheckState(child, selectedIds))
  const allChecked = childStates.every(s => s === 'checked')
  const allUnchecked = childStates.every(s => s === 'unchecked')

  if (allChecked) return 'checked'
  if (allUnchecked) return 'unchecked'
  return 'indeterminate'
}

/**
 * Get all leaf IDs under a node
 */
function getLeafIdsUnderNode(node: TreeNodeData): string[] {
  if (node.isLeaf) return [node.id]
  if (!node.children) return []
  return node.children.flatMap(getLeafIdsUnderNode)
}

/**
 * Toggle a node's selection state
 */
function toggleNodeSelection(
  node: TreeNodeData,
  currentState: CheckState,
  selectedIds: Set<string>
): Set<string> {
  const newSet = new Set(selectedIds)
  const shouldSelect = currentState !== 'checked'
  const leafIds = getLeafIdsUnderNode(node)

  for (const id of leafIds) {
    if (shouldSelect) {
      newSet.add(id)
    } else {
      newSet.delete(id)
    }
  }

  return newSet
}

interface TreeNodeProps {
  node: TreeNodeData
  depth: number
  selectedIds: Set<string>
  expandedIds: Set<string>
  onToggleExpand: (id: string) => void
  onToggleSelect: (node: TreeNodeData, state: CheckState) => void
}

/**
 * Memoized tree node component for performance with large trees
 */
const TreeNode = memo(function TreeNode({
  node,
  depth,
  selectedIds,
  expandedIds,
  onToggleExpand,
  onToggleSelect
}: TreeNodeProps) {
  const isExpanded = expandedIds.has(node.id)
  const checkState = computeCheckState(node, selectedIds)
  const hasChildren = !node.isLeaf && node.children && node.children.length > 0

  const handleChevronClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (hasChildren) {
      onToggleExpand(node.id)
    }
  }

  const handleCheckboxClick = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation()
    onToggleSelect(node, checkState)
  }

  const handleCheckboxKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      handleCheckboxClick(e)
    }
  }

  const handleRowClick = () => {
    // Clicking the row toggles the checkbox
    onToggleSelect(node, checkState)
  }

  // Compute aria-checked value for accessibility
  const ariaChecked = checkState === 'checked' ? true : checkState === 'indeterminate' ? 'mixed' : false

  return (
    <div className="tree-node" data-depth={depth}>
      <div
        className="tree-node-header"
        onClick={handleRowClick}
        style={{ paddingLeft: `${12 + depth * 20}px` }}
      >
        {/* Expand/collapse chevron */}
        <span
          className={`tree-chevron ${hasChildren ? (isExpanded ? 'expanded' : '') : 'hidden'}`}
          onClick={handleChevronClick}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>

        {/* Tri-state checkbox with accessibility */}
        <span
          role="checkbox"
          aria-checked={ariaChecked}
          aria-label={`${node.label}${node.settingCount ? ` (${node.settingCount} settings)` : ''}`}
          tabIndex={0}
          className={`tri-checkbox ${checkState}`}
          onClick={handleCheckboxClick}
          onKeyDown={handleCheckboxKeyDown}
        >
          {checkState === 'checked' && (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
          {checkState === 'indeterminate' && (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          )}
        </span>

        {/* Label */}
        <span className={`tree-node-label ${!node.isLeaf ? 'category' : ''}`}>
          {node.label}
        </span>

        {/* Setting count or badge */}
        {node.settingCount !== undefined && (
          <span className="tree-node-count">
            ({node.settingCount} setting{node.settingCount !== 1 ? 's' : ''})
          </span>
        )}
        {node.badge && (
          <span className="tree-node-badge">{node.badge}</span>
        )}
      </div>

      {/* Children */}
      {hasChildren && isExpanded && (
        <div className="tree-children">
          {node.children?.map(child => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedIds={selectedIds}
              expandedIds={expandedIds}
              onToggleExpand={onToggleExpand}
              onToggleSelect={onToggleSelect}
            />
          ))}
        </div>
      )}
    </div>
  )
})

function SettingsTreeView({
  nodes,
  selectedIds,
  onSelectionChange,
  mode,
  maxHeight = '400px'
}: SettingsTreeViewProps) {
  // Track which nodes are expanded
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    // Default: expand top-level nodes
    const initial = new Set<string>()
    nodes.forEach(node => initial.add(node.id))
    return initial
  })

  // Get all leaf IDs for select all/none
  const allLeafIds = useMemo(() => getAllLeafIds(nodes), [nodes])

  const handleToggleExpand = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  const handleToggleSelect = useCallback((node: TreeNodeData, currentState: CheckState) => {
    const newSelected = toggleNodeSelection(node, currentState, selectedIds)
    onSelectionChange(newSelected)
  }, [selectedIds, onSelectionChange])

  const handleSelectAll = () => {
    onSelectionChange(new Set(allLeafIds))
  }

  const handleClearAll = () => {
    onSelectionChange(new Set())
  }

  const handleExpandAll = () => {
    const allIds = new Set<string>()
    function addAll(node: TreeNodeData) {
      allIds.add(node.id)
      node.children?.forEach(addAll)
    }
    nodes.forEach(addAll)
    setExpandedIds(allIds)
  }

  const handleCollapseAll = () => {
    // Keep only top-level expanded
    const topLevel = new Set(nodes.map(n => n.id))
    setExpandedIds(topLevel)
  }

  // Calculate selection summary
  const selectedCount = selectedIds.size
  const totalCount = allLeafIds.length

  return (
    <div className={`settings-tree-view ${mode}`}>
      {/* Toolbar */}
      <div className="tree-toolbar">
        <span className="tree-selection-summary">
          {selectedCount} of {totalCount} selected
        </span>
        <div className="tree-toolbar-buttons">
          <button
            type="button"
            className="tree-toolbar-btn"
            onClick={handleSelectAll}
            disabled={selectedCount === totalCount}
          >
            Select All
          </button>
          <button
            type="button"
            className="tree-toolbar-btn"
            onClick={handleClearAll}
            disabled={selectedCount === 0}
          >
            Clear All
          </button>
          <span className="tree-toolbar-separator" />
          <button
            type="button"
            className="tree-toolbar-btn icon"
            onClick={handleExpandAll}
            title="Expand All"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          <button
            type="button"
            className="tree-toolbar-btn icon"
            onClick={handleCollapseAll}
            title="Collapse All"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="18 15 12 9 6 15" />
            </svg>
          </button>
        </div>
      </div>

      {/* Tree content */}
      <div className="tree-content" style={{ maxHeight }}>
        {nodes.map(node => (
          <TreeNode
            key={node.id}
            node={node}
            depth={0}
            selectedIds={selectedIds}
            expandedIds={expandedIds}
            onToggleExpand={handleToggleExpand}
            onToggleSelect={handleToggleSelect}
          />
        ))}
      </div>
    </div>
  )
}

export default SettingsTreeView
