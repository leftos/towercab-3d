/**
 * MSFS Indexing Modal
 *
 * Shows a blocking modal with progress bar while FSLTL/AIG models are being indexed.
 * Appears when user enables a source in Settings > MSFS Models.
 */

import React from 'react'
import { useIndexingStore } from '@/stores/indexingStore'
import styles from './MSFSIndexingModal.module.css'

export function MSFSIndexingModal() {
  const isIndexing = useIndexingStore((state) => state.isIndexing)
  const progress = useIndexingStore((state) => state.progress)
  const status = useIndexingStore((state) => state.status)
  const source = useIndexingStore((state) => state.source)

  if (!isIndexing) {
    return null
  }

  const sourceLabel = source?.toUpperCase() ?? 'Models'

  return (
    <div className={styles.overlay}>
      <div className={styles.modal}>
        <h2 className={styles.title}>Indexing {sourceLabel} Models</h2>
        <p className={styles.status}>{status}</p>

        <div className={styles.progressContainer}>
          <div className={styles.progressBar}>
            <div className={styles.progressFill} style={{ width: `${progress}%` }} />
          </div>
          <span className={styles.progressText}>{Math.round(progress)}%</span>
        </div>

        <p className={styles.hint}>This may take a few seconds. The app will resume once indexing is complete.</p>
      </div>
    </div>
  )
}
