-- ╭──────────────────────────────────────────────────────────╮
-- │  LSP — language servers, diagnostics, code intelligence    │
-- │  Uses Neovim 0.11+ native vim.lsp.config + Mason v2.        │
-- ╰──────────────────────────────────────────────────────────╯
return {
  -- lazydev: makes lua_ls aware of the Neovim API when editing configs
  {
    "folke/lazydev.nvim",
    ft = "lua",
    opts = {
      library = {
        { path = "${3rd}/luv/library", words = { "vim%.uv" } },
      },
    },
  },

  {
    "neovim/nvim-lspconfig",
    event = { "BufReadPre", "BufNewFile" },
    dependencies = {
      { "mason-org/mason.nvim", opts = {} },
      "mason-org/mason-lspconfig.nvim",
      "saghen/blink.cmp",
    },
    config = function()
      -- ── Diagnostics UI ────────────────────────────────────
      local icons = { Error = " ", Warn = " ", Hint = " ", Info = " " }
      vim.diagnostic.config({
        severity_sort = true,
        underline = { severity = vim.diagnostic.severity.ERROR },
        update_in_insert = false,
        virtual_text = {
          spacing = 4,
          source = "if_many",
          prefix = "●",
        },
        signs = {
          text = {
            [vim.diagnostic.severity.ERROR] = icons.Error,
            [vim.diagnostic.severity.WARN] = icons.Warn,
            [vim.diagnostic.severity.HINT] = icons.Hint,
            [vim.diagnostic.severity.INFO] = icons.Info,
          },
        },
        float = { border = "rounded", source = true },
      })

      -- Rounded borders for hover / signature popups
      vim.o.winborder = "rounded"

      -- ── Keymaps applied when a server attaches to a buffer ─
      vim.api.nvim_create_autocmd("LspAttach", {
        group = vim.api.nvim_create_augroup("user_lsp_attach", { clear = true }),
        callback = function(event)
          local buf = event.buf
          local function map(keys, fn, desc, mode)
            vim.keymap.set(mode or "n", keys, fn, { buffer = buf, desc = "LSP: " .. desc })
          end

          local tb = require("telescope.builtin")
          map("gd", tb.lsp_definitions, "Goto definition")
          map("gr", tb.lsp_references, "Goto references")
          map("gI", tb.lsp_implementations, "Goto implementation")
          map("gy", tb.lsp_type_definitions, "Goto type definition")
          map("gD", vim.lsp.buf.declaration, "Goto declaration")
          map("<leader>ds", tb.lsp_document_symbols, "Document symbols")
          map("<leader>ws", tb.lsp_dynamic_workspace_symbols, "Workspace symbols")

          map("K", vim.lsp.buf.hover, "Hover documentation")
          map("gK", vim.lsp.buf.signature_help, "Signature help")
          map("<C-k>", vim.lsp.buf.signature_help, "Signature help", "i")
          map("<leader>rn", vim.lsp.buf.rename, "Rename symbol")
          map("<leader>ca", vim.lsp.buf.code_action, "Code action", { "n", "x" })
          map("<leader>cl", vim.lsp.codelens.run, "Run CodeLens", { "n", "x" })

          local client = vim.lsp.get_client_by_id(event.data.client_id)

          -- Highlight references to the symbol under the cursor
          if client and client:supports_method("textDocument/documentHighlight") then
            local hl = vim.api.nvim_create_augroup("user_lsp_highlight", { clear = false })
            vim.api.nvim_create_autocmd({ "CursorHold", "CursorHoldI" }, {
              buffer = buf, group = hl, callback = vim.lsp.buf.document_highlight,
            })
            vim.api.nvim_create_autocmd({ "CursorMoved", "CursorMovedI" }, {
              buffer = buf, group = hl, callback = vim.lsp.buf.clear_references,
            })
          end

          -- Toggle inlay hints with <leader>uh
          if client and client:supports_method("textDocument/inlayHint") then
            map("<leader>uh", function()
              vim.lsp.inlay_hint.enable(not vim.lsp.inlay_hint.is_enabled({ bufnr = buf }), { bufnr = buf })
            end, "Toggle inlay hints")
          end
        end,
      })

      -- ── Capabilities (advertise blink.cmp's completion features) ─
      local capabilities = require("blink.cmp").get_lsp_capabilities()
      vim.lsp.config("*", { capabilities = capabilities })

      -- ── Per-server settings ───────────────────────────────
      -- Add a key here to customise a server; otherwise the
      -- nvim-lspconfig defaults are used. Install servers with :Mason.
      local servers = {
        lua_ls = {
          settings = {
            Lua = {
              workspace = { checkThirdParty = false },
              codeLens = { enable = true },
              completion = { callSnippet = "Replace" },
              hint = { enable = true },
              diagnostics = { globals = { "vim" } },
            },
          },
        },
        -- Uncomment / add more as you install them via :Mason
        -- pyright = {},
        -- ts_ls = {},
        -- gopls = {},
        -- rust_analyzer = {},
      }

      -- Register settings, then enable any server whose binary is already
      -- on PATH (Mason prepends its own bin dir during mason.setup, so this
      -- catches both Mason- and system-installed servers).
      for name, cfg in pairs(servers) do
        vim.lsp.config(name, cfg)
        local conf = vim.lsp.config[name]
        local cmd = conf and conf.cmd
        local exe = type(cmd) == "table" and cmd[1] or nil
        if exe and vim.fn.executable(exe) == 1 then
          vim.lsp.enable(name)
        end
      end

      -- Servers you install later via :Mason are enabled automatically.
      -- ensure_installed is empty on purpose: nothing downloads at startup,
      -- so launches stay instant. Add servers whenever you like with :Mason.
      require("mason-lspconfig").setup({
        ensure_installed = {},
        automatic_enable = true,
      })
    end,
  },
}
