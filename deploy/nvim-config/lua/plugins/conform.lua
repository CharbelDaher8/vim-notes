-- ╭──────────────────────────────────────────────────────────╮
-- │  Conform — format-on-save (async, LSP fallback)            │
-- │  Install formatters via :Mason (stylua, prettierd, black…) │
-- ╰──────────────────────────────────────────────────────────╯
return {
  "stevearc/conform.nvim",
  event = { "BufWritePre" },
  cmd = "ConformInfo",
  keys = {
    {
      "<leader>cf",
      function() require("conform").format({ async = true, lsp_format = "fallback" }) end,
      mode = { "n", "v" },
      desc = "Format buffer",
    },
    {
      "<leader>uf",
      function()
        vim.g.autoformat = not (vim.g.autoformat == nil or vim.g.autoformat)
        vim.notify("Format on save: " .. (vim.g.autoformat and "ON" or "OFF"))
      end,
      desc = "Toggle format on save",
    },
  },
  opts = {
    -- Map filetypes → formatters. `stop_after_first` runs the first available.
    formatters_by_ft = {
      lua = { "stylua" },
      python = { "isort", "black" },
      javascript = { "prettierd", "prettier", stop_after_first = true },
      typescript = { "prettierd", "prettier", stop_after_first = true },
      javascriptreact = { "prettierd", "prettier", stop_after_first = true },
      typescriptreact = { "prettierd", "prettier", stop_after_first = true },
      json = { "prettierd", "prettier", stop_after_first = true },
      jsonc = { "prettierd", "prettier", stop_after_first = true },
      yaml = { "prettierd", "prettier", stop_after_first = true },
      html = { "prettierd", "prettier", stop_after_first = true },
      css = { "prettierd", "prettier", stop_after_first = true },
      markdown = { "prettierd", "prettier", stop_after_first = true },
      sh = { "shfmt" },
      go = { "gofmt" },
      rust = { "rustfmt" },
    },
    format_on_save = function(bufnr)
      -- Respect the <leader>uf toggle (default: on)
      if vim.g.autoformat == false then
        return
      end
      -- Don't block the write if a formatter is missing / slow
      return { timeout_ms = 800, lsp_format = "fallback" }
    end,
  },
  init = function()
    -- Use conform for the gq operator too
    vim.o.formatexpr = "v:lua.require'conform'.formatexpr()"
    vim.g.autoformat = true
  end,
}
