"""Build the Archipelago-branded gun pickup sprite and emit it as a base64 data URI.

The gun pickup badge in Johnny Upgrade is `assets/pics/sheetGunSymb.png` from the game's own SDK
zip: 1200x120, i.e. 10 frames of 120x120. Each frame is a red/orange/yellow starburst with a green
ray gun, a blue orb and three zap lines inside it, and the "animation" is nothing but a vertical
bob of the whole badge. Since the gun is now an Archipelago item rather than something you pick up
(see apworld/johnny_upgrade/items.py), the badge should show the Archipelago logo instead of a gun.

The compositing is done HERE, offline, rather than on a canvas in the browser. That matters:
  - the client can then ship the finished sheet as an inlined base64 data URI, so there is no
    cross-origin fetch of the logo at runtime, no tainted canvas, and no @grant needed;
  - the result can actually be looked at before it ships.

Run from the repo root:  python assets/make_gun_sprite.py
It rewrites assets/sheetGunSymbAP.png and splices the data URI straight into the userscript's
AP_GUN_SPRITE_DATA_URI constant, so regenerating the art is a single command.
"""

import base64
import io
import os
import re
import zipfile

from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SDK_ZIP = os.path.join(ROOT, "scratch-work", "johnny_sdk.zip")
LOGO = os.path.join(ROOT, "assets", "ap logo transparent.webp")
OUT = os.path.join(ROOT, "assets", "sheetGunSymbAP.png")
CLIENT = os.path.join(ROOT, "client", "johnny-upgrade-ap.user.js")
CONST = "AP_GUN_SPRITE_DATA_URI"

FRAME = 120
FRAMES = 10
YELLOW = (255, 255, 0, 255)
HALO_RADIUS = 3
HALO_COLOUR = (26, 26, 26, 255)
# The starburst pinches to points, so a square logo centred in it will overhang unless it is kept
# small. Rather than hard-code a size, search downward for the largest one whose outlined footprint
# lands essentially entirely on the flat yellow interior. A little slack absorbs the antialiased
# boundary pixels, which are neither cleanly yellow nor cleanly orange.
FIT_TOLERANCE = 0.995


def is_yellow(p):
    r, g, b, a = p
    return a > 200 and r > 200 and g > 200 and b < 120


def prepared_logo():
    """The logo trimmed to its artwork, squared without distortion, and given a transparent margin.

    Three things have to happen before it can be scaled down and outlined:
      - trim to the opaque bounding box, so "size" means the size of the artwork rather than of
        whatever padding the source file happens to carry;
      - pad to a SQUARE rather than resizing to one, since the source is 2034x2112 and resizing
        straight to a square would visibly squash the flower;
      - add a GENEROUS transparent margin. The flower runs right up to the edge of its own bounding
        box, and MaxFilter clamps at the image border, so a thin margin makes the halo smear flat
        along whichever edge runs out of room first -- with the artwork taller than it is wide,
        that is the top, which comes out visibly squared off instead of following the petal. The
        margin must stay comfortably wider than HALO_RADIUS once scaled down to the final ~50px,
        hence a fraction this large rather than a few pixels. Nothing is lost by overshooting:
        fit_size measures the outlined footprint, so a roomier margin simply makes it pick a
        proportionally larger size.
    """
    logo = Image.open(LOGO).convert("RGBA")
    logo = logo.crop(logo.getchannel("A").getbbox())
    w, h = logo.size
    side = max(w, h)
    margin = max(8, side // 5)
    out = Image.new("RGBA", (side + 2 * margin, side + 2 * margin), (0, 0, 0, 0))
    out.alpha_composite(logo, (margin + (side - w) // 2, margin + (side - h) // 2))
    return out


def outlined(logo, size):
    """The logo at `size`, over a dilated flat-colour silhouette of itself.

    The dilation is done on a 4x supersampled alpha rather than directly at the final size.
    Repeated MaxFilter is a SQUARE structuring element, so applied at 50-odd pixels it grows the
    silhouette by the full radius diagonally but visibly less across a flat run -- the outline then
    bulges into blobs at the flower's shoulders while looking pinched across its flat top and
    bottom, which reads as the outline having been cut off there. Supersampling first quantises
    that squareness to a quarter pixel, and the downsample turns it into a smooth, even-width
    outline all the way round.
    """
    ss = 4
    big = logo.resize((size * ss, size * ss), Image.LANCZOS)
    alpha = big.getchannel("A")
    for _ in range(HALO_RADIUS * ss):
        alpha = alpha.filter(ImageFilter.MaxFilter(3))
    halo = Image.new("RGBA", big.size, HALO_COLOUR)
    halo.putalpha(alpha)
    halo.alpha_composite(big)
    return halo.resize((size, size), Image.LANCZOS)


def load_original():
    with zipfile.ZipFile(SDK_ZIP) as z:
        with z.open("assets/pics/sheetGunSymb.png") as f:
            return Image.open(io.BytesIO(f.read())).convert("RGBA")


def erase_gun(sheet):
    """Blank the gun, orb and zap lines back to the flat yellow they sit on.

    Done by reachability rather than by colour, because a plain colour test quietly fails twice
    over: the orb's white highlight and the gun's dark red eye sit in the same warm r >= g family
    as the starburst itself, so they survive as specks; and the gun's muzzle overlaps the orange
    band, so "fill the holes in the yellow mask" leaks -- the flood walks in from outside through
    the orange, through the muzzle, and declares the whole gun to be exterior.

    What works is to flood from the frame border across pixels that are transparent or warm, and
    treat every gun-coloured (non-warm, opaque) pixel as a wall. The starburst stays fully reached,
    since its band touches the transparent exterior everywhere. The gun cannot be entered at all:
    the muzzle that formed the bridge is itself a wall. Anything the flood fails to reach is the
    gun assembly -- greens, blue orb, white highlight, and the warm specks trapped inside them.

    The erased area is filled flat yellow. The gun does poke very slightly past the yellow interior
    where the muzzle and orb cross the orange band, so this is not strictly faithful there. Two
    reconstruction schemes were tried to fix that -- copying the nearest surviving pixel, and
    deriving the bands from a fitted concentric-star model (the three bands really are scaled
    copies of one polygon, but only to ~98.5%). Both look worse: their error lands at the notches
    between star points, exactly where the gun's handle crosses, so instead of a small flat spot
    you get orange wedges pushing into the yellow. Flat yellow is the better-looking compromise.

    Returns the erased sheet plus each frame's vertical centre (the badge bobs between frames).
    """

    def warm(p):
        """The starburst's palette: red, orange and yellow all have r >= g and almost no blue."""
        r, g, b, a = p
        return a >= 32 and r >= g and b < 60

    out = sheet.copy()
    src, dst = sheet.load(), out.load()
    centres = []
    for f in range(FRAMES):
        x0 = f * FRAME
        passable = [[src[x0 + x, y][3] < 32 or warm(src[x0 + x, y]) for y in range(FRAME)] for x in range(FRAME)]

        reached = [[False] * FRAME for _ in range(FRAME)]
        stack = []
        for i in range(FRAME):
            for x, y in ((i, 0), (i, FRAME - 1), (0, i), (FRAME - 1, i)):
                if passable[x][y] and not reached[x][y]:
                    reached[x][y] = True
                    stack.append((x, y))
        while stack:
            x, y = stack.pop()
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if 0 <= nx < FRAME and 0 <= ny < FRAME and passable[nx][ny] and not reached[nx][ny]:
                    reached[nx][ny] = True
                    stack.append((nx, ny))

        gun = [(x, y) for x in range(FRAME) for y in range(FRAME) if not reached[x][y]]

        # Grow the erase by a couple of pixels to take the antialiased fringe where the gun met the
        # yellow, which is warm enough to have been reached and would otherwise survive as a faint
        # outline of the old gun. Growth is allowed onto yellow only, never onto the orange or red
        # bands, so widening this can never eat into the starburst's silhouette.
        grown = set(gun)
        frontier = gun
        for _ in range(2):
            nxt = []
            for x, y in frontier:
                for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                    if 0 <= nx < FRAME and 0 <= ny < FRAME and (nx, ny) not in grown:
                        if is_yellow(src[x0 + nx, ny]):
                            grown.add((nx, ny))
                            nxt.append((nx, ny))
            frontier = nxt

        for x, y in grown:
            dst[x0 + x, y] = YELLOW

        rows = [y for x in range(FRAME) for y in range(FRAME) if src[x0 + x, y][3] >= 32]
        centres.append((min(rows) + max(rows)) // 2)
    return out, centres


def fit_size(erased, centre, logo):
    """Largest logo size whose outlined footprint stays on the yellow, measured on frame 0."""
    px = erased.load()
    for size in range(FRAME, 8, -1):
        stamp = outlined(logo, size)
        sp = stamp.load()
        ox, oy = (FRAME - size) // 2, centre - size // 2
        total = covered = 0
        for x in range(size):
            for y in range(size):
                if sp[x, y][3] < 32:
                    continue
                total += 1
                px_x, px_y = ox + x, oy + y
                if 0 <= px_x < FRAME and 0 <= px_y < FRAME and is_yellow(px[px_x, px_y]):
                    covered += 1
        if total and covered / total >= FIT_TOLERANCE:
            return size
    raise SystemExit("no logo size fits inside the starburst")


def main():
    sheet = load_original()
    if sheet.size != (FRAME * FRAMES, FRAME):
        raise SystemExit(f"unexpected sheet size {sheet.size}")

    logo = prepared_logo()
    erased, centres = erase_gun(sheet)
    size = fit_size(erased, centres[0], logo)
    stamp = outlined(logo, size)

    out = erased
    for f in range(FRAMES):
        out.alpha_composite(stamp, (f * FRAME + (FRAME - size) // 2, centres[f] - size // 2))
    out.save(OUT, optimize=True)

    with open(OUT, "rb") as fh:
        uri = "data:image/png;base64," + base64.b64encode(fh.read()).decode("ascii")
    print(f"logo size {size}px, wrote {OUT} ({os.path.getsize(OUT)} bytes)")

    # Splice it into the client. newline="" on both ends so the file's existing line endings
    # survive the round trip rather than being rewritten wholesale.
    with io.open(CLIENT, encoding="utf-8", newline="") as fh:
        src = fh.read()
    pattern = r'const %s =\s*"[^"]*";' % CONST
    if not re.search(pattern, src):
        raise SystemExit(f"could not find `const {CONST} = \"...\";` in {CLIENT}")
    src = re.sub(pattern, 'const %s =\n    "%s";' % (CONST, uri), src, count=1)
    with io.open(CLIENT, "w", encoding="utf-8", newline="") as fh:
        fh.write(src)
    print(f"spliced {len(uri)} chars into {CONST} in client/johnny-upgrade-ap.user.js")


if __name__ == "__main__":
    main()
