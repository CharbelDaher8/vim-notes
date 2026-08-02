import { useEffect, useRef, type ReactNode } from 'react'

import { Close } from './icons'

/**
 * Built on native `<dialog>` -- it brings the focus trap, the inert background,
 * Escape handling and the top layer with it, all of which are tedious and easy
 * to get subtly wrong by hand.
 */
export function Dialog({
  open,
  title,
  description,
  onClose,
  children,
  actions,
  size = 'regular',
}: {
  open: boolean
  title: string
  description?: ReactNode
  onClose: () => void
  children?: ReactNode
  actions?: ReactNode
  size?: 'regular' | 'wide'
}) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const element = ref.current
    if (element === null) return

    if (open && !element.open) element.showModal()
    if (!open && element.open) element.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className="dialog"
      data-size={size}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        // `<dialog>` reports backdrop clicks as clicks on the dialog element
        // itself, so anything landing on a child is a real interaction.
        if (event.target === ref.current) onClose()
      }}
    >
      <header className="dialog__header">
        <div>
          <h2 className="dialog__title">{title}</h2>
          {description === undefined ? null : <p className="dialog__description">{description}</p>}
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
          <Close />
        </button>
      </header>

      {children === undefined ? null : <div className="dialog__body">{children}</div>}
      {actions === undefined ? null : <footer className="dialog__actions">{actions}</footer>}
    </dialog>
  )
}
