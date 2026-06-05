// Canvas Renderer for Pattrniq Professional
// Handles all viewport rendering for the leather pattern nesting application.

import { polyArea, polyBbox, polyCentroid, polyPIP } from './geometry.js';

/**
 * Size-code color palette (14 colors) for badge rendering.
 */
const SZ_COLORS = [
  '#ff4466', '#ffaa00', '#b8ff47', '#00d4ff', '#8855ff',
  '#00cc88', '#ff8833', '#ff55cc', '#55aaff', '#ffdd55',
  '#ff66aa', '#aaffdd', '#ffcc44', '#cc88ff',
];

/**
 * CanvasRenderer - renders the nesting viewport with leather hide outlines,
 * placed pattern pieces, grid overlays, and HUD information.
 */
export class CanvasRenderer {
  /**
   * @param {HTMLCanvasElement} canvas - The HTML canvas element
   * @param {object} options - Callback options
   * @param {function} [options.onZoomChange] - Called when zoom level changes
   * @param {function} [options.onHover] - Called when a placement is hovered
   * @param {function} [options.onSelect] - Called when a placement is clicked
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onZoomChange = options.onZoomChange || null;
    this.onHover = options.onHover || null;
    this.onSelect = options.onSelect || null;
    this.onContextMenu = options.onContextMenu || null;

    // Device pixel ratio
    this.dpr = window.devicePixelRatio || 1;

    // View state
    this.zoom = 1.0;
    this.panX = 0;
    this.panY = 0;

    // Data
    this.hide = null;       // { polygon: [[x,y],...], holes: [[[x,y],...], ...] }
    this.sheet = null;      // { w, h }
    this.bgImage = null;    // HTMLImageElement for hide photo
    this.placements = [];   // array of { boundary, children, tx, ty, rot, name, color, sizeCode, sizeIndex, material, sourceFile }
    this.previewParts = []; // unplaced parts for reference

    // Collision engine reference (set externally for debug overlay)
    this.collisionEngine = null;

    // Interaction state
    this.hoveredIndex = -1;
    this._hoveredPlacement = null;
    this._tooltipMouseScreen = { x: 0, y: 0 };
    this.mouseWorld = { x: 0, y: 0 };
    this.mouseScreen = { x: 0, y: 0 };
    this.isPanning = false;
    this.panStart = { x: 0, y: 0 };
    this.panOrigin = { x: 0, y: 0 };
    this.spaceDown = false;
    this.interactionEnabled = false;

    // Options
    this.options = {
      showGrid: true,
      showOutline: true,
      showLabels: true,
      showHUD: true,
      showRulers: true,
      debugOverlay: false,
    };

    // Dirty flag for performance
    this._dirty = true;
    this._animating = false;

    // Bound handlers (for removal)
    this._onMouseMove = this._handleMouseMove.bind(this);
    this._onMouseDown = this._handleMouseDown.bind(this);
    this._onMouseUp = this._handleMouseUp.bind(this);
    this._onWheel = this._handleWheel.bind(this);
    this._onDblClick = this._handleDblClick.bind(this);
    this._onKeyDown = this._handleKeyDown.bind(this);
    this._onKeyUp = this._handleKeyUp.bind(this);
    this._onContextMenu = this._handleContextMenu.bind(this);

    // Initial resize
    this.resize();
  }

  // =========================================================================
  // Setup
  // =========================================================================

  /**
   * Recalculate canvas dimensions to fit parent container, accounting for DPR.
   */
  resize() {
    this.dpr = window.devicePixelRatio || 1;
    const parent = this.canvas.parentElement;
    if (!parent) return;

    const rect = parent.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    this.canvas.width = w * this.dpr;
    this.canvas.height = h * this.dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';

    this.width = w;
    this.height = h;

    this._dirty = true;
    this.render();
  }

  // =========================================================================
  // Data
  // =========================================================================

  /**
   * Set the leather hide outline polygon and optional holes.
   * @param {number[][]} polygon - [[x,y], ...] outer boundary
   * @param {number[][][]} holes - Array of hole polygons [[[x,y], ...], ...]
   */
  setHide(polygon, holes = []) {
    this.hide = { polygon, holes };
    this.sheet = null;
    this._dirty = true;
    this.render();
  }

  /**
   * Set a rectangular sheet (no leather hide).
   * @param {number} w - Width in world units (mm)
   * @param {number} h - Height in world units (mm)
   */
  setSheet(w, h) {
    this.sheet = { w, h };
    this.hide = null;
    this._dirty = true;
    this.render();
  }

  /**
   * Set placed pattern pieces.
   * @param {Array<{boundary: number[][], children: Array, tx: number, ty: number, rot: number, name: string, color: string, sizeCode: string, sizeIndex: number, material: string}>} placements
   */
  setPlacements(placements) {
    this.placements = placements || [];
    this._dirty = true;
  }

  /**
   * Set unplaced preview parts shown below sheet for reference.
   * @param {Array} parts
   */
  setPreviewParts(parts) {
    this.previewParts = parts || [];
    this._dirty = true;
  }

  /**
   * Set a background image (hide photo) to display on the canvas.
   * @param {HTMLImageElement|null} img
   */
  setBackgroundImage(img) {
    this.bgImage = img;
    this._dirty = true;
  }

  /**
   * Set the collision engine reference for debug overlay rendering.
   * @param {object} engine - CollisionEngine instance with getDebugCanvas()
   */
  setCollisionEngine(engine) {
    this.collisionEngine = engine;
  }

  // =========================================================================
  // View
  // =========================================================================

  zoomIn() {
    this.setZoom(this.zoom * 1.25);
  }

  zoomOut() {
    this.setZoom(this.zoom / 1.25);
  }

  /**
   * Animate zoom to fit all content in viewport with padding.
   */
  zoomToFit() {
    const bbox = this._getContentBbox();
    if (!bbox || bbox.w <= 0 || bbox.h <= 0) return;
    if (this.width <= 0 || this.height <= 0) return;

    const padding = 40;
    const availW = Math.max(10, this.width - padding * 2);
    const availH = Math.max(10, this.height - padding * 2);

    const targetZoom = Math.min(
      availW / bbox.w,
      availH / bbox.h,
      4.0
    );
    const targetPanX = (this.width / 2) - (bbox.x0 + bbox.w / 2) * targetZoom;
    const targetPanY = (this.height / 2) - (bbox.y0 + bbox.h / 2) * targetZoom;

    this._animateTo(targetZoom, targetPanX, targetPanY, 300);
  }

  /**
   * Set zoom level directly.
   * @param {number} level - Zoom level between 0.1 and 4.0
   */
  setZoom(level) {
    const oldZoom = this.zoom;
    this.zoom = Math.max(0.1, Math.min(4.0, level));

    // Zoom toward center of viewport
    const cx = this.width / 2;
    const cy = this.height / 2;
    this.panX = cx - (cx - this.panX) * (this.zoom / oldZoom);
    this.panY = cy - (cy - this.panY) * (this.zoom / oldZoom);

    this._dirty = true;
    if (this.onZoomChange) this.onZoomChange(this.zoom);
  }

  /**
   * Get current zoom level.
   * @returns {number}
   */
  getZoom() {
    return this.zoom;
  }

  // =========================================================================
  // Rendering
  // =========================================================================

  /**
   * Full redraw of the canvas. Only redraws if state has changed (dirty flag).
   */
  render() {
    if (!this._dirty && !this._animating) return;
    this._dirty = false;

    const ctx = this.ctx;
    const dpr = this.dpr;

    ctx.save();
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = '#111827';
    ctx.fillRect(0, 0, this.width, this.height);

    // Draw sheet/hide area background
    this._drawSheetBackground(ctx);

    // Grid
    if (this.options.showGrid) {
      this._drawGrid(ctx);
    }

    // Hide or sheet outline
    if (this.options.showOutline) {
      this._drawOutline(ctx);
    }

    // Placed parts
    this._drawPlacements(ctx);

    // Labels
    if (this.options.showLabels) {
      this._drawLabels(ctx);
    }

    // Preview parts (unplaced, below sheet)
    this._drawPreviewParts(ctx);

    // Rulers
    if (this.options.showRulers) {
      this._drawRulers(ctx);
    }

    // HUD overlay
    if (this.options.showHUD) {
      this._drawHUD(ctx);
    }

    // Debug overlay (collision map)
    if (this.options.debugOverlay) {
      this._drawDebug(ctx);
    }

    // Tooltip (drawn last so it appears on top of everything)
    if (this._hoveredPlacement) {
      this._drawTooltip(ctx);
    }

    ctx.restore();
  }

  // =========================================================================
  // Interaction
  // =========================================================================

  /**
   * Attach mouse, wheel, and keyboard listeners for pan/zoom/hover/select.
   */
  enableInteraction() {
    if (this.interactionEnabled) return;
    this.interactionEnabled = true;

    this.canvas.addEventListener('mousemove', this._onMouseMove);
    this.canvas.addEventListener('mousedown', this._onMouseDown);
    this.canvas.addEventListener('mouseup', this._onMouseUp);
    this.canvas.addEventListener('wheel', this._onWheel, { passive: false });
    this.canvas.addEventListener('dblclick', this._onDblClick);
    this.canvas.addEventListener('contextmenu', this._onContextMenu);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);

    // Touch events for mobile
    this._touchState = { fingers: [], lastTap: 0, startDist: 0, startZoom: 1 };
    this.canvas.addEventListener('touchstart', this._handleTouchStart.bind(this), { passive: false });
    this.canvas.addEventListener('touchmove', this._handleTouchMove.bind(this), { passive: false });
    this.canvas.addEventListener('touchend', this._handleTouchEnd.bind(this));
  }

  /**
   * Remove all interaction listeners.
   */
  disableInteraction() {
    if (!this.interactionEnabled) return;
    this.interactionEnabled = false;

    this.canvas.removeEventListener('mousemove', this._onMouseMove);
    this.canvas.removeEventListener('mousedown', this._onMouseDown);
    this.canvas.removeEventListener('mouseup', this._onMouseUp);
    this.canvas.removeEventListener('wheel', this._onWheel);
    this.canvas.removeEventListener('dblclick', this._onDblClick);
    this.canvas.removeEventListener('contextmenu', this._onContextMenu);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
  }

  // =========================================================================
  // Options
  // =========================================================================

  /**
   * Set a rendering option.
   * @param {string} key - One of: showGrid, showLabels, showHUD, showRulers, debugOverlay
   * @param {*} value
   */
  setOption(key, value) {
    if (key in this.options) {
      this.options[key] = value;
      this._dirty = true;
      this.render();
    }
  }

  // =========================================================================
  // Coordinate transforms
  // =========================================================================

  /**
   * Convert world coordinates to screen (canvas CSS) coordinates.
   * @param {number} x - World x
   * @param {number} y - World y
   * @returns {{x: number, y: number}}
   */
  worldToScreen(x, y) {
    return {
      x: x * this.zoom + this.panX,
      y: y * this.zoom + this.panY,
    };
  }

  /**
   * Convert screen (canvas CSS) coordinates to world coordinates.
   * @param {number} sx - Screen x
   * @param {number} sy - Screen y
   * @returns {{x: number, y: number}}
   */
  screenToWorld(sx, sy) {
    return {
      x: (sx - this.panX) / this.zoom,
      y: (sy - this.panY) / this.zoom,
    };
  }

  // =========================================================================
  // Private: Drawing helpers
  // =========================================================================

  _drawSheetBackground(ctx) {
    if (this.sheet) {
      const tl = this.worldToScreen(0, 0);
      const br = this.worldToScreen(this.sheet.w, this.sheet.h);
      // Draw background image if available
      if (this.bgImage) {
        ctx.drawImage(this.bgImage, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
      } else {
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
      }
    } else if (this.hide) {
      const poly = this.hide.polygon;
      if (poly.length < 3) return;

      if (this.bgImage) {
        const imgW = this.bgImage.naturalWidth || this.bgImage.width;
        const imgH = this.bgImage.naturalHeight || this.bgImage.height;

        ctx.save();
        ctx.beginPath();
        const s0 = this.worldToScreen(poly[0][0], poly[0][1]);
        ctx.moveTo(s0.x, s0.y);
        for (let i = 1; i < poly.length; i++) {
          const s = this.worldToScreen(poly[i][0], poly[i][1]);
          ctx.lineTo(s.x, s.y);
        }
        ctx.closePath();
        ctx.clip();

        // Calculate world boundaries for the image
        let worldImgW = imgW;
        let worldImgH = imgH;
        let worldImgX = 0;
        let worldImgY = 0;

        // If the hide was detected with calibration, the background image needs to be scaled
        // to match the mm-scale of the hide. The hide is at its physical offset, so the image
        // should start at (0,0) and be scaled down by pixelsPerMm.
        if (typeof window !== 'undefined' && window.AppState && window.AppState.hideDetector) {
          const cal = window.AppState.hideDetector.getCalibration();
          if (cal && cal.pixelsPerMm) {
            worldImgW = imgW / cal.pixelsPerMm;
            worldImgH = imgH / cal.pixelsPerMm;
          }
        }

        const tl = this.worldToScreen(worldImgX, worldImgY);
        const br = this.worldToScreen(worldImgX + worldImgW, worldImgY + worldImgH);

        ctx.drawImage(this.bgImage, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
        ctx.restore();
      } else {
        ctx.fillStyle = '#1e293b';
        ctx.beginPath();
        const s0 = this.worldToScreen(poly[0][0], poly[0][1]);
        ctx.moveTo(s0.x, s0.y);
        for (let i = 1; i < poly.length; i++) {
          const s = this.worldToScreen(poly[i][0], poly[i][1]);
          ctx.lineTo(s.x, s.y);
        }
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  _drawGrid(ctx) {
    const bbox = this._getContentBbox();
    if (!bbox) return;

    // Determine visible area in world coordinates
    const topLeft = this.screenToWorld(0, 0);
    const bottomRight = this.screenToWorld(this.width, this.height);

    const minX = Math.floor(topLeft.x / 50) * 50;
    const maxX = Math.ceil(bottomRight.x / 50) * 50;
    const minY = Math.floor(topLeft.y / 50) * 50;
    const maxY = Math.ceil(bottomRight.y / 50) * 50;

    // Minor grid lines (50mm)
    ctx.strokeStyle = 'rgba(55, 65, 81, 0.3)';
    ctx.lineWidth = 0.5;

    ctx.beginPath();
    for (let x = minX; x <= maxX; x += 50) {
      if (x % 100 === 0) continue; // skip major lines
      const s0 = this.worldToScreen(x, minY);
      const s1 = this.worldToScreen(x, maxY);
      ctx.moveTo(s0.x, s0.y);
      ctx.lineTo(s1.x, s1.y);
    }
    for (let y = minY; y <= maxY; y += 50) {
      if (y % 100 === 0) continue;
      const s0 = this.worldToScreen(minX, y);
      const s1 = this.worldToScreen(maxX, y);
      ctx.moveTo(s0.x, s0.y);
      ctx.lineTo(s1.x, s1.y);
    }
    ctx.stroke();

    // Major grid lines (100mm)
    ctx.strokeStyle = 'rgba(55, 65, 81, 0.3)';
    ctx.lineWidth = 1.0;

    ctx.beginPath();
    for (let x = minX; x <= maxX; x += 100) {
      const s0 = this.worldToScreen(x, minY);
      const s1 = this.worldToScreen(x, maxY);
      ctx.moveTo(s0.x, s0.y);
      ctx.lineTo(s1.x, s1.y);
    }
    for (let y = minY; y <= maxY; y += 100) {
      const s0 = this.worldToScreen(minX, y);
      const s1 = this.worldToScreen(maxX, y);
      ctx.moveTo(s0.x, s0.y);
      ctx.lineTo(s1.x, s1.y);
    }
    ctx.stroke();
  }

  _drawOutline(ctx) {
    if (this.hide) {
      const poly = this.hide.polygon;
      if (poly.length < 3) return;

      ctx.save();
      ctx.strokeStyle = '#22a855';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#22a855';
      ctx.shadowBlur = 6;

      ctx.beginPath();
      const s0 = this.worldToScreen(poly[0][0], poly[0][1]);
      ctx.moveTo(s0.x, s0.y);
      for (let i = 1; i < poly.length; i++) {
        const s = this.worldToScreen(poly[i][0], poly[i][1]);
        ctx.lineTo(s.x, s.y);
      }
      ctx.closePath();
      ctx.stroke();

      // Feature 1: Draw vertex markers when zoom > 0.5
      if (this.zoom > 0.5) {
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#22a855';
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1;
        for (let i = 0; i < poly.length; i++) {
          const vs = this.worldToScreen(poly[i][0], poly[i][1]);
          ctx.beginPath();
          ctx.arc(vs.x, vs.y, 3, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }

      // Draw holes
      if (this.hide.holes) {
        ctx.shadowBlur = 0;
        ctx.strokeStyle = '#22a855';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        for (const hole of this.hide.holes) {
          if (hole.length < 3) continue;
          ctx.beginPath();
          const h0 = this.worldToScreen(hole[0][0], hole[0][1]);
          ctx.moveTo(h0.x, h0.y);
          for (let i = 1; i < hole.length; i++) {
            const h = this.worldToScreen(hole[i][0], hole[i][1]);
            ctx.lineTo(h.x, h.y);
          }
          ctx.closePath();
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }

      ctx.restore();
    } else if (this.sheet) {
      const tl = this.worldToScreen(0, 0);
      const br = this.worldToScreen(this.sheet.w, this.sheet.h);
      ctx.save();
      ctx.strokeStyle = '#60a5fa';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#60a5fa';
      ctx.shadowBlur = 4;
      ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
      ctx.restore();

      // Dimension labels
      ctx.font = '11px Inter, monospace';
      ctx.fillStyle = '#60a5fa';
      ctx.textAlign = 'center';
      ctx.fillText(`${this.sheet.w} mm`, (tl.x + br.x) / 2, tl.y - 6);
      ctx.save();
      ctx.translate(tl.x - 6, (tl.y + br.y) / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(`${this.sheet.h} mm`, 0, 0);
      ctx.restore();
    }
  }

  _drawPlacements(ctx) {
    const placements = this.placements;
    if (!placements.length) return;

    // Batch: build all paths first, then fill/stroke
    // For 200+ parts we batch all paths before stroking
    const batchMode = placements.length > 200;

    if (batchMode) {
      this._drawPlacementsBatched(ctx);
    } else {
      for (let i = 0; i < placements.length; i++) {
        this._drawSinglePlacement(ctx, placements[i], i === this.hoveredIndex);
      }
    }
  }

  _drawPlacementsBatched(ctx) {
    const placements = this.placements;

    // First pass: fill all parts
    for (let i = 0; i < placements.length; i++) {
      const p = placements[i];
      const isHovered = i === this.hoveredIndex;
      const worldPts = this._getTransformedBoundary(p);

      ctx.beginPath();
      const s0 = this.worldToScreen(worldPts[0][0], worldPts[0][1]);
      ctx.moveTo(s0.x, s0.y);
      for (let j = 1; j < worldPts.length; j++) {
        const s = this.worldToScreen(worldPts[j][0], worldPts[j][1]);
        ctx.lineTo(s.x, s.y);
      }
      ctx.closePath();

      const alpha = isHovered ? 0.8 : 0.6;
      ctx.fillStyle = this._colorWithAlpha(p.color, alpha);
      ctx.fill();
    }

    // Second pass: stroke all parts
    for (let i = 0; i < placements.length; i++) {
      const p = placements[i];
      const isHovered = i === this.hoveredIndex;
      const worldPts = this._getTransformedBoundary(p);

      ctx.beginPath();
      const s0 = this.worldToScreen(worldPts[0][0], worldPts[0][1]);
      ctx.moveTo(s0.x, s0.y);
      for (let j = 1; j < worldPts.length; j++) {
        const s = this.worldToScreen(worldPts[j][0], worldPts[j][1]);
        ctx.lineTo(s.x, s.y);
      }
      ctx.closePath();

      if (isHovered) {
        ctx.save();
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 10;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
      } else {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    // Third pass: children
    for (let i = 0; i < placements.length; i++) {
      const p = placements[i];
      if (p.children && p.children.length) {
        this._drawChildren(ctx, p);
      }
    }
  }

  _drawSinglePlacement(ctx, placement, isHovered) {
    const worldPts = this._getTransformedBoundary(placement);
    if (worldPts.length < 3) return;

    // Fill
    ctx.beginPath();
    const s0 = this.worldToScreen(worldPts[0][0], worldPts[0][1]);
    ctx.moveTo(s0.x, s0.y);
    for (let j = 1; j < worldPts.length; j++) {
      const s = this.worldToScreen(worldPts[j][0], worldPts[j][1]);
      ctx.lineTo(s.x, s.y);
    }
    ctx.closePath();

    const alpha = isHovered ? 0.8 : 0.6;
    ctx.fillStyle = this._colorWithAlpha(placement.color, alpha);
    ctx.fill();

    // Stroke
    if (isHovered) {
      ctx.save();
      ctx.shadowColor = placement.color;
      ctx.shadowBlur = 10;
      ctx.strokeStyle = placement.color;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.strokeStyle = placement.color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Children
    if (placement.children && placement.children.length) {
      this._drawChildren(ctx, placement);
    }
  }

  _drawChildren(ctx, placement) {
    const tx = placement.tx || 0;
    const ty = placement.ty || 0;
    const rot = placement.rot || 0;
    const rad = (rot * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    for (const child of placement.children) {
      const pts = child.poly || child.points || child.boundary || [];
      if (pts.length < 2) continue;

      // Transform child points
      const transformed = pts.map(([x, y]) => {
        const rx = x * cos - y * sin + tx;
        const ry = x * sin + y * cos + ty;
        return [rx, ry];
      });

      ctx.beginPath();
      const sc0 = this.worldToScreen(transformed[0][0], transformed[0][1]);
      ctx.moveTo(sc0.x, sc0.y);
      for (let k = 1; k < transformed.length; k++) {
        const sc = this.worldToScreen(transformed[k][0], transformed[k][1]);
        ctx.lineTo(sc.x, sc.y);
      }
      if (pts.length > 2) ctx.closePath();

      const type = child.kind || child.type || 'hole';
      ctx.lineWidth = 1;

      switch (type) {
        case 'hole':
          ctx.strokeStyle = '#ff4444';
          ctx.setLineDash([5, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
          break;
        case 'mark':
          ctx.strokeStyle = '#3a9eff';
          ctx.setLineDash([2, 2]);
          ctx.stroke();
          ctx.setLineDash([]);
          break;
        case 'engrave':
          ctx.strokeStyle = '#b07cff';
          ctx.lineWidth = 0.75;
          ctx.stroke();
          break;
        default:
          ctx.strokeStyle = '#ff4444';
          ctx.setLineDash([5, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
      }
    }
  }

  /**
   * Feature 2: Draw labels with size code badge below part name.
   */
  _drawLabels(ctx) {
    if (!this.placements.length) return;

    ctx.font = '10px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const p of this.placements) {
      if (!p.name) continue;

      const worldPts = this._getTransformedBoundary(p);
      if (worldPts.length < 3) continue;

      const centroid = polyCentroid(worldPts);
      const screen = this.worldToScreen(centroid[0], centroid[1]);

      // Short label: just size number (e.g. "sz34") or part type abbreviation
      const shortLabel = p.sizeCode || (p.name ? p.name.replace(/^.*_sz/, 'sz').replace(/^.*_/, '') : '');

      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
      ctx.shadowBlur = 3;
      ctx.shadowOffsetX = 1;
      ctx.shadowOffsetY = 1;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(shortLabel, screen.x, screen.y);
      ctx.restore();

      // Size code badge below the part name
      if (p.sizeCode) {
        const badgeY = screen.y + 13;
        const sizeText = String(p.sizeCode);
        ctx.font = '8px Inter, monospace';
        const textWidth = ctx.measureText(sizeText).width;
        const badgeW = textWidth + 8;
        const badgeH = 12;
        const badgeX = screen.x - badgeW / 2;

        // Badge background color from SZ_COLORS palette
        const colorIdx = (p.sizeIndex != null ? p.sizeIndex : 0) % SZ_COLORS.length;
        const badgeColor = SZ_COLORS[colorIdx];

        ctx.save();
        ctx.fillStyle = badgeColor;
        ctx.beginPath();
        this._roundRect(ctx, badgeX, badgeY - badgeH / 2, badgeW, badgeH, 3);
        ctx.fill();

        // Badge text (dark for readability on bright colors)
        ctx.fillStyle = '#000000';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(sizeText, screen.x, badgeY);
        ctx.restore();

        // Reset font for next iteration
        ctx.font = '10px Inter, sans-serif';
      }
    }
  }

  /**
   * Feature 5: Draw preview parts grouped by sourceFile with wrapping.
   */
  _drawPreviewParts(ctx) {
    return;
    if (!this.previewParts.length) return;

    // Draw unplaced parts below the main content area for reference
    const contentBbox = this._getContentBbox();
    if (!contentBbox) return;

    const startY = contentBbox.y1 + 30;
    const gap = 10;
    const groupGap = 20;
    const headerHeight = 14;
    const maxWidth = contentBbox.w || 600;

    // Group parts by sourceFile
    const groups = new Map();
    for (const part of this.previewParts) {
      const key = part.sourceFile || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(part);
    }

    ctx.globalAlpha = 0.4;
    let curY = startY;

    for (const [sourceFile, parts] of groups) {
      // Draw group header label
      if (sourceFile) {
        ctx.save();
        ctx.globalAlpha = 0.6;
        ctx.font = '9px Inter, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#9ca3af';
        const headerScreen = this.worldToScreen(0, curY);
        ctx.fillText(sourceFile, headerScreen.x, headerScreen.y);
        ctx.restore();
        ctx.globalAlpha = 0.4;
      }
      curY += headerHeight;

      let offsetX = 0;
      let rowH = 0;

      for (const part of parts) {
        const boundary = part.boundary || [];
        if (boundary.length < 3) continue;

        const bbox = polyBbox(boundary);

        // Wrap to next row if exceeding canvas width
        if (offsetX > 0 && offsetX + bbox.w > maxWidth) {
          curY += rowH + gap;
          offsetX = 0;
          rowH = 0;
        }

        const pts = boundary.map(([x, y]) => [x - bbox.x0 + offsetX, y - bbox.y0 + curY]);

        ctx.beginPath();
        const s0 = this.worldToScreen(pts[0][0], pts[0][1]);
        ctx.moveTo(s0.x, s0.y);
        for (let i = 1; i < pts.length; i++) {
          const s = this.worldToScreen(pts[i][0], pts[i][1]);
          ctx.lineTo(s.x, s.y);
        }
        ctx.closePath();

        ctx.fillStyle = this._colorWithAlpha(part.color || '#6b7280', 0.3);
        ctx.fill();
        ctx.strokeStyle = part.color || '#6b7280';
        ctx.lineWidth = 1;
        ctx.stroke();

        if (bbox.h > rowH) rowH = bbox.h;
        offsetX += bbox.w + gap;
      }

      curY += rowH + groupGap;
    }
    ctx.globalAlpha = 1.0;
  }

  /**
   * Feature 3: Draw ruler tick marks along canvas edges.
   * Horizontal ruler at top, vertical ruler on left side.
   * Adapts tick density to zoom level.
   */
  _drawRulers(ctx) {
    const rulerSize = 20; // px width/height of ruler bar
    const zoom = this.zoom;

    // Determine which tick levels to draw based on zoom
    // At zoom 1.0, 1mm = 1px. At zoom 0.5, 1mm = 0.5px, etc.
    const pxPerMm = zoom;
    const drawMicro = pxPerMm >= 4;   // 1mm ticks only at high zoom
    const drawMinor = pxPerMm >= 0.8;  // 10mm ticks at medium+ zoom
    const drawMajor = true;             // 100mm ticks always

    // Visible world range
    const topLeft = this.screenToWorld(rulerSize, rulerSize);
    const bottomRight = this.screenToWorld(this.width, this.height);

    ctx.save();

    // Ruler backgrounds
    ctx.fillStyle = 'rgba(17, 24, 39, 0.9)';
    ctx.fillRect(rulerSize, 0, this.width - rulerSize, rulerSize); // horizontal
    ctx.fillRect(0, rulerSize, rulerSize, this.height - rulerSize); // vertical
    ctx.fillRect(0, 0, rulerSize, rulerSize); // corner

    ctx.strokeStyle = 'rgba(55, 65, 81, 0.6)';
    ctx.lineWidth = 0.5;
    // Bottom edge of horizontal ruler
    ctx.beginPath();
    ctx.moveTo(rulerSize, rulerSize);
    ctx.lineTo(this.width, rulerSize);
    ctx.stroke();
    // Right edge of vertical ruler
    ctx.beginPath();
    ctx.moveTo(rulerSize, rulerSize);
    ctx.lineTo(rulerSize, this.height);
    ctx.stroke();

    // Tick drawing helper
    const drawHTick = (worldX, tickH, drawLabel) => {
      const sx = worldX * zoom + this.panX;
      if (sx < rulerSize || sx > this.width) return;
      ctx.beginPath();
      ctx.moveTo(sx, rulerSize - tickH);
      ctx.lineTo(sx, rulerSize);
      ctx.stroke();
      if (drawLabel) {
        ctx.fillText(`${Math.round(worldX)}`, sx + 2, rulerSize - tickH + 2);
      }
    };

    const drawVTick = (worldY, tickW, drawLabel) => {
      const sy = worldY * zoom + this.panY;
      if (sy < rulerSize || sy > this.height) return;
      ctx.beginPath();
      ctx.moveTo(rulerSize - tickW, sy);
      ctx.lineTo(rulerSize, sy);
      ctx.stroke();
      if (drawLabel) {
        ctx.save();
        ctx.translate(rulerSize - tickW - 1, sy + 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(`${Math.round(worldY)}`, 0, 0);
        ctx.restore();
      }
    };

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    // Micro ticks (1mm)
    if (drawMicro) {
      ctx.strokeStyle = 'rgba(100, 116, 139, 0.3)';
      ctx.lineWidth = 0.5;
      const startX = Math.floor(topLeft.x);
      const endX = Math.ceil(bottomRight.x);
      const startY = Math.floor(topLeft.y);
      const endY = Math.ceil(bottomRight.y);
      for (let x = startX; x <= endX; x++) {
        if (x % 10 === 0) continue;
        drawHTick(x, 3, false);
      }
      for (let y = startY; y <= endY; y++) {
        if (y % 10 === 0) continue;
        drawVTick(y, 3, false);
      }
    }

    // Minor ticks (10mm)
    if (drawMinor) {
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.5)';
      ctx.lineWidth = 0.5;
      const startX = Math.floor(topLeft.x / 10) * 10;
      const endX = Math.ceil(bottomRight.x / 10) * 10;
      const startY = Math.floor(topLeft.y / 10) * 10;
      const endY = Math.ceil(bottomRight.y / 10) * 10;
      for (let x = startX; x <= endX; x += 10) {
        if (x % 100 === 0) continue;
        drawHTick(x, 7, false);
      }
      for (let y = startY; y <= endY; y += 10) {
        if (y % 100 === 0) continue;
        drawVTick(y, 7, false);
      }
    }

    // Major ticks (100mm) with labels
    if (drawMajor) {
      ctx.strokeStyle = 'rgba(209, 213, 219, 0.7)';
      ctx.lineWidth = 1;
      ctx.font = '8px Inter, monospace';
      ctx.fillStyle = '#9ca3af';
      const startX = Math.floor(topLeft.x / 100) * 100;
      const endX = Math.ceil(bottomRight.x / 100) * 100;
      const startY = Math.floor(topLeft.y / 100) * 100;
      const endY = Math.ceil(bottomRight.y / 100) * 100;
      for (let x = startX; x <= endX; x += 100) {
        drawHTick(x, 14, true);
      }
      for (let y = startY; y <= endY; y += 100) {
        drawVTick(y, 14, true);
      }
    }

    ctx.restore();
  }

  _drawHUD(ctx) {
    const padding = 12;
    const lineHeight = 18;
    const lines = [];

    lines.push(`Zoom: ${(this.zoom * 100).toFixed(0)}%`);

    // Efficiency calculation
    if (this.placements.length > 0 && (this.sheet || this.hide)) {
      const totalPartArea = this.placements.reduce((sum, p) => {
        const worldPts = this._getTransformedBoundary(p);
        return sum + Math.abs(polyArea(worldPts));
      }, 0);

      let sheetArea = 0;
      if (this.sheet) {
        sheetArea = this.sheet.w * this.sheet.h;
      } else if (this.hide) {
        sheetArea = Math.abs(polyArea(this.hide.polygon));
      }

      if (sheetArea > 0) {
        const efficiency = (totalPartArea / sheetArea) * 100;
        lines.push(`Efficiency: ${efficiency.toFixed(1)}%`);
      }
    }

    lines.push(`Placed: ${this.placements.length}`);

    if (this.sheet) {
      lines.push(`Sheet: ${this.sheet.w} x ${this.sheet.h} mm`);
    } else if (this.hide) {
      const hBbox = polyBbox(this.hide.polygon);
      lines.push(`Hide: ${hBbox.w.toFixed(0)} x ${hBbox.h.toFixed(0)} mm`);
    }

    // Draw background pill
    const maxTextWidth = 160;
    const hudW = maxTextWidth + padding * 2;
    const hudH = lines.length * lineHeight + padding * 2;
    const hudX = 12;
    const hudY = this.height - hudH - 12;

    ctx.save();
    ctx.fillStyle = 'rgba(17, 24, 39, 0.85)';
    ctx.beginPath();
    this._roundRect(ctx, hudX, hudY, hudW, hudH, 8);
    ctx.fill();

    ctx.font = '11px Inter, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#d1d5db';

    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], hudX + padding, hudY + padding + i * lineHeight);
    }
    ctx.restore();
  }

  /**
   * Feature 4: Debug overlay with collision map heatmap.
   * When debugOverlay is enabled, draws the collision engine occupancy
   * grid with reduced opacity on top of the main canvas.
   */
  _drawDebug(ctx) {
    ctx.save();

    // Draw collision engine heatmap if available
    if (this.collisionEngine && typeof this.collisionEngine.getDebugCanvas === 'function') {
      const debugCanvas = this.collisionEngine.getDebugCanvas();
      if (debugCanvas) {
        ctx.globalAlpha = 0.3;
        // Map the debug canvas to the world coordinate space
        const tl = this.worldToScreen(0, 0);
        const contentBbox = this._getContentBbox();
        if (contentBbox) {
          const br = this.worldToScreen(contentBbox.x1, contentBbox.y1);
          ctx.drawImage(debugCanvas, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
        }
        ctx.globalAlpha = 1.0;
      }
    }

    // Debug text info
    ctx.font = '9px monospace';
    ctx.fillStyle = '#00ff88';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    const info = [
      `mouse: (${this.mouseWorld.x.toFixed(1)}, ${this.mouseWorld.y.toFixed(1)})`,
      `pan: (${this.panX.toFixed(1)}, ${this.panY.toFixed(1)})`,
      `zoom: ${this.zoom.toFixed(3)}`,
      `hovered: ${this.hoveredIndex}`,
      `placements: ${this.placements.length}`,
      `dpr: ${this.dpr}`,
    ];

    for (let i = 0; i < info.length; i++) {
      ctx.fillText(info[i], 12, 12 + i * 12);
    }
    ctx.restore();
  }

  /**
   * Feature 6 & 7: Draw on-canvas tooltip near cursor for hovered part.
   * Shows: part name, area, rotation, size code, material.
   */
  _drawTooltip(ctx) {
    const p = this._hoveredPlacement;
    if (!p) return;

    const mx = this._tooltipMouseScreen.x;
    const my = this._tooltipMouseScreen.y;

    // Build tooltip lines
    const lines = [];
    if (p.name) lines.push(p.name);

    // Calculate area
    const worldPts = this._getTransformedBoundary(p);
    if (worldPts.length >= 3) {
      const area = Math.abs(polyArea(worldPts));
      lines.push(`Area: ${area.toFixed(1)} mm²`);
    }

    const rot = p.rot || 0;
    lines.push(`Rotation: ${rot.toFixed(1)}°`);

    if (p.sizeCode) lines.push(`Size: ${p.sizeCode}`);
    if (p.material) lines.push(`Material: ${p.material}`);

    // Tooltip dimensions
    const padding = 8;
    const lineHeight = 14;
    ctx.font = '10px Inter, sans-serif';

    let maxTextW = 0;
    for (const line of lines) {
      const w = ctx.measureText(line).width;
      if (w > maxTextW) maxTextW = w;
    }

    const ttW = maxTextW + padding * 2;
    const ttH = lines.length * lineHeight + padding * 2;

    // Position tooltip near cursor, avoid going off-canvas
    let ttX = mx + 14;
    let ttY = my + 14;
    if (ttX + ttW > this.width) ttX = mx - ttW - 8;
    if (ttY + ttH > this.height) ttY = my - ttH - 8;
    if (ttX < 0) ttX = 4;
    if (ttY < 0) ttY = 4;

    ctx.save();

    // Background
    ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
    ctx.beginPath();
    this._roundRect(ctx, ttX, ttY, ttW, ttH, 5);
    ctx.fill();

    // Border
    ctx.strokeStyle = 'rgba(100, 116, 139, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    this._roundRect(ctx, ttX, ttY, ttW, ttH, 5);
    ctx.stroke();

    // Text
    ctx.fillStyle = '#e2e8f0';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = '10px Inter, sans-serif';
    for (let i = 0; i < lines.length; i++) {
      // First line (name) in bold/brighter color
      if (i === 0) {
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 10px Inter, sans-serif';
      } else {
        ctx.fillStyle = '#cbd5e1';
        ctx.font = '10px Inter, sans-serif';
      }
      ctx.fillText(lines[i], ttX + padding, ttY + padding + i * lineHeight);
    }

    ctx.restore();
  }

  // =========================================================================
  // Private: Geometry / transform helpers
  // =========================================================================

  /**
   * Get the transformed (rotated + translated) boundary of a placement in world coords.
   */
  _getTransformedBoundary(placement) {
    const { boundary, tx = 0, ty = 0, rot = 0 } = placement;
    if (!boundary || boundary.length < 3) return [];

    if (rot === 0) {
      return boundary.map(([x, y]) => [x + tx, y + ty]);
    }

    const rad = (rot * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    return boundary.map(([x, y]) => [
      x * cos - y * sin + tx,
      x * sin + y * cos + ty,
    ]);
  }

  /**
   * Get the bounding box of all visible content.
   */
  _getContentBbox() {
    if (this.sheet) {
      return { x0: 0, y0: 0, x1: this.sheet.w, y1: this.sheet.h, w: this.sheet.w, h: this.sheet.h };
    }
    if (this.hide && this.hide.polygon.length >= 3) {
      return polyBbox(this.hide.polygon);
    }
    if (this.placements.length > 0) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of this.placements) {
        const pts = this._getTransformedBoundary(p);
        const bb = polyBbox(pts);
        if (bb.x0 < x0) x0 = bb.x0;
        if (bb.y0 < y0) y0 = bb.y0;
        if (bb.x1 > x1) x1 = bb.x1;
        if (bb.y1 > y1) y1 = bb.y1;
      }
      return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
    }
    return null;
  }

  /**
   * Convert a hex color to rgba with specified alpha.
   */
  _colorWithAlpha(color, alpha) {
    if (!color) return `rgba(107, 114, 128, ${alpha})`;

    // Handle hex colors
    if (color.startsWith('#')) {
      const hex = color.slice(1);
      let r, g, b;
      if (hex.length === 3) {
        r = parseInt(hex[0] + hex[0], 16);
        g = parseInt(hex[1] + hex[1], 16);
        b = parseInt(hex[2] + hex[2], 16);
      } else {
        r = parseInt(hex.slice(0, 2), 16);
        g = parseInt(hex.slice(2, 4), 16);
        b = parseInt(hex.slice(4, 6), 16);
      }
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    // Handle rgb/rgba strings
    if (color.startsWith('rgb')) {
      const match = color.match(/[\d.]+/g);
      if (match && match.length >= 3) {
        return `rgba(${match[0]}, ${match[1]}, ${match[2]}, ${alpha})`;
      }
    }

    return color;
  }

  /**
   * Draw a rounded rectangle path.
   */
  _roundRect(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // =========================================================================
  // Private: Animation
  // =========================================================================

  /**
   * Smoothly animate to target zoom/pan over duration ms using requestAnimationFrame.
   */
  _animateTo(targetZoom, targetPanX, targetPanY, duration) {
    const startZoom = this.zoom;
    const startPanX = this.panX;
    const startPanY = this.panY;
    const startTime = performance.now();

    this._animating = true;

    const step = (now) => {
      const elapsed = now - startTime;
      const t = Math.min(elapsed / duration, 1.0);
      // Ease-out cubic
      const ease = 1 - Math.pow(1 - t, 3);

      this.zoom = startZoom + (targetZoom - startZoom) * ease;
      this.panX = startPanX + (targetPanX - startPanX) * ease;
      this.panY = startPanY + (targetPanY - startPanY) * ease;

      this._dirty = true;
      this.render();

      if (t < 1.0) {
        requestAnimationFrame(step);
      } else {
        this._animating = false;
        if (this.onZoomChange) this.onZoomChange(this.zoom);
      }
    };

    requestAnimationFrame(step);
  }

  // =========================================================================
  // Private: Event handlers
  // =========================================================================

  _handleMouseMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    this.mouseScreen = { x: sx, y: sy };
    this.mouseWorld = this.screenToWorld(sx, sy);

    if (this.isPanning) {
      this.panX = this.panOrigin.x + (sx - this.panStart.x);
      this.panY = this.panOrigin.y + (sy - this.panStart.y);
      this._dirty = true;
      this.render();
      return;
    }

    // Hit-test placements for hover
    const oldHovered = this.hoveredIndex;
    this.hoveredIndex = -1;

    // Iterate in reverse so topmost (last drawn) gets priority
    for (let i = this.placements.length - 1; i >= 0; i--) {
      const p = this.placements[i];
      const worldPts = this._getTransformedBoundary(p);
      if (worldPts.length < 3) continue;

      if (polyPIP(this.mouseWorld.x, this.mouseWorld.y, worldPts)) {
        this.hoveredIndex = i;
        break;
      }
    }

    // Feature 7: Store hovered placement + mouse position for tooltip rendering
    if (this.hoveredIndex >= 0) {
      this._hoveredPlacement = this.placements[this.hoveredIndex];
      this._tooltipMouseScreen = { x: sx, y: sy };
    } else {
      this._hoveredPlacement = null;
    }

    if (this.hoveredIndex !== oldHovered || this._hoveredPlacement) {
      this._dirty = true;
      this.render();
      this.canvas.style.cursor = this.hoveredIndex >= 0 ? 'pointer' : 'default';

      if (this.onHover) {
        this.onHover(this.hoveredIndex >= 0 ? this.placements[this.hoveredIndex] : null, this.hoveredIndex);
      }
    } else if (this._hoveredPlacement) {
      // Mouse moved within same part - update tooltip position
      this._tooltipMouseScreen = { x: sx, y: sy };
      this._dirty = true;
      this.render();
    }
  }

  _handleMouseDown(e) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    // Middle mouse button or space+left click: start pan
    if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
      e.preventDefault();
      this.isPanning = true;
      this.panStart = { x: sx, y: sy };
      this.panOrigin = { x: this.panX, y: this.panY };
      this.canvas.style.cursor = 'grabbing';
      return;
    }

    // Left click: select
    if (e.button === 0 && this.hoveredIndex >= 0) {
      if (this.onSelect) {
        this.onSelect(this.placements[this.hoveredIndex], this.hoveredIndex);
      }
    }
  }

  _handleMouseUp(e) {
    if (this.isPanning) {
      this.isPanning = false;
      this.canvas.style.cursor = this.hoveredIndex >= 0 ? 'pointer' : 'default';
    }
  }

  _handleWheel(e) {
    e.preventDefault();

    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    // Zoom toward cursor position
    const worldBefore = this.screenToWorld(sx, sy);

    const zoomFactor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    this.zoom = Math.max(0.1, Math.min(4.0, this.zoom * zoomFactor));

    // Adjust pan so the world point under cursor stays fixed
    this.panX = sx - worldBefore.x * this.zoom;
    this.panY = sy - worldBefore.y * this.zoom;

    this._dirty = true;
    this.render();

    if (this.onZoomChange) this.onZoomChange(this.zoom);
  }

  _handleDblClick(e) {
    this.zoomToFit();
  }

  _handleKeyDown(e) {
    if (e.code === 'Space') {
      e.preventDefault();
      this.spaceDown = true;
      this.canvas.style.cursor = 'grab';
    }
  }

  _handleKeyUp(e) {
    if (e.code === 'Space') {
      this.spaceDown = false;
      this.canvas.style.cursor = this.hoveredIndex >= 0 ? 'pointer' : 'default';
    }
  }

  _handleContextMenu(e) {
    e.preventDefault();
    if (this.onContextMenu) {
      this.onContextMenu({
        screenX: e.clientX,
        screenY: e.clientY,
        worldX: this.mouseWorld.x,
        worldY: this.mouseWorld.y,
        placementIndex: this.hoveredIndex,
        placement: this.hoveredIndex >= 0 ? this.placements[this.hoveredIndex] : null,
      });
    }
  }

  // Touch handlers for mobile
  _handleTouchStart(e) {
    e.preventDefault();
    const ts = this._touchState;
    ts.fingers = [...e.touches];

    if (e.touches.length === 1) {
      // Single finger: pan
      const t = e.touches[0];
      this.isPanning = true;
      this.panStart = { x: t.clientX, y: t.clientY };
      this.panOrigin = { x: this.panX, y: this.panY };

      // Double-tap detection
      const now = Date.now();
      if (now - ts.lastTap < 300) {
        this.zoomToFit();
        this.isPanning = false;
      }
      ts.lastTap = now;
    } else if (e.touches.length === 2) {
      // Two fingers: pinch zoom
      this.isPanning = false;
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      ts.startDist = Math.sqrt(dx * dx + dy * dy);
      ts.startZoom = this.zoom;
    }
  }

  _handleTouchMove(e) {
    e.preventDefault();
    const ts = this._touchState;

    if (e.touches.length === 1 && this.isPanning) {
      const t = e.touches[0];
      const dx = t.clientX - this.panStart.x;
      const dy = t.clientY - this.panStart.y;
      this.panX = this.panOrigin.x + dx;
      this.panY = this.panOrigin.y + dy;
      this.render();
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (ts.startDist > 0) {
        const scale = dist / ts.startDist;
        const newZoom = Math.max(0.1, Math.min(4.0, ts.startZoom * scale));
        this.zoom = newZoom;
        if (this.onZoomChange) this.onZoomChange(newZoom);
        this.render();
      }
    }
  }

  _handleTouchEnd(e) {
    if (e.touches.length === 0) {
      this.isPanning = false;
    } else if (e.touches.length === 1) {
      // Went from 2 → 1 finger: reset pan origin
      const t = e.touches[0];
      this.panStart = { x: t.clientX, y: t.clientY };
      this.panOrigin = { x: this.panX, y: this.panY };
      this.isPanning = true;
    }
  }
}
