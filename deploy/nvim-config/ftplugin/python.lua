-- ╭──────────────────────────────────────────────────────────╮
-- │  Python filetype settings (auto-loaded for *.py buffers)   │
-- ╰──────────────────────────────────────────────────────────╯

-- PEP 8: 4-space indentation
vim.bo.shiftwidth = 4
vim.bo.tabstop = 4
vim.bo.softtabstop = 4
vim.bo.expandtab = true

-- Big, scrollable, dismissable floating window for the compile result.
-- `level` is "ok" or "error" (drives the border colour + title).
local function show_float(msg, level)
  local lines = vim.split(vim.trim(msg), "\n", { trimempty = true })
  if #lines == 0 then
    lines = { "compilation failed" }
  end

  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
  vim.bo[buf].bufhidden = "wipe"

  -- Size to the content, but keep it within the editor.
  local width = 40
  for _, l in ipairs(lines) do
    width = math.max(width, vim.fn.strdisplaywidth(l))
  end
  width = math.min(width + 4, vim.o.columns - 4)
  -- Account for lines that wrap at `width`.
  local rows = 0
  for _, l in ipairs(lines) do
    rows = rows + math.max(1, math.ceil(vim.fn.strdisplaywidth(l) / (width - 2)))
  end
  local height = math.min(rows, math.floor(vim.o.lines * 0.7))

  local is_err = level == "error"
  local win = vim.api.nvim_open_win(buf, true, {
    relative = "editor",
    width = width,
    height = height,
    row = math.floor((vim.o.lines - height) / 2 - 1),
    col = math.floor((vim.o.columns - width) / 2),
    style = "minimal",
    border = "rounded",
    title = is_err and " ✗ py_compile — syntax error " or " ✓ py_compile ",
    title_pos = "center",
  })
  vim.wo[win].wrap = true
  vim.wo[win].linebreak = true
  vim.wo[win].cursorline = false
  local hl = is_err and "DiagnosticError" or "DiagnosticOk"
  vim.wo[win].winhighlight = "FloatBorder:" .. hl .. ",Title:" .. hl

  -- Dismiss with q / <Esc> / <CR>
  for _, key in ipairs({ "q", "<Esc>", "<CR>" }) do
    vim.keymap.set("n", key, "<cmd>close<cr>", { buffer = buf, nowait = true, silent = true })
  end
end

-- <F3> — check whether the current file compiles (syntax check, no run).
-- Compiles the source in-memory, so nothing is written to __pycache__.
local function py_compile_check()
  local file = vim.api.nvim_buf_get_name(0)
  if file == "" then
    vim.notify("Buffer has no file on disk", vim.log.levels.WARN)
    return
  end
  if vim.bo.modified then
    vim.cmd("silent write")
  end

  -- Prefer an activated venv's `python`, else fall back to `python3`.
  local py = vim.fn.executable("python") == 1 and "python" or "python3"
  local name = vim.fn.fnamemodify(file, ":t")
  local src_win = vim.api.nvim_get_current_win()

  local script = [[
import sys
src = sys.argv[1]
try:
    compile(open(src, "rb").read(), src, "exec")
except SyntaxError as e:
    print(f"{e.filename}:{e.lineno}:{e.offset}: {e.msg}", file=sys.stderr)
    sys.exit(1)
]]

  vim.notify("Compiling " .. name .. " …", vim.log.levels.INFO, { title = "py_compile" })

  vim.system({ py, "-c", script, file }, { text = true }, function(res)
    vim.schedule(function()
      if res.code == 0 then
        vim.notify("✓ " .. name .. " compiles cleanly", vim.log.levels.INFO, { title = "py_compile" })
      else
        local msg = res.stderr
        if msg == nil or msg == "" then
          msg = (res.stdout ~= "" and res.stdout) or "compilation failed"
        end
        -- Jump the source window's cursor to the offending line, so it's
        -- waiting for you when you dismiss the popup.
        local lnum = msg:match(":(%d+):")
        if lnum and vim.api.nvim_win_is_valid(src_win) then
          pcall(vim.api.nvim_win_set_cursor, src_win, { tonumber(lnum), 0 })
        end
        show_float(msg, "error")
      end
    end)
  end)
end

vim.keymap.set("n", "<F3>", py_compile_check, {
  buffer = true,
  desc = "Python: check if it compiles",
})
