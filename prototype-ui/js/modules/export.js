// Export utilities for DXF and G-code generation
// Extracted from PatterNestQ nesting export pipeline

import { polyBbox } from './geometry.js';

// ---------------------------------------------------------------------------
// DXF Export
// ---------------------------------------------------------------------------

/**
 * Build a LWPOLYLINE entity string for DXF.
 */
function dxfPolyline(pts, layer, closed = true) {
  let s = '0\nLWPOLYLINE\n';
  s += '8\n' + layer + '\n';
  s += '66\n1\n';
  s += '90\n' + pts.length + '\n';
  s += '70\n' + (closed ? 1 : 0) + '\n';
  for (const [x, y] of pts) {
    s += '10\n' + x.toFixed(4) + '\n';
    s += '20\n' + y.toFixed(4) + '\n';
  }
  return s;
}

/**
 * Generate DXF layer table entry with optional PWM comment.
 */
function dxfLayerEntry(name, color, pwmValue) {
  let s = '0\nLAYER\n';
  s += '2\n' + name + '\n';
  s += '70\n0\n';
  s += '62\n' + color + '\n';
  s += '6\nCONTINUOUS\n';
  if (pwmValue !== undefined && pwmValue > 0) {
    s += '999\nPWM:' + String(pwmValue).padStart(3, '0') + '\n';
  }
  return s;
}

/**
 * Generates a DXF string from nesting placement results.
 */
export function exportDXF(placements, options) {
  const {
    mode = 'all',
    sheetW = 600,
    sheetH = 400,
    hide = null,
    pwm = { cut: 100, hole: 80, mark: 25, engrave: 15 }
  } = options || {};

  // No Y-flip — output coordinates as-is (matches PatterNestQ original)
  function flipY(pts) {
    return pts;
  }

  // --- HEADER section ---
  let dxf = '0\nSECTION\n2\nHEADER\n';
  dxf += '9\n$ACADVER\n1\nAC1014\n';
  dxf += '9\n$INSUNITS\n70\n4\n';
  dxf += '0\nENDSEC\n';

  // --- TABLES section (PWM embedded in layer definitions) ---
  dxf += '0\nSECTION\n2\nTABLES\n';
  dxf += '0\nTABLE\n2\nLAYER\n';

  dxf += dxfLayerEntry('CUT', 3, pwm.cut);
  dxf += dxfLayerEntry('HOLE', 1, pwm.hole);
  dxf += dxfLayerEntry('MARK', 5, pwm.mark);
  dxf += dxfLayerEntry('ENGRAVE', 6, pwm.engrave);

  dxf += '0\nENDTAB\n';
  dxf += '0\nENDSEC\n';

  // --- ENTITIES section ---
  dxf += '0\nSECTION\n2\nENTITIES\n';

  // Placed parts
  for (const placement of placements) {
    const { boundary, children = [], tx = 0, ty = 0 } = placement;
    const translatedBoundary = boundary.map(([x, y]) => [x + tx, y + ty]);

    // CUT layer: outer boundary (skip if pwm.cut === 0)
    if ((mode === 'all' || mode === 'cut') && pwm.cut !== 0) {
      dxf += dxfPolyline(flipY(translatedBoundary), 'CUT', true);
    }

    // Child polygons on their respective layers (skip layers with pwm === 0)
    if (mode === 'all' || mode === 'mark') {
      for (const child of children) {
        const { poly, kind } = child;
        const translatedChild = poly.map(([x, y]) => [x + tx, y + ty]);

        let layer;
        let layerPwm;
        switch (kind) {
          case 'hole': layer = 'HOLE'; layerPwm = pwm.hole; break;
          case 'mark': layer = 'MARK'; layerPwm = pwm.mark; break;
          case 'engrave': layer = 'ENGRAVE'; layerPwm = pwm.engrave; break;
          default: layer = 'MARK'; layerPwm = pwm.mark;
        }

        if (layerPwm !== 0) {
          dxf += dxfPolyline(flipY(translatedChild), layer, true);
        }
      }
    }
  }

  dxf += '0\nENDSEC\n';
  dxf += '0\nEOF\n';

  return dxf;
}

// ---------------------------------------------------------------------------
// G-code Export
// ---------------------------------------------------------------------------

const GCODE_DIALECTS = {
  grbl: { end: 'M2' },
  mach3: { end: 'M30' },
  linuxcnc: { end: 'M2' }
};

function fmt(v) {
  return v.toFixed(3);
}

/**
 * Nearest-neighbor sort for placements to minimize rapid travel.
 */
function nearestNeighborSort(placements) {
  if (placements.length <= 1) return [...placements];

  const remaining = [...placements];
  const sorted = [];
  let curX = 0, curY = 0;

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const p = remaining[i];
      const fx = (p.boundary[0]?.[0] || 0) + (p.tx || 0);
      const fy = (p.boundary[0]?.[1] || 0) + (p.ty || 0);
      const d = (fx - curX) ** 2 + (fy - curY) ** 2;
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }

    const chosen = remaining.splice(bestIdx, 1)[0];
    sorted.push(chosen);
    curX = (chosen.boundary[0]?.[0] || 0) + (chosen.tx || 0);
    curY = (chosen.boundary[0]?.[1] || 0) + (chosen.ty || 0);
  }

  return sorted;
}

/**
 * Generates G-code string for CNC machines from nesting placement results.
 */
export function exportGcode(placements, options) {
  const {
    controller = 'grbl',
    machineType = 'laser',
    feedRate = 1000,
    rapidRate = 3000,
    spindleSpeed = 1000,
    zSafe = 5,
    zCut = -1,
    homeFirst = true,
    useMaterialOffset = false,
    materialOffset = { x: 0, y: 0 },
    pwm = { cut: 100, hole: 80, mark: 25, engrave: 15 },
    tableWidth = 0,
    tableHeight = 0,
    laserOn = 'M3',
    laserOff = 'M5'
  } = options || {};

  const offsetX = useMaterialOffset ? (materialOffset.x || 0) : 0;
  const offsetY = useMaterialOffset ? (materialOffset.y || 0) : 0;
  const dialect = GCODE_DIALECTS[controller] || GCODE_DIALECTS.grbl;

  const isLaser = machineType === 'laser';
  const lines = [];

  function sValue(percent) {
    return Math.round((percent / 100) * spindleSpeed);
  }

  function pt(x, y) {
    return { x: x + offsetX, y: y + offsetY };
  }

  function cutPath(polygon, power) {
    if (!polygon || polygon.length < 2 || power <= 0) return;

    const first = pt(polygon[0][0], polygon[0][1]);

    if (isLaser) {
      lines.push(`G0 X${fmt(first.x)} Y${fmt(first.y)}`);
      lines.push(`${laserOn} S${sValue(power)}`);
    } else {
      lines.push(`G0 X${fmt(first.x)} Y${fmt(first.y)}`);
      lines.push(`G0 Z${fmt(zSafe)}`);
      lines.push(`G1 Z${fmt(zCut)} F${fmt(feedRate / 2)}`);
    }

    for (let i = 1; i < polygon.length; i++) {
      const p = pt(polygon[i][0], polygon[i][1]);
      lines.push(`G1 X${fmt(p.x)} Y${fmt(p.y)} F${fmt(feedRate)}`);
    }

    lines.push(`G1 X${fmt(first.x)} Y${fmt(first.y)} F${fmt(feedRate)}`);

    if (isLaser) {
      lines.push(laserOff);
    } else {
      lines.push(`G0 Z${fmt(zSafe)}`);
    }
  }

  // --- Bounds validation ---
  let boundsWarning = false;
  if (tableWidth > 0 && tableHeight > 0) {
    for (const placement of placements) {
      const { boundary, children = [], tx = 0, ty = 0 } = placement;
      const allPolys = [boundary, ...children.map(c => c.poly)];
      for (const poly of allPolys) {
        for (const [x, y] of poly) {
          const px = x + tx + offsetX;
          const py = y + ty + offsetY;
          if (px > tableWidth + 0.5 || py > tableHeight + 0.5 || px < -0.5 || py < -0.5) {
            boundsWarning = true;
            break;
          }
        }
        if (boundsWarning) break;
      }
      if (boundsWarning) break;
    }
  }

  // --- Header ---
  if (boundsWarning) {
    lines.push('; WARNING: Some cuts exceed table boundaries!');
  }
  lines.push('; Generated by PatterNestQ Export');
  lines.push('; Controller: ' + controller);
  lines.push('; Machine: ' + machineType);
  if (tableWidth > 0 && tableHeight > 0) {
    lines.push('; Table: ' + tableWidth + 'x' + tableHeight + ' mm');
  }
  lines.push('G90 ; Absolute positioning');
  lines.push('G21 ; Units: millimeters');

  if (homeFirst) {
    lines.push('G28 ; Home all axes');
  }

  if (!isLaser) {
    lines.push(`G0 Z${fmt(zSafe)} ; Raise to safe height`);
  }

  lines.push('');

  // --- Process placements (nearest-neighbor order) ---
  const sortedPlacements = nearestNeighborSort(placements);

  for (let idx = 0; idx < sortedPlacements.length; idx++) {
    const placement = sortedPlacements[idx];
    const { boundary, children = [], tx = 0, ty = 0, name = '' } = placement;

    lines.push(`;--- Part: ${name} #${idx + 1} ---`);

    const translatedBoundary = boundary.map(([x, y]) => [x + tx, y + ty]);

    // CUT ORDER: engrave → mark → hole → boundary (internals first, boundary LAST)
    const engraves = children.filter(c => c.kind === 'engrave');
    const marks = children.filter(c => c.kind === 'mark');
    const holes = children.filter(c => c.kind === 'hole');

    for (const child of engraves) {
      const translatedChild = child.poly.map(([x, y]) => [x + tx, y + ty]);
      lines.push('; Child: engrave');
      cutPath(translatedChild, pwm.engrave);
      lines.push('');
    }

    for (const child of marks) {
      const translatedChild = child.poly.map(([x, y]) => [x + tx, y + ty]);
      lines.push('; Child: mark');
      cutPath(translatedChild, pwm.mark);
      lines.push('');
    }

    for (const child of holes) {
      const translatedChild = child.poly.map(([x, y]) => [x + tx, y + ty]);
      lines.push('; Child: hole');
      cutPath(translatedChild, pwm.hole);
      lines.push('');
    }

    // Boundary LAST (releases the piece from material)
    cutPath(translatedBoundary, pwm.cut);
    lines.push('');
  }

  // --- Footer ---
  if (!isLaser) {
    lines.push(`G0 Z${fmt(zSafe)} ; Retract to safe height`);
  }
  lines.push(`${laserOff} ; Spindle/laser off`);
  lines.push('G0 X0 Y0 ; Return to origin');
  lines.push(`${dialect.end} ; Program end`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// File Download
// ---------------------------------------------------------------------------

export function downloadFile(filename, content, mimeType = 'application/octet-stream') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';

  document.body.appendChild(a);
  a.click();

  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}
