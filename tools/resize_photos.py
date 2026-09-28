"""Resize photos for the photo album and create thumbnails, ready to upload to R2.

Usage:
    python tools/resize_photos.py <input_folder> <output_folder>

Each sub-folder of the input becomes an album (e.g. "2025", "2026"). For every photo
the script writes:
    <output>/<album>/<name>.jpg          web-sized copy (longest side 2000px)
    <output>/<album>/thumbs/<name>.jpg   thumbnail (longest side 400px)

Upload the contents of the output folder to the root of the R2 bucket, keeping the
folder structure. Photos already processed are skipped, so it is safe to re-run.

For the home page carousel (smaller photos, no thumbnails):
    python tools/resize_photos.py <input_folder> site/images/carousel --size 1200 --no-thumbs

Requires Pillow:  pip install Pillow
"""

import argparse
import sys
from pathlib import Path

from PIL import Image, ImageOps

FULL_SIZE = 2000
THUMB_SIZE = 400
FULL_QUALITY = 82
THUMB_QUALITY = 75
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".bmp"}


def save_resized(image, size, quality, dest):
    copy = image.copy()
    copy.thumbnail((size, size), Image.LANCZOS)
    dest.parent.mkdir(parents=True, exist_ok=True)
    # Saving without exif= drops the camera metadata, including any GPS location.
    copy.save(dest, "JPEG", quality=quality, optimize=True, progressive=True)


def is_up_to_date(source, dest):
    return dest.exists() and dest.stat().st_mtime >= source.stat().st_mtime


def process_photo(source, full_dest, thumb_dest, full_size):
    if is_up_to_date(source, full_dest) and (thumb_dest is None or is_up_to_date(source, thumb_dest)):
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


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input", type=Path, help="folder of original photos (sub-folders become albums)")
    parser.add_argument("output", type=Path, help="folder to write the resized photos to")
    parser.add_argument("--size", type=int, default=FULL_SIZE,
                        help=f"longest side of the resized photos in pixels (default {FULL_SIZE})")
    parser.add_argument("--no-thumbs", action="store_true",
                        help="don't create thumbnails (e.g. for the home page carousel)")
    args = parser.parse_args()

    if not args.input.is_dir():
        sys.exit(f"Input folder not found: {args.input}")

    sources = sorted(
        path for path in args.input.rglob("*")
        if path.suffix.lower() in IMAGE_EXTENSIONS and "thumbs" not in path.parts
    )
    if not sources:
        sys.exit(f"No photos found in {args.input}")

    processed = skipped = failed = 0
    for source in sources:
        relative = source.relative_to(args.input).with_suffix(".jpg")
        full_dest = args.output / relative
        thumb_dest = None if args.no_thumbs else args.output / relative.parent / "thumbs" / relative.name

        try:
            if process_photo(source, full_dest, thumb_dest, args.size):
                processed += 1
                print(f"  {relative}")
            else:
                skipped += 1
        except Exception as err:
            failed += 1
            print(f"  FAILED {source}: {err}", file=sys.stderr)

    print(f"\nDone: {processed} resized, {skipped} already up to date, {failed} failed.")
    print(f"Output: {args.output.resolve()}")


if __name__ == "__main__":
    main()
