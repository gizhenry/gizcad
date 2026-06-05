/**
 * Checkout Module - Pattern checkout and order system.
 * Ported from patternOutQ.html.
 * Handles the workflow between pattern library and nesting:
 * selecting a pattern, setting quantities per size, assigning materials,
 * and generating export-ready DXF files or pushing to the nesting engine.
 */

import { polyArea, polyBbox } from './geometry.js';

// ── Material presets ────────────────────────────────────────────────────────
const MATERIAL_PRESETS = [
  'Leather', 'Synthetic Leather', 'Mesh', 'Suede', 'Canvas', 'Nylon',
  'Rubber', 'EVA Foam', 'PU Foam', 'Textile', 'Lining Fabric', 'Nonwoven'
];

// ── DXF layout constants ────────────────────────────────────────────────────
const GRID_MAX_ROW_WIDTH = 2000; // mm before wrapping to next row
const GRID_GAP_X = 10;          // gap between pieces in a row (mm)
const GRID_GAP_Y = 15;          // gap between rows (mm)

/**
 * Manages the pattern checkout workflow: pattern selection, quantity assignment,
 * material assignment, DXF export, and nesting payload generation.
 */
export class CheckoutManager {
  /**
   * @param {object} options
   * @param {function} [options.onUpdate] - Callback fired when state changes
   */
  constructor(options = {}) {
    this._onUpdate = options.onUpdate || null;
    this._pattern = null;
    this._quantities = {};   // {sizeId: number}
    this._materials = {};    // {partId: materialName}
    this._mirrorPair = false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Pattern Selection
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Load a pattern into the checkout manager.
   * @param {object} pattern
   * @param {string} pattern.id
   * @param {string} pattern.name
   * @param {Array<{id: string, label: string}>} pattern.sizes
   * @param {Array<{id: string, name: string, color: string}>} pattern.parts
   * @param {Array<{pts: number[][], sizeId: string, partId: string, layer: string, area: number, bbox: object, children: Array}>} pattern.pieces
   * @param {object} [pattern.pwm] - Power/speed settings {cut, hole, mark, engrave}
   */
  loadPattern(pattern) {
    this._pattern = pattern;
    this._quantities = {};
    this._materials = {};
    if (pattern && pattern.sizes) {
      for (const sz of pattern.sizes) {
        this._quantities[sz.id] = 0;
      }
    }
    this._notify();
  }

  /**
   * Get the currently loaded pattern.
   * @returns {object|null}
   */
  getPattern() {
    return this._pattern;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Step 1: Quantities
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Set the number of pairs for a specific size.
   * @param {string} sizeId
   * @param {number} qty
   */
  setQuantity(sizeId, qty) {
    if (!this._pattern) return;
    this._quantities[sizeId] = Math.max(0, Math.floor(qty) || 0);
    this._notify();
  }

  /**
   * Fill all sizes with the same quantity.
   * @param {number} qty
   */
  setAllQuantities(qty) {
    if (!this._pattern) return;
    const val = Math.max(0, Math.floor(qty) || 0);
    for (const sz of this._pattern.sizes) {
      this._quantities[sz.id] = val;
    }
    this._notify();
  }

  /**
   * Clear all quantities to zero.
   */
  clearQuantities() {
    if (!this._pattern) return;
    for (const sz of this._pattern.sizes) {
      this._quantities[sz.id] = 0;
    }
    this._notify();
  }

  /**
   * Get the current quantities map.
   * @returns {object} {sizeId: number}
   */
  getQuantities() {
    return { ...this._quantities };
  }

  /**
   * Calculate the total number of pieces after quantity expansion.
   * @returns {number}
   */
  getTotalPieces() {
    if (!this._pattern) return 0;
    let total = 0;
    for (const sz of this._pattern.sizes) {
      const qty = this._quantities[sz.id] || 0;
      if (qty <= 0) continue;
      const piecesAtSize = this._pattern.pieces.filter(p => p.sizeId === sz.id).length;
      total += piecesAtSize * qty;
    }
    return total;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Step 2: Materials
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Assign a material name to a part.
   * @param {string} partId
   * @param {string} materialName
   */
  assignMaterial(partId, materialName) {
    this._materials[partId] = materialName;
    this._notify();
  }

  /**
   * Get the current material assignments.
   * @returns {object} {partId: materialName}
   */
  getMaterials() {
    return { ...this._materials };
  }

  /**
   * Get unique materials with their associated parts and piece counts.
   * @returns {Array<{name: string, partIds: string[], pieceCount: number}>}
   */
  getUniqueMaterials() {
    if (!this._pattern) return [];
    const groups = {};
    for (const [partId, matName] of Object.entries(this._materials)) {
      if (!matName) continue;
      if (!groups[matName]) groups[matName] = { name: matName, partIds: [], pieceCount: 0 };
      groups[matName].partIds.push(partId);
    }
    // Count pieces per material group
    for (const group of Object.values(groups)) {
      const partIdSet = new Set(group.partIds);
      for (const sz of this._pattern.sizes) {
        const qty = this._quantities[sz.id] || 0;
        if (qty <= 0) continue;
        const pcs = this._pattern.pieces.filter(
          p => p.sizeId === sz.id && partIdSet.has(p.partId)
        );
        group.pieceCount += pcs.length * qty;
      }
      if (this._mirrorPair) group.pieceCount *= 2;
    }
    return Object.values(groups);
  }

  /**
   * Enable or disable L/R mirror pair splitting.
   * @param {boolean} enabled
   */
  setMirrorPair(enabled) {
    this._mirrorPair = !!enabled;
    this._notify();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Export
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Generate a DXF string for one material group.
   * @param {string} materialName - Target material to filter by
   * @param {string} [side='both'] - 'both'|'left'|'right' (for mirror pair splitting)
   * @returns {{dxf: string, filename: string, pieceCount: number}}
   */
  buildDxfForMaterial(materialName, side = null) {
    if (!this._pattern) return { dxf: '', filename: '', pieceCount: 0 };

    const pat = this._pattern;
    const pwm = pat.pwm || { cut: 100, hole: 80, mark: 25, engrave: 15 };
    const patSlug = pat.name.replace(/[^a-zA-Z0-9]/g, '_');
    const matSlug = materialName.replace(/[^a-zA-Z0-9]/g, '_');

    const partIds = Object.entries(this._materials)
      .filter(([, mat]) => mat === materialName)
      .map(([pid]) => pid);
    const partIdSetMaterial = new Set(partIds);

    const mirror = side === 'L';
    const cutLayerName = materialName;

    // Build DXF header
    let dxf = '0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1021\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n';

    // TABLES section — layer definitions
    dxf += '0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n4\n';
    dxf += '0\nLAYER\n2\n' + cutLayerName + '\n70\n0\n62\n3\n6\nContinuous\n999\nPWM:' + pwm.cut + '\n';
    dxf += '0\nLAYER\n2\nHOLE\n70\n0\n62\n1\n6\nContinuous\n999\nPWM:' + pwm.hole + '\n';
    dxf += '0\nLAYER\n2\nMARK\n70\n0\n62\n5\n6\nContinuous\n999\nPWM:' + pwm.mark + '\n';
    dxf += '0\nLAYER\n2\nENGRAVE\n70\n0\n62\n6\n6\nContinuous\n999\nPWM:' + pwm.engrave + '\n';
    dxf += '0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n';

    let pcCount = 0;
    let curX = 0;
    let curY = 0;
    let rowMaxH = 0;

    // Collect and layout pieces
    const sortedSizes = [...pat.sizes].sort(
      (a, b) => (parseFloat(a.label) || 0) - (parseFloat(b.label) || 0)
    );

    for (const sz of sortedSizes) {
      const qty = this._quantities[sz.id] || 0;
      if (qty <= 0) continue;

      const pcs = pat.pieces.filter(
        p => p.sizeId === sz.id && partIdSetMaterial.has(p.partId)
      );

      for (const p of pcs) {
        const bb = p.bbox || polyBbox(p.pts);
        const pieceW = bb.w || (bb.x1 - bb.x0) || 0;
        const pieceH = bb.h || (bb.y1 - bb.y0) || 0;
        const cx = (bb.x != null ? bb.x : bb.x0) + pieceW / 2;

        for (let copy = 0; copy < qty; copy++) {
          // Grid layout: check if we need to wrap
          if (curX + pieceW > GRID_MAX_ROW_WIDTH && curX > 0) {
            curX = 0;
            curY += rowMaxH + GRID_GAP_Y;
            rowMaxH = 0;
          }

          // Compute offsets to position piece at (curX, curY)
          const offsetX = curX - (bb.x != null ? bb.x : bb.x0);
          const offsetY = curY - (bb.y != null ? bb.y : bb.y0);

          // Outer boundary on CUT layer
          if (pwm.cut > 0) {
            const pts = mirror ? [...p.pts].reverse() : p.pts;
            dxf += '0\nLWPOLYLINE\n8\n' + cutLayerName + '\n90\n' + pts.length + '\n70\n1\n';
            for (const [x, y] of pts) {
              const wx = mirror ? (2 * cx - x) : x;
              // Y-flip for DXF coordinate system (positive Y up)
              dxf += '10\n' + (wx + offsetX).toFixed(6) + '\n20\n' + (-(y + offsetY)).toFixed(6) + '\n';
            }
          }

          // Children (holes, marks, engrave)
          if (p.children) {
            for (const ch of p.children) {
              const ck = ch.kind || 'hole';
              if (ck === 'mark' && pwm.mark === 0) continue;
              if (ck === 'hole' && pwm.hole === 0) continue;
              if (ck === 'engrave' && pwm.engrave === 0) continue;
              const lyr = ck === 'mark' ? 'MARK' : ck === 'engrave' ? 'ENGRAVE' : 'HOLE';
              const cpts = mirror ? [...ch.pts].reverse() : ch.pts;
              dxf += '0\nLWPOLYLINE\n8\n' + lyr + '\n90\n' + cpts.length + '\n70\n1\n';
              for (const [x, y] of cpts) {
                const wx = mirror ? (2 * cx - x) : x;
                dxf += '10\n' + (wx + offsetX).toFixed(6) + '\n20\n' + (-(y + offsetY)).toFixed(6) + '\n';
              }
            }
          }

          pcCount++;
          curX += pieceW + GRID_GAP_X;
          if (pieceH > rowMaxH) rowMaxH = pieceH;
        }
      }
    }

    dxf += '0\nENDSEC\n0\nEOF\n';

    let sideSuffix = '';
    if (side === 'L') sideSuffix = '_L';
    else if (side === 'R') sideSuffix = '_R';
    const filename = patSlug + '_' + matSlug + sideSuffix + '.dxf';

    return { dxf, filename, pieceCount: pcCount };
  }

  /**
   * Export one DXF per material. If mirror pair is enabled, produces L and R files.
   * @returns {Array<{dxf: string, filename: string, pieceCount: number}>}
   */
  exportByMaterial() {
    if (!this._pattern) return [];

    const groups = this._buildMaterialGroups();
    const results = [];

    for (const matName of Object.keys(groups)) {
      if (this._mirrorPair) {
        const left = this.buildDxfForMaterial(matName, 'L');
        if (left.pieceCount > 0) results.push(left);
        const right = this.buildDxfForMaterial(matName, 'R');
        if (right.pieceCount > 0) results.push(right);
      } else {
        const res = this.buildDxfForMaterial(matName, null);
        if (res.pieceCount > 0) results.push(res);
      }
    }

    return results;
  }

  /**
   * Export a single combined DXF with all materials as named layers.
   * @returns {{dxf: string, filename: string}}
   */
  exportCombined() {
    if (!this._pattern) return [];

    const pat = this._pattern;
    const pwm = pat.pwm || { cut: 100, hole: 80, mark: 25, engrave: 15 };
    const patSlug = pat.name.replace(/[^a-zA-Z0-9]/g, '_');
    const groups = this._buildMaterialGroups();
    const matNames = Object.keys(groups);

    const sides = this._mirrorPair ? ['L', 'R'] : [null];
    const results = [];

    for (const side of sides) {
      const mirror = side === 'L';

      // Header
      let dxf = '0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1021\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n';

      // Layers — one per material + HOLE/MARK/ENGRAVE
      dxf += '0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n4\n';
      for (const mat of matNames) {
        dxf += '0\nLAYER\n2\n' + mat + '\n70\n0\n62\n3\n6\nContinuous\n999\nPWM:' + pwm.cut + '\n';
      }
      dxf += '0\nLAYER\n2\nHOLE\n70\n0\n62\n1\n6\nContinuous\n999\nPWM:' + pwm.hole + '\n';
      dxf += '0\nLAYER\n2\nMARK\n70\n0\n62\n5\n6\nContinuous\n999\nPWM:' + pwm.mark + '\n';
      dxf += '0\nLAYER\n2\nENGRAVE\n70\n0\n62\n6\n6\nContinuous\n999\nPWM:' + pwm.engrave + '\n';
      dxf += '0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n';

      let curX = 0;
      let curY = 0;
      let rowMaxH = 0;
      let pcCount = 0;

      const sortedSizes = [...pat.sizes].sort(
        (a, b) => (parseFloat(a.label) || 0) - (parseFloat(b.label) || 0)
      );

      // Iterate by material, then size, then piece (area descending)
      for (const matName of matNames) {
        const partIds = groups[matName];
        const partIdSet = new Set(partIds);
        for (const sz of sortedSizes) {
          const qty = this._quantities[sz.id] || 0;
          if (qty <= 0) continue;
          const pcs = pat.pieces
            .filter(p => p.sizeId === sz.id && partIdSet.has(p.partId))
            .sort((a, b) => (b.area || 0) - (a.area || 0));

          for (const p of pcs) {
            const bb = p.bbox || polyBbox(p.pts);
            const pieceW = bb.w || (bb.x1 - bb.x0) || 0;
            const pieceH = bb.h || (bb.y1 - bb.y0) || 0;
            const cx = (bb.x != null ? bb.x : bb.x0) + pieceW / 2;

            for (let copy = 0; copy < qty; copy++) {
              if (curX + pieceW > GRID_MAX_ROW_WIDTH && curX > 0) {
                curX = 0;
                curY += rowMaxH + GRID_GAP_Y;
                rowMaxH = 0;
              }

              const offsetX = curX - (bb.x != null ? bb.x : bb.x0);
              const offsetY = curY - (bb.y != null ? bb.y : bb.y0);

              if (pwm.cut > 0) {
                const pts = mirror ? [...p.pts].reverse() : p.pts;
                dxf += '0\nLWPOLYLINE\n8\n' + matName + '\n90\n' + pts.length + '\n70\n1\n';
                for (const [x, y] of pts) {
                  const wx = mirror ? (2 * cx - x) : x;
                  dxf += '10\n' + (wx + offsetX).toFixed(6) + '\n20\n' + (-(y + offsetY)).toFixed(6) + '\n';
                }
              }

              if (p.children) {
                for (const ch of p.children) {
                  const ck = ch.kind || 'hole';
                  if (ck === 'mark' && pwm.mark === 0) continue;
                  if (ck === 'hole' && pwm.hole === 0) continue;
                  if (ck === 'engrave' && pwm.engrave === 0) continue;
                  const lyr = ck === 'mark' ? 'MARK' : ck === 'engrave' ? 'ENGRAVE' : 'HOLE';
                  const cpts = mirror ? [...ch.pts].reverse() : ch.pts;
                  dxf += '0\nLWPOLYLINE\n8\n' + lyr + '\n90\n' + cpts.length + '\n70\n1\n';
                  for (const [x, y] of cpts) {
                    const wx = mirror ? (2 * cx - x) : x;
                    dxf += '10\n' + (wx + offsetX).toFixed(6) + '\n20\n' + (-(y + offsetY)).toFixed(6) + '\n';
                  }
                }
              }

              pcCount++;
              curX += pieceW + GRID_GAP_X;
              if (pieceH > rowMaxH) rowMaxH = pieceH;
            }
          }
        }
      }

      dxf += '0\nENDSEC\n0\nEOF\n';

      const sfx = side ? '_' + side : '';
      const filename = patSlug + '_ALL' + sfx + '.dxf';
      results.push({ dxf, filename, pieceCount: pcCount, side });
    }

    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Push to Nesting
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Build a payload of parts ready for the NestingEngine.
   * Expands by quantity, applies mirror if enabled.
   * @returns {Array<{id: string, name: string, boundary: number[][], children: Array, qty: number, bb: object, color: string, material: string, sizeLbl: string, partName: string, side: string|null}>}
   */
  buildNestingPayload() {
    if (!this._pattern) return [];

    const pat = this._pattern;
    const sides = this._mirrorPair ? ['L', 'R'] : [null];
    const pushParts = [];
    let idCounter = 0;

    for (const side of sides) {
      const mirror = side === 'L';
      const sfx = side ? '_' + side : '';

      for (const pt of pat.parts) {
        const mat = this._materials[pt.id] || 'Unassigned';
        const pcs = pat.pieces.filter(p => p.partId === pt.id);

        for (const p of pcs) {
          const qty = this._quantities[p.sizeId] || 0;
          if (qty <= 0) continue;

          const sz = pat.sizes.find(s => s.id === p.sizeId);
          const szLabel = sz ? sz.label : '?';
          const bb = p.bbox || polyBbox(p.pts);
          const pieceW = bb.w || (bb.x1 - bb.x0) || 0;
          const pieceH = bb.h || (bb.y1 - bb.y0) || 0;
          const cx = (bb.x != null ? bb.x : bb.x0) + pieceW / 2;

          // Build boundary: apply mirror, normalize to origin, Y-flip
          const boundary = p.pts.map(([x, y]) => {
            const wx = mirror ? (2 * cx - x) : x;
            return [wx, y];
          });
          if (mirror) boundary.reverse();

          const normBbox = _computeBbox(boundary);
          const normH = normBbox.y1 - normBbox.y0;
          const norm = boundary.map(([x, y]) => [
            x - normBbox.x0,
            normH - (y - normBbox.y0)
          ]);

          // Process children
          const children = [];
          if (p.children) {
            for (const ch of p.children) {
              const cpoly = ch.pts.map(([x, y]) => {
                const wx = mirror ? (2 * cx - x) : x;
                return [wx, y];
              });
              if (mirror) cpoly.reverse();
              children.push({
                poly: cpoly.map(([x, y]) => [
                  x - normBbox.x0,
                  normH - (y - normBbox.y0)
                ]),
                kind: ch.kind || 'hole'
              });
            }
          }

          const name = pat.name + '_' + pt.name + sfx + '_sz' + szLabel;
          const finalBb = {
            x0: 0,
            y0: 0,
            x1: normBbox.x1 - normBbox.x0,
            y1: normBbox.y1 - normBbox.y0,
            w: normBbox.x1 - normBbox.x0,
            h: normBbox.y1 - normBbox.y0
          };

          pushParts.push({
            id: pat.id + '_' + pt.id + '_' + p.sizeId + sfx + '_' + (idCounter++),
            name,
            boundary: norm,
            children,
            qty,
            bb: finalBb,
            color: pt.color,
            material: mat,
            sizeLbl: szLabel,
            partName: pt.name,
            side
          });
        }
      }
    }

    return pushParts;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Presets
  // ═══════════════════════════════════════════════════════════════════════════

  getMaterialPresets() {
    return [...MATERIAL_PRESETS];
  }

  getActiveParts() {
    if (!this._pattern) return [];
    const usedIds = new Set(this._pattern.pieces.map(p => p.partId).filter(Boolean));
    const parts = this._pattern.parts.filter(p => usedIds.has(p.id));
    usedIds.forEach(pid => {
      if (!parts.find(p => p.id === pid)) {
        const pc = this._pattern.pieces.find(p => p.partId === pid);
        parts.push({ id: pid, name: pc ? (pc.layer || 'Part_' + pid) : 'Part_' + pid, color: '#7a8fa8' });
      }
    });
    return parts;
  }

  applyPreset(mat) {
    if (!this._pattern) return null;
    const activeParts = this.getActiveParts();
    const empty = activeParts.find(pt => !this._materials[pt.id]);
    if (empty) {
      this._materials[empty.id] = mat;
      this._saveMatCache();
      this._notify();
      return empty.id;
    }
    return null;
  }

  _loadMatCache() {
    try { return JSON.parse(localStorage.getItem('patterniq_mat_cache')) || {}; }
    catch { return {}; }
  }

  _saveMatCache() {
    if (!this._pattern) return;
    const cache = this._loadMatCache();
    cache[this._pattern.id] = { ...this._materials };
    try { localStorage.setItem('patterniq_mat_cache', JSON.stringify(cache)); } catch {}
  }

  async pushToNesting() {
    const pushParts = this.buildNestingPayload();
    if (!pushParts.length) return false;

    const pat = this._pattern;
    const payload = {
      id: 'push',
      ts: Date.now(),
      patternName: pat.name,
      mirrorPair: this._mirrorPair,
      pwm: pat.pwm || { cut: 100, hole: 80, mark: 25, engrave: 15 },
      parts: pushParts
    };

    try {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('PatternIQ_NestPush', 1);
        req.onupgradeneeded = (e) => {
          const d = e.target.result;
          if (!d.objectStoreNames.contains('push')) d.createObjectStore('push', { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const tx = db.transaction('push', 'readwrite');
      tx.objectStore('push').put(payload);
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = reject; });
      db.close();
      return true;
    } catch (e) {
      console.warn('[Checkout] pushToNesting IndexedDB failed:', e);
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Private helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Build a map of materialName → partId[] from current assignments.
   * @returns {object}
   * @private
   */
  _buildMaterialGroups() {
    const groups = {};
    for (const [partId, matName] of Object.entries(this._materials)) {
      if (!matName) continue;
      if (!groups[matName]) groups[matName] = [];
      groups[matName].push(partId);
    }
    return groups;
  }

  /**
   * Notify listener of state change.
   * @private
   */
  _notify() {
    if (this._onUpdate) {
      this._onUpdate(this);
    }
  }
}

// ── Internal utility ──────────────────────────────────────────────────────────

/**
 * Compute axis-aligned bounding box from a points array.
 * @param {number[][]} pts
 * @returns {{x0: number, y0: number, x1: number, y1: number}}
 * @private
 */
function _computeBbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}
