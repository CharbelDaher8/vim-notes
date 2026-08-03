# Neovim IDE

A minimal-but-complete Neovim setup that replaces VSCode. Fast, modular, and
pretty (Catppuccin Mocha). Built on [lazy.nvim](https://github.com/folke/lazy.nvim).

> **Leader key is `<Space>`.** Press it and wait — [which-key](https://github.com/folke/which-key.nvim)
> shows you every available shortcut.

## Requirements

- **Neovim ≥ 0.11** (built/tested on 0.12)
- A **Nerd Font** in your terminal (icons). Install one with:
  ```sh
  brew install --cask font-jetbrains-mono-nerd-font
  ```
  Then set it as your terminal font. If you don't want icons, set
  `vim.g.have_nerd_font = false` in `init.lua`.
- CLI tools (already installed on this machine): `ripgrep`, `fd`, `fzf`, `lazygit`, `git`, `node`, a C compiler + `make`.

## Layout

```
~/.config/nvim/
├── init.lua                 # entry point, sets leader + loads modules
└── lua/
    ├── config/
    │   ├── options.lua      # editor settings
    │   ├── keymaps.lua      # general keybindings
    │   ├── autocmds.lua     # auto-commands
    │   └── lazy.lua         # plugin-manager bootstrap
    └── plugins/             # one file per concern (auto-imported)
        ├── colorscheme.lua  # Catppuccin
        ├── treesitter.lua   # syntax / indent / folds
        ├── lsp.lua          # language servers + Mason
        ├── completion.lua   # blink.cmp
        ├── telescope.lua    # fuzzy finder
        ├── neo-tree.lua     # file explorer
        ├── lualine.lua      # statusline
        ├── bufferline.lua   # buffer tabs
        ├── gitsigns.lua     # git gutter + hunks
        ├── conform.lua      # format-on-save
        ├── which-key.lua    # keybinding hints
        ├── editor.lua       # autopairs, surround, todo, trouble
        └── snacks.lua       # dashboard, terminal, lazygit, notifier
```

## Key bindings (the essentials)

### Files & search (Telescope)
| Key | Action |
|-----|--------|
| `Ctrl-p` / `<leader>ff` | Find files |
| `<leader>fg` or `<leader>/` | Live grep (search in project) |
| `<leader>fr` | Recent files |
| `<leader><space>` | Open buffers |
| `<leader>fw` | Grep word under cursor |
| `<leader>fh` | Help pages |
| `<leader>fk` | Search keymaps |

### File explorer
| Key | Action |
|-----|--------|
| `<leader>e` | Toggle file tree |
| `<leader>o` | Focus file tree |

### Code / LSP (when a language server is attached)
| Key | Action |
|-----|--------|
| `gd` / `gr` | Go to definition / references |
| `gI` / `gy` | Go to implementation / type def |
| `K` | Hover docs |
| `<leader>rn` | Rename symbol |
| `<leader>ca` | Code action |
| `<leader>cf` | Format buffer |
| `[d` / `]d` | Prev / next diagnostic |
| `<leader>uh` | Toggle inlay hints |
| `<leader>xx` | Problems panel (Trouble) |

### Git
| Key | Action |
|-----|--------|
| `<leader>gg` | Lazygit (full TUI) |
| `]h` / `[h` | Next / prev hunk |
| `<leader>gh` / `<leader>gr` | Stage / reset hunk |
| `<leader>gp` | Preview hunk |
| `<leader>gB` | Blame line |

### Buffers & windows
| Key | Action |
|-----|--------|
| `Shift-h` / `Shift-l` | Prev / next buffer |
| `<leader>bd` | Close buffer |
| `Ctrl-h/j/k/l` | Move between splits |
| `<leader>-` / `<leader>\|` | Split below / right |

### Terminal & misc
| Key | Action |
|-----|--------|
| `Ctrl-/` or `<leader>tt` | Toggle terminal |
| `<leader>L` | Plugin manager (Lazy) |
| `Ctrl-s` | Save |
| `<leader>uf` | Toggle format-on-save |

## Adding language support

Language servers, formatters, and linters are managed by **Mason**:

1. Open Neovim and run `:Mason`.
2. Press `i` on any tool to install it (e.g. `pyright`, `typescript-language-server`, `gopls`, `rust-analyzer`, `prettierd`, `black`).
3. For LSP servers you can also add per-project settings in
   `lua/plugins/lsp.lua` under the `servers = { … }` table (a few are stubbed out as comments).

Treesitter parsers install **automatically** the first time you open a file of
a new language (`auto_install = true`).

## Updating

- `:Lazy sync` — update plugins
- `:Lazy` — the plugin manager UI
- `:Mason` — manage LSP/formatter tools
- `:checkhealth` — diagnose issues

## Changing the look

Edit `lua/plugins/colorscheme.lua`. Catppuccin has four flavours:
`latte` (light), `frappe`, `macchiato`, `mocha` (default, darkest).
Set `transparent_background = true` for a see-through terminal look.
