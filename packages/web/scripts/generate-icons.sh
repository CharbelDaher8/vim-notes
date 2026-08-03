#!/usr/bin/env bash
#
# Regenerate the PWA raster icons from public/icon.svg.
#
# Chrome will not offer "Install app" without a PNG of at least 192x192 in the
# manifest, and iOS Safari ignores SVG for apple-touch-icon entirely -- an SVG
# alone looks like a complete icon set and installs on neither platform. Hence
# rasters, checked in, so a build needs no image toolchain.
#
# Nothing here draws artwork. Every output is icon.svg rendered at a size and,
# for the two opaque ones, composited onto the background colour the SVG
# already uses. That is the point: the glyph lives in exactly one file, and
# editing icon.svg then re-running this keeps the whole set in step. Do not
# hand-edit the PNGs.
#
# Run from anywhere:  packages/web/scripts/generate-icons.sh
set -euo pipefail

cd "$(dirname "$0")/../public"

for tool in rsvg-convert magick; do
	if ! command -v "$tool" >/dev/null 2>&1; then
		echo "missing $tool (brew install librsvg imagemagick)" >&2
		exit 1
	fi
done

# The rounded rect's fill, and the manifest's background_color. The two opaque
# icons below are flattened onto it, so it has to agree with icon.svg.
BACKGROUND='#16171a'

# --- purpose: any ------------------------------------------------------------
#
# Left with their alpha channel. These are shown as drawn -- Chrome's install
# dialog, the Android task switcher -- so the rounded corners are the icon.

rsvg-convert -w 192 -h 192 icon.svg -o icon-192.png
rsvg-convert -w 512 -h 512 icon.svg -o icon-512.png

# --- purpose: maskable -------------------------------------------------------
#
# Android crops this to whatever shape the launcher uses, so only the centre
# circle of diameter 80% is guaranteed to survive -- a corner-to-corner render
# would lose its rounded edges to the crop and look clipped rather than shaped.
#
# So: render the icon at 80% and centre it on a full-bleed square of the same
# background. Because the SVG's rounded rect is that exact colour on
# transparency, the corners vanish into the canvas and the result is a square
# tile with the glyph inset -- which is what a maskable icon is.
#
# The glyph's own bounding radius is ~26 of icon.svg's 64 units; at 80% on a
# 512 canvas that lands ~166px from centre, inside the 204.8px safe radius.
GLYPH=$((512 * 80 / 100))
rsvg-convert -w "$GLYPH" -h "$GLYPH" icon.svg -o /tmp/vim-notes-glyph.png
magick -size 512x512 "xc:$BACKGROUND" /tmp/vim-notes-glyph.png \
	-gravity center -composite icon-maskable-512.png
rm -f /tmp/vim-notes-glyph.png

# --- apple-touch-icon --------------------------------------------------------
#
# 180x180 is the size current iPhones ask for. Full-bleed and flattened: iOS
# applies its own squircle mask (close enough to the SVG's own corner radius
# that nothing looks off), and composites any transparency onto black rather
# than onto the page, so shipping alpha here only risks a corner seam.
rsvg-convert -w 180 -h 180 icon.svg -o /tmp/vim-notes-apple.png
magick -size 180x180 "xc:$BACKGROUND" /tmp/vim-notes-apple.png \
	-gravity center -composite -alpha off apple-touch-icon.png
rm -f /tmp/vim-notes-apple.png

echo "icons regenerated:"
ls -1 icon-192.png icon-512.png icon-maskable-512.png apple-touch-icon.png
