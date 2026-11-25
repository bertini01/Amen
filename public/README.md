# Public assets

Served with the app's web interface.

- `logo.png`: the Wavecrate mark at 512 px (sidebar, Studio empty state).
- `favicon.ico`, `favicon-*.png`, `apple-touch-icon.png`, `android-chrome-*.png`: icon sizes.
- `site.webmanifest`: name and icons for the web view.

The master artwork is `packaging/brand/wavecrate-logo.svg`, rendered to
`packaging/brand/wavecrate-1024.png`. After changing it, regenerate the app's
icons with `npm run gen:icon` and re-create these files from the same PNG.
