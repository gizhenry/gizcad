// Geometry utilities for CadShot Professional
// Extracted from PatterNestQ and cncVisionPRO

/**
 * Shoelace formula for polygon area.
 * @param {number[][]} p - Array of [x, y] vertices
 * @returns {number} Signed area (positive if CCW)
 */
export function polyArea(p) {
  let area = 0;
  const n = p.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area += (p[j][0] + p[i][0]) * (p[j][1] - p[i][1]);
  }
  return area / 2;
}

/**
 * Axis-aligned bounding box of a polygon.
 * @param {number[][]} p - Array of [x, y] vertices
 * @returns {{x0: number, y0: number, x1: number, y1: number, w: number, h: number}}
 */
export function polyBbox(p) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i++) {
    const [x, y] = p[i];
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

/**
 * Centroid of a polygon using the signed-area weighted formula.
 * @param {number[][]} p - Array of [x, y] vertices
 * @returns {number[]} [cx, cy]
 */
export function polyCentroid(p) {
  let cx = 0, cy = 0;
  const n = p.length;
  let areaSum = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const cross = p[j][0] * p[i][1] - p[i][0] * p[j][1];
    areaSum += cross;
    cx += (p[j][0] + p[i][0]) * cross;
    cy += (p[j][1] + p[i][1]) * cross;
  }
  const a6 = areaSum * 3; // 6 * (area/2) = 3 * area_sum
  return [cx / a6, cy / a6];
}

/**
 * Point-in-polygon test using ray casting algorithm.
 * @param {number} px - Test point x
 * @param {number} py - Test point y
 * @param {number[][]} poly - Array of [x, y] vertices
 * @returns {boolean}
 */
export function polyPIP(px, py, poly) {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if (((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Perimeter length of a polygon.
 * @param {number[][]} p - Array of [x, y] vertices
 * @returns {number}
 */
export function polyPerimeter(p) {
  let len = 0;
  const n = p.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const dx = p[i][0] - p[j][0];
    const dy = p[i][1] - p[j][1];
    len += Math.sqrt(dx * dx + dy * dy);
  }
  return len;
}

/**
 * Generate points approximating a circle.
 * @param {number} cx - Center x
 * @param {number} cy - Center y
 * @param {number} r - Radius
 * @param {number} n - Number of segments (default 24)
 * @returns {number[][]} Array of [x, y] with n+1 points (closed)
 */
export function circPts(cx, cy, r, n = 24) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const angle = (2 * Math.PI * i) / n;
    pts.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
  }
  return pts;
}

/**
 * Rotate a boundary polygon and its children by deg degrees around the
 * bounding box center, then normalize so the result bbox starts at (0, 0).
 * @param {number[][]} boundary - Outer polygon [[x,y],...]
 * @param {number[][][]} children - Array of child polygons
 * @param {number} deg - Rotation in degrees
 * @returns {{boundary: number[][], children: number[][][]}}
 */
export function rotateGroup(boundary, children, deg) {
  const bbox = polyBbox(boundary);
  const cxr = (bbox.x0 + bbox.x1) / 2;
  const cyr = (bbox.y0 + bbox.y1) / 2;
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  function rotPt(pt) {
    const dx = pt[0] - cxr;
    const dy = pt[1] - cyr;
    return [cxr + dx * cos - dy * sin, cyr + dx * sin + dy * cos];
  }

  const rotBoundary = boundary.map(rotPt);

  // Normalize to (0, 0)
  const newBbox = polyBbox(rotBoundary);
  const shiftX = -newBbox.x0;
  const shiftY = -newBbox.y0;

  const normBoundary = rotBoundary.map(([x, y]) => [x + shiftX, y + shiftY]);

  // Children can be either plain polygon arrays or objects with {poly, kind}
  const normChildren = (children || []).map(child => {
    if (Array.isArray(child) && child.length > 0 && Array.isArray(child[0])) {
      const rotChild = child.map(rotPt);
      return rotChild.map(([x, y]) => [x + shiftX, y + shiftY]);
    }
    if (child && child.poly) {
      const rotChild = child.poly.map(rotPt);
      return {
        ...child,
        poly: rotChild.map(([x, y]) => [x + shiftX, y + shiftY])
      };
    }
    return child;
  });

  return { boundary: normBoundary, children: normChildren };
}

/**
 * Ear-clipping triangulation.
 * @param {number[][]} poly - Array of [x, y] vertices (no repeated last vertex)
 * @returns {number[]} Flat array of triangle vertex coordinates [x0,y0,x1,y1,x2,y2,...]
 */
export function earClip(poly) {
  const triangles = [];
  // Work on a copy
  const verts = poly.map(([x, y]) => [x, y]);

  // Ensure counter-clockwise winding
  if (polyArea(verts) < 0) {
    verts.reverse();
  }

  const indices = [];
  for (let i = 0; i < verts.length; i++) indices.push(i);

  function cross2D(o, a, b) {
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  }

  function isConvex(i) {
    const n = indices.length;
    const prev = indices[(i - 1 + n) % n];
    const curr = indices[i];
    const next = indices[(i + 1) % n];
    return cross2D(verts[prev], verts[curr], verts[next]) > 0;
  }

  function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
    const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
    const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
    const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
    const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
    const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
    return !(hasNeg && hasPos);
  }

  function isEar(i) {
    if (!isConvex(i)) return false;
    const n = indices.length;
    const prev = indices[(i - 1 + n) % n];
    const curr = indices[i];
    const next = indices[(i + 1) % n];
    const ax = verts[prev][0], ay = verts[prev][1];
    const bx = verts[curr][0], by = verts[curr][1];
    const cx = verts[next][0], cy = verts[next][1];

    for (let j = 0; j < n; j++) {
      const idx = indices[j];
      if (idx === prev || idx === curr || idx === next) continue;
      if (pointInTriangle(verts[idx][0], verts[idx][1], ax, ay, bx, by, cx, cy)) {
        return false;
      }
    }
    return true;
  }

  let safety = indices.length * 3;
  while (indices.length > 3 && safety-- > 0) {
    let earFound = false;
    for (let i = 0; i < indices.length; i++) {
      if (isEar(i)) {
        const n = indices.length;
        const prev = indices[(i - 1 + n) % n];
        const curr = indices[i];
        const next = indices[(i + 1) % n];
        triangles.push(
          verts[prev][0], verts[prev][1],
          verts[curr][0], verts[curr][1],
          verts[next][0], verts[next][1]
        );
        indices.splice(i, 1);
        earFound = true;
        break;
      }
    }
    if (!earFound) break;
  }

  // Last remaining triangle
  if (indices.length === 3) {
    triangles.push(
      verts[indices[0]][0], verts[indices[0]][1],
      verts[indices[1]][0], verts[indices[1]][1],
      verts[indices[2]][0], verts[indices[2]][1]
    );
  }

  return triangles;
}

/**
 * Ramer-Douglas-Peucker polyline simplification.
 * @param {{x: number, y: number}[]} points - Input polyline
 * @param {number} epsilon - Distance tolerance
 * @returns {{x: number, y: number}[]} Simplified polyline
 */
export function rdpSimplify(points, epsilon) {
  if (points.length <= 2) return points.slice();

  // Find the point with the maximum distance from the line segment
  const first = points[0];
  const last = points[points.length - 1];
  let maxDist = 0;
  let maxIndex = 0;

  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const lenSq = dx * dx + dy * dy;

  for (let i = 1; i < points.length - 1; i++) {
    let dist;
    if (lenSq === 0) {
      // first and last are the same point
      const ex = points[i].x - first.x;
      const ey = points[i].y - first.y;
      dist = Math.sqrt(ex * ex + ey * ey);
    } else {
      // Perpendicular distance from point to line
      const t = ((points[i].x - first.x) * dx + (points[i].y - first.y) * dy) / lenSq;
      const projX = first.x + t * dx;
      const projY = first.y + t * dy;
      const ex = points[i].x - projX;
      const ey = points[i].y - projY;
      dist = Math.sqrt(ex * ex + ey * ey);
    }
    if (dist > maxDist) {
      maxDist = dist;
      maxIndex = i;
    }
  }

  if (maxDist > epsilon) {
    const left = rdpSimplify(points.slice(0, maxIndex + 1), epsilon);
    const right = rdpSimplify(points.slice(maxIndex), epsilon);
    return left.slice(0, -1).concat(right);
  } else {
    return [first, last];
  }
}

/**
 * Convex hull using Andrew's monotone chain algorithm.
 * @param {{x: number, y: number}[]} points - Input point set
 * @returns {{x: number, y: number}[]} Convex hull vertices in CCW order
 */
export function convexHull(points) {
  if (points.length <= 1) return points.slice();

  const sorted = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const n = sorted.length;

  function cross(O, A, B) {
    return (A.x - O.x) * (B.y - O.y) - (A.y - O.y) * (B.x - O.x);
  }

  // Lower hull
  const lower = [];
  for (let i = 0; i < n; i++) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], sorted[i]) <= 0) {
      lower.pop();
    }
    lower.push(sorted[i]);
  }

  // Upper hull
  const upper = [];
  for (let i = n - 1; i >= 0; i--) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], sorted[i]) <= 0) {
      upper.pop();
    }
    upper.push(sorted[i]);
  }

  // Remove last point of each half because it's repeated
  lower.pop();
  upper.pop();

  return lower.concat(upper);
}

/**
 * Sort 4 corner points in order: top-left, top-right, bottom-right, bottom-left.
 * @param {{x: number, y: number}[]} corners - Exactly 4 corner points
 * @returns {{x: number, y: number}[]} [TL, TR, BR, BL]
 */
export function sortCornersClockwise(corners) {
  // Compute centroid
  const cx = corners.reduce((s, p) => s + p.x, 0) / 4;
  const cy = corners.reduce((s, p) => s + p.y, 0) / 4;

  // Separate into top (y < cy) and bottom (y >= cy)
  const sorted = corners.slice().sort((a, b) => a.y - b.y);
  const top = sorted.slice(0, 2);
  const bottom = sorted.slice(2, 4);

  // Sort top row left-to-right, bottom row left-to-right
  top.sort((a, b) => a.x - b.x);
  bottom.sort((a, b) => a.x - b.x);

  // TL, TR, BR, BL
  return [top[0], top[1], bottom[1], bottom[0]];
}

/**
 * Compute a 4-point perspective homography matrix (3x3).
 * Maps srcPts to dstPts using Direct Linear Transform (DLT).
 * @param {{x: number, y: number}[]} srcPts - 4 source points
 * @param {{x: number, y: number}[]} dstPts - 4 destination points
 * @returns {number[][]|null} 3x3 matrix or null if degenerate
 */
export function computeHomography(srcPts, dstPts) {
  if (srcPts.length !== 4 || dstPts.length !== 4) return null;

  // Build the 8x9 matrix A for Ah = 0
  const A = [];
  for (let i = 0; i < 4; i++) {
    const sx = srcPts[i].x, sy = srcPts[i].y;
    const dx = dstPts[i].x, dy = dstPts[i].y;
    A.push([-sx, -sy, -1, 0, 0, 0, dx * sx, dx * sy, dx]);
    A.push([0, 0, 0, -sx, -sy, -1, dy * sx, dy * sy, dy]);
  }

  // Solve using simplified SVD approach for 8x9 system
  // We use Gaussian elimination to find the null space
  const m = 8, n = 9;
  const M = A.map(row => row.slice());

  // Forward elimination with partial pivoting
  for (let col = 0; col < m; col++) {
    // Find pivot
    let maxVal = 0, maxRow = col;
    for (let row = col; row < m; row++) {
      const absVal = Math.abs(M[row][col]);
      if (absVal > maxVal) {
        maxVal = absVal;
        maxRow = row;
      }
    }
    if (maxVal < 1e-10) return null;

    // Swap rows
    [M[col], M[maxRow]] = [M[maxRow], M[col]];

    // Eliminate below
    for (let row = col + 1; row < m; row++) {
      const factor = M[row][col] / M[col][col];
      for (let k = col; k < n; k++) {
        M[row][k] -= factor * M[col][k];
      }
    }
  }

  // Back substitution: solve for h[0..7] in terms of h[8]
  // Set h[8] = 1
  const h = new Array(9);
  h[8] = 1;

  for (let row = m - 1; row >= 0; row--) {
    let sum = 0;
    for (let col = row + 1; col < n; col++) {
      sum += M[row][col] * h[col];
    }
    h[row] = -sum / M[row][row];
  }

  // Construct 3x3 matrix
  return [
    [h[0], h[1], h[2]],
    [h[3], h[4], h[5]],
    [h[6], h[7], h[8]]
  ];
}

/**
 * Apply a 3x3 homography matrix to a point.
 * @param {number[][]} H - 3x3 homography matrix
 * @param {number} x - Input x coordinate
 * @param {number} y - Input y coordinate
 * @returns {{x: number, y: number}} Transformed point
 */
export function applyHomography(H, x, y) {
  const w = H[2][0] * x + H[2][1] * y + H[2][2];
  return {
    x: (H[0][0] * x + H[0][1] * y + H[0][2]) / w,
    y: (H[1][0] * x + H[1][1] * y + H[1][2]) / w
  };
}
