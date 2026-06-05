// Pattern Library module for Pattrniq Professional
// Handles pattern piece library, size/part management, fingerprint matching, and spread algorithm
// Ported from patternINQ.html

import { polyArea, polyBbox, polyCentroid } from './geometry.js';

// ---- Helpers ----

let _nextId = 1;
function uid() {
  return 'pl_' + (_nextId++);
}

function polyPerimeter(pts) {
  let len = 0;
  const n = pts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const dx = pts[i][0] - pts[j][0];
    const dy = pts[i][1] - pts[j][1];
    len += Math.sqrt(dx * dx + dy * dy);
  }
  return len;
}

const PART_COLORS = [
  '#b8ff47', '#00d4ff', '#ffaa00', '#ff4466', '#8855ff',
  '#00cc88', '#ff9500', '#3a9eff', '#ff6b5b', '#ffc542',
  '#e879f9', '#34d399'
];

const SZ_COLORS = [
  '#ff4466', '#ffaa00', '#b8ff47', '#00d4ff', '#8855ff', '#00cc88',
  '#ff8833', '#ff55cc', '#55aaff', '#ffdd55', '#ff66aa', '#aaffdd',
  '#ffcc44', '#cc88ff'
];

const SHOE_PARTS = [
  'Vamp', 'Quarter', 'Tongue', 'Counter', 'Heel Cap', 'Toe Cap',
  'Collar', 'Eyestay', 'Mudguard', 'Foxing', 'Lining', 'Insole'
];

// ---- PatternLibrary class ----

export class PatternLibrary {
  constructor() {
    this._sizes = [];        // [{id, label}]
    this._parts = [];        // [{id, name, color}]
    this._pieces = [];       // [{id, boundary, children, sizeId, partId, material, name, ...}]
    this._quantities = {};   // {sizeId: qty}
    this._materials = new Map(); // partId -> materialName
    this._colorIndex = 0;
  }

  // ==========================================================================
  // Size Management
  // ==========================================================================

  addSize(label) {
    const size = { id: uid(), label };
    this._sizes.push(size);
    return { id: size.id, label: size.label };
  }

  removeSize(sizeId) {
    this._sizes = this._sizes.filter(s => s.id !== sizeId);
    delete this._quantities[sizeId];
    // Unassign pieces that referenced this size
    for (const piece of this._pieces) {
      if (piece.sizeId === sizeId) piece.sizeId = null;
    }
  }

  getSizes() {
    return this._sizes.map(s => ({ id: s.id, label: s.label }));
  }

  // ==========================================================================
  // Part Management
  // ==========================================================================

  addPart(name) {
    const color = PART_COLORS[this._colorIndex % PART_COLORS.length];
    this._colorIndex++;
    const part = { id: uid(), name, color };
    this._parts.push(part);
    return { id: part.id, name: part.name, color: part.color };
  }

  removePart(partId) {
    this._parts = this._parts.filter(p => p.id !== partId);
    this._materials.delete(partId);
    // Unassign pieces that referenced this part
    for (const piece of this._pieces) {
      if (piece.partId === partId) piece.partId = null;
    }
  }

  getParts() {
    return this._parts.map(p => ({ id: p.id, name: p.name, color: p.color }));
  }

  // ==========================================================================
  // Piece Management
  // ==========================================================================

  addPieces(pieces) {
    const added = [];
    for (const piece of pieces) {
      const entry = {
        id: uid(),
        boundary: piece.boundary || piece.pts || [],
        children: piece.children || [],
        name: piece.name || null,
        sizeId: piece.sizeId || null,
        partId: piece.partId || null,
        material: piece.material || null
      };
      this._pieces.push(entry);
      added.push(entry);
    }
    return added;
  }

  removePiece(pieceId) {
    this._pieces = this._pieces.filter(p => p.id !== pieceId);
  }

  getPieces(filter) {
    if (!filter) return this._pieces.slice();
    return this._pieces.filter(p => {
      if (filter.sizeId !== undefined && p.sizeId !== filter.sizeId) return false;
      if (filter.partId !== undefined && p.partId !== filter.partId) return false;
      if (filter.material !== undefined && p.material !== filter.material) return false;
      return true;
    });
  }

  getPiece(pieceId) {
    return this._pieces.find(p => p.id === pieceId) || null;
  }

  assignSize(pieceIds, sizeId) {
    for (const piece of this._pieces) {
      if (pieceIds.includes(piece.id)) {
        piece.sizeId = sizeId;
      }
    }
  }

  assignPart(pieceIds, partId) {
    for (const piece of this._pieces) {
      if (pieceIds.includes(piece.id)) {
        piece.partId = partId;
      }
    }
  }

  setQuantity(sizeId, qty) {
    this._quantities[sizeId] = qty;
  }

  getQuantities() {
    return { ...this._quantities };
  }

  // ==========================================================================
  // Fingerprinting & Spread
  // ==========================================================================

  computeFingerprint(piece) {
    const pts = piece.pts || piece.boundary;
    if (!pts || pts.length < 3) return null;

    const bb = polyBbox(pts);
    const w = bb.w || 1, h = bb.h || 1;
    const area = Math.abs(polyArea(pts));
    const perim = polyPerimeter(pts);
    const aspect = Math.min(w / h, h / w);
    const circ = (4 * Math.PI * area) / (perim * perim);
    const solid = area / (w * h);
    const verts = pts.length;

    // Radial signature: iterate ALL points, assign to angular bins, keep max distance
    const [cx, cy] = polyCentroid(pts);
    const radial = Array(12).fill(0);
    const maxR = Math.hypot(w, h) / 2;
    for (const [px, py] of pts) {
      const dx = px - cx, dy = py - cy;
      const ang = (Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI);
      const bin = Math.floor(ang * 12) % 12;
      const d = Math.sqrt(dx * dx + dy * dy);
      const norm = maxR > 0 ? d / maxR : 0;
      if (norm > radial[bin]) radial[bin] = norm;
    }

    // Curvature: dot-product cosine between vectors
    const curv = Array(8).fill(0);
    const step = Math.floor(pts.length / 8);
    for (let i = 0; i < 8 && step > 0; i++) {
      const idx = i * step;
      const prev = pts[(idx - step + pts.length) % pts.length];
      const curr = pts[idx];
      const next = pts[(idx + step) % pts.length];
      const v1x = curr[0] - prev[0], v1y = curr[1] - prev[1];
      const v2x = next[0] - curr[0], v2y = next[1] - curr[1];
      const mag1 = Math.sqrt(v1x * v1x + v1y * v1y);
      const mag2 = Math.sqrt(v2x * v2x + v2y * v2y);
      if (mag1 > 0 && mag2 > 0) {
        curv[i] = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (mag1 * mag2)));
      }
    }

    return { aspect, circ, solid, verts, radial, curv, area, perim };
  }

  fingerprintSimilarity(fpA, fpB) {
    if (!fpA || !fpB) return 0;

    // Cosine similarity of radial vectors (weight 0.28)
    function cosSim(a, b) {
      let dot = 0, ma = 0, mb = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        ma += a[i] * a[i];
        mb += b[i] * b[i];
      }
      ma = Math.sqrt(ma); mb = Math.sqrt(mb);
      return (ma > 0 && mb > 0) ? Math.max(0, dot / (ma * mb)) : 0;
    }

    const radialSim = cosSim(fpA.radial, fpB.radial);
    const curvSim = cosSim(fpA.curv, fpB.curv);

    // Scalar similarities
    const aspectSim = 1 - Math.abs(fpA.aspect - fpB.aspect) / (Math.max(fpA.aspect, fpB.aspect) || 1);
    const circSim = 1 - Math.abs(fpA.circ - fpB.circ);
    const solidSim = 1 - Math.abs(fpA.solid - fpB.solid);
    const vertsSim = 1 - Math.abs(fpA.verts - fpB.verts) / Math.max(fpA.verts, fpB.verts, 1);

    // 6-component weighted formula matching source
    const score = radialSim * 0.28 + curvSim * 0.18 + aspectSim * 0.15 +
                  circSim * 0.12 + solidSim * 0.12 + vertsSim * 0.15;
    return Math.max(0, Math.min(1, score));
  }

  spreadPart(referencePiece) {
    if (!referencePiece.partId) {
      console.warn('[PatternLibrary] spreadPart: reference piece must have partId assigned');
      return [];
    }

    const refFp = this.computeFingerprint(referencePiece);
    if (!refFp) return [];

    // Find candidates with gap-based threshold
    const scores = [];
    for (const piece of this._pieces) {
      if (piece.id === referencePiece.id) continue;
      if (piece.partId) continue;
      const fp = this.computeFingerprint(piece);
      const sim = this.fingerprintSimilarity(refFp, fp);
      scores.push({ piece, area: Math.abs(polyArea(piece.boundary)), sim });
    }

    // Gap detection: sort descending, find first gap > 0.05
    scores.sort((a, b) => b.sim - a.sim);
    let threshold = 0.90;
    for (let i = 1; i < scores.length; i++) {
      if (scores[i - 1].sim - scores[i].sim > 0.05) {
        threshold = scores[i].sim + 0.001;
        break;
      }
    }
    threshold = Math.max(threshold, 0.90);

    const candidates = scores.filter(s => s.sim >= threshold);
    // Include reference in pool
    const pool = [{ piece: referencePiece, area: Math.abs(polyArea(referencePiece.boundary)), sim: 1.0 }, ...candidates];
    pool.sort((a, b) => a.area - b.area);

    // Auto-create missing sizes if pool has more pieces than available sizes
    if (this._sizes.length < pool.length) {
      // Determine next sequential numeric label
      let maxNum = 0;
      for (const s of this._sizes) {
        const n = parseFloat(s.label);
        if (!isNaN(n) && n > maxNum) maxNum = n;
      }
      // Add sizes until we have enough
      while (this._sizes.length < pool.length) {
        maxNum++;
        this.addSize(String(maxNum));
      }
    }

    // Sort sizes by label ascending
    const sortedSizes = this._sizes.slice().sort((a, b) => {
      const numA = parseFloat(a.label);
      const numB = parseFloat(b.label);
      if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
      return a.label.localeCompare(b.label);
    });

    // Group/clone: distribute sizes evenly across pool pieces
    const assigned = [];
    if (sortedSizes.length === 0) return assigned;

    const groupSize = Math.ceil(sortedSizes.length / pool.length);
    for (let i = 0; i < sortedSizes.length; i++) {
      const poolIdx = Math.min(Math.floor(i / groupSize), pool.length - 1);
      let target = pool[poolIdx].piece;

      // Clone if this piece already has a size assigned (multi-size grouping)
      if (target.sizeId && target.sizeId !== sortedSizes[i].id) {
        const clone = {
          id: uid(),
          boundary: target.boundary.map(p => [...p]),
          children: (target.children || []).map(c => ({ ...c, poly: c.poly.map(p => [...p]) })),
          name: target.name,
          sizeId: null,
          partId: null,
          material: target.material
        };
        this._pieces.push(clone);
        target = clone;
      }

      target.sizeId = sortedSizes[i].id;
      target.partId = referencePiece.partId;
      if (target.id !== referencePiece.id) assigned.push(target);
    }

    // Engrave propagation: copy engrave children from reference to all assigned siblings
    const refEngraves = (referencePiece.children || []).filter(c => c.kind === 'engrave');
    if (refEngraves.length > 0) {
      const refCentroid = polyCentroid(referencePiece.boundary);
      for (const piece of assigned) {
        const pCentroid = polyCentroid(piece.boundary);
        const dx = pCentroid[0] - refCentroid[0];
        const dy = pCentroid[1] - refCentroid[1];
        for (const eng of refEngraves) {
          const shifted = eng.poly.map(([x, y]) => [x + dx, y + dy]);
          piece.children = piece.children || [];
          piece.children.push({ poly: shifted, kind: 'engrave' });
        }
      }
    }

    return assigned;
  }

  spreadAll() {
    const results = [];
    // Find all pieces that have both sizeId and partId (reference pieces)
    const references = this._pieces.filter(p => p.sizeId && p.partId);
    // Group by partId to avoid spreading the same part multiple times
    const seenParts = new Set();
    for (const ref of references) {
      if (seenParts.has(ref.partId)) continue;
      seenParts.add(ref.partId);
      const assigned = this.spreadPart(ref);
      results.push(...assigned);
    }
    return results;
  }

  // ==========================================================================
  // Material Assignment
  // ==========================================================================

  assignMaterial(partId, material) {
    this._materials.set(partId, material);
    // Also update pieces belonging to this part
    for (const piece of this._pieces) {
      if (piece.partId === partId) {
        piece.material = material;
      }
    }
  }

  getMaterials() {
    return new Map(this._materials);
  }

  // ==========================================================================
  // Expand for Nesting
  // ==========================================================================

  expandForNesting(options = {}) {
    const { materials = null, mirrorPair = false } = options;
    const result = [];

    for (const piece of this._pieces) {
      if (!piece.sizeId || !piece.partId) continue;

      // Filter by material if specified
      if (materials) {
        const pieceMaterial = piece.material || this._materials.get(piece.partId) || null;
        if (pieceMaterial && !materials.has(pieceMaterial)) continue;
        if (!pieceMaterial && materials.size > 0) continue;
      }

      const qty = this._quantities[piece.sizeId] || 0;
      if (qty <= 0) continue;

      const part = this._parts.find(p => p.id === piece.partId);
      const size = this._sizes.find(s => s.id === piece.sizeId);
      if (!part || !size) continue;

      const bb = polyBbox(piece.boundary);
      const material = piece.material || this._materials.get(piece.partId) || null;
      const name = `${part.name}_${size.label}`;

      const entry = {
        id: piece.id,
        name,
        boundary: piece.boundary,
        children: piece.children || [],
        qty: mirrorPair ? qty * 2 : qty,
        bb,
        color: part.color,
        material
      };
      result.push(entry);
    }

    return result;
  }

  // ==========================================================================
  // Shoe Defaults
  // ==========================================================================

  addShoeParts() {
    const added = [];
    for (const name of SHOE_PARTS) {
      if (!this._parts.find(p => p.name === name)) {
        added.push(this.addPart(name));
      }
    }
    return added;
  }

  getSzColor(sizeIndex) {
    return SZ_COLORS[sizeIndex % SZ_COLORS.length];
  }

  // ==========================================================================
  // Publish to Nesting DB (IndexedDB + localStorage dual-write)
  // ==========================================================================

  buildPublishPayload(patternName, pwm = { cut: 100, hole: 80, mark: 25, engrave: 15 }) {
    return {
      id: patternName || 'pattern_' + Date.now(),
      name: patternName || 'Untitled',
      savedAt: new Date().toISOString(),
      lastUsedAt: Date.now(),
      ts: Date.now(),
      sizes: this._sizes,
      parts: this._parts,
      pieces: this._pieces.map(p => ({
        id: p.id, boundary: p.boundary, pts: p.boundary,
        area: Math.abs(polyArea(p.boundary)),
        bbox: polyBbox(p.boundary),
        layer: p.name || '',
        children: p.children,
        sizeId: p.sizeId, partId: p.partId, material: p.material, name: p.name
      })),
      quantities: this._quantities,
      materials: Array.from(this._materials.entries()),
      pwm
    };
  }

  // ==========================================================================
  // Persistence
  // ==========================================================================

  toJSON() {
    return {
      sizes: this._sizes,
      parts: this._parts,
      pieces: this._pieces,
      quantities: this._quantities,
      materials: Array.from(this._materials.entries()),
      colorIndex: this._colorIndex
    };
  }

  fromJSON(data) {
    if (!data) return;
    this._sizes = data.sizes || [];
    this._parts = data.parts || [];
    this._pieces = data.pieces || [];
    this._quantities = data.quantities || {};
    this._materials = new Map(data.materials || []);
    this._colorIndex = data.colorIndex || 0;

    // Ensure _nextId is higher than any existing id
    const allIds = [
      ...this._sizes.map(s => s.id),
      ...this._parts.map(p => p.id),
      ...this._pieces.map(p => p.id)
    ];
    for (const id of allIds) {
      const num = parseInt(id.replace('pl_', ''), 10);
      if (!isNaN(num) && num >= _nextId) {
        _nextId = num + 1;
      }
    }
  }

  // ==========================================================================
  // Publish via DataBridge (replaces direct localStorage/IndexedDB access)
  // ==========================================================================

  async publishToNestingDB(patternName, pwm, dataBridge) {
    const data = this.buildPublishPayload(patternName, pwm);
    if (dataBridge && dataBridge.publishToNestingDB) {
      await dataBridge.publishToNestingDB(data);
    }
    return data;
  }

  // ==========================================================================
  // Sibling Detection (SPA-aware checkout availability check)
  // ==========================================================================

  detectSibling(checkoutPath = 'patternOutQ.html') {
    return new Promise((resolve) => {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('HEAD', checkoutPath, true);
        xhr.timeout = 2000;
        xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 400);
        xhr.onerror = () => resolve(false);
        xhr.ontimeout = () => resolve(false);
        xhr.send();
      } catch {
        resolve(false);
      }
    });
  }

  // ==========================================================================
  // Stats
  // ==========================================================================

  getStats() {
    const totalPieces = this._pieces.length;
    const assignedPieces = this._pieces.filter(p => p.sizeId && p.partId).length;
    const sizeCount = this._sizes.length;
    const partCount = this._parts.length;
    const labeledParts = new Set(
      this._pieces.filter(p => p.partId).map(p => p.partId)
    ).size;

    return { totalPieces, assignedPieces, sizeCount, partCount, labeledParts };
  }
}
