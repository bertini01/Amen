# Public Assets

This folder contains all public assets for the Amply Studio application.

## Files

### Logo
- **logo.png** (275 KB) - Main Amply Studio logo (the "A" mark), high resolution
  - Used in: Empty states, branding, source for favicons

### Favicons
- **favicon.ico** - Classic browser favicon
- **favicon-16x16.png** - 16x16 pixel favicon
- **favicon-32x32.png** - 32x32 pixel favicon (most common)
- **favicon-48x48.png** - 48x48 pixel favicon
- **favicon-64x64.png** - 64x64 pixel favicon for high DPI

### Mobile Icons
- **apple-touch-icon.png** (180x180) - iOS home screen icon
- **android-chrome-192x192.png** - Android home screen icon
- **android-chrome-512x512.png** - Android splash screen icon

### Web App
- **site.webmanifest** - Progressive Web App configuration

---

## Regenerating Favicons

If you update `logo.png`, regenerate all favicons:

```powershell
cd ..\scripts
.\create-all-favicons.ps1
```

This will recreate all favicon sizes from the main logo.

---

## Icon Sizes Reference

| Size | Purpose |
|------|---------|
| 16x16 | Browser tab (standard) |
| 32x32 | Browser tab (Retina) |
| 48x48 | Windows taskbar |
| 64x64 | High DPI displays |
| 180x180 | iOS home screen |
| 192x192 | Android home screen |
| 512x512 | Android splash |

---

All icons maintain the Amply Studio branding:
- 3D blue gradient aesthetic
- Modern, premium design
- Audio-focused identity
