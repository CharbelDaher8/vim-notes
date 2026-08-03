-- ╭──────────────────────────────────────────────────────────╮
-- │  lazy.nvim — plugin manager bootstrap + setup              │
-- │  Every file under lua/plugins/ is auto-imported.           │
-- ╰──────────────────────────────────────────────────────────╯
local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"

if not (vim.uv or vim.loop).fs_stat(lazypath) then
  local repo = "https://github.com/folke/lazy.nvim.git"
  local out = vim.fn.system({ "git", "clone", "--filter=blob:none", "--branch=stable", repo, lazypath })
  if vim.v.shell_error ~= 0 then
    vim.api.nvim_echo({
      { "Failed to clone lazy.nvim:\n", "ErrorMsg" },
      { out, "WarningMsg" },
      { "\nPress any key to exit...", "MoreMsg" },
    }, true, {})
    vim.fn.getchar()
    os.exit(1)
  end
end

vim.opt.rtp:prepend(lazypath)

require("lazy").setup({
  spec = {
    { import = "plugins" },
  },
  defaults = { lazy = true },
  install = { colorscheme = { "catppuccin", "habamax" } },
  checker = { enabled = true, notify = false }, -- quietly check for updates
  change_detection = { notify = false },
  ui = {
    border = "rounded",
    backdrop = 100,
  },
  performance = {
    rtp = {
      -- disable unused built-in plugins for a faster startup
      disabled_plugins = {
        "gzip",
        "tarPlugin",
        "tohtml",
        "tutor",
        "zipPlugin",
        "netrwPlugin",
        "matchit",
      },
    },
  },
})

-- Handy: <leader>L opens the lazy.nvim UI
vim.keymap.set("n", "<leader>L", "<cmd>Lazy<cr>", { desc = "Lazy (plugin manager)" })
