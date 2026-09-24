// Layout API for SVG Placement and Management

// "Biology" -> "Department", "Biology, Chemistry" -> "Departments"
function departmentLabel(category) {
    const count = String(category || '').split(',').map(c => c.trim()).filter(Boolean).length;
    return count > 1 ? 'Departments' : 'Department';
}

class LayoutAPI {
    constructor(mapInstance) {
        this.map = mapInstance;
        this.layoutElements = new Map();
        this.svgCache = new Map();
        this.loneMarkerBoards = new Set(['HC-1', 'P-13']);
        
        // Create a dedicated layer for poster mounts to ensure they're always on top
        this.posterLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        this.posterLayer.setAttribute('id', 'poster-mounts-layer');
        this.posterLayer.style.pointerEvents = 'all'; // Ensure interactions work
        this.map.svg.appendChild(this.posterLayer);
    }

    isLoneMarkerBoard(easelBoard) {
        return easelBoard ? this.loneMarkerBoards.has(easelBoard) : false;
    }

    /**
     * Calculate appropriate font size based on text length to prevent overflow
     * @param {string} text - The text to size
     * @returns {string} Font size in px
     */
    calculateFontSize(text) {
        if (!text) return '8';
        
        const textLength = text.length;
        
        // Scale font size based on text length to fit in 14px radius circle
        if (textLength <= 2) {
            return '9';  // Default size for short text like "B1", "C5"
        } else if (textLength <= 4) {
            return '7';  // Smaller for medium text like "CS-1", "BCS1"
        } else if (textLength <= 6) {
            return '6';  // Even smaller for longer text like "CSEM-1"
        } else {
            return '5';  // Smallest for very long text
        }
    }

    /**
     * Get appropriate text color based on background color for better contrast.
     * Colors now come from the poster data's own Color column (arbitrary hex
     * values, not a fixed palette), so contrast is computed from luminance
     * rather than matched against a hardcoded list of known colors.
     * @param {string} backgroundColor - The background color hex value
     * @returns {string} Text color (white or black)
     */
    getTextColorForBackground(backgroundColor) {
        const hex = (backgroundColor || '').replace('#', '');
        if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
            return 'white';
        }
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        const brightness = (r * 299 + g * 587 + b * 114) / 1000;
        return brightness > 125 ? 'black' : 'white';
    }

    /**
     * Add an SVG element to the layout
     * @param {Object} config - Layout configuration
     * @param {string} config.id - Unique identifier
     * @param {string} config.svgFile - Path to SVG file or inline SVG content
     * @param {Object} config.position - Position configuration
     * @param {number} config.position.x - X coordinate
     * @param {number} config.position.y - Y coordinate
     * @param {Object} [config.transform] - Transform options
     * @param {number} [config.transform.scale] - Uniform scale factor (default: 1)
     * @param {number} [config.transform.scaleX] - Horizontal scale factor (default: 1)
     * @param {number} [config.transform.scaleY] - Vertical scale factor (default: 1); -1 flips vertically
     * @param {number} [config.transform.rotate] - Rotation in degrees
     * @param {string} [config.transform.anchor] - Transform origin (center, top-left, etc.)
     * @param {Object} [config.style] - Style overrides
     * @param {string} [config.style.fill] - Fill color
     * @param {string} [config.style.stroke] - Stroke color
     * @param {number} [config.style.opacity] - Opacity (0-1)
     * @param {number} [config.zIndex] - Z-index for layering
     * @param {boolean} [config.interactive] - Whether element should be clickable
     * @param {Function} [config.onClick] - Click handler function
     */
    async addSVG(config) {
        try {
            const svgContent = await this.loadSVG(config.svgFile);
            const element = this.createSVGElement(config, svgContent);
            
            this.layoutElements.set(config.id, {
                ...config,
                element: element,
                type: 'svg'
            });

            this.renderElement(config.id);
            return config.id;
        } catch (error) {
            console.error(`Error adding SVG ${config.id}:`, error);
            throw error;
        }
    }

    /**
     * Add a simple shape to the layout
     * @param {Object} config - Shape configuration
     * @param {string} config.id - Unique identifier
     * @param {string} config.type - Shape type (rect, circle, polygon, path)
     * @param {Object} config.geometry - Shape-specific geometry
     * @param {Object} config.position - Position configuration
     * @param {Object} [config.style] - Style configuration
     * @param {boolean} [config.interactive] - Whether element should be clickable
     */
    addShape(config) {
        const element = this.createShapeElement(config);
        
        this.layoutElements.set(config.id, {
            ...config,
            element: element,
            type: 'shape'
        });

        this.renderElement(config.id);
        return config.id;
    }

    /**
     * Position elements relative to other elements
     * @param {Object} config - Relative positioning configuration
     * @param {string} config.id - Element to position
     * @param {string} config.relativeTo - ID of reference element
     * @param {string} config.position - Relative position (above, below, left, right, inside)
     * @param {number} [config.offset] - Distance from reference element
     */
    positionRelativeTo(config) {
        const element = this.layoutElements.get(config.id);
        const reference = this.layoutElements.get(config.relativeTo);
        
        if (!element || !reference) {
            throw new Error(`Element not found: ${config.id} or ${config.relativeTo}`);
        }

        const newPosition = this.calculateRelativePosition(
            reference.position,
            reference.geometry || this.getSVGDimensions(reference.element),
            config.position,
            config.offset || 0
        );

        this.updatePosition(config.id, newPosition);
    }

    /**
     * Create a grid layout for multiple elements
     * @param {Object} config - Grid configuration
     * @param {Array} config.elements - Array of element IDs
     * @param {Object} config.grid - Grid configuration
     * @param {number} config.grid.cols - Number of columns
     * @param {number} config.grid.rows - Number of rows
     * @param {Object} config.area - Area to place grid in
     * @param {number} config.spacing - Spacing between elements
     */
    createGrid(config) {
        const { elements, grid, area, spacing = 20 } = config;
        const cellWidth = (area.width - (spacing * (grid.cols - 1))) / grid.cols;
        const cellHeight = (area.height - (spacing * (grid.rows - 1))) / grid.rows;

        elements.forEach((elementId, index) => {
            const row = Math.floor(index / grid.cols);
            const col = index % grid.cols;
            
            const x = area.x + (col * (cellWidth + spacing));
            const y = area.y + (row * (cellHeight + spacing));
            
            this.updatePosition(elementId, { x, y });
        });
    }

    /**
     * Load SVG content from file or return inline content
     */
    async loadSVG(svgSource) {
        if (svgSource.startsWith('<svg')) {
            return svgSource; // Inline SVG
        }

        if (this.svgCache.has(svgSource)) {
            return this.svgCache.get(svgSource);
        }

        try {
            const response = await fetch(svgSource);
            const svgText = await response.text();
            this.svgCache.set(svgSource, svgText);
            return svgText;
        } catch (error) {
            throw new Error(`Failed to load SVG: ${svgSource}`);
        }
    }

    /**
     * Create SVG element from configuration
     */
    createSVGElement(config, svgContent) {
        const parser = new DOMParser();
        const svgDoc = parser.parseFromString(svgContent, 'image/svg+xml');
        const svgElement = svgDoc.documentElement;

        // Extract path data from the SVG, skipping anything defined inside
        // <defs>/<clipPath>/<mask>/<symbol> (e.g. clipPath rects) - those are
        // definitions, not visible content, and must not be drawn directly
        const paths = Array.from(svgElement.querySelectorAll('path, rect, circle, polygon'))
            .filter(el => !el.closest('defs, clipPath, mask, symbol'));
        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.setAttribute('id', config.id);

        // Apply transform
        const transform = this.buildTransform(config);
        if (transform) {
            group.setAttribute('transform', transform);
        }

        // Copy all paths/shapes to the group
        paths.forEach(path => {
            const clonedPath = path.cloneNode(true);
            
            // Apply style overrides (force override existing fills)
            if (config.style) {
                if (config.style.fill) {
                    clonedPath.setAttribute('fill', config.style.fill);
                    clonedPath.style.fill = config.style.fill; // Force override
                }
                if (config.style.stroke) {
                    clonedPath.setAttribute('stroke', config.style.stroke);
                    clonedPath.style.stroke = config.style.stroke;
                }
                if (config.style.strokeWidth) {
                    clonedPath.setAttribute('stroke-width', config.style.strokeWidth);
                    clonedPath.style.strokeWidth = config.style.strokeWidth;
                }
                if (config.style.opacity) {
                    clonedPath.setAttribute('opacity', config.style.opacity);
                    clonedPath.style.opacity = config.style.opacity;
                }
            }

            // Add interactivity
            if (config.interactive) {
                clonedPath.style.cursor = 'pointer';
                clonedPath.setAttribute('tabindex', '0');
                clonedPath.setAttribute('role', 'button');
                
                if (config.onClick) {
                    clonedPath.addEventListener('click', config.onClick);
                    clonedPath.addEventListener('touchend', (e) => {
                        e.preventDefault();
                        config.onClick(e);
                    });
                }
            }

            group.appendChild(clonedPath);
        });

        return group;
    }

    /**
     * Create shape element from configuration
     */
    createShapeElement(config) {
        let element;
        const { type, geometry, position, style = {} } = config;

        switch (type) {
            case 'rect':
                element = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                element.setAttribute('x', position.x);
                element.setAttribute('y', position.y);
                element.setAttribute('width', geometry.width);
                element.setAttribute('height', geometry.height);
                if (geometry.rx) element.setAttribute('rx', geometry.rx);
                break;

            case 'circle':
                element = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                element.setAttribute('cx', position.x);
                element.setAttribute('cy', position.y);
                element.setAttribute('r', geometry.radius);
                break;

            case 'polygon':
                element = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
                element.setAttribute('points', geometry.points);
                break;

            case 'path':
                element = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                element.setAttribute('d', geometry.d);
                break;

            default:
                throw new Error(`Unknown shape type: ${type}`);
        }

        // Apply styles
        element.setAttribute('fill', style.fill || '#D9D9D9');
        if (style.stroke) element.setAttribute('stroke', style.stroke);
        if (style.strokeWidth) element.setAttribute('stroke-width', style.strokeWidth);
        if (style.opacity) element.setAttribute('opacity', style.opacity);

        // Add interactivity
        if (config.interactive && config.onClick) {
            element.style.cursor = 'pointer';
            element.addEventListener('click', config.onClick);
            element.addEventListener('touchend', (e) => {
                e.preventDefault();
                config.onClick(e);
            });
        }

        element.setAttribute('id', config.id);
        return element;
    }

    /**
     * Build transform string from configuration
     */
    buildTransform(config) {
        const transforms = [];
        
        // Position
        if (config.position) {
            transforms.push(`translate(${config.position.x}, ${config.position.y})`);
        }

        // Additional transforms
        if (config.transform) {
            if (config.transform.scale && config.transform.scale !== 1) {
                transforms.push(`scale(${config.transform.scale})`);
            }
            if (config.transform.scaleX && config.transform.scaleX !== 1) {
                const sy = config.transform.scaleY === -1 ? -1 : (config.transform.scaleY || 1);
                transforms.push(`scale(${config.transform.scaleX}, ${sy})`);
            } else if (config.transform.scaleY && config.transform.scaleY === -1) {
                // For vertical flip, use scale(1, -1) which flips around the center
                transforms.push(`scale(1, -1)`);
            } else if (config.transform.scaleY && config.transform.scaleY !== 1) {
                transforms.push(`scale(1, ${config.transform.scaleY})`);
            }
            if (config.transform.rotate) {
                const anchor = config.transform.anchor || 'center';
                // You can extend this to calculate actual anchor points
                transforms.push(`rotate(${config.transform.rotate})`);
            }
        }

        return transforms.length > 0 ? transforms.join(' ') : null;
    }

    /**
     * Calculate relative position
     */
    calculateRelativePosition(refPosition, refGeometry, position, offset) {
        const newPos = { ...refPosition };
        
        switch (position) {
            case 'above':
                newPos.y = refPosition.y - offset;
                break;
            case 'below':
                newPos.y = refPosition.y + refGeometry.height + offset;
                break;
            case 'left':
                newPos.x = refPosition.x - offset;
                break;
            case 'right':
                newPos.x = refPosition.x + refGeometry.width + offset;
                break;
            case 'inside-center':
                newPos.x = refPosition.x + refGeometry.width / 2;
                newPos.y = refPosition.y + refGeometry.height / 2;
                break;
        }
        
        return newPos;
    }

    /**
     * Update element position
     */
    updatePosition(elementId, newPosition) {
        const layoutElement = this.layoutElements.get(elementId);
        if (!layoutElement) return;

        layoutElement.position = newPosition;
        
        // Update the actual SVG element
        const currentTransform = layoutElement.element.getAttribute('transform') || '';
        const newTransform = currentTransform.replace(
            /translate\([^)]+\)/,
            `translate(${newPosition.x}, ${newPosition.y})`
        ) || `translate(${newPosition.x}, ${newPosition.y})`;
        
        layoutElement.element.setAttribute('transform', newTransform);
    }

    /**
     * Render element to the map
     */
    renderElement(elementId) {
        const layoutElement = this.layoutElements.get(elementId);
        if (!layoutElement) return;

        // Determine which group to add to based on element type
        let targetGroup;
        if (layoutElement.type === 'poster-mount' || layoutElement.type === 'lone-marker') {
            // Poster mounts and lone markers always go to the top layer
            targetGroup = this.posterLayer;
        } else if (layoutElement.zIndex && layoutElement.zIndex > 100) {
            targetGroup = this.map.markersGroup;
        } else {
            targetGroup = this.map.posterAreasGroup;
        }

        targetGroup.appendChild(layoutElement.element);
        
        // Ensure poster layer stays on top after any element is added
        this.ensurePosterLayerOnTop();
    }

    /**
     * Ensure the poster layer is always rendered on top of other elements
     */
    ensurePosterLayerOnTop() {
        // Move the poster layer to the end of the SVG (renders last = on top)
        if (this.posterLayer.parentNode) {
            this.posterLayer.parentNode.appendChild(this.posterLayer);
        }
    }

    /**
     * Remove element from layout
     */
    removeElement(elementId) {
        const layoutElement = this.layoutElements.get(elementId);
        if (layoutElement && layoutElement.element.parentNode) {
            layoutElement.element.parentNode.removeChild(layoutElement.element);
        }
        this.layoutElements.delete(elementId);
    }

    /**
     * Get all elements in the layout
     */
    getAllElements() {
        return Array.from(this.layoutElements.keys());
    }

    /**
     * Export layout configuration
     */
    exportLayout() {
        const layout = {};
        this.layoutElements.forEach((element, id) => {
            layout[id] = {
                id: element.id,
                type: element.type,
                position: element.position,
                transform: element.transform,
                style: element.style,
                interactive: element.interactive
            };
        });
        return layout;
    }

    /**
     * Add a lone marker for a single poster (not on a mount)
     * @param {Object} config - Lone marker configuration
     * @param {string} config.id - Unique identifier
     * @param {Object} config.position - Position configuration
     * @param {number} config.position.x - X coordinate
     * @param {number} config.position.y - Y coordinate
     * @param {string} [config.orientation] - 'vertical' or 'horizontal' board orientation
     * @param {Object} config.poster - Poster information
     * @param {Object} [config.style] - Style overrides
     */
    addLoneMarker(config) {
        const orientation = (config.orientation || 'vertical').toLowerCase();
        const element = this.createLoneMarkerElement({ ...config, orientation });
        
        this.layoutElements.set(config.id, {
            ...config,
            orientation,
            element: element,
            type: 'lone-marker'
        });

        this.renderElement(config.id);
        return config.id;
    }

    /**
     * Create lone marker SVG element
     */
    createLoneMarkerElement(config) {
        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.setAttribute('id', config.id);

        // Apply transform
        const transform = this.buildTransform(config);
        if (transform) {
            group.setAttribute('transform', transform);
        }

        const orientation = (config.orientation || 'vertical').toLowerCase();
        const isVertical = orientation === 'vertical';
        const boardWidth = isVertical ? 10 : 60;
        const boardHeight = isVertical ? 60 : 10;

        const board = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        board.setAttribute('x', -boardWidth / 2);
        board.setAttribute('y', -boardHeight / 2);
        board.setAttribute('width', boardWidth);
        board.setAttribute('height', boardHeight);
        board.setAttribute('rx', 2);
        board.setAttribute('fill', config.style?.boardFill || '#4a4a4a');
        board.setAttribute('stroke', config.style?.boardStroke || '#2a2a2a');
        board.setAttribute('stroke-width', config.style?.boardStrokeWidth || 1);
        board.setAttribute('pointer-events', 'none');
        group.appendChild(board);

        // Create the marker circle
        const marker = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        marker.setAttribute('cx', 0);
        marker.setAttribute('cy', 0);
        marker.setAttribute('r', 14);
        marker.setAttribute('fill', config.poster.color || '#404040');
        marker.setAttribute('stroke', 'white');
        marker.setAttribute('stroke-width', 2);
        marker.style.cursor = 'pointer';
        marker.style.transition = 'r 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), filter 0.2s ease-out';
        marker.setAttribute('tabindex', '0');
        marker.setAttribute('role', 'button');
        marker.setAttribute('aria-label', `Poster: ${config.poster.title}`);
        marker.setAttribute('data-easel', config.poster?.easelBoard || '');
        marker.classList.add('color-marker');

        // Add text for the marker showing easel ID with dynamic sizing
        const markerText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        markerText.setAttribute('x', 0);
        markerText.setAttribute('y', 1); // Slight vertical offset for better centering
        markerText.setAttribute('text-anchor', 'middle');
        markerText.setAttribute('dominant-baseline', 'central');
        markerText.setAttribute('font-family', 'Arial, sans-serif');
        
        // Dynamic font sizing based on text length
        const easelBoard = config.poster.easelBoard || '';
        const fontSize = this.calculateFontSize(easelBoard);
        markerText.setAttribute('font-size', fontSize);
        
        // Store original font size for hover effect
        markerText.setAttribute('data-original-font-size', fontSize);
        
        markerText.setAttribute('font-weight', 'bold');
        // Use dynamic text color based on background color for better contrast
        const backgroundColor = config.poster.color || '#404040';
        const textColor = this.getTextColorForBackground(backgroundColor);
        markerText.setAttribute('fill', textColor);
        markerText.setAttribute('pointer-events', 'none'); // Make text non-interactive to prevent hover conflicts
        markerText.style.transition = 'font-size 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)';
        markerText.textContent = easelBoard;

        // Add invisible touch area for easier mobile interaction
        const touchArea = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        touchArea.setAttribute('cx', 0);
        touchArea.setAttribute('cy', 0);
        touchArea.setAttribute('r', 28); // Slightly larger to accommodate expanded circle
        touchArea.setAttribute('fill', 'transparent');
        touchArea.style.cursor = 'pointer';

        const originalFontSize = Number(fontSize);

        const isMultiTouchGestureActive = () => Boolean(window.posterMap && window.posterMap.isMultiTouchGesture);

        const activateMarker = () => {
            marker.setAttribute('r', '16');
            marker.style.filter = 'drop-shadow(0 3px 8px rgba(0,0,0,0.3))';

            if (!Number.isNaN(originalFontSize) && originalFontSize > 0) {
                markerText.setAttribute('font-size', originalFontSize * 1.2);
            }
        };

        const resetMarker = () => {
            marker.setAttribute('r', '14');
            marker.style.filter = 'none';

            const storedFontSize = markerText.getAttribute('data-original-font-size');
            if (storedFontSize) {
                markerText.setAttribute('font-size', storedFontSize);
            }
        };

        // Create a shared timer for all markers to prevent conflicts
        if (!window.posterInfoTimer) {
            window.posterInfoTimer = null;
        }
        
        // Mouse velocity tracking to disable tooltips during fast movement
        if (!window.mouseVelocityTracker) {
            window.mouseVelocityTracker = {
                lastX: 0,
                lastY: 0,
                lastTime: 0,
                velocity: 0,
                updateVelocity: function(x, y) {
                    const now = Date.now();
                    const deltaTime = now - this.lastTime;
                    
                    if (deltaTime > 0 && this.lastTime > 0) {
                        const deltaX = x - this.lastX;
                        const deltaY = y - this.lastY;
                        const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
                        this.velocity = distance / deltaTime; // pixels per millisecond
                    }
                    
                    this.lastX = x;
                    this.lastY = y;
                    this.lastTime = now;
                }
            };
            
            // Global mouse move tracking
            document.addEventListener('mousemove', (e) => {
                window.mouseVelocityTracker.updateVelocity(e.clientX, e.clientY);
            });
        }
        
        const showPosterInfo = (options = {}) => {
            const { moveFocus = false } = options;
            if (isMultiTouchGestureActive()) {
                return;
            }
            // Always cancel any pending hide timer first
            if (window.posterInfoTimer) {
                clearTimeout(window.posterInfoTimer);
                window.posterInfoTimer = null;
            }

            // Reduced delay for faster switching between markers
            const showDelay = 50; // Reduced from 150ms to 50ms
            window.posterInfoTimer = setTimeout(() => {
                if (isMultiTouchGestureActive()) {
                    window.posterInfoTimer = null;
                    return;
                }
                // Only check velocity if mouse is moving very fast (increased threshold)
                const velocityThreshold = 2.0; // Increased from 0.8 to 2.0
                if (window.mouseVelocityTracker && window.mouseVelocityTracker.velocity > velocityThreshold) {
                    return; // Only skip if moving extremely fast
                }

                if (window.posterMap) {
                    const easel = config.poster.easelBoard || 'N/A';
                    const title = config.poster.title || 'Poster Information';
                    const bgColor = config.poster.color || '#404040';
                    const textColor = window.layout?.getTextColorForBackground?.(bgColor) || 'white';
                    const fontSize = easel.length <= 2 ? 13 : easel.length <= 4 ? 11 : easel.length <= 6 ? 10 : 9;
                    window.posterMap.infoTitle.innerHTML = `
                        <span class="easel-pill" data-easel="${easel}">
                            <svg class="easel-pill__svg" viewBox="0 0 36 36" role="presentation">
                                <circle cx="18" cy="18" r="16" fill="${bgColor}" stroke="white" stroke-width="2"></circle>
                                <text x="18" y="18" fill="${textColor}" font-size="${fontSize}" dominant-baseline="middle" text-anchor="middle">${easel}</text>
                            </svg>
                        </span>
                        <span class="title-text">${title}</span>
                    `;
                    window.posterMap.infoDescription.innerHTML = `
                        <p><strong>Student(s):</strong> ${config.poster.students || 'N/A'}</p>
                        <p class="tt-mentor"><strong>Faculty/Mentor:</strong> ${config.poster.facultyMentor || 'N/A'}</p>
                        <p><strong>${departmentLabel(config.poster.category)}:</strong> ${config.poster.category || 'N/A'}</p>
                    `;
                    window.posterMap.infoPanel.setAttribute('aria-label', title);

                    // Safe-area-aware placement + live tracking (Poster Map
                    // Tooltip Containment PRD) - replaces the old
                    // viewport-only positionInfoPanelSmart().
                    window.posterMap.showMarkerTooltip(marker, { easel, moveFocus });
                }
                window.posterInfoTimer = null;
            }, showDelay);
        };
        

        const hidePosterInfo = () => {
            // Use the global timer to prevent conflicts between markers
            if (window.posterInfoTimer) {
                clearTimeout(window.posterInfoTimer);
            }

            window.posterInfoTimer = setTimeout(() => {
                if (window.posterMap && typeof window.posterMap.hideInfo === 'function') {
                    window.posterMap.hideInfo();
                }
                window.posterInfoTimer = null;
            }, 200); // Increased delay to prevent flickering
        };

        // Add hover effects for balloon animation and info display
        marker.addEventListener('mouseenter', () => {
            activateMarker();

            // Show mount ID in console for dev debugging
            showPosterInfo();
        });

        marker.addEventListener('mouseleave', () => {
            resetMarker();
            hidePosterInfo();
        });

        // Touch events
        marker.addEventListener('touchstart', (e) => {
            if ((e.touches && e.touches.length > 1) || isMultiTouchGestureActive()) {
                return;
            }
            e.preventDefault();
            activateMarker();
            showPosterInfo({ moveFocus: true });
        });

        marker.addEventListener('touchend', () => {
            resetMarker();
        });

        marker.addEventListener('touchcancel', () => {
            resetMarker();
        });

        // Keyboard support
        marker.addEventListener('focus', () => {
            activateMarker();
            showPosterInfo({ moveFocus: true });
        });

        marker.addEventListener('blur', () => {
            resetMarker();
            hidePosterInfo();
        });

        marker.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                showPosterInfo({ moveFocus: true });
            }
        });

        // Append all elements
        group.appendChild(marker);
        group.appendChild(markerText);

        return group;
    }

    /**
     * Add a poster mount with two-sided poster display
     * @param {Object} config - Poster mount configuration
     * @param {string} config.id - Unique identifier
     * @param {Object} config.position - Position configuration
     * @param {number} config.position.x - X coordinate
     * @param {number} config.position.y - Y coordinate
     * @param {string} config.orientation - 'vertical' or 'horizontal'
     * @param {Object} config.sideA - Poster A information
     * @param {Object} config.sideB - Poster B information
     * @param {Object} [config.style] - Style overrides
     */
    addPosterMount(config) {
        const element = this.createPosterMountElement(config);
        
        this.layoutElements.set(config.id, {
            ...config,
            element: element,
            type: 'poster-mount'
        });

        this.renderElement(config.id);
        return config.id;
    }

    /**
     * Create poster mount SVG element
     */
    createPosterMountElement(config) {
        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.setAttribute('id', config.id);

        // Apply transform
        const transform = this.buildTransform(config);
        if (transform) {
            group.setAttribute('transform', transform);
        }

        // Determine mount dimensions based on orientation - made larger and more proportional
        const isVertical = config.orientation === 'vertical';
        const width = isVertical ? 10 : 60;
        const height = isVertical ? 60 : 10;

        // Create the mount base (thin rectangle)
        const mount = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        mount.setAttribute('x', -width/2);
        mount.setAttribute('y', -height/2);
        mount.setAttribute('width', width);
        mount.setAttribute('height', height);
        mount.setAttribute('rx', 2);
        mount.setAttribute('fill', config.style?.fill || '#4a4a4a');
        mount.setAttribute('stroke', config.style?.stroke || '#2a2a2a');
        mount.setAttribute('stroke-width', config.style?.strokeWidth || 1);

        // Create side A indicator (left or top side) - Mobile-friendly touch target
        const sideAIndicator = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        const offsetA = isVertical ? { x: -width/1.5, y: -height/2.8 } : { x: -width/3, y: -height/2.5 };
        sideAIndicator.setAttribute('cx', offsetA.x);
        sideAIndicator.setAttribute('cy', offsetA.y);
        sideAIndicator.setAttribute('r', 14); // Same size for all mounts
        sideAIndicator.setAttribute('fill', config.sideA.color || '#404040');
        sideAIndicator.setAttribute('stroke', 'white');
        sideAIndicator.setAttribute('stroke-width', 2);
        sideAIndicator.style.cursor = 'pointer';
        sideAIndicator.style.transition = 'r 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), filter 0.2s ease-out';
        sideAIndicator.setAttribute('data-side', 'A');
        sideAIndicator.setAttribute('data-easel', config.sideA?.easelBoard || '');
        sideAIndicator.setAttribute('tabindex', '0');
        sideAIndicator.setAttribute('role', 'button');
        sideAIndicator.setAttribute('aria-label', `Poster A: ${config.sideA.title}`);
        sideAIndicator.classList.add('color-marker');
        
        // Add text for side A showing easel ID with dynamic sizing
        const sideAText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        sideAText.setAttribute('x', offsetA.x);
        sideAText.setAttribute('y', offsetA.y + 1); // Slight vertical offset for better centering
        sideAText.setAttribute('text-anchor', 'middle');
        sideAText.setAttribute('dominant-baseline', 'central');
        sideAText.setAttribute('font-family', 'Arial, sans-serif');
        sideAText.setAttribute('data-side', 'A');
        
        // Dynamic font sizing based on text length
        const sideAEaselBoard = config.sideA.easelBoard || '';
        const sideAFontSize = this.calculateFontSize(sideAEaselBoard);
        sideAText.setAttribute('font-size', sideAFontSize);
        
        // Store original font size for hover effect
        sideAText.setAttribute('data-original-font-size', sideAFontSize);
        
        sideAText.setAttribute('font-weight', 'bold');
        // Use dynamic text color based on background color for better contrast
        const sideABackgroundColor = config.sideA.color || '#404040';
        const sideATextColor = this.getTextColorForBackground(sideABackgroundColor);
        sideAText.setAttribute('fill', sideATextColor);
        sideAText.setAttribute('pointer-events', 'none'); // Make text non-interactive to prevent hover conflicts
        sideAText.style.transition = 'font-size 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)';
        sideAText.textContent = sideAEaselBoard;
        
        // Add invisible touch area for easier mobile interaction
        const sideATouchArea = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        sideATouchArea.setAttribute('cx', offsetA.x);
        sideATouchArea.setAttribute('cy', offsetA.y);
        sideATouchArea.setAttribute('r', 28); // Slightly larger to accommodate expanded circle
        sideATouchArea.setAttribute('fill', 'transparent');
        sideATouchArea.style.cursor = 'pointer';
        sideATouchArea.setAttribute('data-side', 'A');

        // Create side B indicator (right or bottom side) - Mobile-friendly touch target
        const sideBIndicator = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        const offsetB = isVertical ? { x: width/1.5, y: height/2.8 } : { x: width/3, y: height/2.5 };
        sideBIndicator.setAttribute('cx', offsetB.x);
        sideBIndicator.setAttribute('cy', offsetB.y);
        sideBIndicator.setAttribute('r', 14); // Same size for all mounts
        sideBIndicator.setAttribute('fill', config.sideB.color || '#404040');
        sideBIndicator.setAttribute('stroke', 'white');
        sideBIndicator.setAttribute('stroke-width', 2);
        sideBIndicator.style.cursor = 'pointer';
        sideBIndicator.style.transition = 'r 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), filter 0.2s ease-out';
        sideBIndicator.setAttribute('data-side', 'B');
        sideBIndicator.setAttribute('data-easel', config.sideB?.easelBoard || '');
        sideBIndicator.setAttribute('tabindex', '0');
        sideBIndicator.setAttribute('role', 'button');
        sideBIndicator.setAttribute('aria-label', `Poster B: ${config.sideB.title}`);
        sideBIndicator.classList.add('color-marker');
        
        // Add text for side B showing easel ID with dynamic sizing
        const sideBText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        sideBText.setAttribute('x', offsetB.x);
        sideBText.setAttribute('y', offsetB.y + 1); // Slight vertical offset for better centering
        sideBText.setAttribute('text-anchor', 'middle');
        sideBText.setAttribute('dominant-baseline', 'central');
        sideBText.setAttribute('font-family', 'Arial, sans-serif');
        sideBText.setAttribute('data-side', 'B');
        
        // Dynamic font sizing based on text length
        const sideBEaselBoard = config.sideB.easelBoard || '';
        const sideBFontSize = this.calculateFontSize(sideBEaselBoard);
        sideBText.setAttribute('font-size', sideBFontSize);
        
        // Store original font size for hover effect
        sideBText.setAttribute('data-original-font-size', sideBFontSize);
        
        sideBText.setAttribute('font-weight', 'bold');
        // Use dynamic text color based on background color for better contrast
        const sideBBackgroundColor = config.sideB.color || '#404040';
        const sideBTextColor = this.getTextColorForBackground(sideBBackgroundColor);
        sideBText.setAttribute('fill', sideBTextColor);
        sideBText.setAttribute('pointer-events', 'none'); // Make text non-interactive to prevent hover conflicts
        sideBText.style.transition = 'font-size 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)';
        sideBText.textContent = sideBEaselBoard;
        
        // Add invisible touch area for easier mobile interaction
        const sideBTouchArea = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        sideBTouchArea.setAttribute('cx', offsetB.x);
        sideBTouchArea.setAttribute('cy', offsetB.y);
        sideBTouchArea.setAttribute('r', 28); // Slightly larger to accommodate expanded circle
        sideBTouchArea.setAttribute('fill', 'transparent');
        sideBTouchArea.style.cursor = 'pointer';
        sideBTouchArea.setAttribute('data-side', 'B');

        const isMultiTouchGestureActive = () => Boolean(window.posterMap && window.posterMap.isMultiTouchGesture);

        const activateIndicator = (indicator, text) => {
            indicator.setAttribute('r', '16');
            indicator.style.filter = 'drop-shadow(0 3px 8px rgba(0,0,0,0.3))';

            const originalFontSize = Number(text.getAttribute('data-original-font-size'));
            if (!Number.isNaN(originalFontSize) && originalFontSize > 0) {
                text.setAttribute('font-size', originalFontSize * 1.2);
            }
        };

        const resetIndicator = (indicator, text) => {
            indicator.setAttribute('r', '14');
            indicator.style.filter = 'none';

            const storedFontSize = text.getAttribute('data-original-font-size');
            if (storedFontSize) {
                text.setAttribute('font-size', storedFontSize);
            }
        };

        const attachInteractiveHandlers = (side, indicator, text) => {
            indicator.addEventListener('mouseenter', () => {
                activateIndicator(indicator, text);
                showPosterInfo(side);
            });

            indicator.addEventListener('mouseleave', () => {
                resetIndicator(indicator, text);
                hidePosterInfo();
            });

            indicator.addEventListener('touchstart', (e) => {
                if ((e.touches && e.touches.length > 1) || isMultiTouchGestureActive()) {
                    return;
                }
                e.preventDefault();
                activateIndicator(indicator, text);
                showPosterInfo(side, { moveFocus: true });
            });

            indicator.addEventListener('touchend', () => {
                resetIndicator(indicator, text);
            });

            indicator.addEventListener('touchcancel', () => {
                resetIndicator(indicator, text);
            });

            indicator.addEventListener('focus', () => {
                activateIndicator(indicator, text);
                showPosterInfo(side, { moveFocus: true });
            });

            indicator.addEventListener('blur', () => {
                resetIndicator(indicator, text);
                hidePosterInfo();
            });

            indicator.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    activateIndicator(indicator, text);
                    showPosterInfo(side, { moveFocus: true });
                }
            });
        };

        attachInteractiveHandlers('A', sideAIndicator, sideAText);
        attachInteractiveHandlers('B', sideBIndicator, sideBText);

        // Create a shared timer for all markers on this mount to prevent conflicts
        if (!window.posterInfoTimer) {
            window.posterInfoTimer = null;
        }
        
        // Mouse velocity tracking to disable tooltips during fast movement
        if (!window.mouseVelocityTracker) {
            window.mouseVelocityTracker = {
                lastX: 0,
                lastY: 0,
                lastTime: 0,
                velocity: 0,
                updateVelocity: function(x, y) {
                    const now = Date.now();
                    const deltaTime = now - this.lastTime;
                    
                    if (deltaTime > 0 && this.lastTime > 0) {
                        const deltaX = x - this.lastX;
                        const deltaY = y - this.lastY;
                        const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
                        this.velocity = distance / deltaTime; // pixels per millisecond
                    }
                    
                    this.lastX = x;
                    this.lastY = y;
                    this.lastTime = now;
                }
            };
            
            // Global mouse move tracking
            document.addEventListener('mousemove', (e) => {
                window.mouseVelocityTracker.updateVelocity(e.clientX, e.clientY);
            });
        }
        
        const showPosterInfo = (side, options = {}) => {
            const { moveFocus = false } = options;
            if (isMultiTouchGestureActive()) {
                return;
            }
            // Always cancel any pending hide timer first
            if (window.posterInfoTimer) {
                clearTimeout(window.posterInfoTimer);
                window.posterInfoTimer = null;
            }

            const poster = side === 'A' ? config.sideA : config.sideB;
            const markerElement = side === 'A' ? sideAIndicator : sideBIndicator;

            // Reduced delay for faster switching between markers
            const showDelay = 50; // Reduced from 150ms to 50ms
            window.posterInfoTimer = setTimeout(() => {
                if (isMultiTouchGestureActive()) {
                    window.posterInfoTimer = null;
                    return;
                }
                // Only check velocity if mouse is moving very fast (increased threshold)
                const velocityThreshold = 2.0; // Increased from 0.8 to 2.0
                if (window.mouseVelocityTracker && window.mouseVelocityTracker.velocity > velocityThreshold) {
                    return; // Only skip if moving extremely fast
                }

                if (window.posterMap) {
                    const easel = poster.easelBoard || poster.session || 'N/A';
                    const title = poster.title || 'Poster Information';
                    const bgColor = poster.color || '#404040';
                    const textColor = window.layout?.getTextColorForBackground?.(bgColor) || 'white';
                    const fontSize = easel.length <= 2 ? 12 : easel.length <= 4 ? 10 : easel.length <= 6 ? 9 : 8;
                    window.posterMap.infoTitle.innerHTML = `
                        <span class="easel-pill" data-easel="${easel}">
                            <svg class="easel-pill__svg" viewBox="0 0 36 36" role="presentation">
                                <circle cx="18" cy="18" r="16" fill="${bgColor}" stroke="white" stroke-width="2"></circle>
                                <text x="18" y="18" fill="${textColor}" font-size="${fontSize}" dominant-baseline="middle" text-anchor="middle">${easel}</text>
                            </svg>
                        </span>
                        <span class="title-text">${title}</span>
                    `;
                    window.posterMap.infoDescription.innerHTML = `
                        <p><strong>Student(s):</strong> ${poster.students || poster.authors || 'N/A'}</p>
                        <p class="tt-mentor"><strong>Faculty/Mentor:</strong> ${poster.facultyMentor || 'N/A'}</p>
                        <p><strong>${departmentLabel(poster.category)}:</strong> ${poster.category || 'N/A'}</p>
                    `;
                    window.posterMap.infoPanel.setAttribute('aria-label', title);

                    // Safe-area-aware placement + live tracking (Poster Map
                    // Tooltip Containment PRD) - replaces the old
                    // viewport-only positionInfoPanelSmart().
                    window.posterMap.showMarkerTooltip(markerElement, { easel, moveFocus });
                }
                window.posterInfoTimer = null;
            }, showDelay);
        };
        

        const hidePosterInfo = () => {
            // Use the global timer to prevent conflicts between markers
            if (window.posterInfoTimer) {
                clearTimeout(window.posterInfoTimer);
            }

            window.posterInfoTimer = setTimeout(() => {
                if (window.posterMap && typeof window.posterMap.hideInfo === 'function') {
                    window.posterMap.hideInfo();
                }
                window.posterInfoTimer = null;
            }, 200); // Increased delay to prevent flickering
        };

        // Combined hover effects for balloon animation and info display

        // Append all elements - skip markers for sides with no poster assigned
        const sideAUnassigned = !sideAEaselBoard || sideAEaselBoard === 'Unassigned';
        const sideBUnassigned = !sideBEaselBoard || sideBEaselBoard === 'Unassigned';

        group.appendChild(mount);
        if (!sideAUnassigned) {
            group.appendChild(sideAIndicator);
            group.appendChild(sideAText);
        }
        if (!sideBUnassigned) {
            group.appendChild(sideBIndicator);
            group.appendChild(sideBText);
        }

        return group;
    }

    /**
     * Parse a tab-separated file's raw text into an array of row arrays,
     * un-escaping any RFC4180-style quoted cells (spreadsheet TSV exports
     * often wrap a comma-containing field in "double quotes" even though
     * comma isn't the delimiter - without unquoting, those quote marks
     * would show up literally in the UI).
     */
    parseTsvText(tsvText) {
        return tsvText
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .split('\n')
            .filter(line => line.length > 0)
            .map(line => line.split('\t').map(cell => {
                const trimmed = cell.trim();
                if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
                    return trimmed.slice(1, -1).replace(/""/g, '"');
                }
                return trimmed;
            }));
    }

    /**
     * Parse the combined poster-data.tsv format (one row per poster, with its
     * mount position/orientation and marker color inline) into poster objects.
     */
    parsePosterDataTSV(tsvText) {
        const rows = this.parseTsvText(tsvText);
        if (rows.length === 0) return [];

        const headers = rows[0];
        const findIndex = (names) => {
            const searchTerms = Array.isArray(names) ? names : [names];
            for (const name of searchTerms) {
                const index = headers.indexOf(name);
                if (index !== -1) return index;
            }
            return -1;
        };
        const getValue = (values, index) => (index >= 0 && index < values.length) ? (values[index] || '') : '';

        const categoryIndex = findIndex(['Poster Category', 'Category']);
        const easelBoardIndex = findIndex('Easel Board');
        const titleIndex = findIndex('Poster Title');
        const studentsIndex = findIndex(['Students', 'Student(s)']);
        const mentorIndex = findIndex(['Faculty', 'Faculty/Mentor']);
        const mountIdIndex = findIndex('Mount ID');
        const sideIndex = findIndex('Side');
        const xCoordIndex = findIndex('X Coordinate');
        const yCoordIndex = findIndex('Y Coordinate');
        const orientationIndex = findIndex('Orientation');
        const colorIndex = findIndex('Color');

        const posters = [];
        for (let i = 1; i < rows.length; i++) {
            const values = rows[i];
            if (!values.some(v => v)) continue; // skip blank lines

            posters.push({
                category: getValue(values, categoryIndex),
                easelBoard: getValue(values, easelBoardIndex),
                title: getValue(values, titleIndex),
                students: getValue(values, studentsIndex),
                facultyMentor: getValue(values, mentorIndex),
                mountId: getValue(values, mountIdIndex),
                side: getValue(values, sideIndex),
                xCoord: parseFloat(getValue(values, xCoordIndex)),
                yCoord: parseFloat(getValue(values, yCoordIndex)),
                orientation: (getValue(values, orientationIndex) || 'vertical').toLowerCase(),
                color: getValue(values, colorIndex)
            });
        }

        return posters;
    }

    /**
     * Load posters from the combined poster-data.tsv file and create poster mounts
     * @param {string} dataTsvUrl - URL to the combined poster-data.tsv file
     * @param {Object} layoutConfig - Configuration for poster layout
     */
    async loadPostersFromDataTSV(dataTsvUrl = 'data/poster-data.tsv', layoutConfig = {}) {
        try {
            const response = await fetch(dataTsvUrl);
            const tsvText = await response.text();
            const posters = this.parsePosterDataTSV(tsvText);

            console.log(`Loaded ${posters.length} posters from ${dataTsvUrl}`);

            this.createPosterMountsFromData(posters, layoutConfig);
        } catch (error) {
            console.error('Error loading poster data TSV:', error);
        }
    }

    /**
     * Create poster mounts from the combined poster-data rows, grouped by Mount ID.
     * Each poster's own Color column drives its marker fill (default gray for
     * unassigned mount sides, which have no poster row/color of their own).
     */
    createPosterMountsFromData(posters, layoutConfig) {
        const DEFAULT_COLOR = '#404040';

        const toSideData = (poster) => poster ? {
            title: poster.title,
            students: poster.students,
            facultyMentor: poster.facultyMentor,
            category: poster.category,
            easelBoard: poster.easelBoard,
            color: poster.color || DEFAULT_COLOR
        } : {
            title: 'Available Space',
            students: 'No poster assigned',
            facultyMentor: 'N/A',
            category: 'Available',
            easelBoard: 'Unassigned',
            color: DEFAULT_COLOR
        };

        // Group posters by mount ID
        const mountGroups = new Map();
        posters.forEach(poster => {
            if (!poster.mountId) return;
            if (!mountGroups.has(poster.mountId)) {
                mountGroups.set(poster.mountId, []);
            }
            mountGroups.get(poster.mountId).push(poster);
        });

        mountGroups.forEach((mountPosters, mountId) => {
            const primary = mountPosters[0];
            if (Number.isNaN(primary.xCoord) || Number.isNaN(primary.yCoord)) return;

            const orientation = primary.orientation || 'vertical';
            const position = { x: primary.xCoord, y: primary.yCoord };

            const lonePoster = mountPosters.find(poster => this.isLoneMarkerBoard(poster.easelBoard));
            if (lonePoster && mountPosters.length === 1) {
                this.addLoneMarker({
                    id: `lone-marker-${lonePoster.easelBoard}`,
                    position,
                    orientation,
                    poster: toSideData(lonePoster)
                });
                return;
            }

            // Sort posters by their designated side
            let sideAPosters = [];
            let sideBPosters = [];

            mountPosters.forEach(poster => {
                const side = poster.side;
                if (orientation === 'horizontal') {
                    // For horizontal: North goes to A, South goes to B
                    if (side === 'North') {
                        sideAPosters.push(poster);
                    } else if (side === 'South') {
                        sideBPosters.push(poster);
                    } else {
                        // Default assignment if no side specified
                        if (sideAPosters.length === 0) {
                            sideAPosters.push(poster);
                        } else {
                            sideBPosters.push(poster);
                        }
                    }
                } else {
                    // For vertical: West goes to A, East goes to B
                    if (side === 'West') {
                        sideAPosters.push(poster);
                    } else if (side === 'East') {
                        sideBPosters.push(poster);
                    } else {
                        // Default assignment if no side specified
                        if (sideAPosters.length === 0) {
                            sideAPosters.push(poster);
                        } else {
                            sideBPosters.push(poster);
                        }
                    }
                }
            });

            this.addPosterMount({
                id: mountId,
                position,
                orientation,
                sideA: toSideData(sideAPosters[0] || null),
                sideB: toSideData(sideBPosters[0] || null)
            });
        });
    }

    /**
     * Clear all elements
     */
    clear() {
        this.layoutElements.forEach((_, id) => this.removeElement(id));
        this.layoutElements.clear();
    }
}

// Make LayoutAPI available globally
window.LayoutAPI = LayoutAPI;

// Extend the main PosterSessionMap class with layout capabilities
function extendPosterSessionMap() {
    if (typeof window !== 'undefined' && window.PosterSessionMap) {
        window.PosterSessionMap.prototype.initializeLayoutAPI = function() {
            this.layout = new LayoutAPI(this);
            return this.layout;
        };
        return true;
    }
    return false;
}

// Try to extend immediately
if (!extendPosterSessionMap()) {
    // If PosterSessionMap isn't ready, wait for it
    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => {
            if (!extendPosterSessionMap()) {
                console.error('PosterSessionMap class not found - Layout API cannot initialize');
            }
        }, 50);
    });
}
