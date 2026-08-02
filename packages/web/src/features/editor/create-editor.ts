/**
 * The CodeMirror instance, and the only place in the app that touches it.
 *
 * Two rules hold this together:
 *
 *  1. CodeMirror owns the document. Nothing mirrors the buffer into Zustand.
 *     The store knows *about* the document -- which path, dirty or not, what
 *     hash it was read at -- and asks for the text only at the moment it saves.
 *     Two sources of truth for the text is how this class of app rots.
 *
 *  2. Vim lives in a Compartment, so turning it on and off is a reconfigure of
 *     a running editor rather than a teardown. That matters beyond tidiness:
 *     rebuilding the view would lose the selection, the scroll position and the
 *     undo history every time someone toggles it (DECISIONS.md §4).
 */
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  type Extension,
} from '@codemirror/state'
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
  rectangularSelection,
} from '@codemirror/view'
import { editorCommands, type EditorCommands } from './editor-commands'
import { editorTheme } from './editor-theme'
import { findLinkAt, markdownDecorations } from './markdown-decorations'
import { loadMarkdownLanguage, markdownLanguageExtension } from './markdown-language'
import { loadVim, vimExtension } from './vim-extension'
import { wikiLinksExtension, type WikiLinkContext } from './wikilink-extension'

/**
 * Marks a transaction as coming from the platform rather than the keyboard.
 * Dirty tracking keys off this: reloading a note that nvim changed must not
 * make the buffer look unsaved.
 */
const remoteChange = Annotation.define<boolean>()

export interface EditorHandle {
  readonly view: EditorView
  getContent: () => string
  /** Opening a different note: fresh state, so undo cannot cross note boundaries. */
  loadDocument: (content: string) => void
  /** Same note, new bytes from elsewhere. Keeps the cursor where it can. */
  applyRemoteContent: (content: string) => void
  setVimEnabled: (enabled: boolean) => void
  setDark: (dark: boolean) => void
  /** Null until the client knows which notes exist; see wikilink-extension.ts. */
  setWikiLinks: (context: WikiLinkContext | null) => void
  reveal: (line: number, column?: number) => void
  scrollCursorIntoView: () => void
  focus: () => void
  destroy: () => void
}

export interface CreateEditorOptions {
  parent: HTMLElement
  doc: string
  vimEnabled: boolean
  dark: boolean
  /** Fires only for changes the user made. */
  onUserChange: () => void
  onSave: () => void
  onClose: () => void
  /** Mod-click on a link. Routed through the platform host, never navigated to. */
  onOpenLink: (url: string) => void
}

export function createEditor(options: CreateEditorOptions): EditorHandle {
  const vimCompartment = new Compartment()
  const languageCompartment = new Compartment()
  const themeCompartment = new Compartment()
  const keyboardCompartment = new Compartment()
  const gutterCompartment = new Compartment()
  const wikiLinkCompartment = new Compartment()

  let vimEnabled = options.vimEnabled
  let dark = options.dark
  let wikiLinks: WikiLinkContext | null = null

  const commands: EditorCommands = {
    save: () => options.onSave(),
    close: () => options.onClose(),
  }

  const buildExtensions = (): Extension[] => [
    // Ahead of the vim keymap on purpose: Ctrl/Cmd-S has to save in every mode,
    // including insert mode, where vim's own handler sees the key first.
    Prec.highest(
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: (view) => {
            view.state.facet(editorCommands).save()
            return true
          },
        },
      ]),
    ),

    vimCompartment.of(vimExtension(vimEnabled)),
    editorCommands.of(commands),

    history(),
    // Ahead of the default keymap so Enter continues a list rather than just
    // breaking the line. Empty until the chunk lands; see markdown-language.ts.
    languageCompartment.of(markdownLanguageExtension()),
    markdownDecorations,
    wikiLinkCompartment.of(wikiLinksExtension(wikiLinks)),
    EditorView.lineWrapping,
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    gutterCompartment.of(gutterExtensions(vimEnabled)),
    placeholder('Nothing here yet.'),

    keymap.of([...historyKeymap, ...defaultKeymap]),
    keyboardCompartment.of(keyboardExtensions(vimEnabled)),

    themeCompartment.of(editorTheme(dark)),

    /**
     * The mobile essentials. Autocorrect capitalising after every dot in a URL,
     * or "helpfully" replacing a straight quote inside a code fence, makes a
     * markdown buffer genuinely unusable -- and it does it silently, so you
     * find out later, in the diff.
     */
    EditorView.contentAttributes.of({
      autocorrect: 'off',
      autocapitalize: 'off',
      autocomplete: 'off',
      spellcheck: 'false',
      // Grammarly and friends inject DOM into the content element, which
      // CodeMirror then has to fight over.
      'data-gramm': 'false',
      'data-enable-grammarly': 'false',
    }),

    /**
     * Mod-click opens a link. Plain click stays cursor placement -- this is an
     * editor, and on a touch device every tap would otherwise be a navigation.
     *
     * It never lets the webview follow the URL itself: in the Tauri build that
     * replaces the running application, with no chrome to come back from.
     */
    EditorView.domEventHandlers({
      mousedown: (event, view) => {
        if (!event.metaKey && !event.ctrlKey) return false

        const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (position === null) return false

        const line = view.state.doc.lineAt(position)
        const url = findLinkAt(line.text, position - line.from)
        if (url === null) return false

        event.preventDefault()
        options.onOpenLink(url)
        return true
      },
    }),

    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return
      if (
        update.transactions.some((transaction) => transaction.annotation(remoteChange) === true)
      ) {
        return
      }
      options.onUserChange()
    }),
  ]

  const view = new EditorView({
    parent: options.parent,
    state: EditorState.create({ doc: options.doc, extensions: buildExtensions() }),
  })

  const clampedSelection = (length: number) => {
    const previous = view.state.selection.main
    return EditorSelection.single(
      Math.min(previous.anchor, length),
      Math.min(previous.head, length),
    )
  }

  /**
   * Both lazy chunks reconfigure the editor when they land, and either can
   * resolve after the pane has unmounted -- reliably so under StrictMode, which
   * mounts, unmounts and remounts. `dispatch` on a destroyed view throws.
   */
  let destroyed = false

  const applyVim = () => {
    if (destroyed) return
    view.dispatch({
      effects: [
        vimCompartment.reconfigure(vimExtension(vimEnabled)),
        keyboardCompartment.reconfigure(keyboardExtensions(vimEnabled)),
        gutterCompartment.reconfigure(gutterExtensions(vimEnabled)),
      ],
    })
  }

  // Vim arrives in its own chunk (see vim-extension.ts), so the first
  // reconfigure with it on may land a frame or two after the request. Anything
  // toggled in the meantime wins -- `applyVim` always reads the current flag.
  if (vimEnabled) void loadVim().then(applyVim)

  // Always wanted, just not needed for the first paint.
  void loadMarkdownLanguage().then(() => {
    if (destroyed) return
    view.dispatch({ effects: languageCompartment.reconfigure(markdownLanguageExtension()) })
  })

  return {
    view,

    getContent: () => view.state.doc.toString(),

    loadDocument: (content) => {
      view.setState(EditorState.create({ doc: content, extensions: buildExtensions() }))
    },

    applyRemoteContent: (content) => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
        selection: clampedSelection(content.length),
        annotations: remoteChange.of(true),
      })
    },

    setVimEnabled: (enabled) => {
      if (enabled === vimEnabled) return
      vimEnabled = enabled
      applyVim()
    },

    setDark: (next) => {
      if (next === dark) return
      dark = next
      view.dispatch({ effects: themeCompartment.reconfigure(editorTheme(next)) })
    },

    setWikiLinks: (context) => {
      // Guarded like the lazy chunks above: the tree query can resolve after
      // the pane has unmounted, and dispatching on a destroyed view throws.
      if (destroyed || context === wikiLinks) return
      wikiLinks = context
      view.dispatch({ effects: wikiLinkCompartment.reconfigure(wikiLinksExtension(context)) })
    },

    reveal: (line, column = 1) => {
      const target = view.state.doc.line(Math.min(Math.max(line, 1), view.state.doc.lines))
      const position = Math.min(target.from + column - 1, target.to)

      view.dispatch({
        selection: EditorSelection.cursor(position),
        effects: EditorView.scrollIntoView(position, { y: 'center' }),
      })
      view.focus()
    },

    scrollCursorIntoView: () => {
      const { head } = view.state.selection.main
      view.dispatch({ effects: EditorView.scrollIntoView(head, { y: 'nearest', yMargin: 48 }) })
    },

    focus: () => view.focus(),

    destroy: () => {
      destroyed = true
      view.destroy()
    },
  }
}

/**
 * Tab indents only when vim is on.
 *
 * With vim off this is a plain textbox that people reach with a keyboard, and
 * swallowing Tab traps them in it. With vim on there is a real keyboard, Tab is
 * expected to indent, and Esc-then-Tab is already muscle memory for leaving.
 */
function keyboardExtensions(vimEnabled: boolean): Extension {
  return vimEnabled ? keymap.of([indentWithTab]) : []
}

/** Line numbers earn their width only next to `:42` and `42gg`. */
function gutterExtensions(vimEnabled: boolean): Extension {
  return vimEnabled ? [lineNumbers(), highlightActiveLineGutter(), highlightActiveLine()] : []
}
