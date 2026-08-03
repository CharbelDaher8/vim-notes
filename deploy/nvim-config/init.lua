-- ╭──────────────────────────────────────────────────────────╮
-- │  Neovim — a minimal, pretty, full-featured IDE             │
-- │  Entry point. Loads core config, then bootstraps plugins.  │
-- ╰──────────────────────────────────────────────────────────╯

-- Leader keys MUST be set before lazy.nvim is loaded.
vim.g.mapleader = " "
vim.g.maplocalleader = " "

-- Set this to false if your terminal font is NOT a Nerd Font
-- (icons will fall back to text). See README for details.
vim.g.have_nerd_font = true

require("config.options")
require("config.keymaps")
require("config.autocmds")
require("config.lazy")
