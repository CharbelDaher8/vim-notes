-- ╭──────────────────────────────────────────────────────────╮
-- │  Which-key — a popup that shows what your keys do          │
-- │  Press <Space> and wait to see everything.                 │
-- ╰──────────────────────────────────────────────────────────╯
return {
  "folke/which-key.nvim",
  event = "VeryLazy",
  opts = {
    preset = "modern",
    spec = {
      { "<leader>b", group = "Buffer" },
      { "<leader>c", group = "Code" },
      { "<leader>d", group = "Document/Diagnostics" },
      { "<leader>f", group = "Find" },
      { "<leader>g", group = "Git" },
      { "<leader>u", group = "UI / Toggle" },
      { "<leader>x", group = "Diagnostics/Quickfix" },
      { "g", group = "Goto" },
      { "]", group = "Next" },
      { "[", group = "Prev" },
    },
  },
  keys = {
    {
      "<leader>?",
      function() require("which-key").show({ global = false }) end,
      desc = "Buffer local keymaps",
    },
  },
}
