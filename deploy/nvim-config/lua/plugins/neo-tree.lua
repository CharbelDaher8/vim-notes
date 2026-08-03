-- ╭──────────────────────────────────────────────────────────╮
-- │  Neo-tree — a pretty file explorer sidebar                 │
-- ╰──────────────────────────────────────────────────────────╯
return {
  "nvim-neo-tree/neo-tree.nvim",
  branch = "v3.x",
  cmd = "Neotree",
  dependencies = {
    "nvim-lua/plenary.nvim",
    "nvim-tree/nvim-web-devicons",
    "MunifTanjim/nui.nvim",
  },
  keys = {
    { "<leader>e", "<cmd>Neotree toggle<cr>", desc = "Explorer (toggle)" },
    { "<leader>o", "<cmd>Neotree focus<cr>", desc = "Explorer (focus)" },
    { "<leader>ge", "<cmd>Neotree git_status<cr>", desc = "Git explorer" },
  },
  deactivate = function()
    vim.cmd([[Neotree close]])
  end,
  opts = {
    close_if_last_window = true,
    popup_border_style = "rounded",
    enable_git_status = true,
    enable_diagnostics = true,
    sources = { "filesystem", "buffers", "git_status" },
    default_component_configs = {
      indent = {
        with_expanders = true,
        expander_collapsed = "",
        expander_expanded = "",
      },
      git_status = {
        symbols = {
          added = "", modified = "", deleted = "✖", renamed = "󰁕",
          untracked = "", ignored = "", unstaged = "󰄱", staged = "", conflict = "",
        },
      },
    },
    window = {
      width = 32,
      mappings = {
        ["<space>"] = "none",
        ["h"] = "close_node",
        ["l"] = "open",
        ["<cr>"] = "open",
        ["P"] = { "toggle_preview", config = { use_float = true } },
      },
    },
    filesystem = {
      bind_to_cwd = false,
      follow_current_file = { enabled = true },
      use_libuv_file_watcher = true, -- auto-refresh on external changes
      filtered_items = {
        visible = false,
        hide_dotfiles = false,
        hide_gitignored = true,
        never_show = { ".DS_Store", "thumbs.db" },
      },
    },
  },
}
