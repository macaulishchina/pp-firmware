"""Export PA-Terminal's LVGL bitmaps for the browser display simulator."""
import argparse
import json
import re
from pathlib import Path
import shutil
import struct

from PIL import Image


def array(source, name):
    return re.search(rf"\b{name}\[\]\s*=\s*\{{(.*?)\}};", source, re.S)[1]


def numbers(source, name):
    return [
        int(value, 0)
        for value in re.findall(r"0x[\da-f]+|\d+", array(source, name))
    ]


def fields(value):
    return dict(re.findall(r"\.(\w+)\s*=\s*(-?\w+)", value))


def font_atlas(path, destination, name, only=None):
    source = re.sub(r"/\*.*?\*/|//[^\n]*", "", path.read_text(), flags=re.S)
    bitmap = bytes(numbers(source, "glyph_bitmap"))
    descriptors = [fields(item) for item in re.findall(r"\{([^{}]+)\}", array(source, "glyph_dsc"))]
    bpp = int(re.search(r"\.bpp = (\d+)", source)[1])
    if bpp not in (2, 4) or not re.search(r"\.bitmap_format\s*=\s*0\b", source):
        raise ValueError(f"Unsupported LVGL bitmap format in {path}")
    glyphs = {}
    for item in re.findall(r"\{([^{}]+)\}", array(source, "cmaps")):
        mapping = fields(item)
        start, count, first = (int(mapping[k]) for k in ("range_start", "range_length", "glyph_id_start"))
        offsets = range(count) if mapping["unicode_list"] == "NULL" else numbers(source, mapping["unicode_list"])
        ids = range(len(offsets)) if mapping["glyph_id_ofs_list"] == "NULL" else numbers(source, mapping["glyph_id_ofs_list"])
        for offset, index in zip(offsets, ids, strict=True):
            if mapping["type"].endswith("FORMAT0_FULL") and not index and offset:
                continue
            glyphs[start + offset] = descriptors[first + index]
    if only is not None:
        glyphs = {code: glyphs[code] for code in only}
    width = 512
    x = y = row = 0
    metrics, patches = {}, []
    for code, glyph in sorted(glyphs.items()):
        offset, advance, w, h, dx, dy = (
            int(glyph[key]) for key in ("bitmap_index", "adv_w", "box_w", "box_h", "ofs_x", "ofs_y")
        )
        if x + w > width:
            x, y, row = 0, y + row, 0
        metrics[code] = [x, y, w, h, dx, dy, (advance + 8) // 16]
        if w and h:
            mask = (1 << bpp) - 1
            alpha = bytes(
                ((bitmap[offset + i * bpp // 8] >> (8 - bpp - i * bpp % 8)) & mask) * 255 // mask
                for i in range(w * h)
            )
            patches.append((x, y, Image.frombytes("L", (w, h), alpha)))
            x, row = x + w, max(row, h)
    alpha = Image.new("L", (width, y + row))
    for x, y, patch in patches:
        alpha.paste(patch, (x, y))
    atlas = Image.new("RGBA", alpha.size, "white")
    atlas.putalpha(alpha)
    atlas.save(destination / f"{name}.png", optimize=True)
    return {
        "height": int(re.search(r"\.line_height = (\d+)", source)[1]),
        "baseline": int(re.search(r"\.base_line = (\d+)", source)[1]),
        "glyphs": metrics,
    }


def export(project, destination):
    destination.mkdir(parents=True, exist_ok=True)
    main = project / "main"
    lvgl = project / "managed_components/lvgl__lvgl"
    fonts = {
        str(size): font_atlas(main / f"fonts/terminal_zh_{size}.c", destination, f"font-{size}")
        for size in (16, 18)
    }
    fonts["symbols"] = font_atlas(
        lvgl / "src/font/lv_font_montserrat_14.c", destination, "font-symbols",
        {*map(ord, "-0123456789"), 0xF00B, 0xF026, 0xF027, 0xF028, 0xF1EB, 0xF8A2},
    )
    fonts["battery"] = font_atlas(main / "fonts/terminal_battery_12.c", destination, "font-battery")
    (destination / "fonts.json").write_text(json.dumps(fonts, separators=(",", ":")) + "\n")
    images = json.loads((main / "assets/avatar.json").read_text())["images"]
    for name, metadata in images.items():
        width, height = metadata["width"], metadata["height"]
        data = (main / "assets" / name).read_bytes()
        count = width * height
        pixels = [
            ((pixel >> 11) * 255 // 31, ((pixel >> 5) & 63) * 255 // 63,
             (pixel & 31) * 255 // 31, data[2 * count + i])
            for i, (pixel,) in enumerate(struct.iter_unpack("<H", data[:2 * count]))
        ]
        image = Image.new("RGBA", (width, height))
        image.putdata(pixels)
        image.save(destination / Path(name).with_suffix(".png"), optimize=True)
    licenses = lvgl / "scripts/built_in_font/font_license"
    shutil.copyfile(licenses / "SourceHanSansSC/LICENSE.txt", destination / "SourceHanSansSC.LICENSE.txt")
    shutil.copyfile(licenses / "Montserrat/OFL.txt", destination / "Montserrat.LICENSE.txt")
    (destination / "NOTICE.txt").write_text(
        f"Bitmaps exported from PA-Terminal {(project / 'version.txt').read_text().strip()}, including LVGL 9.5.0's Montserrat 14 asset.\n"
        "The LVGL symbols are Font Awesome 5 Free icons (CC BY 4.0, Fonticons, Inc.).\n"
        "https://fontawesome.com/license/free\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("terminal_project", type=Path)
    parser.add_argument("--output", type=Path, default=Path("public/pp-demo/display"))
    args = parser.parse_args()
    export(args.terminal_project, args.output)
