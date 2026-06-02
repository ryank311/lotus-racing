// Shared modal dialog — one presentation for confirmations, errors, and forms.
// Uses the .modal-* styles in styles.css. Click the backdrop or press Escape to
// dismiss (unless locked, e.g. while a request is in flight).

import { useEffect, type ReactNode } from 'react'

export function Modal({
  eyebrow, title, onClose, children, actions, dismissable = true,
}: {
  eyebrow?: string
  title: string
  onClose: () => void
  children?: ReactNode
  actions?: ReactNode
  dismissable?: boolean
}) {
  useEffect(() => {
    if (!dismissable) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dismissable, onClose])

  return (
    <div className="modal-overlay" onClick={dismissable ? onClose : undefined}>
      <div className="modal-card" onClick={e => e.stopPropagation()}>
        <div className="card-corner-marks"><i /></div>
        {eyebrow && <div className="modal-eyebrow">{eyebrow}</div>}
        <div className="modal-title">{title}</div>
        {children && <div className="modal-body">{children}</div>}
        {actions && <div className="modal-actions">{actions}</div>}
      </div>
    </div>
  )
}
