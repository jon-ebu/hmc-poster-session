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
        this.fullscreenEnterIcon = this.fullscreenBtn ? this.fullscreenBtn.querySelector('.fullscreen-enter') : null;
        this.fullscreenExitIcon = this.fullscreenBtn ? this.fullscreenBtn.querySelector('.fullscreen-exit') : null;
        this.isFullScreen = document.body.classList.contains('map-fullscreen');
        this.handleGlobalKeydown = (event) => {
            if (event.key !== 'Escape') {
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
        this.panVelocityX = 0;
        this.panVelocityY = 0;
        this.panInertiaFrame = null;
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
let isPanning = false;
        let startX, startY, initialPanX, initialPanY;
        let lastPointerX = 0;
        let lastPointerY = 0;
        let lastPointerTime = 0;
        let pinchActive = false;
        let pinchStartDistance = 0;
        let pinchStartZoom = this.currentZoom;
        let lastTouchEndTime = 0;
        const doubleTapThresholdMs = 350;
        const velocityConfig = {
            max: 0.75,
            smoothing: 0.22,
            flickMultiplier: 1.1,
            flickWindowMs: 35,
            flickMax: 0.9
        };
        const TOUCH_PAN_MULTIPLIER = 1.4;
        let panInputType = 'mouse';
        let currentPanMultiplier = 1;

        const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

        const getTouchDistance = (touchA, touchB) => {
            const dx = touchA.clientX - touchB.clientX;
            const dy = touchA.clientY - touchB.clientY;
            return Math.hypot(dx, dy);
        };

        const getTouchMidpoint = (touchA, touchB) => ({
            x: (touchA.clientX + touchB.clientX) / 2,
            y: (touchA.clientY + touchB.clientY) / 2
        });

        const updatePanForPinch = (targetZoom, centerClientX, centerClientY) => {
            const anchored = this.computeAnchoredPan(targetZoom, centerClientX, centerClientY);
            this.currentZoom = targetZoom;
            if (anchored) {
                this.panX = anchored.panX;
                this.panY = anchored.panY;
            }
            this.updateViewBox();
        };

        const startPinch = (touches) => {
            if (!touches || touches.length < 2) {
                return;
            }

            this.stopPanInertia(true);
            this.stopPanAnimation();
            isPanning = false;
            pinchActive = true;
            pinchStartDistance = getTouchDistance(touches[0], touches[1]) || 0.0001;
            pinchStartZoom = this.currentZoom;
            this.isMultiTouchGesture = true;
        };

        const resetPinchState = () => {
            pinchActive = false;
            pinchStartDistance = 0;
            pinchStartZoom = this.currentZoom;
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
            const scale = distance / pinchStartDistance;
            const targetZoom = clamp(pinchStartZoom * scale, this.minZoom, this.maxZoom);
            updatePanForPinch(targetZoom, midpoint.x, midpoint.y);
        };

        const recordVelocity = (clientX, clientY) => {
            const now = performance.now();
            if (lastPointerTime) {
                const deltaTime = now - lastPointerTime;
                if (deltaTime > 0) {
                    const appliedMultiplier = this.getPanSpeedMultiplier() * currentPanMultiplier;
                    const deltaPanX = ((clientX - lastPointerX) / this.currentZoom) * appliedMultiplier;
                    const deltaPanY = ((clientY - lastPointerY) / this.currentZoom) * appliedMultiplier;
                    const vx = deltaPanX / deltaTime;
                    const vy = deltaPanY / deltaTime;
                    const { max, smoothing } = velocityConfig;
                    this.panVelocityX = (1 - smoothing) * this.panVelocityX + smoothing * Math.max(-max, Math.min(max, vx));
                    this.panVelocityY = (1 - smoothing) * this.panVelocityY + smoothing * Math.max(-max, Math.min(max, vy));
                }
            }
            lastPointerX = clientX;
            lastPointerY = clientY;
            lastPointerTime = now;
        };

        const beginPan = (clientX, clientY, inputType = 'mouse') => {
            isPanning = true;
            panInputType = inputType;
            currentPanMultiplier = panInputType === 'touch' ? TOUCH_PAN_MULTIPLIER : 1;
            startX = clientX;
            startY = clientY;
            initialPanX = this.panX;
            initialPanY = this.panY;
            this.stopPanInertia(true);
            this.stopPanAnimation();
            lastPointerTime = 0;
            lastPointerX = clientX;
            lastPointerY = clientY;
            recordVelocity(clientX, clientY);
            this.svg.style.cursor = 'grabbing';
        };

        const updatePan = (clientX, clientY) => {
            const appliedMultiplier = this.getPanSpeedMultiplier() * currentPanMultiplier;
            const dx = ((clientX - startX) / this.currentZoom) * appliedMultiplier;
            const dy = ((clientY - startY) / this.currentZoom) * appliedMultiplier;
            this.panX = initialPanX + dx;
            this.panY = initialPanY + dy;
            this.updateViewBox();
            recordVelocity(clientX, clientY);
        };

        const endPan = (options = {}) => {
            if (!isPanning) {
                return;
            }
            isPanning = false;
            panInputType = 'mouse';
            currentPanMultiplier = 1;
            this.svg.style.cursor = 'grab';
            if (!options.skipInertia) {
                const sinceLastSample = lastPointerTime ? performance.now() - lastPointerTime : Infinity;
                if (sinceLastSample <= velocityConfig.flickWindowMs) {
                    const boost = velocityConfig.flickMultiplier;
                    const maxBoosted = velocityConfig.flickMax;
                    this.panVelocityX = Math.max(-maxBoosted, Math.min(maxBoosted, this.panVelocityX * boost));
                    this.panVelocityY = Math.max(-maxBoosted, Math.min(maxBoosted, this.panVelocityY * boost));
                }
                this.startPanInertia();
            }
        };

        this.svg.style.cursor = 'grab';

        this.svg.addEventListener('mousedown', (e) => {
            const isInteractiveElement = e.target.closest('[data-side]') || 
                                       e.target.closest('.color-marker') ||
                                       e.target.closest('[data-point-id]') ||
                                       e.target.classList.contains('color-marker') ||
                                       e.target.closest('#tablePanel');
            if (!isInteractiveElement) {
                e.preventDefault();
                beginPan(e.clientX, e.clientY, 'mouse');
            }
        });

        document.addEventListener('mousemove', (e) => {
            if (!isPanning) {
                return;
            }
            updatePan(e.clientX, e.clientY);
        });

        document.addEventListener('mouseup', () => {
            endPan();
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

            if (touchTarget && touchTarget.closest('#tablePanel')) {
                this.stopPanInertia(true);
                isPanning = false;
                return;
            }

            const isInteractiveElement = touchTarget?.closest('[data-side]') || 
                                       touchTarget?.closest('.color-marker') ||
                                       touchTarget?.closest('[data-point-id]') ||
                                       touchTarget?.classList.contains('color-marker');
            if (!isInteractiveElement) {
                e.preventDefault();
                resetPinchState();
                beginPan(touch.clientX, touch.clientY, 'touch');
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
                return;
            }

            const touch = touches[0];
            const moveTarget = document.elementFromPoint(touch.clientX, touch.clientY);
            if (moveTarget && moveTarget.closest('#tablePanel')) {
                if (isPanning) {
                    this.stopPanInertia(true);
                    this.stopPanAnimation();
                    endPan({ skipInertia: true });
                }
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
                if (now - lastTouchEndTime <= doubleTapThresholdMs) {
                    e.preventDefault();
                }
                lastTouchEndTime = now;
            } else if (endedAllTouches) {
                lastTouchEndTime = now;
            }

            if (pinchActive && touchCount < 2) {
                resetPinchState();
                if (touchCount === 1) {
                    const remainingTouch = touches[0];
                    const remainingTarget = document.elementFromPoint(remainingTouch.clientX, remainingTouch.clientY);
                    if (remainingTarget && remainingTarget.closest('#tablePanel')) {
                        this.stopPanInertia(true);
                        isPanning = false;
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

                const targetZoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.currentZoom * Math.exp(-normalizedDelta * intensity)));
                const anchored = this.computeAnchoredPan(targetZoom, e.clientX, e.clientY);

                this.currentZoom = targetZoom;
                if (anchored) {
                    this.panX = anchored.panX;
                    this.panY = anchored.panY;
                }
                this.updateViewBox();
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
        const zoomRange = Math.max(this.maxZoom - this.minZoom, 0.0001);
        const normalized = (this.currentZoom - this.minZoom) / zoomRange;
        const minMultiplier = 1.3;
        const maxMultiplier = 3.6;

        return minMultiplier + normalized * (maxMultiplier - minMultiplier);
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
        if (this.selectedArea) {
            document.querySelectorAll('.poster-area').forEach(area => {
                area.classList.remove('selected');
            });
            this.selectedArea = null;
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
    computeContentFitZoomAndPan(paddingRatio = 0.1) {
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

        const zoomForWidth = this.baseWidth / width;
        const zoomForHeight = this.baseHeight / height;

        return {
            zoom: Math.min(zoomForWidth, zoomForHeight),
            centerX: minX + width / 2,
            centerY: minY + height / 2
        };
    }

    fitToContent(paddingRatio = 0.1) {
        const fit = this.computeContentFitZoomAndPan(paddingRatio);
        if (!fit) return false;

        let targetZoom = Math.min(this.maxZoom, Math.max(this.minZoom, fit.zoom));

        // The mobile map panel is short and wide (40vh, full width) while the
        // content is tall and narrow, so a pure content-fit zoom still looks
        // small against all the letterboxed empty space on either side.
        // Force a closer starting zoom on narrow viewports; the user can still
        // zoom/pan out from there.
        const isMobileViewport = typeof window !== 'undefined' && window.innerWidth <= 768;
        if (isMobileViewport) {
            const mobileZoomFloor = 2.5;
            targetZoom = Math.min(this.maxZoom, Math.max(targetZoom, mobileZoomFloor));
        }

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

    calculatePanForCoordinates(x, y) {
        const width = this.baseWidth / this.currentZoom;
        const height = this.baseHeight / this.currentZoom;

        const minX = 0;
        const minY = 0;
        const maxX = Math.max(minX, this.baseWidth - width);
        const maxY = Math.max(minY, this.baseHeight - height);

        const desiredX = x - width / 2;
        const desiredY = y - height / 2;

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

    startPanInertia() {
        const minVelocity = 0.0012;
        const currentVelocity = Math.hypot(this.panVelocityX, this.panVelocityY);
        if (currentVelocity < minVelocity) {
            this.stopPanInertia(true);
            return;
        }

        this.stopPanInertia();

        const decay = 0.93;
        let lastTime = performance.now();

        const step = (time) => {
            const dt = time - lastTime;
            lastTime = time;

            this.panX += this.panVelocityX * dt;
            this.panY += this.panVelocityY * dt;
            this.updateViewBox();

            const decayFactor = Math.pow(decay, dt / 16);
            this.panVelocityX *= decayFactor;
            this.panVelocityY *= decayFactor;

            if (Math.hypot(this.panVelocityX, this.panVelocityY) < minVelocity) {
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

function initializeMobileTableScrollFix() {
    const tablePanel = document.getElementById('tablePanel');
    if (!tablePanel) {
        return;
    }

    const tableWrapper = tablePanel.querySelector('.table-responsive');
    if (!tableWrapper) {
        return;
    }

    tableWrapper.addEventListener('touchstart', (ev) => {
        ev.stopPropagation();
    }, { passive: true });

    tableWrapper.addEventListener('touchmove', (ev) => {
        ev.stopPropagation();
    }, { passive: false });

    const mobileQuery = window.matchMedia('(max-width: 768px)');
    const ensureManualTouchScroll = () => {
        if (!mobileQuery.matches) {
            return;
        }

        if (tableWrapper.dataset.manualTouchScroll === 'true') {
            return;
        }

        let lastY = null;
        let lastTime = null;
        let velocityY = 0;
        let inertiaFrame = null;

        // Tuned for a gentle coast rather than a long fling - this hand-rolled
        // touch handler (needed so touchmove can stopPropagation before the
        // map's own pan/pinch handlers see it) replaces native momentum
        // scrolling, so without this the table feels dead/jerky on release.
        const VELOCITY_SMOOTHING = 0.3;
        const MAX_VELOCITY = 1.8; // px/ms, safety clamp on raw finger speed
        const INERTIA_DAMPENING = 0.55; // scales down the captured flick speed
        const INERTIA_DECAY = 0.90; // per ~16ms frame
        const MIN_VELOCITY = 0.03; // px/ms, below this we just stop

        const stopInertia = () => {
            if (inertiaFrame) {
                cancelAnimationFrame(inertiaFrame);
                inertiaFrame = null;
            }
        };

        const startInertia = () => {
            if (Math.abs(velocityY) < MIN_VELOCITY) {
                velocityY = 0;
                return;
            }

            stopInertia();
            let last = performance.now();

            const step = (time) => {
                const dt = time - last;
                last = time;

                const maxScrollTop = tableWrapper.scrollHeight - tableWrapper.clientHeight;
                const nextScrollTop = tableWrapper.scrollTop + velocityY * dt;
                tableWrapper.scrollTop = Math.max(0, Math.min(maxScrollTop, nextScrollTop));

                if (tableWrapper.scrollTop <= 0 || tableWrapper.scrollTop >= maxScrollTop) {
                    velocityY = 0;
                    inertiaFrame = null;
                    return;
                }

                const decayFactor = Math.pow(INERTIA_DECAY, dt / 16);
                velocityY *= decayFactor;

                if (Math.abs(velocityY) < MIN_VELOCITY) {
                    velocityY = 0;
                    inertiaFrame = null;
                    return;
                }

                inertiaFrame = requestAnimationFrame(step);
            };

            inertiaFrame = requestAnimationFrame(step);
        };

        const onTouchStart = (event) => {
            if (event.touches.length !== 1) {
                lastY = null;
                return;
            }
            stopInertia();
            velocityY = 0;
            lastY = event.touches[0].clientY;
            lastTime = performance.now();
        };

        const onTouchMove = (event) => {
            if (event.touches.length !== 1 || lastY === null) {
                return;
            }

            const currentY = event.touches[0].clientY;
            const now = performance.now();
            const deltaY = lastY - currentY;
            const deltaTime = lastTime ? now - lastTime : 0;

            if (Math.abs(deltaY) < 0.5) {
                return;
            }

            const previousScrollTop = tableWrapper.scrollTop;
            tableWrapper.scrollTop += deltaY;
            const scrolled = tableWrapper.scrollTop !== previousScrollTop;

            if (scrolled) {
                event.preventDefault();
            }

            if (deltaTime > 0) {
                const instantVelocity = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, deltaY / deltaTime));
                velocityY = (1 - VELOCITY_SMOOTHING) * velocityY + VELOCITY_SMOOTHING * instantVelocity;
            }

            lastY = currentY;
            lastTime = now;
        };

        const onTouchEnd = () => {
            lastY = null;
            lastTime = null;
            velocityY *= INERTIA_DAMPENING;
            startInertia();
        };

        tableWrapper.addEventListener('touchstart', onTouchStart, { passive: false });
        tableWrapper.addEventListener('touchmove', onTouchMove, { passive: false });
        tableWrapper.addEventListener('touchend', onTouchEnd);
        tableWrapper.addEventListener('touchcancel', onTouchEnd);

        tableWrapper.dataset.manualTouchScroll = 'true';
    };

    let scheduled = false;
    let lastHeight = null;

    const computeHeight = () => {
        if (!mobileQuery.matches) {
            lastHeight = null;
            tableWrapper.style.removeProperty('--table-scroll-max-height');
            tableWrapper.style.removeProperty('height');
            tableWrapper.style.removeProperty('max-height');
            return;
        }

        const isFullscreen = document.body.classList.contains('map-fullscreen');

        if (isFullscreen) {
            if (lastHeight !== null) {
                tableWrapper.style.setProperty('--table-scroll-max-height', `${lastHeight}px`);
                tableWrapper.style.height = `${lastHeight}px`;
                tableWrapper.style.maxHeight = `${lastHeight}px`;
            }
            return;
        }

        const viewportHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        const tableRect = tableWrapper.getBoundingClientRect();
        const marginBottom = 12;
        const minHeight = 180;
        const available = viewportHeight - tableRect.top - marginBottom;

        if (!Number.isFinite(available)) {
            return;
        }

        const nextHeight = Math.max(minHeight, Math.floor(available));

        if (nextHeight === lastHeight) {
            return;
        }

        lastHeight = nextHeight;
        const heightValue = `${nextHeight}px`;
        tableWrapper.style.setProperty('--table-scroll-max-height', heightValue);
        tableWrapper.style.height = heightValue;
        tableWrapper.style.maxHeight = heightValue;
    };

    const scheduleUpdate = () => {
        if (scheduled) {
            return;
        }
        scheduled = true;
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                scheduled = false;
                computeHeight();
                ensureManualTouchScroll();
            });
        });
    };

    const attachMediaListener = () => {
        if (typeof mobileQuery.addEventListener === 'function') {
            mobileQuery.addEventListener('change', scheduleUpdate);
        } else if (typeof mobileQuery.addListener === 'function') {
            mobileQuery.addListener(scheduleUpdate);
        }
    };

    attachMediaListener();

    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('orientationchange', scheduleUpdate);

    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', scheduleUpdate);
        window.visualViewport.addEventListener('scroll', scheduleUpdate);
    }

    const classObserver = new MutationObserver(scheduleUpdate);
    classObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    tablePanel.addEventListener('transitionend', (event) => {
        if (event.target === tablePanel) {
            scheduleUpdate();
        }
    });

    if (typeof ResizeObserver === 'function') {
        const resizeObserver = new ResizeObserver(() => {
            scheduleUpdate();
        });
        resizeObserver.observe(tablePanel);
    }

    ensureManualTouchScroll();
    scheduleUpdate();
}

// Initialize the map when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.posterMap = new PosterSessionMap();
    initializeMobileTableScrollFix();
});

// Export for potential external use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PosterSessionMap;
}
