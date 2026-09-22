# 2025 Poster Session Interactive Map

A mobile-first, interactive SVG-based map for poster sessions with color-coded poster mounts and hover-based information display.

## 📁 File Organization

```
2025-Poster-Session/
├── index.html              # Main application file
├── README.md              # This documentation
├── assets/                # Static assets
│   ├── css/              # Stylesheets
│   │   └── table.css     # Table styling (if used)
│   ├── js/               # JavaScript files
│   │   ├── script.js     # Core PosterSessionMap class
│   │   ├── layout-api.js # Layout API for SVG management
│   │   └── unified-app.js # Additional app functionality
│   └── svg/              # SVG building/map files
│       └── strauss-plaza.svg  # Combined site map (all buildings, one file)
├── data/                 # Data files
│   └── poster-data.tsv  # Poster info, mount position/orientation, and marker color (one row per poster)
└── docs/                 # Documentation
    └── LAYOUT-API.md     # Layout API documentation
```

## 🚀 Quick Start

1. Open `index.html` in a web browser
2. The map will automatically load poster mounts from the TSV file
3. Hover over colored circles to view poster information
4. Use mouse wheel or touch gestures to zoom and pan

## 📊 Data Structure

### Poster Data (`data/poster-data.tsv`)
One row per poster; two posters sharing a Mount ID form one physical two-sided mount.
- **Poster Category**: Subject area (Biology, Chemistry, etc.)
- **Easel Board**: Unique poster identifier (B-1, C-3, etc.)
- **Poster Title**: Full poster title
- **Students**: Student authors
- **Faculty**: Faculty advisor
- **Mount ID**: Groups posters that share a physical mount
- **Side**: North/South (horizontal) or East/West (vertical) positioning
- **X Coordinate**: Pixel position from left
- **Y Coordinate**: Pixel position from top
- **Orientation**: 'horizontal' or 'vertical'
- **Color**: Hex color for this poster's marker (e.g. `#FFFFFF`)

`tools/mount-editor.html` is the dev tool for editing X/Y/Orientation visually - it loads and exports `poster-data.tsv` directly, leaving all other columns untouched.

## 🎨 Color Coding

Each poster's marker is colored by its own **Color** column in `poster-data.tsv` - there's no automatic category-based coloring, so a blank/placeholder value (e.g. `#FFFFFF`) shows as-is until a real color is assigned.

## 🛠️ Technical Features

- **Mobile-first responsive design**
- **Hover-based information display**
- **SVG-based scalable graphics**
- **Touch-friendly interactions**
- **Keyboard accessibility**
- **Directional poster positioning**
- **Layer management** (posters always visible above buildings)

## 📝 Adding New Content

### Add a New Poster:
1. Add a row to `data/poster-data.tsv` with its own Poster Category/Easel Board/Title/Students/Faculty/Color
2. Give it an existing Mount ID (to share a mount with another poster) or a new one, and set its Side
3. Fill in X Coordinate/Y Coordinate/Orientation directly, or leave them blank and place it visually in `tools/mount-editor.html`

### Add a New Mount:
1. Place it in `tools/mount-editor.html` (or set X Coordinate/Y Coordinate/Orientation by hand) for the poster row(s) sharing that Mount ID

### Add a New Building:
1. Add SVG file to `assets/svg/`
2. Use Layout API in `index.html` to position it

## 🎯 Browser Support

Modern browsers with SVG and ES6+ support:
- Chrome 60+
- Firefox 55+
- Safari 12+
- Edge 79+