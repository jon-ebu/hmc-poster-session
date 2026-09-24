// Poster Session Interactive Map

/**
 * Standard bezier-easing solve (Newton-Raphson on the parametric X curve),
 * the same algorithm CSS uses for cubic-bezier() timing functions. Returns
 * a t => easedT function so callers can drop it straight into a lerp.
 */
function cubicBezier(p1x, p1y, p2x, p2y) {
    const A = (a1, a2) => 1.0 - 3.0 * a2 + 3.0 * a1;
    const B = (a1, a2) => 3.0 * a2 - 6.0 * a1;
    const C = (a1) => 3.0 * a1;

    const calcBezier = (t, a1, a2) => ((A(a1, a2) * t + B(a1, a2)) * t + C(a1)) * t;
    const calcSlope = (t, a1, a2) => 3.0 * A(a1, a2) * t * t + 2.0 * B(a1, a2) * t + C(a1);

    const getTForX = (x) => {
        let t = x;
        for (let i = 0; i < 8; i++) {
            const currentSlope = calcSlope(t, p1x, p2x);
            if (currentSlope === 0) return t;
            const currentX = calcBezier(t, p1x, p2x) - x;
            t -= currentX / currentSlope;
        }
        return t;
    };

    return (x) => {
        if (p1x === p1y && p2x === p2y) return x; // linear
        if (x <= 0) return 0;
        if (x >= 1) return 1;
        return calcBezier(getTForX(x), p1y, p2y);
    };
}

// Shared curves for every discrete/animated zoom path - one easing feel
// across buttons, wheel notches, and fly-to (reset/search), per the
// Google-Maps-style zoom PRD.
const EASE_DISCRETE = cubicBezier(0.25, 0.1, 0.25, 1);
const EASE_FLYTO = cubicBezier(0.4, 0, 0.2, 1);
const EASE_WHEEL_STEP = cubicBezier(0, 0, 0.2, 1);

// Zoom-limit rubber-banding, Tight preset (Map Touchscreen Input Behavior
// PRD): used by both applyZoomRubberBand() (a class method, for pinch/wheel)
// and the gesture-tracking closure in initializeEventListeners(), so it's
// module-level like the easing curves above rather than local to either.
const ZOOM_RUBBER_BAND_FRACTION = 0.05; // max overscale past a zoom limit
const ZOOM_RUBBER_BAND_RESISTANCE = 0.35; // damping applied to movement past the limit

// Poster Map Tooltip Containment PRD: used by _placeTooltip()'s fit-check
// against the "Fit all" FAB exclusion zone.
function rectsIntersect(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

class PosterSessionMap {
    constructor() {
        this.svg = document.getElementById('posterMap');
        this.posterAreasGroup = document.getElementById('poster-areas');
        this.markersGroup = document.getElementById('markers');
        this.infoPanel = document.getElementById('infoPanel');
        this.infoTitle = document.getElementById('infoTitle');
        this.infoDescription = document.getElementById('infoDescription');
        this.fullscreenBtn = document.getElementById('toggleFullscreen');
        this.tablePanel = document.getElementById('tablePanel');
        // "Fit all" FAB - an exclusion zone for tooltip placement (Poster Map
        // Tooltip Containment PRD): the tooltip may never cover it.
        this.resetViewBtn = document.getElementById('resetView');
        this.mapContainer = this.svg ? this.svg.closest('.map-container') : null;
        this.fullscreenEnterIcon = this.fullscreenBtn ? this.fullscreenBtn.querySelector('.fullscreen-enter') : null;
        this.fullscreenExitIcon = this.fullscreenBtn ? this.fullscreenBtn.querySelector('.fullscreen-exit') : null;
        this.isFullScreen = document.body.classList.contains('map-fullscreen');
        // Tooltip containment/placement state (Poster Map Tooltip Containment
        // PRD) - see showMarkerTooltip()/_placeTooltip() below.
        this._tooltipMarkerEl = null;
        this._tooltipEasel = null;
        this._tooltipRafId = null;
        this._tooltipTrackingActive = false;
        this.handleGlobalKeydown = (event) => {
            if (event.key !== 'Escape') {
                return;
            }

            if (this.infoPanel && this.infoPanel.classList.contains('active')) {
                event.preventDefault();
                this.hideInfo();
                return;
            }

            if (this.isFullScreen) {
                event.preventDefault();
                this.toggleFullScreen(false);
            }
        };
        
        this.currentZoom = 1;
        this.minZoom = 1;
        this.maxZoom = 8;
        this.panX = 0;
        this.panY = 0;
        this.defaultZoom = null;
        this.defaultPanX = 0;
        this.defaultPanY = 0;
        this.defaultCenterX = null;
        this.defaultCenterY = null;
        // Screen-space px/ms (raw finger movement, not content-space) -
        // set at release by endPan(), decayed by startPanInertia(). See
        // the touch-input PRD's momentum model.
        this.panVelocityX = 0;
        this.panVelocityY = 0;
        this.panInertiaFrame = null;
        // CSS-px-to-SVG-user-units conversion for the SVG's current
        // rendered size (see measureRenderScaleFactor() in
        // initializeEventListeners) - an instance field, not a closure
        // variable, so startPanInertia() (a class method running after the
        // gesture that measured it has ended) can still use the same
        // value the drag itself used.
        this.renderScaleFactor = 1;
        this.selectedArea = null;
        this.panAnimationFrame = null;
        this.panAnimationComplete = null;
        this.zoomAnimationFrame = null;
        this.zoomAnimationComplete = null;

        this.isMultiTouchGesture = false;
        this.infoAutoHideTimer = null;
        this.lastClosedAreaId = null;
        this.lastClosedTime = 0;
        this.lastClosedInteractionType = null;

        this.baseWidth = 1078;
        this.baseHeight = 1558;

        // Screen-pixel margins (bottom-sheet, safe areas) that the camera
        // should treat as "not usable" - fitting/centering leaves this much
        // room clear on each edge instead of using the full container.
        // Zero on desktop and until the mobile bottom sheet sets it.
        this.viewportInsets = { top: 0, right: 0, bottom: 0, left: 0 };

        this.initializeData();
        this.initializeEventListeners();
        this.updateFullScreenUI();
        this.renderMap();
    }

    initializeData() {
        // Data structure for poster areas - easily extensible and can be loaded from JSON
        // Currently empty - geometry will be added later
        this.posterAreas = [];

        // Points of interest markers
        // Currently empty - markers will be added later
        this.markers = [];
    }

    initializeEventListeners() {
        // Zoom controls
        document.getElementById('zoomIn').addEventListener('click', () => this.zoomIn());
        document.getElementById('zoomOut').addEventListener('click', () => this.zoomOut());
        document.getElementById('resetView').addEventListener('click', () => this.resetView());

        if (this.fullscreenBtn) {
            this.fullscreenBtn.addEventListener('click', () => this.toggleFullScreen());
        }

        document.addEventListener('keydown', this.handleGlobalKeydown);

        const handleGlobalTouchStart = (event) => {
            if (!event || !event.touches) {
                return;
            }

            if (event.touches.length > 1) {
                return;
            }

            const touchTarget = event.target;
            if (!touchTarget) {
                return;
            }

            const touchedMarker = touchTarget.closest('[data-side]') ||
                                  touchTarget.closest('.color-marker');
            if (touchedMarker) {
                return;
            }

            const touchedPosterArea = touchTarget.closest('.poster-area') ||
                                      touchTarget.closest('[data-area-id]');
            if (touchedPosterArea) {
                return;
            }

            const touchedInfoPanel = touchTarget.closest('.info-panel');
            if (touchedInfoPanel) {
                return;
            }

            this.hideInfo();
        };

        document.addEventListener('touchstart', handleGlobalTouchStart, { passive: true });

        // Pan functionality (touch and mouse)
        //
        // Touch input model per the "Map Touchscreen Input Behavior" PRD,
        // Tight preset (recommended there for small/dense maps like this
        // floor plan): 1:1 tracking while touching, slop-gated gesture
        // commitment, momentum with an explicit fling threshold/cap/decay
        // distinct from each other, and hard pan bounds. See the plan
        // history for the full parameter table; every number below traces
        // to that preset.
        let isPanning = false;
        let startX, startY, initialPanX, initialPanY;
        let pinchActive = false;
        let pinchStartDistance = 0;
        let pinchStartZoom = this.currentZoom;
        let pinchStartMidpoint = { x: 0, y: 0 };
        let pinchZoomEngaged = false;
        let pinchStartTime = 0;
        let pinchTouchStarts = null; // { a: {x,y}, b: {x,y} } for the two-finger-tap check
        let lastTouchEndTime = 0;
        let lastTouchEndX = 0;
        let lastTouchEndY = 0;
        let panStartTime = 0;
        let tapCancelledInertia = false;

        // Gesture state machine: a touch is Idle until finger-down starts
        // it Pending; Pending commits to Panning only once TOUCH_SLOP is
        // crossed (and starts from the CURRENT finger position, not the
        // touchstart position - no jump). A touch that never crosses slop
        // and lifts within tap timing is a tap candidate (see maptap below
        // and the double-tap handling in handleTouchEnd).
        let gestureState = 'idle'; // 'idle' | 'pending' | 'panning'
        let pendingStartX = 0, pendingStartY = 0, pendingStartTime = 0;
        let wheelPinchEndTimer = null;

        const TOUCH_SLOP = 12; // px - Tight preset
        const PINCH_SLOP_FRACTION = 0.06; // Tight preset "4%" row, tuned to 6% for Tight
        const PINCH_SLOP_MIN_PX = 10;
        const FLING_THRESHOLD = 0.5; // px/ms (500 px/s) - Tight preset
        const VELOCITY_CAP = 2.5; // px/ms (2500 px/s) - Tight preset
        // MOMENTUM_TAU_MS/MOMENTUM_STOP_VELOCITY live in startPanInertia()
        // (a class method, the only place that needs them).
        const VELOCITY_SAMPLE_WINDOW_MS = 100;
        // ZOOM_RUBBER_BAND_FRACTION/RESISTANCE are module-level (shared
        // with the applyZoomRubberBand() class method) - see top of file.
        const TWO_FINGER_TAP_MAX_DURATION_MS = 250;
        const TWO_FINGER_TAP_MAX_DISTANCE = 10;
        // maptap (this app's own tap-the-map-to-collapse-the-sheet
        // feature, layered on top of the PRD's gesture set) uses TOUCH_SLOP
        // itself as its distance threshold, rather than a separate
        // constant - "was this a tap" already means "never (meaningfully)
        // crossed slop," so there's no reason for a second number to keep
        // in sync with it.
        const MAPTAP_MAX_DURATION_MS = 300;
        const doubleTapThresholdMs = 300; // PRD: 300ms window, constant across presets
        const doubleTapMaxDistance = 40;
        const DOUBLE_TAP_ZOOM_DURATION_MS = 200; // Tight preset

        const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        // Screen-space (raw clientX/clientY) sample ring buffer, trimmed to
        // the last VELOCITY_SAMPLE_WINDOW_MS - the same "weighted average
        // of recent samples" approach already used for the bottom sheet's
        // own drag velocity (assets/js/bottom-sheet.js), not the old
        // continuously-applied EMA this replaced (which tracked
        // content-space pan units, not screen px, and had no fling-vs-stop
        // distinction).
        let velocitySamples = [];

        const recordVelocitySample = (clientX, clientY) => {
            const now = performance.now();
            velocitySamples.push({ x: clientX, y: clientY, t: now });
            const cutoff = now - VELOCITY_SAMPLE_WINDOW_MS;
            while (velocitySamples.length > 1 && velocitySamples[0].t < cutoff) {
                velocitySamples.shift();
            }
        };

        const computeReleaseVelocity = () => {
            if (velocitySamples.length < 2) return { vx: 0, vy: 0 };
            const first = velocitySamples[0];
            const last = velocitySamples[velocitySamples.length - 1];
            const dt = last.t - first.t;
            if (dt <= 0) return { vx: 0, vy: 0 };
            return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt };
        };

        // The viewBox is baseWidth/currentZoom content-units wide, but the
        // SVG usually renders much narrower than baseWidth (1078) in CSS
        // pixels - especially in the mobile map panel. Without correcting
        // for that ratio, a screen-pixel of drag only pans a fraction of a
        // screen-pixel's worth of content, which reads as "sluggish"/stiff
        // panning that gets worse the smaller the map is drawn. Measured
        // once per gesture (not per move-event) to avoid forcing layout on
        // every pointermove. This - together with dividing by currentZoom
        // at each call site - is what actually achieves exact 1:1
        // finger-to-content tracking; it is a unit conversion, not a speed
        // choice, and getPanSpeedMultiplier() below must stay at 1 for that
        // to hold (the PRD's central rule: raising pan speed above 1:1
        // breaks direct manipulation - don't "fix" perceived stiffness by
        // reintroducing a multiplier here).
        const measureRenderScaleFactor = () => {
            const rect = this.svg.getBoundingClientRect();
            this.renderScaleFactor = rect.width > 0 ? this.baseWidth / rect.width : 1;
        };

        const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

        const isInteractiveTarget = (target) => Boolean(
            target?.closest?.('[data-side]') ||
            target?.closest?.('.color-marker') ||
            target?.closest?.('[data-point-id]') ||
            target?.closest?.('#tablePanel') ||
            target?.closest?.('#sheetDimOverlay')
        );

        const getTouchDistance = (touchA, touchB) => {
            const dx = touchA.clientX - touchB.clientX;
            const dy = touchA.clientY - touchB.clientY;
            return Math.hypot(dx, dy);
        };

        const getTouchMidpoint = (touchA, touchB) => ({
            x: (touchA.clientX + touchB.clientX) / 2,
            y: (touchA.clientY + touchB.clientY) / 2
        });

        // targetZoom already includes rubber-band resistance past the
        // limits where applicable (see handlePinchMove/wheel) - this just
        // applies it, anchored, same as before.
        const updatePanForPinch = (targetZoom, centerClientX, centerClientY) => {
            const anchored = this.computeAnchoredPan(targetZoom, centerClientX, centerClientY);
            this.currentZoom = targetZoom;
            if (anchored) {
                this.panX = anchored.panX;
                this.panY = anchored.panY;
            }
            this.updateViewBox();
        };

        // Converts a screen-space delta (from some origin point/pan) into
        // the resulting content-space pan, using the same 1:1 conversion as
        // single-finger panning (renderScaleFactor / currentZoom /
        // getPanSpeedMultiplier - the last of which must stay 1, see its
        // definition). Shared by single-finger pan and pinch's
        // pan-before-zoom-engages phase (PRD: two fingers always pan via
        // their midpoint, even below pinch slop).
        const panDeltaFromScreen = (dxScreen, dyScreen) => {
            const appliedMultiplier = this.getPanSpeedMultiplier() * this.renderScaleFactor;
            return {
                dx: (dxScreen / this.currentZoom) * appliedMultiplier,
                dy: (dyScreen / this.currentZoom) * appliedMultiplier
            };
        };

        const startPinch = (touches) => {
            if (!touches || touches.length < 2) {
                return;
            }

            this.stopPanInertia(true);
            this.stopPanAnimation();
            isPanning = false;
            gestureState = 'idle';
            pinchActive = true;
            pinchZoomEngaged = false;
            pinchStartDistance = getTouchDistance(touches[0], touches[1]) || 0.0001;
            pinchStartZoom = this.currentZoom;
            pinchStartMidpoint = getTouchMidpoint(touches[0], touches[1]);
            // Below-slop pan (see handlePinchMove) pans from these, the
            // same way beginPan() does for single-finger pan - re-based
            // fresh each time a pinch starts (including finger-add/remove
            // mid-gesture, since startPinch is also called from
            // touchMoveHandler's "count jumped to >=2" branch), so no jump.
            initialPanX = this.panX;
            initialPanY = this.panY;
            pinchStartTime = performance.now();
            pinchTouchStarts = {
                a: { x: touches[0].clientX, y: touches[0].clientY },
                b: { x: touches[1].clientX, y: touches[1].clientY }
            };
            measureRenderScaleFactor();
            this.isMultiTouchGesture = true;
        };

        const resetPinchState = () => {
            pinchActive = false;
            pinchZoomEngaged = false;
            pinchStartDistance = 0;
            pinchStartZoom = this.currentZoom;
            pinchTouchStarts = null;
            this.isMultiTouchGesture = false;
        };

        const handlePinchMove = (touches) => {
            if (!pinchActive || !touches || touches.length < 2 || pinchStartDistance === 0) {
                return;
            }

            const distance = getTouchDistance(touches[0], touches[1]);
            if (!distance) {
                return;
            }

            const midpoint = getTouchMidpoint(touches[0], touches[1]);
            const slopPx = Math.max(pinchStartDistance * PINCH_SLOP_FRACTION, PINCH_SLOP_MIN_PX);

            if (!pinchZoomEngaged && Math.abs(distance - pinchStartDistance) >= slopPx) {
                pinchZoomEngaged = true;
            }

            if (!pinchZoomEngaged) {
                // Below pinch slop: two fingers pan (via their midpoint,
                // 1:1) but never zoom - stops an unsteady two-finger pan
                // from drifting in scale. Same pan-bounds clamp as
                // single-finger drag, so two fingers can't bypass it.
                const { dx, dy } = panDeltaFromScreen(
                    midpoint.x - pinchStartMidpoint.x,
                    midpoint.y - pinchStartMidpoint.y
                );
                const clamped = this.clampPanToBounds(initialPanX + dx, initialPanY + dy);
                this.panX = clamped.panX;
                this.panY = clamped.panY;
                this.updateViewBox();
                return;
            }

            const scale = distance / pinchStartDistance;
            const rawZoom = pinchStartZoom * scale;
            const targetZoom = this.applyZoomRubberBand(rawZoom);
            updatePanForPinch(targetZoom, midpoint.x, midpoint.y);
        };

        const beginPan = (clientX, clientY, inputType = 'mouse') => {
            isPanning = true;
            gestureState = 'panning';
            measureRenderScaleFactor();
            startX = clientX;
            startY = clientY;
            initialPanX = this.panX;
            initialPanY = this.panY;
            panStartTime = performance.now();
            // A touch that grabs a running inertia glide to stop it is a
            // deliberate "stop the map" gesture, not a tap - maptap (below)
            // checks this so bottom-sheet.js doesn't collapse the sheet
            // when someone was just stopping a flick.
            tapCancelledInertia = Boolean(this.panInertiaFrame);
            this.stopPanInertia(true);
            this.stopPanAnimation();
            velocitySamples = [];
            recordVelocitySample(clientX, clientY);
            this.svg.style.cursor = 'grabbing';
        };

        const updatePan = (clientX, clientY) => {
            const { dx, dy } = panDeltaFromScreen(clientX - startX, clientY - startY);
            const clamped = this.clampPanToBounds(initialPanX + dx, initialPanY + dy);
            this.panX = clamped.panX;
            this.panY = clamped.panY;
            this.updateViewBox();
            recordVelocitySample(clientX, clientY);
        };

        const endPan = (options = {}) => {
            if (!isPanning) {
                gestureState = 'idle';
                return;
            }
            isPanning = false;
            gestureState = 'idle';
            this.svg.style.cursor = 'grab';
            if (!options.skipInertia && !prefersReducedMotion()) {
                const { vx, vy } = computeReleaseVelocity();
                const speed = Math.hypot(vx, vy);
                if (speed >= FLING_THRESHOLD) {
                    const capScale = speed > VELOCITY_CAP ? VELOCITY_CAP / speed : 1;
                    this.startPanInertia(vx * capScale, vy * capScale);
                }
            }
        };

        this.svg.style.cursor = 'grab';

        this.svg.addEventListener('mousedown', (e) => {
            const isInteractiveElement = e.target.closest('[data-side]') ||
                                       e.target.closest('.color-marker') ||
                                       e.target.closest('[data-point-id]') ||
                                       e.target.classList.contains('color-marker') ||
                                       e.target.closest('#tablePanel') ||
                                       e.target.closest('#sheetDimOverlay');
            if (!isInteractiveElement) {
                e.preventDefault();
                gestureState = 'pending';
                pendingStartX = e.clientX;
                pendingStartY = e.clientY;
            }
        });

        document.addEventListener('mousemove', (e) => {
            if (gestureState === 'pending') {
                const dist = Math.hypot(e.clientX - pendingStartX, e.clientY - pendingStartY);
                if (dist < TOUCH_SLOP) {
                    return;
                }
                beginPan(e.clientX, e.clientY, 'mouse');
                return;
            }
            if (!isPanning) {
                return;
            }
            updatePan(e.clientX, e.clientY);
        });

        document.addEventListener('mouseup', () => {
            gestureState = 'idle';
            endPan();
        });

        // Double-click to zoom in, anchored at the click point.
        this.svg.addEventListener('dblclick', (e) => {
            if (isInteractiveTarget(e.target)) {
                return;
            }
            e.preventDefault();
            this.animateZoomTo(this.currentZoom * 2, e.clientX, e.clientY, { duration: DOUBLE_TAP_ZOOM_DURATION_MS, curve: EASE_FLYTO });
        });

        // Global click handler to close info panel when clicking empty map space
        this.svg.addEventListener('click', (e) => {
            const clickedMarker = e.target.closest('[data-side]') || e.target.closest('.color-marker');
            if (!clickedMarker) {
                this.hideInfo();
            }
        });

        // Touch support
        const touchStartHandler = (e) => {
            const touches = e.touches;
            const touchCount = touches ? touches.length : 0;

            if (touchCount >= 2) {
                e.preventDefault();
                this.isMultiTouchGesture = true;
                startPinch(touches);
                this.svg.style.cursor = 'grab';
                return;
            }

            if (touchCount !== 1) {
                return;
            }

            const touch = touches[0];
            const touchTarget = document.elementFromPoint(touch.clientX, touch.clientY);

            if (touchTarget && (touchTarget.closest('#tablePanel') || touchTarget.closest('#sheetDimOverlay'))) {
                this.stopPanInertia(true);
                isPanning = false;
                gestureState = 'idle';
                return;
            }

            const isInteractiveElement = touchTarget?.closest('[data-side]') ||
                                       touchTarget?.closest('.color-marker') ||
                                       touchTarget?.closest('[data-point-id]') ||
                                       touchTarget?.classList.contains('color-marker');
            if (!isInteractiveElement) {
                e.preventDefault();
                resetPinchState();
                // Pending, not panning yet - PRD touch slop. beginPan()
                // only fires once touchMoveHandler sees TOUCH_SLOP crossed,
                // starting from the finger's position AT THAT POINT (no
                // jump), not from here.
                gestureState = 'pending';
                pendingStartX = touch.clientX;
                pendingStartY = touch.clientY;
                pendingStartTime = performance.now();
            }
        };

        try {
            this.svg.addEventListener('touchstart', touchStartHandler, { passive: false });
        } catch (err) {
            this.svg.addEventListener('touchstart', touchStartHandler);
        }

        const touchMoveHandler = (e) => {
            const touches = e.touches;
            const touchCount = touches ? touches.length : 0;

            if (touchCount >= 2) {
                if (!pinchActive) {
                    startPinch(touches);
                }
                this.isMultiTouchGesture = true;
                e.preventDefault();
                handlePinchMove(touches);
                return;
            }

            if (pinchActive && touchCount < 2) {
                resetPinchState();
            }

            if (touchCount !== 1) {
                if (isPanning) {
                    this.stopPanInertia(true);
                    this.stopPanAnimation();
                    endPan({ skipInertia: true });
                }
                gestureState = 'idle';
                return;
            }

            const touch = touches[0];
            const moveTarget = document.elementFromPoint(touch.clientX, touch.clientY);
            if (moveTarget && (moveTarget.closest('#tablePanel') || moveTarget.closest('#sheetDimOverlay'))) {
                if (isPanning) {
                    this.stopPanInertia(true);
                    this.stopPanAnimation();
                    endPan({ skipInertia: true });
                }
                gestureState = 'idle';
                return;
            }

            if (gestureState === 'pending') {
                const dist = Math.hypot(touch.clientX - pendingStartX, touch.clientY - pendingStartY);
                if (dist < TOUCH_SLOP) {
                    return;
                }
                e.preventDefault();
                // Commit to panning from the CURRENT finger position, not
                // pendingStartX/Y - PRD "no jump at pan start": the
                // accumulated slop distance is discarded, not applied in
                // one frame.
                beginPan(touch.clientX, touch.clientY, 'touch');
                return;
            }

            if (!isPanning) {
                return;
            }

            e.preventDefault();
            updatePan(touch.clientX, touch.clientY);
        };

        try {
            document.addEventListener('touchmove', touchMoveHandler, { passive: false });
        } catch (err) {
            document.addEventListener('touchmove', touchMoveHandler);
        }

        const handleTouchEnd = (e) => {
            const touches = e.touches;
            const touchCount = touches ? touches.length : 0;
            const now = Date.now();
            const changedTouchCount = e.changedTouches ? e.changedTouches.length : 0;
            const endedAllTouches = touchCount === 0;
            const isSingleFingerRelease = !pinchActive && endedAllTouches && changedTouchCount === 1;

            if (isSingleFingerRelease) {
                const changedTouch = e.changedTouches && e.changedTouches[0];
                const tapX = changedTouch ? changedTouch.clientX : null;
                const tapY = changedTouch ? changedTouch.clientY : null;

                // maptap: a genuine tap on open map space - not a marker,
                // not a drag, not a touch that grabbed a running inertia
                // glide to stop it. bottom-sheet.js listens for this to
                // collapse the sheet from Half/Full (tap-the-map-to-dismiss,
                // matching Google/Apple Maps). gestureState is 'pending' for
                // the common case (a tap that never crossed slop, so
                // beginPan() never ran) or 'panning' for one that crossed
                // slop just barely before lifting; a touch that started on
                // #tablePanel/#sheetDimOverlay/a marker never left 'idle'.
                if (gestureState !== 'idle' && tapX !== null) {
                    const originX = gestureState === 'panning' ? startX : pendingStartX;
                    const originY = gestureState === 'panning' ? startY : pendingStartY;
                    const originTime = gestureState === 'panning' ? panStartTime : pendingStartTime;
                    const tapDuration = performance.now() - originTime;
                    const tapDistance = Math.hypot(tapX - originX, tapY - originY);
                    const isMarkerTarget = e.target && (
                        e.target.closest?.('[data-side]') ||
                        e.target.closest?.('.color-marker') ||
                        e.target.closest?.('[data-point-id]')
                    );
                    if (!isMarkerTarget && !tapCancelledInertia &&
                        tapDistance <= TOUCH_SLOP && tapDuration <= MAPTAP_MAX_DURATION_MS) {
                        this.svg.dispatchEvent(new CustomEvent('maptap', { bubbles: true }));
                    }
                }
                gestureState = 'idle';

                const withinTime = now - lastTouchEndTime <= doubleTapThresholdMs;
                const withinDistance = tapX !== null &&
                    Math.hypot(tapX - lastTouchEndX, tapY - lastTouchEndY) <= doubleTapMaxDistance;

                if (withinTime) {
                    // Also blocks the browser's own native double-tap-zoom.
                    e.preventDefault();
                }

                if (withinTime && withinDistance && tapX !== null && !isInteractiveTarget(e.target)) {
                    this.animateZoomTo(this.currentZoom * 2, tapX, tapY, { duration: DOUBLE_TAP_ZOOM_DURATION_MS, curve: EASE_FLYTO });
                    // Reset so a third quick tap starts a fresh pair rather
                    // than immediately chaining into another zoom.
                    lastTouchEndTime = 0;
                    lastTouchEndX = 0;
                    lastTouchEndY = 0;
                } else {
                    lastTouchEndTime = now;
                    lastTouchEndX = tapX ?? 0;
                    lastTouchEndY = tapY ?? 0;
                }
            } else if (endedAllTouches) {
                lastTouchEndTime = now;
            }

            // Two-finger tap: both fingers down/up within
            // TWO_FINGER_TAP_MAX_DURATION_MS, each moving less than
            // TWO_FINGER_TAP_MAX_DISTANCE, and the pinch never crossed its
            // own zoom-engage slop (so it wasn't an intentional pinch or a
            // two-finger pan) - zoom out one step, anchored at the
            // midpoint. Checked before resetPinchState() clears the
            // gesture's start data below.
            if (pinchActive && touchCount === 0 && changedTouchCount === 2 && pinchTouchStarts) {
                const gestureDuration = performance.now() - pinchStartTime;
                if (!pinchZoomEngaged && gestureDuration <= TWO_FINGER_TAP_MAX_DURATION_MS) {
                    const endedA = e.changedTouches[0];
                    const endedB = e.changedTouches[1];
                    const distAtoStartA = Math.hypot(endedA.clientX - pinchTouchStarts.a.x, endedA.clientY - pinchTouchStarts.a.y);
                    const distAtoStartB = Math.hypot(endedA.clientX - pinchTouchStarts.b.x, endedA.clientY - pinchTouchStarts.b.y);
                    const firstMatchesA = distAtoStartA <= distAtoStartB;
                    const dA = firstMatchesA ? distAtoStartA : distAtoStartB;
                    const dB = firstMatchesA
                        ? Math.hypot(endedB.clientX - pinchTouchStarts.b.x, endedB.clientY - pinchTouchStarts.b.y)
                        : Math.hypot(endedB.clientX - pinchTouchStarts.a.x, endedB.clientY - pinchTouchStarts.a.y);
                    if (dA <= TWO_FINGER_TAP_MAX_DISTANCE && dB <= TWO_FINGER_TAP_MAX_DISTANCE) {
                        const midpointX = (endedA.clientX + endedB.clientX) / 2;
                        const midpointY = (endedA.clientY + endedB.clientY) / 2;
                        const targetZoom = Math.max(this.minZoom, this.currentZoom / 2);
                        this.animateZoomTo(targetZoom, midpointX, midpointY, { duration: DOUBLE_TAP_ZOOM_DURATION_MS, curve: EASE_DISCRETE });
                    }
                }
            }

            if (pinchActive && touchCount < 2) {
                // Pinch ending (or dropping to one finger): if the live
                // zoom rubber-banded past a limit, spring back to it now
                // rather than leaving it overscaled.
                if (this.currentZoom < this.minZoom || this.currentZoom > this.maxZoom) {
                    const springTarget = clamp(this.currentZoom, this.minZoom, this.maxZoom);
                    const anchorTouch = (e.changedTouches && e.changedTouches[0]) || null;
                    const anchorX = anchorTouch ? anchorTouch.clientX : pinchStartMidpoint.x;
                    const anchorY = anchorTouch ? anchorTouch.clientY : pinchStartMidpoint.y;
                    this.animateZoomTo(springTarget, anchorX, anchorY, { duration: 200, curve: EASE_DISCRETE });
                }
                resetPinchState();
                if (touchCount === 1) {
                    const remainingTouch = touches[0];
                    const remainingTarget = document.elementFromPoint(remainingTouch.clientX, remainingTouch.clientY);
                    if (remainingTarget && (remainingTarget.closest('#tablePanel') || remainingTarget.closest('#sheetDimOverlay'))) {
                        this.stopPanInertia(true);
                        isPanning = false;
                        gestureState = 'idle';
                        return;
                    }

                    const isInteractiveElement = remainingTarget?.closest('[data-side]') ||
                                                remainingTarget?.closest('.color-marker') ||
                                                remainingTarget?.closest('[data-point-id]') ||
                                                remainingTarget?.classList?.contains('color-marker');

                    if (!isInteractiveElement) {
                        beginPan(remainingTouch.clientX, remainingTouch.clientY, 'touch');
                    }
                }
            }

            if (endedAllTouches) {
                this.isMultiTouchGesture = false;
                endPan();
            }
        };

        try {
            document.addEventListener('touchend', handleTouchEnd, { passive: false });
        } catch (err) {
            document.addEventListener('touchend', handleTouchEnd);
        }

        try {
            document.addEventListener('touchcancel', handleTouchEnd, { passive: false });
        } catch (err) {
            document.addEventListener('touchcancel', handleTouchEnd);
        }

        const preventGestureZoom = (event) => {
            event.preventDefault();
        };

        ['gesturestart', 'gesturechange', 'gestureend'].forEach((eventName) => {
            try {
                document.addEventListener(eventName, preventGestureZoom, { passive: false });
            } catch (err) {
                document.addEventListener(eventName, preventGestureZoom);
            }
        });


        // Mouse wheel / trackpad zoom, anchored at the cursor
        this.svg.addEventListener('wheel', (e) => {
            e.preventDefault();

            const modeMultiplier = e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? 60 : 1;
            const normalizedDelta = e.deltaY * modeMultiplier;
            if (!normalizedDelta) {
                return;
            }

            if (e.ctrlKey) {
                // Trackpad pinch-to-zoom (the ctrl+wheel convention browsers
                // use for this gesture): live, unanimated, cursor-anchored.
                // Intensity scales with gesture size and current zoom level -
                // a flat multiplier felt too twitchy zoomed-in and too
                // sluggish zoomed-out.
                this.stopPanInertia(true);
                this.stopPanAnimation();
                this.stopZoomAnimation();

                const PINCH_BASE_INTENSITY = 0.0035;
                const absDelta = Math.min(240, Math.abs(normalizedDelta));
                const deltaFactor = 1 + (absDelta / 120); // 1 → 3 range based on gesture size
                const zoomRange = Math.max(this.maxZoom - this.minZoom, 0.0001);
                const zoomNormalized = (this.currentZoom - this.minZoom) / zoomRange;
                const zoomFactor = 0.9 + zoomNormalized * 1.2; // 0.9 → 2.1 range based on current zoom
                const intensity = PINCH_BASE_INTENSITY * deltaFactor * zoomFactor;

                const rawTargetZoom = this.currentZoom * Math.exp(-normalizedDelta * intensity);
                const targetZoom = this.applyZoomRubberBand(rawTargetZoom);
                const anchored = this.computeAnchoredPan(targetZoom, e.clientX, e.clientY);

                this.currentZoom = targetZoom;
                if (anchored) {
                    this.panX = anchored.panX;
                    this.panY = anchored.panY;
                }
                this.updateViewBox();

                // Spring back to the true limit once the trackpad gesture
                // pauses (no further ctrl+wheel events for a short window) -
                // wheel has no discrete "gesture end" to hook, unlike
                // pinch's touchend, so this substitutes a short debounce.
                const clientX = e.clientX;
                const clientY = e.clientY;
                clearTimeout(wheelPinchEndTimer);
                wheelPinchEndTimer = setTimeout(() => {
                    if (this.currentZoom < this.minZoom || this.currentZoom > this.maxZoom) {
                        const springTarget = clamp(this.currentZoom, this.minZoom, this.maxZoom);
                        this.animateZoomTo(springTarget, clientX, clientY, { duration: 200, curve: EASE_DISCRETE });
                    }
                }, 150);
                return;
            }

            // Discrete mouse notch vs. continuous trackpad two-finger scroll:
            // a physical wheel's "click" typically reports deltaMode !== 0
            // (line/page units) or a large deltaY even in pixel mode; a
            // trackpad reports small continuous pixel deltas. This
            // distinction is known to be unreliable across browsers/OSes -
            // it's the standard heuristic; refine if real-hardware testing
            // surfaces mismatches.
            const isDiscreteNotch = e.deltaMode !== 0 || Math.abs(normalizedDelta) >= 40;
            const stepMultiplier = isDiscreteNotch ? 1.5 : Math.exp(Math.abs(normalizedDelta) * 0.02);
            const zoomFactor = normalizedDelta > 0 ? 1 / stepMultiplier : stepMultiplier;
            const targetZoom = this.currentZoom * zoomFactor;

            // Each call cancels any in-flight zoom animation and restarts
            // from the live current state (see runZoomAnimation), so rapid
            // repeated notches retarget smoothly instead of queuing/snapping.
            this.animateZoomTo(targetZoom, e.clientX, e.clientY, { duration: 200, curve: EASE_WHEEL_STEP });
        }, { passive: false });

        // Keyboard navigation
        document.addEventListener('keydown', (e) => {
            if (e.target.classList.contains('poster-area')) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.selectArea(e.target.dataset.areaId, { interactionType: 'keyboard' });
                }
            }
        });
    }

    getPanSpeedMultiplier() {
        // Must stay 1. Dividing the raw screen-pixel delta by currentZoom
        // (at the call sites) plus renderScaleFactor (correcting for the
        // SVG's rendered CSS size vs. its viewBox) already together produce
        // exact 1:1 finger-to-content tracking at every zoom level -
        // verified algebraically against getViewBox()'s formula. Per the
        // "Map Touchscreen Input Behavior" PRD, pan speed is never raised
        // above 1:1 ("breaks direct manipulation"); a previous version of
        // this method returned 1.15 as a "looseness" knob layered on top,
        // which was pure overshoot, not unit correction - the actual fix
        // for that era's "sluggish" complaint was renderScaleFactor itself.
        // If panning ever feels off again, the fix is touch slop/momentum
        // tuning (see initializeEventListeners), not this number.
        return 1;
    }

    renderMap() {
        this.renderPosterAreas();
        this.renderMarkers();
    }

    renderPosterAreas() {
        this.posterAreasGroup.innerHTML = '';

        this.posterAreas.forEach(area => {
            const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            
            let shape;
            if (area.path) {
                // Custom path/polygon
                shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                shape.setAttribute('d', area.path);
            } else {
                // Rectangle
                shape = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                shape.setAttribute('x', area.x);
                shape.setAttribute('y', area.y);
                shape.setAttribute('width', area.width);
                shape.setAttribute('height', area.height);
                shape.setAttribute('rx', '5');
            }

            shape.classList.add('poster-area');
            shape.setAttribute('data-area-id', area.id);
            shape.setAttribute('tabindex', '0');
            shape.setAttribute('role', 'button');
            shape.setAttribute('aria-label', `${area.name} - ${area.description}`);

            // Calculate label position
            let labelX, labelY;
            if (area.path) {
                // For custom paths, use area x,y as approximation
                labelX = area.x + (area.width || 75);
                labelY = area.y + (area.height || 50);
            } else {
                labelX = area.x + area.width / 2;
                labelY = area.y + area.height / 2;
            }

            const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            label.setAttribute('x', labelX);
            label.setAttribute('y', labelY);
            label.classList.add('area-label');
            label.textContent = area.name;

            // Event listeners
            shape.addEventListener('click', () => this.selectArea(area.id, { interactionType: 'mouse' }));
            shape.addEventListener('touchend', (e) => {
                e.preventDefault();
                this.selectArea(area.id, { interactionType: 'touch' });
            });

            group.appendChild(shape);
            group.appendChild(label);
            this.posterAreasGroup.appendChild(group);
        });
    }

    renderMarkers() {
        // Markers disabled - no clickable markers will be rendered
        this.markersGroup.innerHTML = '';
    }

    selectArea(areaId, options = {}) {
        const { interactionType = 'mouse' } = options;
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

        if (this.lastClosedAreaId === areaId) {
            if (this.lastClosedInteractionType === 'touch' && (now - this.lastClosedTime) < 350) {
                return;
            }
            this.lastClosedAreaId = null;
            this.lastClosedInteractionType = null;
        }

        if (this.selectedArea && this.selectedArea.id === areaId && this.infoPanel?.classList.contains('active')) {
            this.hideInfo();
            this.lastClosedAreaId = areaId;
            this.lastClosedTime = now;
            this.lastClosedInteractionType = interactionType;
            return;
        }
        // Clear previous selection
        document.querySelectorAll('.poster-area').forEach(area => {
            area.classList.remove('selected');
        });

        const area = this.posterAreas.find(a => a.id === areaId);
        if (area) {
            // Mark as selected
            const areaElement = document.querySelector(`[data-area-id="${areaId}"]`);
            areaElement.classList.add('selected');
            areaElement.focus();

            this.selectedArea = area;
            this.showAreaInfo(area, interactionType);
        }
    }

    showAreaInfo(area, interactionType = 'mouse') {
        if (this.infoAutoHideTimer) {
            clearTimeout(this.infoAutoHideTimer);
            this.infoAutoHideTimer = null;
        }

        this.infoTitle.textContent = area.name;
        this.infoDescription.innerHTML = `
            <p><strong>Focus:</strong> ${area.description}</p>
            <p><strong>Time:</strong> ${area.time}</p>
            <p><strong>Presenters:</strong> ${area.presenters.join(', ')}</p>
        `;
        this.infoPanel.classList.add('active');

        // Auto-hide after 10 seconds except for touch interactions
        if (interactionType !== 'touch') {
            this.infoAutoHideTimer = setTimeout(() => {
                if (this.infoPanel.classList.contains('active')) {
                    this.hideInfo();
                }
            }, 10000);
        }
    }

    // Marker info functionality disabled
    showMarkerInfo(markerId) {
        // No marker info will be shown
        return;
    }

    hideInfo() {
        if (this.infoAutoHideTimer) {
            clearTimeout(this.infoAutoHideTimer);
            this.infoAutoHideTimer = null;
        }
        if (window.posterInfoTimer) {
            clearTimeout(window.posterInfoTimer);
            window.posterInfoTimer = null;
        }
        this.infoPanel.classList.remove('active');
        this._stopTooltipTracking();
        this._tooltipMarkerEl = null;
        this._tooltipEasel = null;
        this.infoPanel.classList.remove('tt-step1', 'tt-step2', 'tt-step3', 'tt-scroll');
        if (this.selectedArea) {
            document.querySelectorAll('.poster-area').forEach(area => {
                area.classList.remove('selected');
            });
            this.selectedArea = null;
        }
    }

    /**
     * Poster Map Tooltip Containment PRD: the tooltip's "safe area" is the
     * map's own visible rect, clipped on the bottom by the live top edge of
     * the mobile bottom sheet (desktop's #tablePanel is a flex sibling that
     * never overlaps the map vertically, so it never clips there). Both
     * rects are read live via getBoundingClientRect() - the sheet's
     * transform is written synchronously every rAF frame during a drag
     * (bottom-sheet.js), so this reflects the sheet's true position even
     * mid-gesture, with no extra event wiring needed. A 12px margin is
     * applied inward on every edge; left/right also respect
     * env(safe-area-inset-left/right) via two tiny :root custom properties
     * that exist purely so JS can read the resolved env() pixel value.
     */
    getTooltipSafeAreaRect() {
        const MARGIN = 12;
        const container = this.mapContainer || this.svg;
        const mapRect = container.getBoundingClientRect();

        let bottom = mapRect.bottom;
        if (window.matchMedia('(max-width: 768px)').matches && this.tablePanel) {
            const sheetTop = this.tablePanel.getBoundingClientRect().top;
            if (sheetTop < bottom) {
                bottom = sheetTop;
            }
        }

        const rootStyle = getComputedStyle(document.documentElement);
        const insetLeft = parseFloat(rootStyle.getPropertyValue('--safe-l')) || 0;
        const insetRight = parseFloat(rootStyle.getPropertyValue('--safe-r')) || 0;

        return {
            top: mapRect.top + MARGIN,
            bottom: bottom - MARGIN,
            left: mapRect.left + Math.max(MARGIN, insetLeft),
            right: mapRect.right - Math.max(MARGIN, insetRight)
        };
    }

    /**
     * The "Fit all" FAB is an exclusion zone the tooltip may never cover
     * (Poster Map Tooltip Containment PRD). Returns its rect only while
     * it's actually visible (hidden past Half sheet height via
     * fit-all-hidden, see bottom-sheet.js), else null.
     */
    getTooltipExclusionRect() {
        if (!this.resetViewBtn || this.resetViewBtn.classList.contains('fit-all-hidden')) {
            return null;
        }
        const rect = this.resetViewBtn.getBoundingClientRect();
        if (!(rect.width > 0) || !(rect.height > 0)) {
            return null;
        }
        return rect;
    }

    /**
     * Shows (or swaps to) a marker's tooltip and starts live placement
     * tracking. `easel` is used only for the "safe area too short" fallback
     * (dispatches poster-tooltip-suppressed for index.html to scroll the
     * matching table row into view instead). `moveFocus` should be true only
     * for a deliberate tap/keyboard activation, never a mouse hover -
     * stealing focus on every hover would be disruptive on desktop.
     */
    showMarkerTooltip(markerElement, { easel = null, moveFocus = false } = {}) {
        this._stopTooltipTracking();
        this._tooltipMarkerEl = markerElement;
        this._tooltipEasel = easel;

        const safeArea = this.getTooltipSafeAreaRect();
        if (safeArea.bottom - safeArea.top < 120) {
            this.infoPanel.classList.remove('active');
            this._tooltipMarkerEl = null;
            if (easel) {
                document.dispatchEvent(new CustomEvent('poster-tooltip-suppressed', {
                    detail: { easel },
                    bubbles: true
                }));
            }
            return false;
        }

        this._placeTooltip({ allowAutoPan: true });
        this.infoPanel.classList.add('active');
        this._startTooltipTracking();

        if (moveFocus) {
            this.infoPanel.focus();
        }

        return true;
    }

    _startTooltipTracking() {
        this._tooltipTrackingActive = true;
        const step = () => {
            if (!this._tooltipTrackingActive || !this._tooltipMarkerEl) {
                this._tooltipRafId = null;
                return;
            }
            this._placeTooltip({ allowAutoPan: false });
            this._tooltipRafId = requestAnimationFrame(step);
        };
        this._tooltipRafId = requestAnimationFrame(step);
    }

    _stopTooltipTracking() {
        this._tooltipTrackingActive = false;
        if (this._tooltipRafId) {
            cancelAnimationFrame(this._tooltipRafId);
            this._tooltipRafId = null;
        }
    }

    /**
     * The placement engine (steps 1-5 of the Poster Map Tooltip Containment
     * PRD). Called once on open (allowAutoPan: true) and every rAF tick
     * thereafter while the tooltip is tracked (allowAutoPan: false, since
     * auto-panning mid-gesture would fight the user's own pan/pinch). Always
     * re-derives from step 0 so the tooltip can scale back up when room
     * returns (e.g. the sheet is dragged back down). The arrow always points
     * down at the marker - this tooltip is never placed below it.
     */
    _placeTooltip({ allowAutoPan = false } = {}) {
        const panel = this.infoPanel;
        const markerEl = this._tooltipMarkerEl;
        if (!markerEl || !markerEl.isConnected) {
            return;
        }

        const safeArea = this.getTooltipSafeAreaRect();
        const safeWidth = safeArea.right - safeArea.left;
        const safeHeight = safeArea.bottom - safeArea.top;

        const markerRect = markerEl.getBoundingClientRect();
        const markerCenterX = markerRect.left + markerRect.width / 2;
        const markerCenterY = markerRect.top + markerRect.height / 2;

        const markerVisible = markerCenterX >= safeArea.left && markerCenterX <= safeArea.right &&
            markerCenterY >= safeArea.top && markerCenterY <= safeArea.bottom;
        if (!markerVisible) {
            // Hide, don't close - the tracking loop keeps running so this
            // can reappear if the marker comes back into the safe area
            // before the gesture/drag ends. Selection itself is untouched.
            panel.classList.remove('active');
            return;
        }
        panel.classList.add('active');

        const ARROW_SIZE = 10;
        const ARROW_GAP = 8;
        const exclusion = this.getTooltipExclusionRect();

        const width = Math.min(safeWidth - 24, safeWidth > safeHeight ? 420 : 340);
        panel.style.setProperty('--tt-width', `${Math.max(0, width)}px`);
        panel.classList.remove('tt-step1', 'tt-step2', 'tt-step3', 'tt-scroll');
        panel.style.removeProperty('--tt-max-height');

        const measure = () => {
            let left = markerCenterX - width / 2;
            left = Math.min(Math.max(left, safeArea.left), safeArea.right - width);
            const top = markerRect.top - ARROW_GAP - ARROW_SIZE - panel.offsetHeight;
            const arrowPos = Math.min(Math.max(markerCenterX - left, 16 + ARROW_SIZE), width - 16 - ARROW_SIZE);

            panel.style.left = `${left}px`;
            panel.style.top = `${top}px`;
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
            panel.style.setProperty('--arrow-side', 'bottom');
            panel.style.setProperty('--arrow-position', `${arrowPos}px`);
            panel.style.setProperty('--arrow-size', `${ARROW_SIZE}px`);

            const rect = { left, top, right: left + width, bottom: top + panel.offsetHeight };
            const fits = top >= safeArea.top && (!exclusion || !rectsIntersect(rect, exclusion));
            return { top, fits };
        };

        let result = measure();
        if (result.fits) return;

        panel.classList.add('tt-step1');
        result = measure();
        if (result.fits) return;

        panel.classList.add('tt-step2');
        result = measure();
        if (result.fits) return;

        panel.classList.add('tt-step3');
        result = measure();
        if (result.fits) return;

        if (allowAutoPan) {
            this._autoPanForTooltip(markerRect, safeArea, () => this._placeTooltip({ allowAutoPan: false }));
            return;
        }

        // Step 5: cap height, pin the title row, scroll the body.
        const maxHeight = Math.max(80, safeHeight - markerRect.height - 20);
        panel.classList.add('tt-scroll');
        panel.style.setProperty('--tt-max-height', `${maxHeight}px`);
        let left = markerCenterX - width / 2;
        left = Math.min(Math.max(left, safeArea.left), safeArea.right - width);
        panel.style.left = `${left}px`;
        panel.style.top = `${safeArea.top}px`;
        const arrowPos = Math.min(Math.max(markerCenterX - left, 16 + ARROW_SIZE), width - 16 - ARROW_SIZE);
        panel.style.setProperty('--arrow-position', `${arrowPos}px`);
    }

    /**
     * Step 4 of the placement PRD: pans so the marker's vertical center
     * lands at 85% of the safe area's height, then re-places above it.
     * Uses getBaseRenderScale() (letterbox-correct) rather than the touch
     * gesture code's renderScaleFactor (which assumes width is the
     * constraining axis and is only refreshed at gesture start) - this is a
     * one-shot conversion, not a per-frame hot path, so the extra
     * getBoundingClientRect() call is negligible.
     */
    _autoPanForTooltip(markerRect, safeArea, onComplete) {
        const scale = this.getBaseRenderScale();
        if (!scale) {
            onComplete();
            return;
        }

        const targetCenterY = safeArea.top + 0.85 * (safeArea.bottom - safeArea.top);
        const currentCenterY = markerRect.top + markerRect.height / 2;
        const deltaScreenY = targetCenterY - currentCenterY;
        const contentDeltaY = deltaScreenY / (scale * this.currentZoom);
        const target = this.clampPanToBounds(this.panX, this.panY + contentDeltaY);

        this.stopPanInertia(true);
        this.stopPanAnimation();

        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            this.panX = target.panX;
            this.panY = target.panY;
            this.updateViewBox();
            onComplete();
        } else {
            this.animatePan(target.panX, target.panY, 250, onComplete);
        }
    }

    getViewportCenterClient() {
        const rect = this.svg.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }

    zoomIn() {
        const center = this.getViewportCenterClient();
        this.animateZoomTo(this.currentZoom * 2, center.x, center.y, { duration: 200, curve: EASE_DISCRETE });
    }

    zoomOut() {
        const center = this.getViewportCenterClient();
        this.animateZoomTo(this.currentZoom * 0.5, center.x, center.y, { duration: 200, curve: EASE_DISCRETE });
    }

    resetView() {
        this.setView(
            {
                scale: this.defaultZoom || this.minZoom,
                x: this.defaultCenterX,
                y: this.defaultCenterY
            },
            { duration: 500, curve: EASE_FLYTO }
        );
        this.hideInfo();
    }

    /**
     * Fit the default/reset view to the actual rendered content (buildings +
     * poster mounts) instead of the full nominal 1078x1558 canvas, which has
     * large empty margins baked in. Without this, short/wide containers
     * (e.g. the mobile map panel) letterbox hard against the tall canvas and
     * the content renders tiny. Called once content has been laid out.
     */
    /**
     * Pure calculation: the zoom + content-center point that frames the
     * rendered buildings/poster-mounts (with padding) inside the nominal
     * baseWidth x baseHeight canvas. Extracted so both fitToContent()
     * (the on-load default view, which also applies a mobile zoom-floor
     * bump) and recalculateZoomLimits() (which uses this raw fit as the
     * zoom-out floor) share one implementation. Returns null if content
     * isn't laid out yet. The returned zoom is NOT clamped against
     * this.minZoom/maxZoom - callers decide how to clamp for their purpose.
     */
    /**
     * CSS pixels per SVG user-unit, AT ZOOM 1. #posterMap has no explicit
     * preserveAspectRatio, so it defaults to "xMidYMid meet": the smaller of
     * the two axis scales is what actually constrains rendering, and the
     * other axis gets letterboxed (blank margin, since the container's
     * rendered aspect ratio generally won't match the 1078x1558 canvas -
     * especially the full-screen mobile map). This mirrors that algorithm.
     * Zero-independent of zoom: the SVG's rendered CSS box size doesn't
     * change when the viewBox zooms, only baseWidth/baseHeight are fixed
     * references, so this is a single reusable constant per layout.
     */
    getBaseRenderScale() {
        const rect = this.svg.getBoundingClientRect();
        if (!rect || rect.width === 0 || rect.height === 0) {
            return null;
        }
        return Math.min(rect.width / this.baseWidth, rect.height / this.baseHeight);
    }

    /**
     * Converts this.viewportInsets (screen px) into SVG user-space units,
     * letterbox-corrected via getBaseRenderScale(). `zoom1` values are in
     * the same units as baseWidth/baseHeight (used when solving for a
     * target zoom in computeContentFitZoomAndPan). `atCurrentZoom` values
     * are in the same units as calculatePanForCoordinates()'s local
     * width/height (baseWidth/this.currentZoom), used for the anchor shift
     * and clamp extension there. Conservative: treats the whole pixel inset
     * as unusable content space even if part of it would have landed in
     * existing letterbox margin anyway - never hides content under the
     * sheet, just occasionally a hair more zoomed-out than the strict
     * minimum.
     */
    getInsetUserUnits() {
        const zero = { top: 0, right: 0, bottom: 0, left: 0 };
        const K = this.getBaseRenderScale();
        if (!K) {
            return { zoom1: { ...zero }, atCurrentZoom: { ...zero } };
        }
        const { top, right, bottom, left } = this.viewportInsets;
        const zoom1 = { top: top / K, right: right / K, bottom: bottom / K, left: left / K };
        const z = this.currentZoom > 0 ? this.currentZoom : 1;
        const atCurrentZoom = {
            top: zoom1.top / z,
            right: zoom1.right / z,
            bottom: zoom1.bottom / z,
            left: zoom1.left / z
        };
        return { zoom1, atCurrentZoom };
    }

    /**
     * Sets the screen-pixel margins the camera should treat as obscured
     * (currently just the mobile bottom sheet + safe areas). Merges given
     * keys, leaves others as-is. Purely stored - affects only the next
     * fit/center call, never triggers a re-render itself, so callers should
     * only call this when they're about to fit/center anyway (e.g. once a
     * sheet drag settles, never mid-drag).
     */
    setViewportInsets(partial = {}) {
        Object.assign(this.viewportInsets, partial);
    }

    /**
     * Raw (unpadded) content bounding box in canvas/user-space, combining
     * the poster-areas and poster-mounts-layer groups. Shared by
     * computeContentFitZoomAndPan() (which pads and reduces it to a single
     * zoom/center) and getPanBounds() (which uses the raw edges directly).
     * Returns null before content has rendered.
     */
    _getContentBBox() {
        const groupIds = ['poster-areas', 'poster-mounts-layer'];
        let combined = null;

        groupIds.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;

            let box;
            try {
                box = el.getBBox();
            } catch (e) {
                return;
            }

            if (!box || !(box.width > 0) || !(box.height > 0)) return;

            if (!combined) {
                combined = { x: box.x, y: box.y, right: box.x + box.width, bottom: box.y + box.height };
            } else {
                combined.x = Math.min(combined.x, box.x);
                combined.y = Math.min(combined.y, box.y);
                combined.right = Math.max(combined.right, box.x + box.width);
                combined.bottom = Math.max(combined.bottom, box.y + box.height);
            }
        });

        return combined;
    }

    /**
     * Pan bounds per the "Map Touchscreen Input Behavior" PRD ("keep at
     * least 50% of the viewport covered by map content"). The direct
     * algebraic consequence of that rule is that the viewport's own center
     * point must stay within the content's bounding box on each axis - so
     * this returns the valid range for the viewBox's own top-left corner
     * (in getViewBox()'s x/y terms) at the current zoom. Tight preset uses
     * 0px overscroll past this, so callers hard-clamp against it directly
     * (see clampPanToBounds); a looser preset would apply resistance here
     * instead. Returns null before content has rendered.
     */
    getPanBounds() {
        const combined = this._getContentBBox();
        if (!combined) return null;
        const width = this.baseWidth / this.currentZoom;
        const height = this.baseHeight / this.currentZoom;
        return {
            minViewX: combined.x - width / 2,
            maxViewX: combined.right - width / 2,
            minViewY: combined.y - height / 2,
            maxViewY: combined.bottom - height / 2
        };
    }

    /**
     * Hard-clamps a candidate panX/panY to getPanBounds(), working in
     * viewBox-x/y terms (getViewBox()'s x/y = -panX/-panY + a zoom-only
     * offset) so the clamp is expressed in the same coordinate space the
     * bounds are defined in, then converts back. Used for live drag and
     * momentum only (§5 of the plan) - programmatic moves (fitToContent,
     * search/row centering, reset) already target valid positions and are
     * left untouched, and pinch/wheel zoom-anchored pan keeps its own
     * separate, coarser canvas-bounds clamp in computeAnchoredPan().
     */
    clampPanToBounds(rawPanX, rawPanY) {
        const bounds = this.getPanBounds();
        if (!bounds) return { panX: rawPanX, panY: rawPanY };

        const width = this.baseWidth / this.currentZoom;
        const height = this.baseHeight / this.currentZoom;
        const halfBaseX = (this.baseWidth - width) / 2;
        const halfBaseY = (this.baseHeight - height) / 2;

        const viewX = halfBaseX - rawPanX;
        const viewY = halfBaseY - rawPanY;
        const clampedViewX = Math.min(Math.max(viewX, bounds.minViewX), bounds.maxViewX);
        const clampedViewY = Math.min(Math.max(viewY, bounds.minViewY), bounds.maxViewY);

        return {
            panX: halfBaseX - clampedViewX,
            panY: halfBaseY - clampedViewY
        };
    }

    /**
     * Rubber-band resistance past a zoom limit, Tight preset: allows up to
     * ZOOM_RUBBER_BAND_FRACTION past minZoom/maxZoom during a live pinch or
     * ctrl+wheel gesture, damped by ZOOM_RUBBER_BAND_RESISTANCE so it feels
     * resistant rather than free. Callers spring back to the true limit on
     * gesture end via the existing animateZoomTo() engine.
     */
    applyZoomRubberBand(rawZoom) {
        if (rawZoom >= this.minZoom && rawZoom <= this.maxZoom) {
            return rawZoom;
        }
        const limit = rawZoom < this.minZoom ? this.minZoom : this.maxZoom;
        const excess = rawZoom - limit;
        const damped = limit + excess * ZOOM_RUBBER_BAND_RESISTANCE;
        const ceiling = limit * (1 + ZOOM_RUBBER_BAND_FRACTION);
        const floor = limit * (1 - ZOOM_RUBBER_BAND_FRACTION);
        return Math.min(Math.max(damped, floor), ceiling);
    }

    computeContentFitZoomAndPan(paddingRatio = 0.1) {
        const combined = this._getContentBBox();
        if (!combined) return null;

        const contentWidth = combined.right - combined.x;
        const contentHeight = combined.bottom - combined.y;
        if (!(contentWidth > 0) || !(contentHeight > 0)) return null;

        const padX = contentWidth * paddingRatio;
        const padY = contentHeight * paddingRatio;

        const minX = Math.max(0, combined.x - padX);
        const minY = Math.max(0, combined.y - padY);
        const maxX = Math.min(this.baseWidth, combined.right + padX);
        const maxY = Math.min(this.baseHeight, combined.bottom + padY);

        const width = maxX - minX;
        const height = maxY - minY;
        if (!(width > 0) || !(height > 0)) return null;

        const { zoom1: inset } = this.getInsetUserUnits();
        const availableWidth = this.baseWidth - inset.left - inset.right;
        const availableHeight = this.baseHeight - inset.top - inset.bottom;

        const zoomForWidth = availableWidth / width;
        const zoomForHeight = availableHeight / height;

        return {
            zoom: Math.min(zoomForWidth, zoomForHeight),
            centerX: minX + width / 2,
            centerY: minY + height / 2
        };
    }

    fitToContent(paddingRatio = 0.1) {
        const fit = this.computeContentFitZoomAndPan(paddingRatio);
        if (!fit) return false;

        const targetZoom = Math.min(this.maxZoom, Math.max(this.minZoom, fit.zoom));

        this.currentZoom = targetZoom;
        const target = this.calculatePanForCoordinates(fit.centerX, fit.centerY);
        this.panX = target.panX;
        this.panY = target.panY;

        this.defaultZoom = targetZoom;
        this.defaultPanX = this.panX;
        this.defaultPanY = this.panY;
        this.defaultCenterX = fit.centerX;
        this.defaultCenterY = fit.centerY;

        this.updateViewBox();
        return true;
    }

    /**
     * Measure a representative marker label's current on-screen size and
     * solve for the zoom that would scale it to ~targetPx, per the PRD's
     * "max zoom = label reaches ~40px" spec. Recomputed at runtime (rather
     * than a hardcoded constant) because the on-screen size of a fixed
     * SVG-user-unit font depends on the map container's current rendered
     * width, which varies by breakpoint/fullscreen state/orientation.
     */
    computeMaxZoomForLabelSize(targetPx = 40) {
        const labelEl = document.querySelector('#poster-mounts-layer text');
        if (!labelEl || !(this.currentZoom > 0)) return null;

        const rect = labelEl.getBoundingClientRect();
        if (!(rect.height > 0)) return null;

        const heightAtZoom1 = rect.height / this.currentZoom;
        if (!(heightAtZoom1 > 0)) return null;

        return targetPx / heightAtZoom1;
    }

    /**
     * Recompute min/max zoom from the current layout: minZoom = fit-whole-
     * map-in-viewport (reuses computeContentFitZoomAndPan, no mobile-floor
     * bump - that's a nice default, not a hard boundary), maxZoom = label
     * reaches ~40px. Called once markers finish loading, and again on
     * resize/orientation/fullscreen changes since the container's rendered
     * width changes what zoom level those targets correspond to.
     */
    recalculateZoomLimits() {
        const fit = this.computeContentFitZoomAndPan(0);
        if (fit && fit.zoom > 0) {
            this.minZoom = fit.zoom;
        }

        const maxForLabel = this.computeMaxZoomForLabelSize(40);
        if (maxForLabel && maxForLabel > this.minZoom) {
            this.maxZoom = maxForLabel;
        }

        const clampedZoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.currentZoom));
        if (clampedZoom !== this.currentZoom) {
            this.currentZoom = clampedZoom;
            this.updateViewBox();
        }
    }

    toggleFullScreen(forceState) {
        const shouldEnable = typeof forceState === 'boolean' ? forceState : !this.isFullScreen;

        if (shouldEnable === this.isFullScreen) {
            return;
        }

        this.isFullScreen = shouldEnable;
        document.body.classList.toggle('map-fullscreen', this.isFullScreen);
        this.updateFullScreenUI();

        // Fullscreen resizes .map-container without firing a window resize
        // event, so zoom limits (which depend on the container's rendered
        // size) need their own recalculation here rather than only on
        // window 'resize'.
        this.recalculateZoomLimits();
    }

    updateFullScreenUI() {
        if (!this.fullscreenBtn) {
            return;
        }

        const pressed = this.isFullScreen ? 'true' : 'false';
        this.fullscreenBtn.setAttribute('aria-pressed', pressed);
        this.fullscreenBtn.setAttribute('aria-label', this.isFullScreen ? 'Exit full screen view' : 'View map full screen');
        this.fullscreenBtn.setAttribute('title', this.isFullScreen ? 'Exit Full Screen' : 'View map full screen');
        this.fullscreenBtn.setAttribute('data-state', this.isFullScreen ? 'exit' : 'enter');

        if (this.fullscreenEnterIcon) {
            this.fullscreenEnterIcon.setAttribute('aria-hidden', this.isFullScreen ? 'true' : 'false');
        }

        if (this.fullscreenExitIcon) {
            this.fullscreenExitIcon.setAttribute('aria-hidden', this.isFullScreen ? 'false' : 'true');
        }
    }

    getViewBox() {
        const width = this.baseWidth / this.currentZoom;
        const height = this.baseHeight / this.currentZoom;
        const x = -this.panX + (this.baseWidth - width) / 2;
        const y = -this.panY + (this.baseHeight - height) / 2;

        return { x, y, width, height };
    }

    updateViewBox() {
        const { x, y, width, height } = this.getViewBox();
        this.svg.setAttribute('viewBox', `${x} ${y} ${width} ${height}`);
    }

    stopPanAnimation() {
        if (this.panAnimationFrame) {
            cancelAnimationFrame(this.panAnimationFrame);
            this.panAnimationFrame = null;
        }
        this.panAnimationComplete = null;
    }

    /**
     * Pure focal-anchor math: given a target zoom and a screen point (client
     * coords), solve the pan that keeps that point fixed on screen at the
     * new zoom. Extracted from the pinch-zoom handler (which already had
     * this right) so both pinch and the animated zoom paths (buttons, wheel)
     * share one implementation. Returns null if the SVG isn't laid out yet.
     */
    computeAnchoredPan(targetZoom, clientX, clientY) {
        const rect = this.svg.getBoundingClientRect();
        if (!rect || rect.width === 0 || rect.height === 0) {
            return null;
        }

        const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
        const { x: viewX, y: viewY, width: viewWidth, height: viewHeight } = this.getViewBox();
        const fractionX = clamp((clientX - rect.left) / rect.width, 0, 1);
        const fractionY = clamp((clientY - rect.top) / rect.height, 0, 1);

        const mapCenterX = viewX + viewWidth * fractionX;
        const mapCenterY = viewY + viewHeight * fractionY;

        const nextViewWidth = this.baseWidth / targetZoom;
        const nextViewHeight = this.baseHeight / targetZoom;

        const minViewX = 0;
        const minViewY = 0;
        const maxViewX = Math.max(minViewX, this.baseWidth - nextViewWidth);
        const maxViewY = Math.max(minViewY, this.baseHeight - nextViewHeight);

        const desiredViewX = mapCenterX - fractionX * nextViewWidth;
        const desiredViewY = mapCenterY - fractionY * nextViewHeight;

        const clampedViewX = clamp(desiredViewX, minViewX, maxViewX);
        const clampedViewY = clamp(desiredViewY, minViewY, maxViewY);

        return {
            panX: (this.baseWidth - nextViewWidth) / 2 - clampedViewX,
            panY: (this.baseHeight - nextViewHeight) / 2 - clampedViewY
        };
    }

    stopZoomAnimation() {
        if (this.zoomAnimationFrame) {
            cancelAnimationFrame(this.zoomAnimationFrame);
            this.zoomAnimationFrame = null;
        }
        this.zoomAnimationComplete = null;
    }

    /**
     * Shared animation core for every discrete zoom path (buttons, wheel
     * notches, reset, search fly-to). Interpolates zoom in LOG space so each
     * doubling takes the same wall-clock time (linear interpolation of scale
     * feels fast-then-sluggish), while panX/panY lerp toward the given
     * target in lockstep so the anchor point stays put throughout the
     * animation, not just at the end.
     *
     * Any call cancels an in-flight zoom animation first and always starts
     * from the LIVE this.currentZoom/panX/panY - never a stored prior
     * target - which is what makes a new input interrupting an animation
     * continue smoothly instead of snapping back.
     */
    runZoomAnimation({ toZoom, toPanX, toPanY, duration = 200, curve = EASE_DISCRETE, onComplete } = {}) {
        this.stopPanInertia(true);
        this.stopPanAnimation();
        this.stopZoomAnimation();

        const reducedMotion = typeof window !== 'undefined' && window.matchMedia &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        if (reducedMotion || !(duration > 0)) {
            this.currentZoom = toZoom;
            this.panX = toPanX;
            this.panY = toPanY;
            this.updateViewBox();
            if (typeof onComplete === 'function') {
                onComplete();
            }
            return;
        }

        const fromZoom = this.currentZoom;
        const fromPanX = this.panX;
        const fromPanY = this.panY;
        const logFrom = Math.log(fromZoom);
        const logTo = Math.log(toZoom);
        const startTime = performance.now();
        this.zoomAnimationComplete = typeof onComplete === 'function' ? onComplete : null;

        const step = (now) => {
            const elapsed = now - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const eased = curve(progress);

            this.currentZoom = Math.exp(logFrom + (logTo - logFrom) * eased);
            this.panX = fromPanX + (toPanX - fromPanX) * eased;
            this.panY = fromPanY + (toPanY - fromPanY) * eased;
            this.updateViewBox();

            if (progress < 1) {
                this.zoomAnimationFrame = requestAnimationFrame(step);
            } else {
                this.zoomAnimationFrame = null;
                if (this.zoomAnimationComplete) {
                    const callback = this.zoomAnimationComplete;
                    this.zoomAnimationComplete = null;
                    callback();
                }
            }
        };

        this.zoomAnimationFrame = requestAnimationFrame(step);
    }

    /**
     * Animate to a target zoom anchored at a screen point (client coords) -
     * the point under the cursor/button stays fixed on screen throughout.
     * Used by +/- buttons (anchor = viewport center) and wheel notches
     * (anchor = cursor position).
     */
    animateZoomTo(targetZoom, clientX, clientY, options = {}) {
        const { duration = 200, curve = EASE_DISCRETE, onComplete } = options;
        const clampedZoom = Math.min(this.maxZoom, Math.max(this.minZoom, targetZoom));
        const anchored = this.computeAnchoredPan(clampedZoom, clientX, clientY);
        const toPanX = anchored ? anchored.panX : this.panX;
        const toPanY = anchored ? anchored.panY : this.panY;

        this.runZoomAnimation({ toZoom: clampedZoom, toPanX, toPanY, duration, curve, onComplete });
    }

    /**
     * Fly to a target view: { scale, x, y } where x/y are content
     * coordinates to center (same convention as calculatePanForCoordinates),
     * and scale is the target zoom. Omit x/y to change zoom only, in place.
     * Used by resetView() and search-result-to-marker centering - both are
     * "fly to a target view" per the zoom PRD, sharing one curve/duration.
     */
    setView(view = {}, options = {}) {
        const { scale = this.currentZoom, x, y } = view;
        const { animate = true, duration = 500, curve = EASE_FLYTO, onComplete } = options;
        const clampedZoom = Math.min(this.maxZoom, Math.max(this.minZoom, scale));

        let toPanX = this.panX;
        let toPanY = this.panY;

        if (Number.isFinite(x) && Number.isFinite(y)) {
            const previousZoom = this.currentZoom;
            this.currentZoom = clampedZoom;
            const pan = this.calculatePanForCoordinates(x, y);
            this.currentZoom = previousZoom;
            toPanX = pan.panX;
            toPanY = pan.panY;
        }

        this.runZoomAnimation({
            toZoom: clampedZoom,
            toPanX,
            toPanY,
            duration: animate ? duration : 0,
            curve,
            onComplete
        });
    }

    centerOnCoordinates(x, y, options = {}) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return;
        }

        const { animate = true, duration = 300, onComplete } = options;

        this.stopPanInertia(true);
        this.stopPanAnimation();

        const targetPan = this.calculatePanForCoordinates(x, y);

        if (animate && duration > 0) {
            this.animatePan(targetPan.panX, targetPan.panY, duration, onComplete);
        } else {
            this.panX = targetPan.panX;
            this.panY = targetPan.panY;
            this.updateViewBox();
            if (typeof onComplete === 'function') {
                onComplete();
            }
        }
    }

    /**
     * Pans so (x,y) lands at the center of the current *visible* area - the
     * viewBox minus this.viewportInsets - rather than always the dead
     * center of the viewBox. With zero insets this reduces exactly to the
     * original center-on-(x,y) behavior (see the derivation in the mobile
     * bottom-sheet plan), so every existing caller (fitToContent,
     * centerOnCoordinates/search-and-row centering, resetView) gets
     * inset-awareness automatically with no call-site changes.
     *
     * Derivation: getViewBox() defines viewX = -panX + (baseWidth-width)/2.
     * The visible sub-rectangle spans local viewbox coordinates
     * [insetLeft, width-insetRight] x [insetTop, height-insetBottom], whose
     * center is width/2 + (insetLeft-insetRight)/2 horizontally (and the Y
     * equivalent) - the usual midpoint, shifted by half the *difference*
     * between opposing insets. Setting viewX + that local center = x and
     * solving for viewX (then panX = (baseWidth-width)/2 - viewX, unchanged
     * from the original) gives the anchorOffset terms below. The clamp
     * range is extended by the insets too: at minZoom the viewbox already
     * spans nearly the whole canvas, leaving ~0 slack in the original
     * [0, baseWidth-width] range, which would silently clamp the anchor
     * shift away right when it matters most (see setViewportInsets).
     */
    calculatePanForCoordinates(x, y) {
        const width = this.baseWidth / this.currentZoom;
        const height = this.baseHeight / this.currentZoom;
        const { atCurrentZoom: inset } = this.getInsetUserUnits();

        const anchorOffsetX = (inset.left - inset.right) / 2;
        const anchorOffsetY = (inset.top - inset.bottom) / 2;

        const minX = -inset.left;
        const minY = -inset.top;
        const maxX = Math.max(minX, this.baseWidth - width + inset.right);
        const maxY = Math.max(minY, this.baseHeight - height + inset.bottom);

        const desiredX = x - width / 2 - anchorOffsetX;
        const desiredY = y - height / 2 - anchorOffsetY;

        const clampedX = Math.min(Math.max(desiredX, minX), maxX);
        const clampedY = Math.min(Math.max(desiredY, minY), maxY);

        return {
            panX: (this.baseWidth - width) / 2 - clampedX,
            panY: (this.baseHeight - height) / 2 - clampedY
        };
    }

    animatePan(targetPanX, targetPanY, duration = 300, onComplete) {
        const startPanX = this.panX;
        const startPanY = this.panY;
        const startTime = performance.now();
        this.panAnimationComplete = typeof onComplete === 'function' ? onComplete : null;

        const step = (now) => {
            const elapsed = now - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const eased = progress < 0.5
                ? 2 * progress * progress
                : -1 + (4 - 2 * progress) * progress;

            this.panX = startPanX + (targetPanX - startPanX) * eased;
            this.panY = startPanY + (targetPanY - startPanY) * eased;
            this.updateViewBox();

            if (progress < 1) {
                this.panAnimationFrame = requestAnimationFrame(step);
            } else {
                this.panAnimationFrame = null;
                if (this.panAnimationComplete) {
                    const callback = this.panAnimationComplete;
                    this.panAnimationComplete = null;
                    callback();
                }
            }
        };

        this.panAnimationFrame = requestAnimationFrame(step);
    }

    stopPanInertia(resetVelocity = false) {
        if (this.panInertiaFrame) {
            cancelAnimationFrame(this.panInertiaFrame);
            this.panInertiaFrame = null;
        }
        if (resetVelocity) {
            this.panVelocityX = 0;
            this.panVelocityY = 0;
        }
    }

    /**
     * Momentum per the touch-input PRD, Tight preset. velocityScreenX/Y
     * are screen-space px/ms - already fling-threshold-gated and
     * cap-clamped by the caller (endPan(), which has access to the
     * gesture's velocity samples) - stored into this.panVelocityX/Y so the
     * decay loop below can keep updating them frame to frame. Each frame
     * converts the current screen-space velocity to a content-space delta
     * the same way live drag does (getPanSpeedMultiplier() * this.
     * renderScaleFactor / this.currentZoom - see panDeltaFromScreen() in
     * initializeEventListeners, which this mirrors since a class method
     * can't reach that closure), applies it through the same pan-bounds
     * clamp live drag uses, and decays exponentially with time constant
     * MOMENTUM_TAU_MS. Tight preset's pan bounds have zero overscroll, so
     * hitting a bound just zeroes that axis's velocity - an immediate
     * stop, not a bounce.
     */
    startPanInertia(velocityScreenX, velocityScreenY) {
        const MOMENTUM_TAU_MS = 150; // Tight preset
        const MOMENTUM_STOP_VELOCITY = 0.02; // px/ms (20 px/s) - constant across presets

        if (typeof velocityScreenX === 'number') this.panVelocityX = velocityScreenX;
        if (typeof velocityScreenY === 'number') this.panVelocityY = velocityScreenY;

        const currentSpeed = Math.hypot(this.panVelocityX, this.panVelocityY);
        if (currentSpeed < MOMENTUM_STOP_VELOCITY) {
            this.stopPanInertia(true);
            return;
        }

        this.stopPanInertia();

        let lastTime = performance.now();

        const step = (time) => {
            const dt = time - lastTime;
            lastTime = time;

            const appliedMultiplier = this.getPanSpeedMultiplier() * this.renderScaleFactor;
            const dxContent = (this.panVelocityX * dt / this.currentZoom) * appliedMultiplier;
            const dyContent = (this.panVelocityY * dt / this.currentZoom) * appliedMultiplier;

            const rawPanX = this.panX + dxContent;
            const rawPanY = this.panY + dyContent;
            const clamped = this.clampPanToBounds(rawPanX, rawPanY);
            const hitBoundX = Math.abs(clamped.panX - rawPanX) > 1e-6;
            const hitBoundY = Math.abs(clamped.panY - rawPanY) > 1e-6;
            this.panX = clamped.panX;
            this.panY = clamped.panY;
            this.updateViewBox();

            if (hitBoundX) this.panVelocityX = 0;
            if (hitBoundY) this.panVelocityY = 0;

            const decayFactor = Math.exp(-dt / MOMENTUM_TAU_MS);
            this.panVelocityX *= decayFactor;
            this.panVelocityY *= decayFactor;

            if (Math.hypot(this.panVelocityX, this.panVelocityY) < MOMENTUM_STOP_VELOCITY) {
                this.stopPanInertia(true);
                return;
            }

            this.panInertiaFrame = requestAnimationFrame(step);
        };

        this.panInertiaFrame = requestAnimationFrame(step);
    }


    // Method to load external JSON data
    async loadExternalData(jsonUrl) {
        try {
            const response = await fetch(jsonUrl);
            const data = await response.json();
            
            if (data.posterAreas) {
                this.posterAreas = data.posterAreas;
            }
            if (data.markers) {
                this.markers = data.markers;
            }
            
            this.renderMap();
        } catch (error) {
            console.error('Error loading external data:', error);
        }
    }
}

// Make the class available globally
window.PosterSessionMap = PosterSessionMap;

// Initialize the map when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.posterMap = new PosterSessionMap();
});

// Export for potential external use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PosterSessionMap;
}
