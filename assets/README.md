# Plugin Store Assets

Assets for the AppOS Plugin Store listing.

## Shipped

- `icon.png` -- 256x256 generic placeholder icon (an abstract gradient
  pattern, NOT a rendering of product UI). The catalog bundle layout requires
  an icon member, so this placeholder ships until the design pass produces a
  real one (1024x1024 target).

## Screenshots — intentionally absent

The listing ships WITHOUT screenshots for now. Real screenshots require
capturing the running AppOS GUI with this plugin installed, which is a
tracked maintainer task. Placeholder or generated "screenshots" must never
be added here: fabricated UI captures were removed from this repo during
public-prep on honesty grounds, and the catalog listing deliberately has no
screenshots until real captures exist.

Planned captures (names reserved for when real ones land):

- `screenshot-download.png` -- Download form with URL probed and format options
- `screenshot-queue.png` -- Active download queue with streaming progress bars
- `screenshot-library.png` -- Library browser with media grid and metadata
- `screenshot-degraded.png` -- Degraded-state banner when yt-dlp is missing

## Future

- `demo.mp4` -- End-to-end workflow video: paste URL, download, play in library (v1.1)
