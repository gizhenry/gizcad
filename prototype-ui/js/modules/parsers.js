/**
 * parsers.js — DXF and SVG parsers for leather pattern nesting application.
 * Parses pattern files into normalized part objects with boundaries and children.
 */

import { polyArea, polyBbox, polyCentroid, polyPIP } from './geometry.js';

const PALETTE = [
  '#3a9eff', '#00c896', '#ff8c42', '#b07cff',
  '#ff6b5b', '#3dd68c', '#ffc542', '#60c7f5'
];

const ENDPOINT_TOLERANCE = 0.5;

function ensureClosed(pts) {
  if (pts.length < 3) return pts;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const dx = first[0] - last[0];
  const dy = first[1] - last[1];
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > 0 && dist < ENDPOINT_TOLERANCE * 2) {
    pts[pts.length - 1] = [first[0], first[1]];
  }
  return pts;
}

function isClosed(pts) {
  if (pts.length < 3) return false;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const dx = first[0] - last[0];
  const dy = first[1] - last[1];
  return (dx * dx + dy * dy) < ENDPOINT_TOLERANCE * ENDPOINT_TOLERANCE * 4;
}

function expandBulges(pts, bulges) {
  const result = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    result.push(pts[i]);
    const bulge = bulges[i] || 0;
    if (Math.abs(bulge) < 1e-6) continue;
    const j = (i + 1) % n;
    if (j === 0 && n < 3) continue;
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[j];
    const dx = x2 - x1, dy = y2 - y1;
    const chord = Math.sqrt(dx * dx + dy * dy);
    if (chord < 1e-10) continue;
    const sagitta = Math.abs(bulge) * chord / 2;
    const r = (chord * chord / 4 + sagitta * sagitta) / (2 * sagitta);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const d = r - sagitta;
    const nx = -dy / chord, ny = dx / chord;
    const sign = bulge > 0 ? 1 : -1;
    const cx = mx + sign * d * nx;
    const cy = my + sign * d * ny;
    const startAngle = Math.atan2(y1 - cy, x1 - cx);
    const endAngle = Math.atan2(y2 - cy, x2 - cx);
    let sweep = endAngle - startAngle;
    if (bulge > 0 && sweep < 0) sweep += 2 * Math.PI;
    if (bulge < 0 && sweep > 0) sweep -= 2 * Math.PI;
    const segments = Math.max(4, Math.ceil(Math.abs(sweep) * r / 5));
    for (let s = 1; s < segments; s++) {
      const t = startAngle + sweep * (s / segments);
      result.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
    }
  }
  return result;
}

// ─── Utility ────────────────────────────────────────────────────────────────

let _idCounter = 0;
function uniqueId() {
  return 'part_' + (++_idCounter) + '_' + Date.now().toString(36);
}

function normalize(poly) {
  if (!poly || poly.length === 0) return poly;
  const bb = polyBbox(poly);
  return poly.map(([x, y]) => [x - bb.x0, y - bb.y0]);
}

// ─── DXF Parser ─────────────────────────────────────────────────────────────

/**
 * Parse DXF text into an array of part objects.
 * @param {string} text - raw DXF file content
 * @param {string} filename - source filename
 * @returns {Array|null} array of part objects or null on failure
 */
export function parseDXF(text, filename) {
  try {
    const pairs = splitGroupPairs(text);

    // Parse BLOCKS section for block definitions
    const blocks = parseBlocks(pairs);

    const entitiesStart = findEntitiesSection(pairs);
    if (entitiesStart < 0) return null;

    const rawEntities = parseEntities(pairs, entitiesStart);

    // Resolve INSERT references into actual geometry from blocks
    const resolvedEntities = resolveInserts(rawEntities, blocks);

    if (resolvedEntities.length === 0) return null;

    let polys = entitiesToPolys(resolvedEntities);
    if (polys.length === 0) return null;

    // Auto-detect units and scale
    const scale = detectScale(polys);
    if (scale !== 1) {
      polys = polys.map(p => ({
        ...p,
        pts: p.pts.map(([x, y]) => [x * scale, y * scale])
      }));
    }

    // Flip Y axis (DXF Y-up to screen Y-down)
    const allY = polys.flatMap(p => p.pts.map(pt => pt[1]));
    const maxY = Math.max(...allY);
    polys = polys.map(p => ({
      ...p,
      pts: p.pts.map(([x, y]) => [x, maxY - y])
    }));

    return buildParts(polys, filename);
  } catch (e) {
    console.error('parseDXF error:', e);
    return null;
  }
}

function splitGroupPairs(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    const value = lines[i + 1].trim();
    pairs.push({ code, value });
  }
  return pairs;
}

function findEntitiesSection(pairs) {
  for (let i = 0; i < pairs.length - 1; i++) {
    if (pairs[i].code === 0 && pairs[i].value === 'SECTION' &&
        pairs[i + 1].code === 2 && pairs[i + 1].value === 'ENTITIES') {
      return i + 2;
    }
  }
  return -1;
}

function parseBlocks(pairs) {
  const blocks = new Map();
  let blockStart = -1;

  for (let i = 0; i < pairs.length - 1; i++) {
    if (pairs[i].code === 0 && pairs[i].value === 'SECTION' &&
        pairs[i + 1].code === 2 && pairs[i + 1].value === 'BLOCKS') {
      blockStart = i + 2;
      break;
    }
  }
  if (blockStart < 0) return blocks;

  let bi = blockStart;
  while (bi < pairs.length) {
    if (pairs[bi].code === 0 && pairs[bi].value === 'ENDSEC') break;

    if (pairs[bi].code === 0 && pairs[bi].value === 'BLOCK') {
      let name = null;
      let entStart = -1;
      let endBlkIdx = -1;

      for (let j = bi + 1; j < pairs.length; j++) {
        if (pairs[j].code === 2 && !name) {
          name = pairs[j].value;
        }
        if (pairs[j].code === 0 && entStart < 0 &&
            pairs[j].value !== 'BLOCK' && pairs[j].value !== 'ENDBLK') {
          entStart = j;
        }
        if (pairs[j].code === 0 && pairs[j].value === 'ENDBLK') {
          endBlkIdx = j;
          break;
        }
      }

      if (name && entStart >= 0 && endBlkIdx >= 0) {
        const ents = parseBlockEntities(pairs, entStart, endBlkIdx);
        if (ents.length > 0) {
          blocks.set(name, ents);
        }
      }
      bi = (endBlkIdx >= 0) ? endBlkIdx + 1 : bi + 1;
      continue;
    }
    bi++;
  }

  return blocks;
}

function parseBlockEntities(pairs, startIdx, endIdx) {
  const sliced = pairs.slice(startIdx, endIdx);
  sliced.push({ code: 0, value: 'ENDSEC' });
  return parseEntities(sliced, 0);
}

function resolveInserts(entities, blocks) {
  if (blocks.size === 0) return entities;

  const resolved = [];
  for (const ent of entities) {
    if (ent.type === 'INSERT') {
      const blockName = ent.params.blockName;
      const blockEnts = blocks.get(blockName);
      if (blockEnts) {
        const tx = ent.params.x || 0;
        const ty = ent.params.y || 0;
        const sx = ent.params.scaleX || 1;
        const sy = ent.params.scaleY || 1;
        const rot = (ent.params.rotation || 0) * Math.PI / 180;
        const cos = Math.cos(rot);
        const sin = Math.sin(rot);

        for (const bEnt of blockEnts) {
          const clone = JSON.parse(JSON.stringify(bEnt));
          clone.layer = clone.layer || ent.layer;
          clone._insertTransform = { tx, ty, sx, sy, cos, sin };
          resolved.push(clone);
        }
      }
    } else {
      resolved.push(ent);
    }
  }
  return resolved;
}

function parseEntities(pairs, startIdx) {
  const entities = [];
  let current = null;
  let vertices = [];
  let inPolyline = false;

  for (let i = startIdx; i < pairs.length; i++) {
    const { code, value } = pairs[i];

    if (code === 0 && value === 'ENDSEC') break;

    if (code === 0) {
      // Finish previous entity
      if (current && !inPolyline) {
        entities.push(current);
      }

      if (value === 'POLYLINE') {
        inPolyline = true;
        vertices = [];
        current = { type: 'POLYLINE', layer: '', pts: [] };
      } else if (value === 'VERTEX' && inPolyline) {
        vertices.push({ x: 0, y: 0 });
      } else if (value === 'SEQEND' && inPolyline) {
        current.pts = vertices.map(v => [v.x, v.y]);
        entities.push(current);
        inPolyline = false;
        current = null;
        continue;
      } else {
        current = { type: value, layer: '', pts: [], params: {} };
      }
      continue;
    }

    if (inPolyline && vertices.length > 0) {
      const vtx = vertices[vertices.length - 1];
      if (code === 10) vtx.x = parseFloat(value);
      else if (code === 20) vtx.y = parseFloat(value);
      else if (code === 8 && current) current.layer = value;
      continue;
    }

    if (!current) continue;

    if (code === 8) {
      current.layer = value;
    } else if (current.type === 'LWPOLYLINE') {
      if (code === 10) {
        if (!current._xs) current._xs = [];
        current._xs.push(parseFloat(value));
      } else if (code === 20) {
        if (!current._ys) current._ys = [];
        current._ys.push(parseFloat(value));
      } else if (code === 42) {
        if (!current._bulges) current._bulges = [];
        current._bulges.push(parseFloat(value));
      } else if (code === 70) {
        current.params.closed = (parseInt(value, 10) & 1) === 1;
      }
    } else if (current.type === 'LINE') {
      if (code === 10) current.params.x1 = parseFloat(value);
      else if (code === 20) current.params.y1 = parseFloat(value);
      else if (code === 11) current.params.x2 = parseFloat(value);
      else if (code === 21) current.params.y2 = parseFloat(value);
    } else if (current.type === 'CIRCLE') {
      if (code === 10) current.params.cx = parseFloat(value);
      else if (code === 20) current.params.cy = parseFloat(value);
      else if (code === 40) current.params.r = parseFloat(value);
    } else if (current.type === 'ARC') {
      if (code === 10) current.params.cx = parseFloat(value);
      else if (code === 20) current.params.cy = parseFloat(value);
      else if (code === 40) current.params.r = parseFloat(value);
      else if (code === 50) current.params.startAngle = parseFloat(value);
      else if (code === 51) current.params.endAngle = parseFloat(value);
    } else if (current.type === 'SPLINE') {
      if (code === 10) {
        if (!current._xs) current._xs = [];
        current._xs.push(parseFloat(value));
      } else if (code === 20) {
        if (!current._ys) current._ys = [];
        current._ys.push(parseFloat(value));
      }
    } else if (current.type === 'ELLIPSE') {
      if (code === 10) current.params.cx = parseFloat(value);
      else if (code === 20) current.params.cy = parseFloat(value);
      else if (code === 11) current.params.majorX = parseFloat(value);
      else if (code === 21) current.params.majorY = parseFloat(value);
      else if (code === 40) current.params.ratio = parseFloat(value);
      else if (code === 41) current.params.startParam = parseFloat(value);
      else if (code === 42) current.params.endParam = parseFloat(value);
    } else if (current.type === 'INSERT') {
      if (code === 2) current.params.blockName = value;
      else if (code === 10) current.params.x = parseFloat(value);
      else if (code === 20) current.params.y = parseFloat(value);
      else if (code === 41) current.params.scaleX = parseFloat(value);
      else if (code === 42) current.params.scaleY = parseFloat(value);
      else if (code === 50) current.params.rotation = parseFloat(value);
    }
  }

  // Push last entity
  if (current && !inPolyline) {
    entities.push(current);
  }

  return entities;
}

function entitiesToPolys(entities) {
  const polys = [];
  const lines = [];

  for (const ent of entities) {
    const xf = ent._insertTransform || null;

    switch (ent.type) {
      case 'LWPOLYLINE': {
        const xs = ent._xs || [];
        const ys = ent._ys || [];
        const bulges = ent._bulges || [];
        let pts = [];
        const len = Math.min(xs.length, ys.length);
        for (let i = 0; i < len; i++) {
          pts.push([xs[i], ys[i]]);
        }
        if (bulges.length > 0 && pts.length >= 2) {
          pts = expandBulges(pts, bulges);
        }
        if (pts.length >= 3) {
          if (ent.params.closed) ensureClosed(pts);
          polys.push({ pts, layer: ent.layer, _insertTransform: xf });
        }
        break;
      }
      case 'LINE': {
        const { x1, y1, x2, y2 } = ent.params;
        if (x1 != null && y1 != null && x2 != null && y2 != null) {
          lines.push({ pts: [[x1, y1], [x2, y2]], layer: ent.layer, _insertTransform: xf });
        }
        break;
      }
      case 'CIRCLE': {
        const { cx, cy, r } = ent.params;
        if (cx != null && cy != null && r != null) {
          const pts = [];
          const segments = 64;
          for (let i = 0; i < segments; i++) {
            const a = (2 * Math.PI * i) / segments;
            pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
          }
          polys.push({ pts, layer: ent.layer, _insertTransform: xf });
        }
        break;
      }
      case 'ARC': {
        const { cx, cy, r, startAngle, endAngle } = ent.params;
        if (cx != null && cy != null && r != null && startAngle != null && endAngle != null) {
          const pts = [];
          let sa = startAngle * (Math.PI / 180);
          let ea = endAngle * (Math.PI / 180);
          if (ea <= sa) ea += 2 * Math.PI;
          const da = ea - sa;
          const segments = Math.max(8, Math.ceil(da * r));
          for (let i = 0; i <= segments; i++) {
            const a = sa + (ea - sa) * (i / segments);
            pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
          }
          if (pts.length >= 3) {
            polys.push({ pts, layer: ent.layer, _insertTransform: xf });
          }
        }
        break;
      }
      case 'SPLINE': {
        const xs = ent._xs || [];
        const ys = ent._ys || [];
        const pts = [];
        const len = Math.min(xs.length, ys.length);
        for (let i = 0; i < len; i++) {
          pts.push([xs[i], ys[i]]);
        }
        if (pts.length >= 3) {
          polys.push({ pts, layer: ent.layer, _insertTransform: xf });
        }
        break;
      }
      case 'POLYLINE': {
        if (ent.pts && ent.pts.length >= 3) {
          polys.push({ pts: ent.pts, layer: ent.layer, _insertTransform: xf });
        }
        break;
      }
      case 'ELLIPSE': {
        const { cx, cy, majorX, majorY, ratio, startParam, endParam } = ent.params;
        if (cx != null && cy != null && majorX != null && majorY != null) {
          const r = ratio || 1;
          const rx = Math.sqrt(majorX * majorX + majorY * majorY);
          const ry = rx * r;
          const axisAngle = Math.atan2(majorY, majorX);
          const sp = startParam || 0;
          const ep = (endParam != null && endParam !== 0) ? endParam : 2 * Math.PI;
          const pts = [];
          const segments = 64;
          for (let i = 0; i <= segments; i++) {
            const t = sp + (ep - sp) * (i / segments);
            const ex = rx * Math.cos(t);
            const ey = ry * Math.sin(t);
            const cosA = Math.cos(axisAngle), sinA = Math.sin(axisAngle);
            pts.push([cx + ex * cosA - ey * sinA, cy + ex * sinA + ey * cosA]);
          }
          if (pts.length >= 3) {
            polys.push({ pts, layer: ent.layer, _insertTransform: xf });
          }
        }
        break;
      }
      default:
        break;
    }
  }

  // Stitch LINE segments into polylines — only keep closed loops
  if (lines.length > 0) {
    const stitched = stitchLines(lines);
    for (const s of stitched) {
      if (s.pts.length >= 3 && isClosed(s.pts)) {
        ensureClosed(s.pts);
        if (!s._insertTransform && lines[0]._insertTransform) {
          s._insertTransform = lines[0]._insertTransform;
        }
        polys.push(s);
      }
    }
  }

  // Apply INSERT transforms to resolved block entities
  for (const poly of polys) {
    if (poly._insertTransform) {
      const { tx, ty, sx, sy, cos, sin } = poly._insertTransform;
      poly.pts = poly.pts.map(([x, y]) => {
        const xs = x * sx;
        const ys = y * sy;
        return [xs * cos - ys * sin + tx, xs * sin + ys * cos + ty];
      });
      delete poly._insertTransform;
    }
  }

  return polys;
}

function stitchLines(lines) {
  const tol = ENDPOINT_TOLERANCE;
  const used = new Array(lines.length).fill(false);
  const chains = [];

  function dist(a, b) {
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    return Math.sqrt(dx * dx + dy * dy);
  }

  for (let i = 0; i < lines.length; i++) {
    if (used[i]) continue;
    used[i] = true;

    let chain = [...lines[i].pts];
    let layer = lines[i].layer;
    const seedTransform = lines[i]._insertTransform || null;
    let changed = true;

    while (changed) {
      changed = false;
      for (let j = 0; j < lines.length; j++) {
        if (used[j]) continue;
        const seg = lines[j].pts;
        const head = chain[0];
        const tail = chain[chain.length - 1];

        if (dist(tail, seg[0]) < tol) {
          chain.push(seg[1]);
          used[j] = true;
          changed = true;
        } else if (dist(tail, seg[1]) < tol) {
          chain.push(seg[0]);
          used[j] = true;
          changed = true;
        } else if (dist(head, seg[1]) < tol) {
          chain.unshift(seg[0]);
          used[j] = true;
          changed = true;
        } else if (dist(head, seg[0]) < tol) {
          chain.unshift(seg[1]);
          used[j] = true;
          changed = true;
        }
      }
    }

    const result = { pts: chain, layer };
    if (seedTransform) result._insertTransform = seedTransform;
    chains.push(result);
  }

  return chains;
}

function detectScale(polys) {
  // Collect max dimension from each polygon
  const dims = [];
  for (const p of polys) {
    const bb = polyBbox(p.pts);
    dims.push(Math.max(bb.w, bb.h));
  }
  if (dims.length === 0) return 1;

  // Use 98th percentile for robustness against outliers
  dims.sort((a, b) => a - b);
  const ref = dims[Math.floor(0.98 * dims.length)] || dims[dims.length - 1];

  // Cascading checks matching PatterNestQ logic
  if (ref >= 30 && ref <= 2000) return 1;                          // mm
  if (ref * 10 >= 80 && ref * 10 <= 500) return 10;               // cm→mm
  if (ref * 25.4 >= 80 && ref * 25.4 <= 500) return 25.4;         // inch→mm
  if (ref * 10 >= 30 && ref * 10 <= 2000) return 10;              // cm→mm (wider range)
  if (ref * 25.4 >= 30 && ref * 25.4 <= 2000) return 25.4;        // inch→mm (wider range)
  if (ref < 30) return 10;                                         // assume cm

  return 1;
}

// ─── SVG Parser ─────────────────────────────────────────────────────────────

/**
 * Parse SVG text into an array of part objects.
 * @param {string} text - raw SVG file content
 * @param {string} filename - source filename
 * @returns {Array|null} array of part objects or null on failure
 */
export function parseSVG(text, filename) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'image/svg+xml');
    const svg = doc.querySelector('svg');
    if (!svg) return null;

    // Get viewBox scaling
    let scaleX = 1, scaleY = 1, offsetX = 0, offsetY = 0;
    const vb = svg.getAttribute('viewBox');
    if (vb) {
      const parts = vb.split(/[\s,]+/).map(Number);
      if (parts.length === 4) {
        offsetX = parts[0];
        offsetY = parts[1];
        const vbW = parts[2];
        const vbH = parts[3];
        const svgW = parseFloat(svg.getAttribute('width')) || vbW;
        const svgH = parseFloat(svg.getAttribute('height')) || vbH;
        if (vbW > 0 && vbH > 0) {
          scaleX = svgW / vbW;
          scaleY = svgH / vbH;
        }
      }
    }

    const rawPolys = [];

    // Parse <path> elements
    const paths = doc.querySelectorAll('path');
    for (const path of paths) {
      const d = path.getAttribute('d');
      if (!d) continue;
      const subPolys = parsePathData(d);
      const layer = path.getAttribute('id') || path.closest('[id]')?.getAttribute('id') || '';
      for (const pts of subPolys) {
        if (pts.length >= 3) {
          rawPolys.push({ pts, layer });
        }
      }
    }

    // Parse <circle> elements
    const circles = doc.querySelectorAll('circle');
    for (const c of circles) {
      const cx = parseFloat(c.getAttribute('cx')) || 0;
      const cy = parseFloat(c.getAttribute('cy')) || 0;
      const r = parseFloat(c.getAttribute('r')) || 0;
      if (r <= 0) continue;
      const pts = [];
      const segments = 64;
      for (let i = 0; i < segments; i++) {
        const a = (2 * Math.PI * i) / segments;
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
      const layer = c.getAttribute('id') || '';
      rawPolys.push({ pts, layer });
    }

    // Parse <ellipse> elements
    const ellipses = doc.querySelectorAll('ellipse');
    for (const e of ellipses) {
      const cx = parseFloat(e.getAttribute('cx')) || 0;
      const cy = parseFloat(e.getAttribute('cy')) || 0;
      const rx = parseFloat(e.getAttribute('rx')) || 0;
      const ry = parseFloat(e.getAttribute('ry')) || 0;
      if (rx <= 0 || ry <= 0) continue;
      const pts = [];
      const segments = 64;
      for (let i = 0; i < segments; i++) {
        const a = (2 * Math.PI * i) / segments;
        pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
      }
      const layer = e.getAttribute('id') || '';
      rawPolys.push({ pts, layer });
    }

    // Parse <rect> elements
    const rects = doc.querySelectorAll('rect');
    for (const r of rects) {
      const x = parseFloat(r.getAttribute('x')) || 0;
      const y = parseFloat(r.getAttribute('y')) || 0;
      const w = parseFloat(r.getAttribute('width')) || 0;
      const h = parseFloat(r.getAttribute('height')) || 0;
      if (w <= 0 || h <= 0) continue;
      const pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
      const layer = r.getAttribute('id') || '';
      rawPolys.push({ pts, layer });
    }

    if (rawPolys.length === 0) return null;

    // Apply viewBox scaling if needed
    if (scaleX !== 1 || scaleY !== 1 || offsetX !== 0 || offsetY !== 0) {
      for (const poly of rawPolys) {
        poly.pts = poly.pts.map(([x, y]) => [(x - offsetX) * scaleX, (y - offsetY) * scaleY]);
      }
    }

    return buildParts(rawPolys, filename);
  } catch (e) {
    console.error('parseSVG error:', e);
    return null;
  }
}

class PathDataParser {
  constructor(tokens, polys = []) {
    this.tokens = tokens;
    this.polys = polys;
    this.currentPoly = [];
    this.cx = 0;
    this.cy = 0;
    this.startX = 0;
    this.startY = 0;
    this.lastCpX = 0;
    this.lastCpY = 0;
    this.lastCmd = '';
    this.i = 0;
  }

  nextNum() {
    if (this.i < this.tokens.length) {
      const n = parseFloat(this.tokens[this.i]);
      if (!isNaN(n)) { this.i++; return n; }
    }
    return 0;
  }

  isNumber(token) {
    return /^[-+]?[0-9]*\.?[0-9]+/.test(token);
  }

  parse() {
    while (this.i < this.tokens.length) {
      let cmd = this.tokens[this.i];

      if (!this.isNumber(cmd)) {
        this.i++;
      } else {
        cmd = this.lastCmd;
        if (cmd === 'M') cmd = 'L';
        if (cmd === 'm') cmd = 'l';
      }

      switch (cmd) {
        case 'M': this.handleMove(false); break;
        case 'm': this.handleMove(true); break;
        case 'L': this.handleLine(false); break;
        case 'l': this.handleLine(true); break;
        case 'H': this.handleHLine(false); break;
        case 'h': this.handleHLine(true); break;
        case 'V': this.handleVLine(false); break;
        case 'v': this.handleVLine(true); break;
        case 'C': this.handleCubic(false); break;
        case 'c': this.handleCubic(true); break;
        case 'S': this.handleSmoothCubic(false, cmd); break;
        case 's': this.handleSmoothCubic(true, cmd); break;
        case 'Q': this.handleQuadratic(false); break;
        case 'q': this.handleQuadratic(true); break;
        case 'T': this.handleSmoothQuadratic(false, cmd); break;
        case 't': this.handleSmoothQuadratic(true, cmd); break;
        case 'A':
        case 'a': this.handleArc(cmd === 'a', cmd); break;
        case 'Z':
        case 'z': this.handleClose(cmd); break;
        default:
          this.i++;
          break;
      }
    }

    if (this.currentPoly.length >= 3 && isClosed(this.currentPoly)) {
      ensureClosed(this.currentPoly);
      this.polys.push(this.currentPoly);
    }

    return this.polys;
  }

  handleMove(isRel) {
    if (this.currentPoly.length >= 3) this.polys.push(this.currentPoly);
    this.cx = isRel ? this.cx + this.nextNum() : this.nextNum();
    this.cy = isRel ? this.cy + this.nextNum() : this.nextNum();
    this.startX = this.cx; this.startY = this.cy;
    this.currentPoly = [[this.cx, this.cy]];
    this.lastCmd = isRel ? 'm' : 'M';
    while (this.i < this.tokens.length && this.isNumber(this.tokens[this.i])) {
      this.cx = isRel ? this.cx + this.nextNum() : this.nextNum();
      this.cy = isRel ? this.cy + this.nextNum() : this.nextNum();
      this.currentPoly.push([this.cx, this.cy]);
    }
  }

  handleLine(isRel) {
    this.lastCmd = isRel ? 'l' : 'L';
    while (this.i < this.tokens.length && this.isNumber(this.tokens[this.i])) {
      this.cx = isRel ? this.cx + this.nextNum() : this.nextNum();
      this.cy = isRel ? this.cy + this.nextNum() : this.nextNum();
      this.currentPoly.push([this.cx, this.cy]);
    }
  }

  handleHLine(isRel) {
    this.lastCmd = isRel ? 'h' : 'H';
    while (this.i < this.tokens.length && this.isNumber(this.tokens[this.i])) {
      this.cx = isRel ? this.cx + this.nextNum() : this.nextNum();
      this.currentPoly.push([this.cx, this.cy]);
    }
  }

  handleVLine(isRel) {
    this.lastCmd = isRel ? 'v' : 'V';
    while (this.i < this.tokens.length && this.isNumber(this.tokens[this.i])) {
      this.cy = isRel ? this.cy + this.nextNum() : this.nextNum();
      this.currentPoly.push([this.cx, this.cy]);
    }
  }

  handleCubic(isRel) {
    this.lastCmd = isRel ? 'c' : 'C';
    while (this.i < this.tokens.length && this.isNumber(this.tokens[this.i])) {
      const x1 = isRel ? this.cx + this.nextNum() : this.nextNum();
      const y1 = isRel ? this.cy + this.nextNum() : this.nextNum();
      const x2 = isRel ? this.cx + this.nextNum() : this.nextNum();
      const y2 = isRel ? this.cy + this.nextNum() : this.nextNum();
      const x3 = isRel ? this.cx + this.nextNum() : this.nextNum();
      const y3 = isRel ? this.cy + this.nextNum() : this.nextNum();
      sampleCubic(this.currentPoly, this.cx, this.cy, x1, y1, x2, y2, x3, y3, 20);
      this.lastCpX = x2; this.lastCpY = y2;
      this.cx = x3; this.cy = y3;
    }
  }

  handleSmoothCubic(isRel, cmd) {
    this.lastCmd = cmd;
    while (this.i < this.tokens.length && this.isNumber(this.tokens[this.i])) {
      let x1, y1;




      if ('CcSs'.includes(this.lastCmd) || true) { // Replicates original logic
        x1 = 2 * this.cx - this.lastCpX;
        y1 = 2 * this.cy - this.lastCpY;
      } else {
        x1 = this.cx; y1 = this.cy;
      }
      const x2 = isRel ? this.cx + this.nextNum() : this.nextNum();
      const y2 = isRel ? this.cy + this.nextNum() : this.nextNum();
      const x3 = isRel ? this.cx + this.nextNum() : this.nextNum();
      const y3 = isRel ? this.cy + this.nextNum() : this.nextNum();
      sampleCubic(this.currentPoly, this.cx, this.cy, x1, y1, x2, y2, x3, y3, 20);
      this.lastCpX = x2; this.lastCpY = y2;
      this.cx = x3; this.cy = y3;
    }
  }

  handleQuadratic(isRel) {
    this.lastCmd = isRel ? 'q' : 'Q';
    while (this.i < this.tokens.length && this.isNumber(this.tokens[this.i])) {
      const x1 = isRel ? this.cx + this.nextNum() : this.nextNum();
      const y1 = isRel ? this.cy + this.nextNum() : this.nextNum();
      const x2 = isRel ? this.cx + this.nextNum() : this.nextNum();
      const y2 = isRel ? this.cy + this.nextNum() : this.nextNum();
      sampleQuadratic(this.currentPoly, this.cx, this.cy, x1, y1, x2, y2, 16);
      this.lastCpX = x1; this.lastCpY = y1;
      this.cx = x2; this.cy = y2;
    }
  }

  handleSmoothQuadratic(isRel, cmd) {
    this.lastCmd = cmd;
    while (this.i < this.tokens.length && this.isNumber(this.tokens[this.i])) {
      const cpX = 2 * this.cx - this.lastCpX;
      const cpY = 2 * this.cy - this.lastCpY;
      const ex = isRel ? this.cx + this.nextNum() : this.nextNum();
      const ey = isRel ? this.cy + this.nextNum() : this.nextNum();
      sampleQuadratic(this.currentPoly, this.cx, this.cy, cpX, cpY, ex, ey, 16);
      this.lastCpX = cpX; this.lastCpY = cpY;
      this.cx = ex; this.cy = ey;
    }
  }

  handleArc(isRel, cmd) {
    this.lastCmd = cmd;
    while (this.i < this.tokens.length && !isNaN(parseFloat(this.tokens[this.i]))) {
      const rx = Math.abs(this.nextNum());
      const ry = Math.abs(this.nextNum());
      const xRot = this.nextNum() * Math.PI / 180;
      const largeArc = this.nextNum();
      const sweep = this.nextNum();
      let ex = this.nextNum();
      let ey = this.nextNum();
      if (isRel) { ex += this.cx; ey += this.cy; }
      if (rx === 0 || ry === 0) {
        this.currentPoly.push([ex, ey]);
        this.cx = ex;
        this.cy = ey;
        continue;
      }
      sampleArc(this.currentPoly, this.cx, this.cy, rx, ry, xRot, largeArc, sweep, ex, ey, 24);
      this.cx = ex; this.cy = ey;
    }
  }

  handleClose(cmd) {
    this.lastCmd = cmd;
    this.cx = this.startX; this.cy = this.startY;
    if (this.currentPoly.length >= 3) {
      ensureClosed(this.currentPoly);
      this.polys.push(this.currentPoly);
    }
    this.currentPoly = [];
  }
}


function parsePathData(d) {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/g);
  if (!tokens) return [];
  const parser = new PathDataParser(tokens);
  return parser.parse();
}


function sampleCubic(poly, x0, y0, x1, y1, x2, y2, x3, y3, samples) {
  for (let i = 1; i <= samples; i++) {
    const t = i / samples;
    const mt = 1 - t;
    const x = mt * mt * mt * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3;
    const y = mt * mt * mt * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3;
    poly.push([x, y]);
  }
}

function sampleQuadratic(poly, x0, y0, x1, y1, x2, y2, samples) {
  for (let i = 1; i <= samples; i++) {
    const t = i / samples;
    const mt = 1 - t;
    const x = mt * mt * x0 + 2 * mt * t * x1 + t * t * x2;
    const y = mt * mt * y0 + 2 * mt * t * y1 + t * t * y2;
    poly.push([x, y]);
  }
}

function sampleArc(poly, x1, y1, rx, ry, phi, fA, fS, x2, y2, samples) {
  const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);
  const dx2 = (x1 - x2) / 2, dy2 = (y1 - y2) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;
  let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) { rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda); }
  const num = Math.max(0, rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p);
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const sq = Math.sqrt(num / (den || 1));
  const sign = (fA === fS) ? -1 : 1;
  const cxp = sign * sq * (rx * y1p / ry);
  const cyp = sign * sq * (-ry * x1p / rx);
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;
  function angle(ux, uy, vx, vy) {
    const dot = ux * vx + uy * vy;
    const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy)) || 1;
    let a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  }
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (fS && dTheta < 0) dTheta += 2 * Math.PI;
  if (!fS && dTheta > 0) dTheta -= 2 * Math.PI;
  for (let i = 1; i <= samples; i++) {
    const t = theta1 + (i / samples) * dTheta;
    const xr = rx * Math.cos(t), yr = ry * Math.sin(t);
    poly.push([cosPhi * xr - sinPhi * yr + cx, sinPhi * xr + cosPhi * yr + cy]);
  }
}

// ─── buildParts ─────────────────────────────────────────────────────────────

/**
 * Classify polygons into outer boundaries (parts) and inner children.
 * @param {Array} rawPolys - array of {pts, layer}
 * @param {string} filename - source filename
 * @param {number} areaThresh - minimum area threshold
 * @returns {Array} array of part objects
 */
function buildParts(rawPolys, filename, areaThresh = 1) {
  // Compute areas and sort descending
  const withArea = rawPolys.map(p => ({
    pts: p.pts,
    layer: p.layer || '',
    area: Math.abs(polyArea(p.pts)),
    bb: polyBbox(p.pts),
    centroid: polyCentroid(p.pts)
  }));

  withArea.sort((a, b) => b.area - a.area);

  // Classify outer vs inner
  const outers = [];
  const inners = [];

  for (let i = 0; i < withArea.length; i++) {
    const poly = withArea[i];
    if (poly.area < areaThresh) continue;

    const layerUpper = poly.layer.toUpperCase();
    const isInnerByLayer = ['HOLE', 'MARK', 'ENGRAVE'].includes(layerUpper);

    if (isInnerByLayer) {
      inners.push({ ...poly, kind: layerUpper.toLowerCase() });
      continue;
    }

    let isInner = false;
    for (let j = 0; j < i; j++) {
      const larger = withArea[j];
      if (larger.area <= poly.area) continue;
      if (poly.area >= 0.80 * larger.area) continue;

      if (polyPIP(poly.centroid[0], poly.centroid[1], larger.pts)) {
        isInner = true;
        break;
      }

      if (poly.bb.x0 >= larger.bb.x0 &&
          poly.bb.y0 >= larger.bb.y0 &&
          poly.bb.x1 <= larger.bb.x1 &&
          poly.bb.y1 <= larger.bb.y1) {
        isInner = true;
        break;
      }
    }

    if (isInner) {
      inners.push({ ...poly, kind: 'engrave' });
    } else {
      outers.push(poly);
    }
  }

  // Build part objects
  const parts = outers.map((outer, idx) => {
    // Find children whose centroid is inside this outer
    const children = [];
    for (const inner of inners) {
      if (polyPIP(inner.centroid[0], inner.centroid[1], outer.pts)) {
        children.push({ poly: inner.pts, kind: inner.kind });
      }
    }

    // Normalize boundary and children to same origin
    const outerBb = polyBbox(outer.pts);
    const normalizedBoundary = outer.pts.map(([x, y]) => [x - outerBb.x0, y - outerBb.y0]);
    const normalizedChildren = children.map(c => ({
      ...c,
      poly: c.poly.map(([x, y]) => [x - outerBb.x0, y - outerBb.y0])
    }));

    const bb = polyBbox(normalizedBoundary);
    const color = PALETTE[idx % PALETTE.length];

    return {
      id: uniqueId(),
      name: outer.layer || `Part ${idx + 1}`,
      boundary: normalizedBoundary,
      children: normalizedChildren,
      color,
      qty: 1,
      bb,
      sourceFile: filename,
      material: null
    };
  });

  return parts.length > 0 ? parts : null;
}

// ─── parseHide ──────────────────────────────────────────────────────────────

/**
 * Parse a hide boundary from DXF or SVG text.
 * @param {string} text - raw file content (DXF or SVG)
 * @param {string} filename - source filename
 * @returns {Object|null} {poly, holes, bb, sourceFile} or null
 */
export function parseHide(text, filename) {
  try {
    let parts;

    // Detect format
    const trimmed = text.trim();
    if (trimmed.startsWith('<') || trimmed.startsWith('<?xml')) {
      parts = parseSVG(text, filename);
    } else {
      parts = parseDXF(text, filename);
    }

    if (!parts || parts.length === 0) return null;

    // The largest part is the hide boundary
    let largest = parts[0];
    let largestArea = Math.abs(polyArea(largest.boundary));

    for (let i = 1; i < parts.length; i++) {
      const a = Math.abs(polyArea(parts[i].boundary));
      if (a > largestArea) {
        largestArea = a;
        largest = parts[i];
      }
    }

    // Holes are children of the largest part, or other smaller parts
    const holes = largest.children
      .filter(c => c.kind === 'hole')
      .map(c => c.poly);

    return {
      poly: largest.boundary,
      holes,
      bb: polyBbox(largest.boundary),
      sourceFile: filename
    };
  } catch (e) {
    console.error('parseHide error:', e);
    return null;
  }
}
