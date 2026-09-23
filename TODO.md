# Table
[] Incorporate Sort by category toggle
[X] Fix vertical scroll on mobile (continuously having problems) - root cause was Bootstrap 3.3.7's own `.table-responsive{overflow-y:hidden}` mobile rule winning the cascade tie against ours (it loads after our inline styles); fixed with a higher-specificity `#tablePanel .table-responsive` override, which let the old hand-rolled touch-scroll workaround be deleted entirely in favor of native scrolling
[X] Include an option to view table full screen (table becomes a footer that can be reopened) - superseded by the bottom-sheet redesign below (the old chevron/fullscreen toggle is gone; the sheet itself is always at least peekable)
[X] When selecting a row, have map pan so that marker is centered.

# Mobile bottom sheet (replaces the old stacked map/table + chevron toggle)
[X] Phase 1: full-screen map, header removed on mobile (branding + info button move into the sheet), collapsed/half/full draggable sheet, dim overlay, Fit-all pill, camera viewport insets so fit/center/search-row-centering all land above the sheet
[X] Phase 2: drag-to-snap with fling detection, tap-the-handle-to-cycle, tap-the-map-to-collapse, list scroll only at Full with a scrollTop-aware handoff back to the sheet, reduced-motion support
[X] Row selection drops the sheet to Half so the marker it centers on isn't hidden under a Full sheet (pulled forward from Phase 4 after testing showed the gap)
[X] Phase 3 (partial): search-focus opens the sheet to Full; the funnel button + dropdown/centered-modal category filter is replaced everywhere (not just mobile, per a mid-build call) by a single horizontally-scrolling row of toggle chips, one per department, shared between desktop and mobile. Chips are neutrally colored, not tinted per department - checked the data directly and colors are assigned per easel-prefix *combination* (e.g. `CSHC` vs `CS` vs `CSEP` differ even though all involve Computer Science), not per single department, so a "department color" legend wasn't accurate to build.
[] Phase 3 (remaining): card-style list rows on mobile
[] Phase 4: sheet detail view on row/marker tap, back-navigation, `?easel=` deep links
[] Phase 5: confirm/polish the desktop side-panel layout against the same PRD, marker focus/labeling accessibility pass

# Map
[X] Click within map to hide info pane/unselect row
[X] Restrict Zoom on scroll and - button to whatever the default zoom is
[X] Make panning feel less stiff
[X] Touchscreen input rework Phase 1 (core physics), per the "Map Touchscreen Input Behavior" PRD, Tight preset: exact 1:1 pan tracking (removed the >1:1 multipliers "less stiff" above had added), touch/pinch slop-gated gesture recognition, pan bounds, momentum with a proper fling threshold/cap/decay, zoom-limit rubber-banding, two-finger-tap-to-zoom-out
[] Touchscreen input rework, deferred: long-press, double-tap-drag continuous zoom, 44px marker hit-target rework, palm/edge rejection
[] Show a "Zoom in!" window on load with a little pinching animation
[X] Change map controls to be brand colors

# Tooltips
[] Change tooltips to be brand colors (header primarily)
[X] Ensure Tooltips are on Z-index over Controls.
[] Increase length of tooltip arrow and have it look good (don't look disjointed, look like it's organically coming from tooltip bubble)
[X] Update Easel Board in Tooltip to be in a colored pill like how the markers are 
[ ] Something is wrong with extracting Category from TSV. The header is "Poster Category" in the TSV. is missing in info pane tooltip. Shows N/A instead.
# Markers
[X] When marker is focused on, fade the marker it shares the mount with
[X] Fix bug when marker is focused on it stays in an increased size when unfocused/unselected. It should return to normal size after some point.
[] See if slightly increasing the size of the markers across the board helps with readability
[X] Change BHC-1 to Gold
[X] Update Lone Markers to still have board
[X] p14 - remove and keep p13 north
[X] HC-1 - add easel board icon

# Search
[X] When there is only one result, automatically highlight the result after a small buffer window

Some restrictions:
- Mobile first app. Text should be relatively easy to read on mobile.
- Map should stay fixed location
- The only thing that should scroll is the table.
- Colors in circles in table should be consistent with map markers
- Search should be in a fixed location. Table headers should be frozen.
- Header on top should be fixed. (Desktop only as of the bottom-sheet redesign - on mobile the header is removed entirely and its content moves into the sheet's search row / the info popover, so the map can run full-screen.)