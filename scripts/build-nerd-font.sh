#!/usr/bin/env bash
#
# Rebuild the icon font /term falls back to for Nerd Font glyphs.
#
# The mounted nvim config draws icons -- a statusline, a file tree, diagnostic
# signs -- from the Nerd Font private-use area. xterm.js renders with the app's
# `--font-mono`, which is an ordinary mono stack with nothing in that range, so
# every one of them arrives as a tofu box. This produces the symbols-only font
# named after it in terminal.css, which covers the icons and nothing else: the
# text stays in your own font, and only the glyphs it has no opinion about fall
# through to this one.
#
# Committed as a build artifact rather than fetched at build time. It changes
# about once a year, the build has no business reaching GitHub for a font, and
# a deploy that fails because a font CDN is down is a bad trade for 400 kB in
# git. Rerun this when an icon shows up as a box.
#
# Measured, per block, as woff2 (`--flavor=woff2`, so brotli is required):
#
#   powerline      7 kB      octicons        31 kB
#   seti          41 kB      font-awesome    97 kB
#   devicons     175 kB      font-awesome-ext  115 kB   (legacy, dropped)
#   codicons      58 kB      material-design  492 kB   (see below)
#
# Everything below adds up to about 400 kB. Two deliberate omissions:
#
#   - font-awesome-ext is a legacy block that duplicates font-awesome, and
#     nothing in a modern config draws from it.
#   - material-design is 2000+ glyphs and 492 kB on its own -- more than
#     everything else combined -- so instead of the whole plane, only the
#     codepoints the config actually uses are listed. That is the one choice
#     here that can go wrong, and it is worth knowing how it looks when it
#     does: measured in the browser, an MD codepoint that is missing from this
#     subset renders as *nothing at all*, not as a box. The `unicode-range` in
#     terminal.css claims the whole plane, so the browser picks this font and
#     then finds no glyph, and blank is what that draws. Quieter than a box and
#     easier to miss -- if an icon seems simply absent, this list is the first
#     place to look. The fix is to add the codepoint below and rerun.
set -euo pipefail

VERSION=${VERSION:-latest}
OUT=${OUT:-packages/web/src/features/terminal/nerd-symbols.woff2}

# Blocks kept whole, because a plugin may draw any glyph in them.
BLOCKS="U+E0A0-E0D4,U+E5FA-E6B7,U+E700-E8EF,U+EA60-EC1E,U+F000-F2FF,U+F400-F533"

# Material Design, one codepoint at a time. Regenerate the list with:
#   rg -o '[\x{F0000}-\x{FFFFD}]' deploy/nvim-config | sort -u
MATERIAL="U+F0055,U+F0131,U+F04B2"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

echo "fetching NerdFontsSymbolsOnly (${VERSION})"
curl -fsSL -o "$work/symbols.zip" \
	"https://github.com/ryanoasis/nerd-fonts/releases/${VERSION}/download/NerdFontsSymbolsOnly.zip"
unzip -o -q "$work/symbols.zip" -d "$work/symbols"

# The Mono variant, not the proportional one: xterm.js lays out a fixed grid and
# measures the cell from the primary font, so a fallback whose glyphs are wider
# than one cell overlaps its neighbour.
src="$work/symbols/SymbolsNerdFontMono-Regular.ttf"
[ -f "$src" ] || { echo "no SymbolsNerdFontMono-Regular.ttf in the release" >&2; exit 1; }

python3 -m fontTools.subset "$src" \
	--unicodes="${BLOCKS},${MATERIAL}" \
	--flavor=woff2 \
	--no-hinting \
	--desubroutinize \
	--output-file="$OUT"

python3 - "$OUT" <<'PY'
import sys
from fontTools.ttLib import TTFont

path = sys.argv[1]
font = TTFont(path)
size = __import__('os').path.getsize(path)
print(f"wrote {path}: {len(font.getBestCmap())} glyphs, {size / 1024:.1f} kB")
PY
