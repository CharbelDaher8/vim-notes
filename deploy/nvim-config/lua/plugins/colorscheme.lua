-- ╭──────────────────────────────────────────────────────────╮
-- │  Colourschemes                                             │
-- │  Active theme is whichever calls vim.cmd.colorscheme(...)  │
-- │  Switch by moving that call between the specs below.       │
-- ╰──────────────────────────────────────────────────────────╯
return {
  -- ── Gruvbox Material (active) ────────────────────────────────
  -- background: soft | medium | hard   foreground: material | mix | original
  {
    "sainnhe/gruvbox-material",
    name = "gruvbox-material",
    lazy = false,
    priority = 1000, -- load before everything else
    config = function()
      vim.o.background = "dark" -- set to "light" for the light variant
      vim.g.gruvbox_material_background = "medium"
      vim.g.gruvbox_material_foreground = "material"
      vim.g.gruvbox_material_enable_italic = 1
      vim.g.gruvbox_material_enable_bold = 1
      vim.g.gruvbox_material_better_performance = 1
      vim.cmd.colorscheme("gruvbox-material")
    end,
  },

  -- ── Catppuccin (installed, inactive) ─────────────────────────
  -- To use instead: move the `vim.cmd.colorscheme` call here and
  -- remove it from gruvbox-material above.
  {
    "catppuccin/nvim",
    name = "catppuccin",
    lazy = false,
    priority = 1000,
    opts = {
      flavour = "mocha",
      transparent_background = false,
      show_end_of_buffer = false,
      term_colors = true,
      styles = {
        comments = { "italic" },
        conditionals = { "italic" },
        keywords = { "italic" },
      },
      integrations = {
        blink_cmp = true,
        gitsigns = true,
        neotree = true,
        treesitter = true,
        telescope = { enabled = true },
        which_key = true,
        mason = true,
        bufferline = true,
        lsp_trouble = false,
        notify = true,
        snacks = { enabled = true },
        native_lsp = {
          enabled = true,
          underlines = {
            errors = { "undercurl" },
            hints = { "undercurl" },
            warnings = { "undercurl" },
            information = { "undercurl" },
          },
        },
        indent_blankline = { enabled = false },
      },
    },
    config = function(_, opts)
      require("catppuccin").setup(opts)
    end,
  },
}
