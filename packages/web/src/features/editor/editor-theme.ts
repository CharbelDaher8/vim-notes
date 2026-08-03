import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/**
 * Colours come from the CSS custom properties in tokens.css rather than being
 * repeated here, so the editor cannot end up a slightly different shade of the
 * app around it. What the `dark` flag still buys is CodeMirror's own
 * behaviour -- selection blending and the default panel styling read it -- so
 * this is reconfigured through a compartment when the theme flips rather than
 * relying on the variables alone.
 */
export function editorTheme(dark: boolean): Extension {
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        color: 'var(--text)',
        backgroundColor: 'transparent',
        fontSize: 'var(--editor-font-size)',
      },

      '.cm-scroller': {
        fontFamily: 'var(--font-mono)',
        lineHeight: 'var(--editor-line-height)',
        // Room to breathe under the last line, and clearance for the virtual
        // keyboard so the final paragraph is not pinned against it.
        paddingBottom: 'calc(35vh + var(--keyboard-inset, 0px))',
        // Momentum scrolling stops at the container instead of dragging the
        // page behind it.
        overscrollBehavior: 'contain',
      },

      '.cm-content': {
        padding: '1.25rem 0',
        caretColor: 'var(--accent)',
        maxWidth: 'var(--editor-measure)',
        margin: '0 auto',
        width: '100%',
      },

      '.cm-line': {
        padding: '0 clamp(0.9rem, 4vw, 1.4rem)',
      },

      '&.cm-focused': { outline: 'none' },

      '.cm-cursor, .cm-dropCursor': {
        borderLeftWidth: '2px',
        borderLeftColor: 'var(--accent)',
      },

      '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--accent)' },

      '.cm-selectionBackground, ::selection': {
        backgroundColor: 'var(--accent-soft)',
      },

      '&.cm-focused .cm-selectionBackground': {
        backgroundColor: 'var(--accent-soft)',
      },

      '.cm-activeLine': {
        backgroundColor: 'var(--surface-hover)',
      },

      '.cm-gutters': {
        border: 'none',
        backgroundColor: 'transparent',
        color: 'var(--text-faint)',
        fontSize: '0.85em',
        paddingRight: '0.35rem',
      },

      '.cm-activeLineGutter': {
        backgroundColor: 'transparent',
        color: 'var(--text-muted)',
      },

      '.cm-placeholder': {
        color: 'var(--text-faint)',
        fontStyle: 'italic',
      },

      // The vim command line. Pinned to the bottom of the editor, above the
      // keyboard inset so `:w` stays visible while typing it on a phone.
      '.cm-vim-panel': {
        padding: '0.3rem clamp(0.9rem, 4vw, 1.4rem)',
        borderTop: '1px solid var(--border)',
        backgroundColor: 'var(--surface-sunken)',
        color: 'var(--text-muted)',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-sm)',
      },

      '.cm-vim-panel input': {
        border: 'none',
        outline: 'none',
        background: 'transparent',
        color: 'var(--text)',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-sm)',
        width: '100%',
      },

      '.cm-panels': {
        backgroundColor: 'var(--surface-sunken)',
        color: 'var(--text)',
      },

      /*
       * The wiki link completion list.
       *
       * Restyled rather than left alone because CodeMirror's default is a
       * system-blue selection on white, which is the one surface in the app
       * that would not be wearing the palette -- and it appears directly over
       * the note, where the mismatch is impossible to miss.
       */
      '.cm-tooltip.cm-tooltip-autocomplete': {
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-sm)',
        backgroundColor: 'var(--surface-raised)',
        boxShadow: 'var(--shadow-lg)',
        // Clear of the caret, so the line being typed stays readable.
        marginTop: '0.25rem',
        overflow: 'hidden',
      },

      '.cm-tooltip-autocomplete > ul': {
        maxHeight: '14rem',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-sm)',
      },

      '.cm-tooltip-autocomplete > ul > li': {
        display: 'flex',
        alignItems: 'baseline',
        gap: '0.6rem',
        padding: '0.25rem 0.6rem',
        color: 'var(--text)',
        lineHeight: '1.5',
      },

      '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
        backgroundColor: 'var(--accent-soft)',
        color: 'var(--text)',
      },

      // What is about to be written, when it differs from the path above it.
      '.cm-completionDetail': {
        marginLeft: 'auto',
        color: 'var(--text-faint)',
        fontStyle: 'normal',
      },

      // The characters that matched what has been typed so far.
      '.cm-completionMatchedText': {
        color: 'var(--accent)',
        fontWeight: '600',
        textDecoration: 'none',
      },
    },
    { dark },
  )
}
