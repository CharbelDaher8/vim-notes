-- ╭──────────────────────────────────────────────────────────╮
-- │  Options — sane IDE defaults                               │
-- ╰──────────────────────────────────────────────────────────╯
local opt = vim.opt

-- UI
opt.number = true            -- absolute line numbers
opt.relativenumber = true    -- relative line numbers (great for motions)
opt.cursorline = true        -- highlight the current line
opt.termguicolors = true     -- 24-bit colour
opt.signcolumn = "yes"       -- always show the sign column (no text shift)
opt.scrolloff = 8            -- keep 8 lines above/below the cursor
opt.sidescrolloff = 8
opt.wrap = false             -- no line wrapping by default
opt.pumheight = 10           -- max items in the completion popup
opt.pumblend = 0
opt.winminwidth = 5          -- minimum window width
opt.laststatus = 3           -- a single, global statusline
opt.cmdheight = 1
opt.showmode = false         -- mode is shown in the statusline instead
opt.conceallevel = 2
opt.fillchars = {
  diff = "╱",
  eob = " ",
}
opt.list = true
opt.listchars = { tab = "» ", trail = "·", nbsp = "␣" }

-- Editing / indentation
opt.expandtab = true         -- spaces, not tabs
opt.shiftwidth = 2           -- indent = 2 spaces
opt.tabstop = 2
opt.softtabstop = 2
opt.smartindent = true
opt.breakindent = true
opt.autoindent = true

-- Search
opt.ignorecase = true
opt.smartcase = true         -- case-sensitive if the query has capitals
opt.hlsearch = true
opt.incsearch = true
opt.inccommand = "split"     -- live preview of :substitute

-- Splits
opt.splitright = true
opt.splitbelow = true
opt.splitkeep = "screen"

-- Files / persistence
opt.undofile = true          -- persistent undo across sessions
opt.undolevels = 10000
opt.swapfile = false
opt.backup = false
opt.writebackup = false
opt.confirm = true           -- ask to save instead of failing on :q

-- Behaviour
opt.mouse = "a"              -- mouse works everywhere
opt.clipboard = "unnamedplus" -- sync with the system clipboard
opt.updatetime = 200         -- faster CursorHold / diagnostics
opt.timeoutlen = 400         -- mapped-sequence wait time
opt.completeopt = "menu,menuone,noselect"
opt.virtualedit = "block"    -- let the cursor move past EOL in visual-block
opt.formatoptions = "jcroqlnt"
opt.shortmess:append({ W = true, I = true, c = true, C = true })
opt.wildmode = "longest:full,full"
opt.smoothscroll = true

-- Folds (Treesitter-powered; see the treesitter plugin)
opt.foldlevel = 99
opt.foldlevelstart = 99
opt.foldcolumn = "0"
opt.foldmethod = "expr"
opt.foldexpr = "v:lua.vim.treesitter.foldexpr()"

-- Fall back to ascii listchars/fill when there is no Nerd Font
if not vim.g.have_nerd_font then
  opt.list = false
end
