-- ╭──────────────────────────────────────────────────────────╮
-- │  Telescope — fuzzy finder (files, grep, symbols, …)        │
-- │  Think VSCode's Ctrl-P / Ctrl-Shift-F, but faster.         │
-- ╰──────────────────────────────────────────────────────────╯
return {
  "nvim-telescope/telescope.nvim",
  cmd = "Telescope",
  version = false,
  dependencies = {
    "nvim-lua/plenary.nvim",
    {
      "nvim-telescope/telescope-fzf-native.nvim",
      build = "make", -- compiled fzf sorter (needs make + cc, both installed)
    },
  },
  keys = {
    -- Files & search
    { "<C-p>", "<cmd>Telescope find_files<cr>", desc = "Find files" },
    { "<leader>ff", "<cmd>Telescope find_files<cr>", desc = "Find files" },
    { "<leader>fg", "<cmd>Telescope live_grep<cr>", desc = "Grep (live)" },
    { "<leader>/", "<cmd>Telescope live_grep<cr>", desc = "Grep (live)" },
    { "<leader>fw", "<cmd>Telescope grep_string<cr>", desc = "Grep word under cursor" },
    { "<leader>fr", "<cmd>Telescope oldfiles<cr>", desc = "Recent files" },
    { "<leader><space>", "<cmd>Telescope buffers<cr>", desc = "Buffers" },
    { "<leader>fb", "<cmd>Telescope buffers<cr>", desc = "Buffers" },
    -- Meta / help
    { "<leader>fh", "<cmd>Telescope help_tags<cr>", desc = "Help pages" },
    { "<leader>fk", "<cmd>Telescope keymaps<cr>", desc = "Keymaps" },
    { "<leader>fc", "<cmd>Telescope commands<cr>", desc = "Commands" },
    { "<leader>fd", "<cmd>Telescope diagnostics<cr>", desc = "Diagnostics" },
    { "<leader>f:", "<cmd>Telescope command_history<cr>", desc = "Command history" },
    { "<leader>fR", "<cmd>Telescope resume<cr>", desc = "Resume last search" },
    { "<leader>gc", "<cmd>Telescope git_commits<cr>", desc = "Git commits" },
    { "<leader>gs", "<cmd>Telescope git_status<cr>", desc = "Git status" },
  },
  opts = function()
    local actions = require("telescope.actions")
    return {
      defaults = {
        prompt_prefix = "   ",
        selection_caret = "  ",
        entry_prefix = "  ",
        sorting_strategy = "ascending",
        layout_config = {
          horizontal = { prompt_position = "top", preview_width = 0.55 },
          width = 0.87,
          height = 0.80,
        },
        path_display = { "truncate" },
        mappings = {
          i = {
            ["<C-j>"] = actions.move_selection_next,
            ["<C-k>"] = actions.move_selection_previous,
            ["<C-q>"] = actions.send_to_qflist + actions.open_qflist,
            ["<Esc>"] = actions.close, -- single Esc closes
          },
        },
      },
      pickers = {
        find_files = { hidden = true },
        buffers = {
          sort_mru = true,
          ignore_current_buffer = true,
          mappings = { i = { ["<C-d>"] = require("telescope.actions").delete_buffer } },
        },
      },
      extensions = {
        fzf = {
          fuzzy = true,
          override_generic_sorter = true,
          override_file_sorter = true,
          case_mode = "smart_case",
        },
      },
    }
  end,
  config = function(_, opts)
    local telescope = require("telescope")
    telescope.setup(opts)
    telescope.load_extension("fzf")
  end,
}
