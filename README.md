# Unpinned

**Check what a photo reveals before you share it, then save a copy without the hidden details. Everything happens in your browser.**

Live demo: https://hyunsikparker.github.io/unpinned/

## The problem

A photo file usually carries more than the picture. Phones and cameras write metadata into it: the GPS position where it
was taken, the date and time, the device model and sometimes its serial number, an owner name, and a small preview image.
Some apps keep the *uncropped* original in that preview after you crop the photo.

Big social networks often strip this data on upload, but many everyday paths do not: sending a photo as a file in a chat
app, attaching it to an email, uploading to a marketplace listing, a forum or a cloud link. A sofa photo for a second-hand
sale can tell a stranger the exact house it is in.

## Who it helps

People who share photos outside the big platforms: someone selling furniture online, a parent posting in a school group, a
person who has left an abusive relationship and does not want to reveal a new address, a volunteer sending pictures of a
shelter. None of them should need to know what EXIF is.

## What it does

1. **Check.** Drop JPEG, PNG or WebP photos (or try the built-in sample). Unpinned lists what the file reveals, most serious
   first, each with one line on why it matters:
   - exact location (GPS position and altitude, also XMP and IPTC place fields)
   - names of the owner, author or copyright holder
   - device serial numbers and unique photo IDs
   - date and time taken, captions and hidden comments
   - hidden preview images, including the uncropped original some editors leave behind (shown next to your photo)
   - data attached after the picture, such as a motion-photo video clip
2. **Clean.** "Make a clean copy" rebuilds the file without those blocks. The compressed picture data is copied byte for
   byte, so quality does not change. The rotation flag and colour profile are kept so the photo still looks right.
3. **Verify.** The copy is analysed again before you save it. The page states what was removed, what was kept and whether
   anything remains.

## Safer by design

- **Nothing leaves your device.** There is no server, no upload, no analytics. The deployed page ships a Content Security
  Policy with `connect-src 'none'`, so the browser itself blocks any network request from the page.
- **No account and no install.** It works offline once loaded.
- **Honest limits** (also shown on the page):
  - It cannot see clues *in the picture itself*: a street sign, a house number, a reflection, a school uniform.
  - HEIC files from iPhones are not read yet. Use "Most Compatible" in the camera settings or turn off Location in the
    share sheet's Options.
  - It removes metadata blocks it knows; unknown vendor blocks are removed too, but a file in an unusual format is
    reported as unreadable rather than guessed at.

## Example

The sample photo is a sofa for sale, cropped to the sofa. Unpinned shows that the file still contains an exact location
(synthetic: the Eiffel Tower, not anyone's home), the owner's name, a device serial number, the time it was taken, and a
hidden preview image of the whole room, including the window and street sign that the crop cut out. The clean copy keeps the
same picture, drops 3 KB of metadata, and the re-check finds nothing left.

## How it was checked

- 8 unit tests (`npm test`) run on synthetic photos whose metadata was written by **exiftool**, an independent
  implementation: GPS, names, serial number, XMP and IPTC places, a comment, an embedded preview, data after the image,
  plus PNG and WebP files. The tests check that every item is found, that the clean copy has none of them, that the
  picture bytes are identical, and that exiftool itself finds no location, names or serials in the clean copy.
- 2 browser tests (`npm run test:e2e`, Playwright on the production build): the sample flow end to end, an automated
  accessibility scan (axe, no violations), no console errors, **no network requests**, and no horizontal scrolling at
  phone width.

## Run it locally

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm test           # unit tests (exiftool cross-check runs when exiftool is installed)
npm run test:e2e   # browser tests on the production build
```

To regenerate the test photos: `python3 scripts/make_fixtures.py` (needs Pillow and exiftool).

## How it works

`src/metadata.ts` parses the containers directly, without libraries:

- **JPEG:** walks the marker segments; reads EXIF (TIFF IFD0, Exif IFD, GPS IFD, IFD1 thumbnail), XMP, Photoshop/IPTC,
  comments and multi-picture data; finds the true end of the image to detect attached data. Cleaning keeps SOI, JFIF,
  the colour profile, the Adobe colour-transform segment and all image segments, adds back a minimal EXIF block holding only
  the orientation, and drops everything after the end-of-image marker.
- **PNG:** reads `eXIf`, `tEXt`, `iTXt`, `zTXt` and `tIME` chunks and drops them.
- **WebP:** reads and drops the `EXIF` and `XMP ` chunks, clears their flags in `VP8X` and fixes the RIFF size.

## Credits and disclosure

- Built during SafeSpace Hacks 2026 (started October 22, 2026). No pre-existing project code.
- **AI assistance:** built with Claude (Anthropic), an AI coding assistant, which wrote the code, the tests and this README.
- Libraries: React, Vite and TypeScript; Vitest, Testing Library, Playwright and axe-core for tests. exiftool and Pillow are
  used only to create test files.
- The sample photo and every value in it are synthetic.

## License

MIT
