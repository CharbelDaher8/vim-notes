-- ╭──────────────────────────────────────────────────────────╮
-- │  Treesitter — accurate syntax highlighting, indent, folds  │
-- ╰──────────────────────────────────────────────────────────╯
return {
  "nvim-treesitter/nvim-treesitter",
  branch = "master",
  build = ":TSUpdate",
  event = { "BufReadPost", "BufNewFile", "BufWritePre" },
  cmd = { "TSUpdate", "TSInstall", "TSInstallInfo" },
  main = "nvim-treesitter.configs",
  dependencies = {
    "nvim-treesitter/nvim-treesitter-textobjects",
  },
  opts = {
    -- Parsers installed on first launch. `auto_install` grabs any others
    -- automatically the first time you open a matching file.
    ensure_installed = {
      "bash", "c", "cpp", "css", "diff", "dockerfile", "go", "gomod",
      "html", "javascript", "json", "jsonc", "lua", "luadoc", "luap",
      "markdown", "markdown_inline", "python", "query", "regex", "rust",
      "toml", "tsx", "typescript", "vim", "vimdoc", "yaml",
    },
    auto_install = true,
    highlight = {
      enable = true,
      additional_vim_regex_highlighting = false,
    },
    indent = { enable = true },
    incremental_selection = {
      enable = true,
      keymaps = {
        init_selection = "<C-space>",
        node_incremental = "<C-space>",
        scope_incremental = false,
        node_decremental = "<bs>",
      },
    },
    textobjects = {
      move = {
        enable = true,
        goto_next_start = { ["]f"] = "@function.outer", ["]c"] = "@class.outer" },
        goto_previous_start = { ["[f"] = "@function.outer", ["[c"] = "@class.outer" },
      },
      select = {
        enable = true,
        lookahead = true,
        keymaps = {
          ["af"] = "@function.outer",
          ["if"] = "@function.inner",
          ["ac"] = "@class.outer",
          ["ic"] = "@class.inner",
          ["aa"] = "@parameter.outer",
          ["ia"] = "@parameter.inner",
        },
      },
    },
  },
}
