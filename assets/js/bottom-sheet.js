// Mobile bottom sheet (Phases 1-2 of the mobile map redesign). Vanilla JS,
// no jQuery dependency. Owns: snap-state (Collapsed/Half/Full), the drag
// gesture and its handoff with the list's native scroll, the dim overlay,
// the "Fit all" pill's position, and viewport insets pushed into
// PosterSessionMap so the camera doesn't fit/center content under the sheet.
// Inert everywhere above the 768px mobile breakpoint.

(function () {
    'use strict';

    const MOBILE_QUERY = '(max-width: 768px)';
    const HALF_FRACTION = 0.45;
    const FLING_VELOCITY_THRESHOLD = 0.5; // px/ms
    const DRAG_THRESHOLD = 8; // px, before a touch is claimed as a drag
    const VELOCITY_WINDOW_MS = 100;
    const NO_TRANSITION_CLASS = 'sheet-dragging'; // shared by live-drag and instant (non-animated) snaps
    const STATE_ORDER = ['full', 'half', 'collapsed']; // ascending offset (full = 0)

    class BottomSheet {
        constructor() {
            this.sheet = document.getElementById('tablePanel');
            this.handle = document.getElementById('sheetHandle');
            this.filterForm = document.getElementById('filter-form-container');
            this.filterControls = this.sheet ? this.sheet.querySelector('.filter-controls') : null;
            this.listEl = this.sheet ? this.sheet.querySelector('.table-responsive') : null;
            this.dimOverlay = document.getElementById('sheetDimOverlay');
            this.fitAllBtn = document.getElementById('resetView');
            this.infoButton = document.getElementById('infoButtonToggle');
            this.headerEl = document.querySelector('.header');
            this.svg = document.getElementById('posterMap');

            if (!this.sheet || !this.handle || !this.filterForm || !this.listEl) {
                return;
            }

            this.mobileQuery = window.matchMedia(MOBILE_QUERY);
            this.reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

            this.state = 'collapsed';
            this.offsets = { collapsed: 0, half: 0, full: 0 };
            this.currentOffset = 0;
            this.fullHeight = 0;

            this.dragging = false;
            this._gesture = null;
            this._rafId = null;
            this._pendingOffset = null;
            this._lastDragEndTime = 0;

            this.safeAreaTop = 0;
            this.safeAreaBottom = 0;

            this._createSafeAreaProbe();
            this._relocateInfoButton();
            this._bindEvents();

            window.addEventListener('resize', () => this._onResize());
            window.addEventListener('orientationchange', () => this._onResize());

            if (this.mobileQuery.matches) {
                this._recomputeOffsets();
                this._goTo('collapsed', { animate: false });
                if (window.posterMap && typeof window.posterMap.recalculateZoomLimits === 'function') {
                    window.posterMap.recalculateZoomLimits();
                }
            } else {
                // Defensive: if the constructor happens to run during a
                // transient narrow layout (seen in at least one automated
                // test environment) the block above would apply mobile
                // styling before mobileQuery's own 'change' listener is
                // even attached, so it would never fire to clean up. Covers
                // that case and is a harmless no-op otherwise.
                this._applyDesktopMode();
            }
        }

        // ---- setup helpers ----------------------------------------------

        _createSafeAreaProbe() {
            const probe = document.createElement('div');
            probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;' +
                'padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom) 0;' +
                'pointer-events:none;visibility:hidden;';
            document.body.appendChild(probe);
            this._safeAreaProbe = probe;
        }

        _measureSafeAreas() {
            if (!this._safeAreaProbe) return;
            const style = getComputedStyle(this._safeAreaProbe);
            this.safeAreaTop = parseFloat(style.paddingTop) || 0;
            this.safeAreaBottom = parseFloat(style.paddingBottom) || 0;
        }

        // Moved, not duplicated, so initializeInfoButton()'s click handler
        // (attached to the element itself in index.html) keeps working
        // wherever the node currently lives.
        _relocateInfoButton() {
            if (!this.infoButton) return;
            if (this.mobileQuery.matches) {
                const target = this.filterControls || this.filterForm;
                target.appendChild(this.infoButton);
            } else if (this.headerEl) {
                this.headerEl.appendChild(this.infoButton);
            }
        }

        _bindEvents() {
            this.mobileQuery.addEventListener('change', () => {
                this._relocateInfoButton();
                if (this.mobileQuery.matches) {
                    this._recomputeOffsets();
                    this._goTo(this.state, { animate: false });
                } else {
                    this._applyDesktopMode();
                }
            });

            this.handle.addEventListener('click', () => {
                if (this.mobileQuery.matches) this._cycleState();
            });

            if (this.dimOverlay) {
                this.dimOverlay.addEventListener('click', () => {
                    if (this.mobileQuery.matches && this.state === 'full') {
                        this._goTo('collapsed');
                    }
                });
            }

            if (this.svg) {
                this.svg.addEventListener('maptap', () => {
                    if (this.mobileQuery.matches && (this.state === 'half' || this.state === 'full')) {
                        this._goTo('collapsed');
                    }
                });
            }

            // A row selection (table tap, or the auto-highlight-on-single-
            // search-match feature) is about to pan/zoom the camera to a
            // marker - drop to Half first (synchronously, so insets are
            // updated before that camera call runs) instead of leaving a
            // Full sheet covering the marker it just centered.
            document.addEventListener('poster-row-selected', () => {
                if (this.mobileQuery.matches) {
                    this._goTo('half');
                }
            });

            [this.handle, this.filterForm, this.listEl].forEach((surface) => {
                this._bindDragSurface(surface);
            });
        }

        _bindDragSurface(el) {
            if (!el) return;
            const onStart = (e) => this._onGestureStart(e, el);
            const onMove = (e) => this._onGestureMove(e, el);
            const onEnd = (e) => this._onGestureEnd(e, el);
            el.addEventListener('touchstart', onStart, { passive: false });
            el.addEventListener('touchmove', onMove, { passive: false });
            el.addEventListener('touchend', onEnd, { passive: false });
            el.addEventListener('touchcancel', onEnd, { passive: false });
        }

        // ---- snap offsets --------------------------------------------------

        _recomputeOffsets() {
            if (!this.mobileQuery.matches) return;
            this._measureSafeAreas();

            const rect = this.sheet.getBoundingClientRect();
            const fullHeight = rect.height;
            if (!(fullHeight > 0)) return;
            this.fullHeight = fullHeight;

            const computed = getComputedStyle(this.sheet);
            const paddingBottom = parseFloat(computed.paddingBottom) || 0;
            const handleH = this.handle.offsetHeight;
            const filterH = this.filterForm.offsetHeight;

            const collapsed = Math.max(0, fullHeight - (handleH + filterH + paddingBottom));
            // window.innerHeight (the layout viewport), not
            // visualViewport.height - the latter shrinks when the on-screen
            // keyboard opens, which would otherwise make Phase 3's "focus
            // search -> Full" also spuriously recompute the Half offset.
            const half = Math.max(0, Math.min(collapsed, fullHeight - window.innerHeight * HALF_FRACTION));
            const full = 0;

            this.offsets = { collapsed, half, full };
        }

        _offsetForState(state) {
            return this.offsets[state] !== undefined ? this.offsets[state] : this.offsets.half;
        }

        // ---- applying state --------------------------------------------

        _goTo(stateName, options) {
            const animate = !options || options.animate !== false;
            const effectiveAnimate = animate && !this.reducedMotionQuery.matches;

            this.state = stateName;
            const offset = this._offsetForState(stateName);
            this.currentOffset = offset;

            if (!effectiveAnimate) {
                this._setNoTransition(true);
            }

            this._writeSheetTransform(offset);
            this._writeDimOpacity(this._dimForOffset(offset));
            this._writeFitAllTransform(offset);
            this._updateStateClasses(stateName);
            this._updateHandleAria(stateName);
            this._settleInsets();

            if (!effectiveAnimate) {
                // Release on the next frame so a later, genuinely-animated
                // change (e.g. a drag release right after) transitions again.
                requestAnimationFrame(() => this._setNoTransition(false));
            }
        }

        _setNoTransition(on) {
            [this.sheet, this.dimOverlay, this.fitAllBtn].forEach((el) => {
                if (el) el.classList.toggle(NO_TRANSITION_CLASS, on);
            });
        }

        _writeSheetTransform(offset) {
            this.sheet.style.transform = `translateY(${offset}px)`;
        }

        _dimForOffset(offset) {
            const half = this.offsets.half;
            const full = this.offsets.full; // 0
            if (half <= full || offset >= half) return 0;
            const t = (half - offset) / (half - full); // 0 at Half, 1 at Full
            return Math.max(0, Math.min(0.2, 0.2 * t));
        }

        _writeDimOpacity(value) {
            if (this.dimOverlay) this.dimOverlay.style.opacity = String(value);
        }

        _writeFitAllTransform(offset) {
            if (!this.fitAllBtn) return;
            const visibleSheetHeight = Math.max(0, this.fullHeight - offset);
            this.fitAllBtn.style.transform = `translateY(-${visibleSheetHeight + 12}px)`;
            const pastHalf = offset < this.offsets.half - 1;
            this.fitAllBtn.classList.toggle('fit-all-hidden', pastHalf);
        }

        _updateStateClasses(stateName) {
            ['sheet-state-collapsed', 'sheet-state-half', 'sheet-state-full'].forEach((c) => {
                this.sheet.classList.remove(c);
                if (this.dimOverlay) this.dimOverlay.classList.remove(c);
            });
            this.sheet.classList.add(`sheet-state-${stateName}`);
            if (this.dimOverlay) this.dimOverlay.classList.add(`sheet-state-${stateName}`);

            // Collapsed: the list is offscreen behind the search row, so
            // Tab shouldn't walk into it.
            const collapsed = stateName === 'collapsed';
            if ('inert' in this.listEl) {
                this.listEl.inert = collapsed;
            } else if (collapsed) {
                this.listEl.setAttribute('aria-hidden', 'true');
            } else {
                this.listEl.removeAttribute('aria-hidden');
            }
        }

        _updateHandleAria(stateName) {
            const expanded = stateName === 'full';
            this.handle.setAttribute('aria-expanded', String(expanded));
            this.handle.setAttribute('aria-label', expanded ? 'Collapse poster list' : 'Expand poster list');
        }

        // Pushes the current visible-sheet-height (+ any safe-area) into
        // PosterSessionMap as insets. Only called on settle (goTo) - never
        // mid-drag, and never re-fits/re-centers the camera itself; it only
        // affects the *next* fit/center call, per the mobile bottom-sheet
        // plan's C7 section.
        _settleInsets() {
            if (!this.mobileQuery.matches) return;
            if (!window.posterMap || typeof window.posterMap.setViewportInsets !== 'function') return;
            const visibleSheetHeight = Math.max(0, this.fullHeight - this.currentOffset);
            window.posterMap.setViewportInsets({
                top: this.safeAreaTop,
                bottom: visibleSheetHeight + 12
            });
        }

        // Strips every inline style/class the mobile mode applies, so
        // desktop's plain CSS (fixed sidebar table, no transform, no
        // insets) takes back over completely. Needed because _goTo() etc.
        // only ever get called under a mobileQuery.matches guard going IN,
        // but nothing would otherwise undo their effects going back OUT -
        // without this, a sheet left mid-transform from mobile styling
        // would stay translated (and clipped) at desktop widths too.
        _applyDesktopMode() {
            [this.sheet, this.dimOverlay, this.fitAllBtn].forEach((el) => {
                if (!el) return;
                el.classList.remove(
                    NO_TRANSITION_CLASS,
                    'sheet-state-collapsed', 'sheet-state-half', 'sheet-state-full',
                    'fit-all-hidden'
                );
                el.style.transform = '';
            });
            if (this.dimOverlay) this.dimOverlay.style.opacity = '';
            if ('inert' in this.listEl) {
                this.listEl.inert = false;
            } else {
                this.listEl.removeAttribute('aria-hidden');
            }
            this.handle.removeAttribute('aria-expanded');
            this.handle.setAttribute('aria-label', 'Expand poster list');
            if (window.posterMap && typeof window.posterMap.setViewportInsets === 'function') {
                window.posterMap.setViewportInsets({ top: 0, right: 0, bottom: 0, left: 0 });
            }
        }

        _cycleState() {
            // A click can fire right after a touch-drag ends (synthetic
            // click following touchend); ignore it so a drag doesn't also
            // trigger a cycle.
            if (this._lastDragEndTime && performance.now() - this._lastDragEndTime < 400) {
                return;
            }
            const next = { collapsed: 'half', half: 'full', full: 'half' }[this.state] || 'half';
            this._goTo(next);
        }

        // ---- resize / orientation --------------------------------------

        _onResize() {
            if (!this.mobileQuery.matches) return;
            this._recomputeOffsets();
            this._goTo(this.state, { animate: false });
        }

        // ---- gesture state machine (D3/D4) ------------------------------
        //
        // Raw touch events, not Pointer Events: once native scroll claims a
        // touch, a Pointer Events listener on that element gets
        // pointercancel and can never reclaim the gesture. touchmove's
        // preventDefault() can stop a scroll from starting, or let it
        // continue, decided per-event - which the Full-state/scrollTop
        // handoff (rule 5 below) depends on.

        _touchPoint(e) {
            const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
            return t ? { x: t.clientX, y: t.clientY } : { x: e.clientX, y: e.clientY };
        }

        _onGestureStart(e, surface) {
            if (!this.mobileQuery.matches) return;
            if (e.touches && e.touches.length > 1) {
                this._gesture = null;
                return;
            }
            const p = this._touchPoint(e);
            this._gesture = {
                surface,
                startX: p.x,
                startY: p.y,
                startOffset: this.currentOffset,
                owner: null,
                listScrollTop: surface === this.listEl ? this.listEl.scrollTop : null,
                samples: [{ y: p.y, t: performance.now() }]
            };
        }

        _onGestureMove(e, surface) {
            const g = this._gesture;
            if (!g || g.surface !== surface) return;

            const p = this._touchPoint(e);
            const dx = p.x - g.startX;
            const dy = p.y - g.startY;

            if (g.owner === null) {
                if (Math.hypot(dx, dy) < DRAG_THRESHOLD) {
                    return; // below threshold - let taps on inputs/buttons work
                }
                if (Math.abs(dx) > Math.abs(dy)) {
                    g.owner = 'none'; // horizontal - reserved for the Phase-3 chip row
                    return;
                }
                g.owner = this._resolveDragOwner(g, surface, dy);
                if (g.owner === 'sheet') {
                    this._beginDrag();
                }
            }

            if (g.owner !== 'sheet') {
                return;
            }

            e.preventDefault();
            g.samples.push({ y: p.y, t: performance.now() });
            if (g.samples.length > 10) g.samples.shift();

            // Dragging up (dy negative) should shrink the offset (toward
            // Full = 0); dragging down grows it (toward Collapsed).
            const rawOffset = g.startOffset + dy;
            const clamped = Math.min(this.offsets.collapsed, Math.max(this.offsets.full, rawOffset));
            this._scheduleFrame(clamped);
        }

        // Rules (D4): at Collapsed/Half the list never scrolls - any
        // vertical touch on it is a sheet-drag. At Full with scrollTop>0,
        // or scrollTop===0 with an upward move, native scroll owns it. At
        // Full with scrollTop===0 and a downward move, hand off to the
        // sheet instead of letting the list rubber-band.
        _resolveDragOwner(g, surface, dy) {
            if (surface !== this.listEl) {
                return 'sheet';
            }
            if (this.state !== 'full') {
                return 'sheet';
            }
            if (g.listScrollTop > 0) {
                return 'none';
            }
            if (dy < 0) {
                return 'none';
            }
            return 'sheet';
        }

        _onGestureEnd(e, surface) {
            const g = this._gesture;
            this._gesture = null;
            if (!g || g.surface !== surface) return;

            if (g.owner === 'sheet') {
                this._lastDragEndTime = performance.now();
                this._endDrag(g);
            }
        }

        _beginDrag() {
            this.dragging = true;
            this._setNoTransition(true);
        }

        _scheduleFrame(offset) {
            this._pendingOffset = offset;
            if (this._rafId) return;
            this._rafId = requestAnimationFrame(() => {
                this._rafId = null;
                this.currentOffset = this._pendingOffset;
                this._writeSheetTransform(this.currentOffset);
                this._writeDimOpacity(this._dimForOffset(this.currentOffset));
                this._writeFitAllTransform(this.currentOffset);
            });
        }

        _endDrag(g) {
            this.dragging = false;
            this._setNoTransition(false);

            // A live-drag frame can still be queued from the last
            // touchmove before this touchend fires in the same tick -
            // apply it synchronously now (so the snap decision below uses
            // the freshest position) and cancel the queued callback, or it
            // would otherwise land on the NEXT frame and stomp the
            // just-applied snap offset with a stale mid-drag position.
            if (this._rafId) {
                cancelAnimationFrame(this._rafId);
                this._rafId = null;
                this.currentOffset = this._pendingOffset;
            }

            const velocity = this._computeVelocity(g.samples); // px/ms, +down / -up
            const target = this._resolveSnapTarget(this.currentOffset, velocity);
            this._goTo(target);
        }

        _computeVelocity(samples) {
            if (!samples || samples.length < 2) return 0;
            const lastT = samples[samples.length - 1].t;
            const recent = samples.filter((s) => s.t >= lastT - VELOCITY_WINDOW_MS);
            const first = recent[0];
            const last = recent[recent.length - 1];
            const dt = last.t - first.t;
            if (dt <= 0) return 0;
            return (last.y - first.y) / dt;
        }

        _resolveSnapTarget(offset, velocity) {
            const points = STATE_ORDER.map((name) => ({ name, offset: this.offsets[name] }));
            if (Math.abs(velocity) > FLING_VELOCITY_THRESHOLD) {
                const currentIndex = this._nearestIndex(points, offset);
                const dir = velocity > 0 ? 1 : -1; // down -> toward collapsed
                const nextIndex = Math.min(points.length - 1, Math.max(0, currentIndex + dir));
                return points[nextIndex].name;
            }
            return points[this._nearestIndex(points, offset)].name;
        }

        _nearestIndex(points, offset) {
            let bestIndex = 0;
            let bestDist = Infinity;
            points.forEach((p, i) => {
                const d = Math.abs(p.offset - offset);
                if (d < bestDist) {
                    bestDist = d;
                    bestIndex = i;
                }
            });
            return bestIndex;
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        window.bottomSheet = new BottomSheet();
    });
})();
