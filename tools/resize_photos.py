"""Resize photos for the photo album and create thumbnails, ready to upload to R2.

Usage:
    python tools/resize_photos.py <input_folder> <output_folder>

Each sub-folder of the input becomes an album (e.g. "2025", "2026"). For every photo
the script writes:
    <output>/<album>/<name>.jpg          web-sized copy (longest side 2000px)
    <output>/<album>/thumbs/<name>.jpg   thumbnail (longest side 400px)

Upload the contents of the output folder to the root of the R2 bucket, keeping the
folder structure. Photos already processed are skipped, so it is safe to re-run.

To number the photos in each folder in the order they were taken (001.jpg, 002.jpg, ...),
using the date and time saved in each photo by the camera, add --rename-by-date. Photos
without that information are listed, and numbered after the rest in filename order.
Add --dry-run to see the new names without writing anything.

For the home page carousel (smaller photos, no thumbnails):
    python tools/resize_photos.py <input_folder> site/images/carousel --size 1200 --no-thumbs

Requires Pillow:  pip install Pillow
"""

import argparse
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageOps

FULL_SIZE = 2000
THUMB_SIZE = 400
FULL_QUALITY = 82
THUMB_QUALITY = 75
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".bmp"}

# EXIF tags for when a photo was taken (in the Exif sub-IFD).
EXIF_IFD = 0x8769
DATE_TIME_ORIGINAL = 36867
DATE_TIME_DIGITIZED = 36868
SUBSEC_TIME_ORIGINAL = 37521
MIN_NUMBER_DIGITS = 3


def save_resized(image, size, quality, dest):
    copy = image.copy()
    copy.thumbnail((size, size), Image.LANCZOS)
    dest.parent.mkdir(parents=True, exist_ok=True)
    # Saving without exif= drops the camera metadata, including any GPS location.
    copy.save(dest, "JPEG", quality=quality, optimize=True, progressive=True)


def is_up_to_date(source, dest):
    return dest.exists() and dest.stat().st_mtime >= source.stat().st_mtime


def process_photo(source, full_dest, thumb_dest, full_size, force=False):
    if not force and is_up_to_date(source, full_dest) and (thumb_dest is None or is_up_to_date(source, thumb_dest)):
        return False

    with Image.open(source) as image:
        # Apply the camera's rotation flag so portrait photos don't come out sideways.
        image = ImageOps.exif_transpose(image)
        if image.mode != "RGB":
            image = image.convert("RGB")
        save_resized(image, full_size, FULL_QUALITY, full_dest)
        if thumb_dest is not None:
            save_resized(image, THUMB_SIZE, THUMB_QUALITY, thumb_dest)
    return True


def taken_at(path):
    """When the photo was taken, from its EXIF data, or None if it isn't recorded."""
    try:
        with Image.open(path) as image:
            exif = image.getexif().get_ifd(EXIF_IFD)
    except Exception:
        return None

    for tag in (DATE_TIME_ORIGINAL, DATE_TIME_DIGITIZED):
        value = exif.get(tag)
        if isinstance(value, bytes):
            value = value.decode("ascii", "ignore")
        if not value:
            continue
        try:
            taken = datetime.strptime(value.strip("\x00 "), "%Y:%m:%d %H:%M:%S")
        except ValueError:
            continue  # e.g. "0000:00:00 00:00:00" from a camera whose clock was never set
        # Fractions of a second keep burst shots in order.
        subsec = str(exif.get(SUBSEC_TIME_ORIGINAL, "")).strip("\x00 ")
        return taken, subsec.ljust(6, "0") if subsec.isdigit() else "000000"
    return None


def plan_outputs(sources, input_root, rename_by_date):
    """Pairs each source photo with the path (relative to the output folder) it's written to."""
    if not rename_by_date:
        return [(source, source.relative_to(input_root).with_suffix(".jpg")) for source in sources], []

    by_folder = defaultdict(list)
    for source in sources:
        by_folder[source.relative_to(input_root).parent].append(source)

    plan, undated = [], []
    for folder, photos in sorted(by_folder.items()):
        dates = {photo: taken_at(photo) for photo in photos}
        missing = sorted((p for p in photos if dates[p] is None), key=lambda p: p.name.lower())
        dated = sorted((p for p in photos if dates[p] is not None), key=lambda p: (dates[p], p.name.lower()))
        undated += missing

        digits = max(MIN_NUMBER_DIGITS, len(str(len(photos))))
        for number, photo in enumerate(dated + missing, start=1):
            plan.append((photo, folder / f"{number:0{digits}d}.jpg"))
    return plan, undated


def stale_outputs(output_root, plan, with_thumbs):
    """Photos already in the output folders that the new numbering doesn't produce."""
    expected = {output_root / relative for _, relative in plan}
    if with_thumbs:
        expected |= {output_root / relative.parent / "thumbs" / relative.name for _, relative in plan}
    folders = {(output_root / relative).parent for _, relative in plan}
    if with_thumbs:
        folders |= {folder / "thumbs" for folder in folders}
    return sorted(
        path for folder in folders if folder.is_dir()
        for path in folder.iterdir()
        if path.suffix.lower() in IMAGE_EXTENSIONS and path not in expected
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input", type=Path, help="folder of original photos (sub-folders become albums)")
    parser.add_argument("output", type=Path, help="folder to write the resized photos to")
    parser.add_argument("--size", type=int, default=FULL_SIZE,
                        help=f"longest side of the resized photos in pixels (default {FULL_SIZE})")
    parser.add_argument("--no-thumbs", action="store_true",
                        help="don't create thumbnails (e.g. for the home page carousel)")
    parser.add_argument("--rename-by-date", action="store_true",
                        help="number the photos in each folder 001, 002, ... in the order they were taken")
    parser.add_argument("--dry-run", action="store_true",
                        help="show what would be written, without writing anything")
    args = parser.parse_args()

    if not args.input.is_dir():
        sys.exit(f"Input folder not found: {args.input}")

    sources = sorted(
        path for path in args.input.rglob("*")
        if path.suffix.lower() in IMAGE_EXTENSIONS and "thumbs" not in path.parts
    )
    if not sources:
        sys.exit(f"No photos found in {args.input}")

    plan, undated = plan_outputs(sources, args.input, args.rename_by_date)

    if args.dry_run:
        for source, relative in plan:
            print(f"  {source.relative_to(args.input)}  ->  {relative}")
    else:
        processed = skipped = failed = 0
        for source, relative in plan:
            full_dest = args.output / relative
            thumb_dest = None if args.no_thumbs else args.output / relative.parent / "thumbs" / relative.name

            try:
                # Renumbering can give an existing name to a different photo, so always rewrite.
                if process_photo(source, full_dest, thumb_dest, args.size, force=args.rename_by_date):
                    processed += 1
                    renamed = f"  (from {source.name})" if args.rename_by_date else ""
                    print(f"  {relative}{renamed}")
                else:
                    skipped += 1
            except Exception as err:
                failed += 1
                print(f"  FAILED {source}: {err}", file=sys.stderr)

        print(f"\nDone: {processed} resized, {skipped} already up to date, {failed} failed.")
        print(f"Output: {args.output.resolve()}")

    if undated:
        print(f"\nNo date taken found for {len(undated)} photo(s); numbered after the dated ones, in filename order:")
        for source in undated:
            print(f"  {source.relative_to(args.input)}")

    if args.rename_by_date:
        stale = stale_outputs(args.output, plan, not args.no_thumbs)
        if stale:
            print(f"\n{len(stale)} other photo(s) in the output folders aren't part of this numbering"
                  " (left from an earlier run?). Check them before uploading:")
            for path in stale:
                print(f"  {path.relative_to(args.output)}")


if __name__ == "__main__":
    main()
