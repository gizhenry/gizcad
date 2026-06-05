// Hide Detector module — wraps the SAM (Segment Anything Model) hide detection
// pipeline from cncVisionPRO_B.html as a reusable ES module.
// Supports multiple SAM models for detecting leather, metal, fabric, etc.

import { computeHomography, applyHomography, rdpSimplify, polyArea } from './geometry.js';

// ============================================================
// Available SAM Models
// ============================================================
const SAM_MODELS = {
  'sam-vit-base': {
    id: 'Xenova/sam-vit-base',
    name: 'SAM Base',
    description: 'Fast general-purpose (leather, fabric, wood)',
    size: '~375 MB',
    speed: 'fast',
    accuracy: 'good'
  },
  'sam-vit-large': {
    id: 'Xenova/sam-vit-large',
    name: 'SAM Large',
    description: 'Higher accuracy (metal, reflective, complex edges)',
    size: '~1.2 GB',
    speed: 'medium',
    accuracy: 'high'
  },
  'sam-vit-huge': {
    id: 'Xenova/sam-vit-huge',
    name: 'SAM Huge',
    description: 'Maximum precision (fine detail, thin materials)',
    size: '~2.5 GB',
    speed: 'slow',
    accuracy: 'highest'
  }
};

// ============================================================
// Dynamic loading of @huggingface/transformers
// ============================================================
let transformers = null;
let _usbTransformersBlob = null;

async function loadTransformers() {
  if (transformers) return transformers;

  // Try CDN first
  try {
    const importFn = globalThis.__TEST_IMPORT__ || (url => import(url));
    transformers = await importFn('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.1/dist/transformers.min.js');
    return transformers;
  } catch (cdnErr) {
    console.warn('[HideDetector] CDN import failed:', cdnErr.message);
  }

  // Fallback: try relative local path (for bundled deployments)
  try {
    const importFn = globalThis.__TEST_IMPORT__ || (url => import(url));
    transformers = await importFn('./vendor/transformers.min.js');
    return transformers;
  } catch (e) { /* not bundled locally */ }

  // Fallback: check if pre-loaded via <script> tag
  if (typeof window !== 'undefined' && window.__transformers) {
    transformers = window.__transformers;
    return transformers;
  }

  // Fallback: try loading from a previously stored USB blob
  if (_usbTransformersBlob) {
    try {
      const blobUrl = URL.createObjectURL(_usbTransformersBlob);
      transformers = await import(blobUrl);
      URL.revokeObjectURL(blobUrl);
      return transformers;
    } catch (e) {
      console.warn('[HideDetector] USB blob import failed:', e.message);
    }
  }

  throw new Error(
    'Cannot load transformers library — CDN unreachable and no local copy found. ' +
    'Ensure internet access for first load, or include transformers.min.js in the USB export folder.'
  );
}

async function loadTransformersFromDir(dirHandle) {
  if (transformers) return transformers;

  // Look for the library file in the USB folder
  const libNames = ['transformers.min.js', 'transformers.js', 'transformers.min.mjs'];
  for (const name of libNames) {
    try {
      const fh = await dirHandle.getFileHandle(name);
      const file = await fh.getFile();
      _usbTransformersBlob = new Blob([await file.arrayBuffer()], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(_usbTransformersBlob);
      transformers = await import(blobUrl);
      URL.revokeObjectURL(blobUrl);
      return transformers;
    } catch (e) { /* file not found or import failed, try next */ }
  }

  // Library not in USB folder — fall back to normal loading
  return loadTransformers();
}

// ============================================================
// IndexedDB for USB model directory handle persistence
// ============================================================
const MODEL_DB_NAME = 'cncVisionPRO_modelDB';
const MODEL_DB_VERSION = 1;

function openModelDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(MODEL_DB_NAME, MODEL_DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore('handles');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveModelDirHandle(dirHandle, mode, modelKey) {
  try {
    const db = await openModelDB();
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').put({ dirHandle, mode, modelKey }, 'usbModel');
    await new Promise((r, e) => { tx.oncomplete = r; tx.onerror = e; });
    db.close();
  } catch (err) { /* ignore persistence failure */ }
}

async function clearModelDirHandle() {
  try {
    const db = await openModelDB();
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').delete('usbModel');
    await new Promise((r, e) => { tx.oncomplete = r; tx.onerror = e; });
    db.close();
  } catch (err) { /* ignore */ }
}

async function getSavedModelDirHandle() {
  try {
    const db = await openModelDB();
    const tx = db.transaction('handles', 'readonly');
    const req = tx.objectStore('handles').get('usbModel');
    const result = await new Promise((r, e) => { req.onsuccess = () => r(req.result); req.onerror = e; });
    db.close();
    return result || null;
  } catch (err) { return null; }
}

// ============================================================
// Helper functions
// ============================================================

/**
 * Suppress specular highlights (bright, low-saturation pixels).
 * Modifies imageData in place.
 */
function suppressSpecular(imageData) {
  const data = imageData.data;
  const len = data.length;
  for (let i = 0; i < len; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    const brightness = (r + g + b) / 3;
    const saturation = maxC > 0 ? (maxC - minC) / maxC : 0;
    if (brightness > 200 && saturation < 0.15) {
      const dampen = 0.6;
      data[i]     = Math.round(r * dampen + 128 * (1 - dampen));
      data[i + 1] = Math.round(g * dampen + 128 * (1 - dampen));
      data[i + 2] = Math.round(b * dampen + 128 * (1 - dampen));
    }
  }
  return imageData;
}

/**
 * Generate a uniform grid of sample points.
 */
function generatePointGrid(width, height, gridSize) {
  const points = [];
  const stepX = width / gridSize;
  const stepY = height / gridSize;
  for (let gy = 0; gy < gridSize; gy++) {
    for (let gx = 0; gx < gridSize; gx++) {
      points.push({
        x: Math.round(stepX * (gx + 0.5)),
        y: Math.round(stepY * (gy + 0.5))
      });
    }
  }
  return points;
}

/**
 * Upscale a binary mask using bilinear interpolation.
 */
function upscaleMaskBilinear(maskData, srcW, srcH, dstW, dstH) {
  const result = new Uint8Array(dstW * dstH);
  const sxR = (srcW - 1) / Math.max(1, dstW - 1);
  const syR = (srcH - 1) / Math.max(1, dstH - 1);
  for (let y = 0; y < dstH; y++) {
    const fy = y * syR;
    const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, srcH - 1);
    const wy = fy - y0;
    for (let x = 0; x < dstW; x++) {
      const fx = x * sxR;
      const x0 = Math.floor(fx), x1 = Math.min(x0 + 1, srcW - 1);
      const wx = fx - x0;
      const v00 = maskData[y0 * srcW + x0], v10 = maskData[y0 * srcW + x1];
      const v01 = maskData[y1 * srcW + x0], v11 = maskData[y1 * srcW + x1];
      const top = v00 * (1 - wx) + v10 * wx;
      const bot = v01 * (1 - wx) + v11 * wx;
      result[y * dstW + x] = (top * (1 - wy) + bot * wy) > 0 ? 1 : 0;
    }
  }
  return result;
}

/**
 * Morphological close (dilate then erode) using separable max/min filters.
 * Operates in place on the mask array.
 */
function morphClose(mask, w, h, radius = 2) {
  // Dilate: horizontal pass
  const hPass = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let count = 0;
    for (let x = 0; x <= Math.min(radius, w - 1); x++) {
      if (mask[row + x]) count++;
    }
    for (let x = 0; x < w; x++) {
      if (count > 0) hPass[row + x] = 1;
      const addX = x + radius + 1;
      const removeX = x - radius;
      if (addX < w && mask[row + addX]) count++;
      if (removeX >= 0 && mask[row + removeX]) count--;
    }
  }
  // Dilate: vertical pass
  const dilated = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y <= Math.min(radius, h - 1); y++) {
      if (hPass[y * w + x]) count++;
    }
    for (let y = 0; y < h; y++) {
      if (count > 0) dilated[y * w + x] = 1;
      const addY = y + radius + 1;
      const removeY = y - radius;
      if (addY < h && hPass[addY * w + x]) count++;
      if (removeY >= 0 && hPass[removeY * w + x]) count--;
    }
  }
  // Erode: horizontal pass
  const hPass2 = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let zeroCount = 0;
    for (let x = 0; x <= Math.min(radius, w - 1); x++) {
      if (!dilated[row + x]) zeroCount++;
    }
    for (let x = 0; x < w; x++) {
      hPass2[row + x] = zeroCount === 0 ? 1 : 0;
      const addX = x + radius + 1;
      const removeX = x - radius;
      if (addX < w && !dilated[row + addX]) zeroCount++;
      if (removeX >= 0 && !dilated[row + removeX]) zeroCount--;
    }
  }
  // Erode: vertical pass (writes back to mask)
  for (let x = 0; x < w; x++) {
    let zeroCount = 0;
    for (let y = 0; y <= Math.min(radius, h - 1); y++) {
      if (!hPass2[y * w + x]) zeroCount++;
    }
    for (let y = 0; y < h; y++) {
      mask[y * w + x] = zeroCount === 0 ? 1 : 0;
      const addY = y + radius + 1;
      const removeY = y - radius;
      if (addY < h && !hPass2[addY * w + x]) zeroCount++;
      if (removeY >= 0 && !hPass2[removeY * w + x]) zeroCount--;
    }
  }
}

/**
 * Dilate a binary mask using separable max-filter. Returns a new array.
 */
function dilateMask(mask, w, h, radius) {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  // Horizontal pass
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let count = 0;
    for (let x = 0; x <= Math.min(radius, w - 1); x++) {
      if (mask[row + x]) count++;
    }
    for (let x = 0; x < w; x++) {
      if (count > 0) tmp[row + x] = 1;
      const addX = x + radius + 1;
      const removeX = x - radius;
      if (addX < w && mask[row + addX]) count++;
      if (removeX >= 0 && mask[row + removeX]) count--;
    }
  }
  // Vertical pass
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y <= Math.min(radius, h - 1); y++) {
      if (tmp[y * w + x]) count++;
    }
    for (let y = 0; y < h; y++) {
      if (count > 0) out[y * w + x] = 1;
      const addY = y + radius + 1;
      const removeY = y - radius;
      if (addY < h && tmp[addY * w + x]) count++;
      if (removeY >= 0 && tmp[removeY * w + x]) count--;
    }
  }
  return out;
}

/**
 * Extract the outer boundary contour from a binary mask using
 * Moore neighborhood tracing (marching approach).
 */
function maskToContourMarching(mask, w, h) {
  // Find connected components, keep the largest
  const labels = new Int32Array(w * h);
  let nextLabel = 1;
  const sizes = [0];
  const stack = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (mask[idx] && !labels[idx]) {
        const lbl = nextLabel++;
        let count = 0;
        stack.length = 0;
        stack.push(idx);
        labels[idx] = lbl;
        while (stack.length) {
          const p = stack.pop();
          count++;
          const py = (p / w) | 0, px = p - py * w;
          const nbrs = [
            px > 0 ? p - 1 : -1,
            px < w - 1 ? p + 1 : -1,
            py > 0 ? p - w : -1,
            py < h - 1 ? p + w : -1
          ];
          for (const np of nbrs) {
            if (np >= 0 && mask[np] && !labels[np]) {
              labels[np] = lbl;
              stack.push(np);
            }
          }
        }
        sizes.push(count);
      }
    }
  }
  let bestLbl = 1, bestSz = 0;
  for (let i = 1; i < sizes.length; i++) {
    if (sizes[i] > bestSz) { bestSz = sizes[i]; bestLbl = i; }
  }
  const mainMask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) {
    mainMask[i] = labels[i] === bestLbl ? 1 : 0;
  }

  const isBoundary = (x, y) => {
    if (!mainMask[y * w + x]) return false;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) return true;
    return !mainMask[y * w + (x - 1)] || !mainMask[y * w + (x + 1)] ||
           !mainMask[(y - 1) * w + x] || !mainMask[(y + 1) * w + x];
  };

  // Find start pixel
  let sx = -1, sy = -1;
  findStart:
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isBoundary(x, y)) { sx = x; sy = y; break findStart; }
    }
  }
  if (sx < 0) return [];

  const contour = [];
  const dx8 = [1, 1, 0, -1, -1, -1, 0, 1];
  const dy8 = [0, 1, 1, 1, 0, -1, -1, -1];
  let cx = sx, cy = sy, dir = 7;
  const maxSteps = (w + h) * 8;
  const visitedKey = new Set();
  for (let step = 0; step < maxSteps; step++) {
    const key = cy * w + cx;
    if (!visitedKey.has(key)) {
      contour.push({ x: cx + 0.5, y: cy + 0.5 });
      visitedKey.add(key);
    }
    const startSearch = (dir + 5) % 8;
    let found = false;
    for (let i = 0; i < 8; i++) {
      const d = (startSearch + i) % 8;
      const nx = cx + dx8[d], ny = cy + dy8[d];
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      if (isBoundary(nx, ny)) { dir = d; cx = nx; cy = ny; found = true; break; }
    }
    if (!found) break;
    if (cx === sx && cy === sy && step > 4) break;
  }
  return contour;
}

/**
 * Fallback contour extraction using left/right edge scanning.
 * Used when maskToContourMarching produces fewer than 10 points.
 */
function maskToContourScan(mask, w, h) {
  const leftEdge = [], rightEdge = [];
  for (let y = 0; y < h; y++) {
    let left = -1, right = -1;
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x] === 1) { if (left === -1) left = x; right = x; }
    }
    if (left !== -1) { leftEdge.push({ x: left, y }); rightEdge.push({ x: right, y }); }
  }
  const contour = [...leftEdge, ...rightEdge.reverse()];
  const step = Math.max(1, Math.floor(contour.length / 500));
  const sampled = [];
  for (let i = 0; i < contour.length; i += step) sampled.push(contour[i]);
  return sampled;
}

/**
 * Smooth a contour with a sliding-window average.
 */
function smoothContour(pts, k = 2) {
  if (pts.length < 5) return pts;
  const out = new Array(pts.length);
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    let sx = 0, sy = 0, c = 0;
    for (let j = -k; j <= k; j++) {
      const p = pts[((i + j) % n + n) % n];
      sx += p.x; sy += p.y; c++;
    }
    out[i] = { x: sx / c, y: sy / c };
  }
  return out;
}

/**
 * Flood-fill interior OFF regions of the sheet mask to find holes.
 * Regions touching image edges are considered background, not holes.
 */
function findHoles(mask, w, h, minAreaPercent) {
  const totalArea = w * h;
  const minHolePixels = (minAreaPercent / 100) * totalArea;
  const labels = new Int32Array(w * h);
  let nextLabel = 1;
  const regionInfo = [];
  const stack = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (mask[idx] || labels[idx]) continue;
      const lbl = nextLabel++;
      let count = 0;
      let touchesEdge = false;
      stack.length = 0;
      stack.push(idx);
      labels[idx] = lbl;
      while (stack.length) {
        const p = stack.pop();
        count++;
        const py = (p / w) | 0, px = p - py * w;
        if (px === 0 || py === 0 || px === w - 1 || py === h - 1) touchesEdge = true;
        const nbrs = [
          px > 0 ? p - 1 : -1,
          px < w - 1 ? p + 1 : -1,
          py > 0 ? p - w : -1,
          py < h - 1 ? p + w : -1,
        ];
        for (const np of nbrs) {
          if (np >= 0 && !mask[np] && !labels[np]) {
            labels[np] = lbl;
            stack.push(np);
          }
        }
      }
      regionInfo.push({ label: lbl, area: count, touchesEdge });
    }
  }

  const holes = [];
  for (const region of regionInfo) {
    if (region.touchesEdge) continue;
    if (region.area < minHolePixels) continue;
    const holeMask = new Uint8Array(w * h);
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] === region.label) holeMask[i] = 1;
    }
    const contour = maskToContourMarching(holeMask, w, h);
    if (contour.length >= 6) {
      holes.push({ contour, area: region.area });
    }
  }
  holes.sort((a, b) => b.area - a.area);
  return holes;
}

/**
 * Count how many mask pixels touch each image edge.
 */
function countEdgeTouches(maskData, w, h) {
  let top = 0, bottom = 0, left = 0, right = 0;
  const THRESH = 5;
  for (let x = 0; x < w; x++) {
    if (maskData[x] > 0) top++;
    if (maskData[(h - 1) * w + x] > 0) bottom++;
  }
  for (let y = 0; y < h; y++) {
    if (maskData[y * w] > 0) left++;
    if (maskData[y * w + (w - 1)] > 0) right++;
  }
  return {
    count: (top > THRESH ? 1 : 0) + (bottom > THRESH ? 1 : 0) +
           (left > THRESH ? 1 : 0) + (right > THRESH ? 1 : 0),
    top, bottom, left, right,
  };
}

/**
 * Compute the axis-aligned bounding box of a binary mask.
 */
function computeMaskBbox(maskData, w, h) {
  let x1 = w, y1 = h, x2 = 0, y2 = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (maskData[y * w + x] > 0) {
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
      }
    }
  }
  return { x1, y1, x2, y2, w: x2 - x1, h: y2 - y1 };
}

/**
 * Compute what fraction of innerMask pixels are also ON in outerMask.
 */
function maskContains(outerMask, innerMask) {
  if (outerMask.w !== innerMask.w || outerMask.h !== innerMask.h) return 0;
  let innerOn = 0, alsoOuter = 0;
  const len = outerMask.w * outerMask.h;
  for (let i = 0; i < len; i++) {
    if (innerMask.data[i] > 0) {
      innerOn++;
      if (outerMask.data[i] > 0) alsoOuter++;
    }
  }
  return innerOn > 0 ? alsoOuter / innerOn : 0;
}

/**
 * Local RDP simplification operating on {x,y} point arrays.
 * (Duplicated here to avoid dependency on geometry.js rdpSimplify which uses
 * a different point format.)
 */
function rdpSimplifyXY(points, epsilon) {
  if (points.length <= 2) return points;
  let maxDist = 0, maxIdx = 0;
  const first = points[0], last = points[points.length - 1];
  const dx = last.x - first.x, dy = last.y - first.y;
  const lenSq = dx * dx + dy * dy;
  for (let i = 1; i < points.length - 1; i++) {
    let dist;
    if (lenSq === 0) {
      const ex = points[i].x - first.x, ey = points[i].y - first.y;
      dist = Math.sqrt(ex * ex + ey * ey);
    } else {
      dist = Math.abs(dy * points[i].x - dx * points[i].y +
             last.x * first.y - last.y * first.x) / Math.sqrt(lenSq);
    }
    if (dist > maxDist) { maxDist = dist; maxIdx = i; }
  }
  if (maxDist > epsilon) {
    const left = rdpSimplifyXY(points.slice(0, maxIdx + 1), epsilon);
    const right = rdpSimplifyXY(points.slice(maxIdx), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

/**
 * Convert an image source (HTMLImageElement, HTMLCanvasElement, or File)
 * to a canvas and return it along with dimensions.
 */
async function imageSourceToCanvas(imageSource) {
  let canvas, w, h;
  if (imageSource instanceof HTMLCanvasElement) {
    canvas = imageSource;
    w = canvas.width;
    h = canvas.height;
  } else if (imageSource instanceof HTMLImageElement) {
    w = imageSource.naturalWidth || imageSource.width;
    h = imageSource.naturalHeight || imageSource.height;
    const MAX_DIM = 4096;
    if (w > MAX_DIM || h > MAX_DIM) {
      const scale = MAX_DIM / Math.max(w, h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(imageSource, 0, 0, w, h);
  } else if (imageSource instanceof File) {
    const bitmap = await createImageBitmap(imageSource);
    w = bitmap.width;
    h = bitmap.height;
    const MAX_DIM = 4096;
    if (w > MAX_DIM || h > MAX_DIM) {
      const scale = MAX_DIM / Math.max(w, h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
  } else {
    throw new Error('imageSource must be HTMLImageElement, HTMLCanvasElement, or File');
  }
  return { canvas, w, h };
}

// ============================================================
// Geometry Helpers: Convex Hull, Minimum-Area Bounding Rect,
// Quad Corner Finding
// ============================================================

/**
 * Convex hull using Andrew's monotone chain algorithm.
 * Input: array of {x, y} points.
 * Returns: array of {x, y} hull vertices in counter-clockwise order.
 */
function convexHull(points) {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length <= 2) return pts;
  const cross = (O, A, B) => (A.x - O.x) * (B.y - O.y) - (A.y - O.y) * (B.x - O.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Minimum-area bounding rectangle via rotating calipers on convex hull.
 * Returns 4 corner points or null if hull is degenerate.
 */
function minAreaRect(hull) {
  if (hull.length < 3) return null;
  const n = hull.length;
  let minArea = Infinity;
  let bestRect = null;

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = hull[j].x - hull[i].x;
    const ey = hull[j].y - hull[i].y;
    const elen = Math.hypot(ex, ey);
    if (elen < 1e-6) continue;
    const ux = ex / elen, uy = ey / elen;
    const vx = -uy, vy = ux;

    let minU = Infinity, maxU = -Infinity;
    let minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const du = (p.x - hull[i].x) * ux + (p.y - hull[i].y) * uy;
      const dv = (p.x - hull[i].x) * vx + (p.y - hull[i].y) * vy;
      if (du < minU) minU = du;
      if (du > maxU) maxU = du;
      if (dv < minV) minV = dv;
      if (dv > maxV) maxV = dv;
    }

    const area = (maxU - minU) * (maxV - minV);
    if (area < minArea) {
      minArea = area;
      bestRect = [
        { x: hull[i].x + minU * ux + minV * vx, y: hull[i].y + minU * uy + minV * vy },
        { x: hull[i].x + maxU * ux + minV * vx, y: hull[i].y + maxU * uy + minV * vy },
        { x: hull[i].x + maxU * ux + maxV * vx, y: hull[i].y + maxU * uy + maxV * vy },
        { x: hull[i].x + minU * ux + maxV * vx, y: hull[i].y + minU * uy + maxV * vy },
      ];
    }
  }
  return bestRect;
}

/**
 * Compute polygon perimeter from array of {x,y} points.
 */
function polygonPerimeter(polygon) {
  let p = 0;
  for (let i = 0; i < polygon.length; i++) {
    const j = (i + 1) % polygon.length;
    p += Math.hypot(polygon[j].x - polygon[i].x, polygon[j].y - polygon[i].y);
  }
  return p;
}

/**
 * Shoelace area formula for {x,y} polygon.
 */
function shoelaceArea(polygon) {
  let a = 0;
  for (let i = 0; i < polygon.length; i++) {
    const j = (i + 1) % polygon.length;
    a += polygon[i].x * polygon[j].y - polygon[j].x * polygon[i].y;
  }
  return Math.abs(a) / 2;
}

/**
 * Point-in-polygon test (ray casting).
 */
function pointInPolygon(pt, polygon) {
  if (!polygon || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    if ((yi > pt.y) !== (yj > pt.y) && pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * RDP simplification for closed polygons (ring).
 * Splits the ring at the two farthest-apart points and simplifies each chain.
 */
function rdpSimplifyRing(ring, epsilon) {
  if (ring.length <= 4) return ring;
  let maxDist = 0, a = 0, b = 0;
  for (let i = 0; i < ring.length; i++) {
    for (let j = i + 1; j < ring.length; j++) {
      const d = Math.hypot(ring[j].x - ring[i].x, ring[j].y - ring[i].y);
      if (d > maxDist) { maxDist = d; a = i; b = j; }
    }
  }
  const chain1 = [];
  for (let i = a; i !== b; i = (i + 1) % ring.length) chain1.push(ring[i]);
  chain1.push(ring[b]);
  const chain2 = [];
  for (let i = b; i !== a; i = (i + 1) % ring.length) chain2.push(ring[i]);
  chain2.push(ring[a]);

  const s1 = rdpSimplifyXY(chain1, epsilon);
  const s2 = rdpSimplifyXY(chain2, epsilon);
  const merged = [...s1];
  for (let i = 1; i < s2.length - 1; i++) merged.push(s2[i]);
  return merged;
}

/**
 * From N candidate points (N > 4), pick the 4 that form the
 * largest-area quadrilateral -- these are the true corners.
 */
function bestFourFromCandidates(pts) {
  if (pts.length < 4) return null;
  if (pts.length === 4) return pts;
  let bestArea = 0, best = null;
  const n = pts.length;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      for (let k = j + 1; k < n; k++)
        for (let l = k + 1; l < n; l++) {
          const quad = sortCornersClockwise([pts[i], pts[j], pts[k], pts[l]]);
          const area = shoelaceArea(quad);
          if (area > bestArea) { bestArea = area; best = quad; }
        }
  return best;
}

/**
 * Sort 4 corners as TL, TR, BR, BL (clockwise from top-left).
 * Uses angle from centroid, then rotates so that TL (smallest x+y sum) is first.
 */
function sortCornersClockwise(corners) {
  let cx = 0, cy = 0;
  for (const c of corners) { cx += c.x; cy += c.y; }
  cx /= 4; cy /= 4;

  const withAngle = corners.map(c => ({
    ...c,
    angle: Math.atan2(c.y - cy, c.x - cx)
  }));
  withAngle.sort((a, b) => a.angle - b.angle);

  let tlIdx = 0;
  let minSum = Infinity;
  for (let i = 0; i < 4; i++) {
    const s = withAngle[i].x + withAngle[i].y;
    if (s < minSum) { minSum = s; tlIdx = i; }
  }

  const ordered = [];
  for (let i = 0; i < 4; i++) ordered.push(withAngle[(tlIdx + i) % 4]);
  return ordered;
}

/**
 * Find the actual 4 perspective-distorted corners of a quadrilateral
 * from a convex hull, preserving the real keystone shape for homography.
 * Uses RDP simplification to reduce hull to ~4 dominant corners, then
 * picks the best 4-point subset that maximizes quadrilateral area.
 */
function findQuadCorners(hull) {
  if (hull.length < 4) return null;

  const perimeter = polygonPerimeter(hull);
  let bestQuad = null;

  for (let epsScale = 0.01; epsScale <= 0.15; epsScale += 0.005) {
    const eps = perimeter * epsScale;
    const simplified = rdpSimplifyRing(hull, eps);
    if (simplified.length === 4) {
      bestQuad = simplified;
      break;
    }
    if (simplified.length > 4 && simplified.length <= 8) {
      bestQuad = bestFourFromCandidates(simplified);
      if (bestQuad) break;
    }
  }

  if (!bestQuad) {
    let candidates = hull;
    if (hull.length > 20) {
      const step = Math.ceil(hull.length / 20);
      candidates = hull.filter((_, i) => i % step === 0);
    }
    bestQuad = bestFourFromCandidates(candidates);
  }

  return bestQuad;
}

/**
 * Invert a 3x3 homography matrix using cofactors.
 */
function invertHomography(H) {
  const [
    [a, b, c],
    [d, e, f],
    [g, h, i]
  ] = H;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return null;
  const invDet = 1.0 / det;
  return [
    [(e * i - f * h) * invDet, (c * h - b * i) * invDet, (b * f - c * e) * invDet],
    [(f * g - d * i) * invDet, (a * i - c * g) * invDet, (c * d - a * f) * invDet],
    [(d * h - e * g) * invDet, (b * g - a * h) * invDet, (a * e - b * d) * invDet]
  ];
}

/**
 * Warp an image canvas using inverse homography with bilinear interpolation.
 * H_inv maps destination pixels back to source pixels.
 */
async function warpImage(srcCanvas, H_inv, dstW, dstH) {
  const dst = document.createElement('canvas');
  dst.width = dstW;
  dst.height = dstH;
  const dstCtx = dst.getContext('2d');
  const srcW = srcCanvas.width, srcH = srcCanvas.height;
  const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
  const srcData = srcCtx.getImageData(0, 0, srcW, srcH);
  const dstData = dstCtx.createImageData(dstW, dstH);
  const sp = srcData.data, dp = dstData.data;

  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const w = H_inv[2][0] * x + H_inv[2][1] * y + H_inv[2][2];
      const sx = (H_inv[0][0] * x + H_inv[0][1] * y + H_inv[0][2]) / w;
      const sy = (H_inv[1][0] * x + H_inv[1][1] * y + H_inv[1][2]) / w;
      if (sx < 0 || sy < 0 || sx >= srcW - 1 || sy >= srcH - 1) continue;

      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * srcW + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + srcW * 4;
      const i11 = i01 + 4;
      const di = (y * dstW + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        dp[di + ch] = Math.round(
          sp[i00 + ch] * (1 - fx) * (1 - fy) + sp[i10 + ch] * fx * (1 - fy) +
          sp[i01 + ch] * (1 - fx) * fy + sp[i11 + ch] * fx * fy
        );
      }
      dp[di + 3] = 255;
    }
    if (y % 256 === 0) await new Promise(r => setTimeout(r, 0));
  }
  dstCtx.putImageData(dstData, 0, 0);
  return dst;
}

/**
 * Build the rectification transform from calibration data.
 * Maps source image pixels to a top-down (rectified) pixel space.
 */
function buildRectificationTransform(calibration, polygon) {
  const H = calibration.homography;
  const ppm = calibration.pixelsPerMm;
  const calPts = calibration.points;
  if (!H || !ppm || !calPts || calPts.length < 4) return null;

  const paperMm = calPts.map(p => applyHomography(H, p.x, p.y));

  let samplePts = calPts;
  if (polygon && polygon.length >= 3) {
    samplePts = polygon.map(p => (Array.isArray(p) ? { x: p[0], y: p[1] } : p));
  }
  const sampleMm = samplePts.map(p => applyHomography(H, p.x, p.y));

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of sampleMm) {
    if (isFinite(p.x) && isFinite(p.y)) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!isFinite(minX)) return null;

  const marginX = (maxX - minX) * 0.05;
  const marginY = (maxY - minY) * 0.05;
  minX -= marginX; minY -= marginY;
  maxX += marginX; maxY += marginY;

  const mmW = maxX - minX, mmH = maxY - minY;
  let dstW = Math.round(mmW * ppm);
  let dstH = Math.round(mmH * ppm);

  const maxDim = 4096;
  if (dstW > maxDim || dstH > maxDim) {
    const shrink = maxDim / Math.max(dstW, dstH);
    dstW = Math.round(dstW * shrink);
    dstH = Math.round(dstH * shrink);
  }

  const effScaleX = dstW / mmW;
  const effScaleY = dstH / mmH;

  const srcQuad = calPts.map(p => (Array.isArray(p) ? { x: p[0], y: p[1] } : p));
  const dstQuad = paperMm.map(p => ({
    x: (p.x - minX) * effScaleX,
    y: (p.y - minY) * effScaleY
  }));

  const H_rect = computeHomography(srcQuad, dstQuad);
  const H_rect_inv = computeHomography(dstQuad, srcQuad);

  return { H_rect, H_rect_inv, dstW, dstH, minX, minY, effScaleX, effScaleY };
}

// ============================================================
// HideDetector class
// ============================================================

export { SAM_MODELS };

export class HideDetector {
  #model = null;
  #processor = null;
  #ready = false;
  #calibration = null;
  #onProgress = null;
  #onLog = null;
  #device = 'wasm';
  #modelKey = 'sam-vit-base';
  #tableMask = null;
  #tableMaskFull = null;
  #lastPolygon = null;
  #lastHoles = null;

  /**
   * @param {object} options
   * @param {function} [options.onProgress] - Progress callback (0-1)
   * @param {function} [options.onLog] - Log callback (message, level)
   */
  constructor(options = {}) {
    this.#onProgress = options.onProgress || null;
    this.#onLog = options.onLog || null;
  }

  /**
   * Get the list of available SAM models.
   * @returns {Object} Map of model key → {id, name, description, size, speed, accuracy}
   */
  static getAvailableModels() {
    return { ...SAM_MODELS };
  }

  /**
   * Get the currently loaded model key.
   * @returns {string|null}
   */
  get currentModel() {
    return this.#ready ? this.#modelKey : null;
  }

  #log(msg, level = 'info') {
    if (this.#onLog) this.#onLog(msg, level);
  }

  #progress(value) {
    if (this.#onProgress) this.#onProgress(value);
  }

  /**
   * Whether the SAM model is loaded and ready for inference.
   */
  get modelReady() {
    return this.#ready;
  }

  /**
   * Load a SAM model. Supports multiple model variants for different materials.
   * @param {object} options
   * @param {'sam-vit-base'|'sam-vit-large'|'sam-vit-huge'} [options.model='sam-vit-base']
   * @param {'webgpu'|'wasm'|'auto'} [options.device='auto']
   * @param {FileSystemDirectoryHandle|null} [options.fromUSB=null] - Load from USB/folder
   * @returns {Promise<{device: string, cached: boolean, model: string}>}
   */
  async loadModel(options = {}) {
    if (this.#ready) return { device: 'already-loaded', cached: true, model: this.#modelKey };

    const { device: preferredDevice = 'auto', fromUSB = null, model: modelKey = 'sam-vit-base' } = options;

    if (!SAM_MODELS[modelKey]) {
      throw new Error(`Unknown model "${modelKey}". Available: ${Object.keys(SAM_MODELS).join(', ')}`);
    }

    this.#modelKey = modelKey;
    const modelInfo = SAM_MODELS[modelKey];
    this.#log(`Loading ${modelInfo.name} (${modelInfo.description})...`);
    this.#progress(0.05);

    const tf = fromUSB ? await loadTransformersFromDir(fromUSB) : await loadTransformers();
    const { env, SamModel, AutoProcessor, RawImage, Tensor } = tf;

    env.useBrowserCache = true;
    env.allowLocalModels = false;
    env.backends = env.backends || {};
    env.backends.onnx = env.backends.onnx || {};
    env.backends.onnx.wasm = env.backends.onnx.wasm || {};
    env.backends.onnx.wasm.numThreads = navigator.hardwareConcurrency || 4;
    env.backends.onnx.wasm.profiling = false;

    // Determine device
    let device = 'wasm';
    if (preferredDevice === 'webgpu' || preferredDevice === 'auto') {
      if (typeof navigator !== 'undefined' && navigator.gpu) {
        try {
          let adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
          if (!adapter) adapter = await navigator.gpu.requestAdapter();
          if (adapter) {
            device = 'webgpu';
            const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {});
            const gpuName = info.device || info.description || info.vendor || 'Unknown GPU';
            this.#log(`GPU adapter: "${gpuName}"`);
            const gpuDevice = await adapter.requestDevice({
              requiredLimits: {
                maxBufferSize: adapter.limits.maxBufferSize,
                maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
              }
            });
            this.#log(`Max buffer: ${(gpuDevice.limits.maxBufferSize / (1024*1024*1024)).toFixed(1)} GB`);
            gpuDevice.destroy();
          } else {
            this.#log('No GPU adapter — falling back to WASM', 'warn');
          }
        } catch (e) {
          this.#log(`WebGPU probe failed: ${e.message} — using WASM`, 'warn');
        }
      } else {
        this.#log('WebGPU not available — using WASM', 'warn');
      }
    }
    if (preferredDevice === 'wasm') device = 'wasm';

    if (device === 'webgpu') {
      if (!env.backends.onnx.webgpu) env.backends.onnx.webgpu = {};
      env.backends.onnx.webgpu.profiling = false;
      env.backends.onnx.webgpu.powerPreference = 'high-performance';
    }

    const model_id = modelInfo.id;

    // USB LOADING PATH: load from FileSystemDirectoryHandle
    if (fromUSB) {
      this.#log('Loading model from USB/folder...');
      this.#progress(0.10);
      const success = await this.#loadFromDirHandle(fromUSB, device, model_id, tf);
      if (success) {
        await saveModelDirHandle(fromUSB, device === 'wasm' ? 'cpu' : 'gpu', modelKey);
        return { device, cached: false, model: modelKey };
      }
      throw new Error('USB model load failed — check folder contents. Ensure manifest.json and model files exist.');
    }

    // Check cache status
    let cached = false;
    try {
      const cacheKeys = await caches.keys();
      const tfCache = cacheKeys.find(k => k.includes('transformers'));
      if (tfCache) {
        const cache = await caches.open(tfCache);
        const keys = await cache.keys();
        if (keys.length > 0) cached = true;
      }
    } catch (e) { /* ignore */ }

    this.#log(cached ? 'Loading model from cache...' : `Downloading ${modelInfo.name} (${modelInfo.size}, first time)...`);
    this.#progress(0.15);

    // Load processor (60s timeout per source)
    const processorPromise = AutoProcessor.from_pretrained(model_id);
    const processorTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Processor load timed out (60s)')), 60000));
    this.#processor = await Promise.race([processorPromise, processorTimeout]);
    this.#progress(0.4);

    // Load model — with auto-fallback to WASM if WebGPU fails (e.g. createBuffer too large)
    const loadAndVerify = async (dev) => {
      const timeoutMs = dev === 'webgpu' ? 480000 : 180000;
      const modelPromise = SamModel.from_pretrained(model_id, { dtype: 'fp32', device: dev });
      const modelTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Model load timed out (${timeoutMs/1000}s)`)), timeoutMs));
      this.#model = await Promise.race([modelPromise, modelTimeout]);
      this.#progress(0.75);
      this.#log('Verifying model (compiling shaders)...');
      const testSize = 256;
      const testPixels = new Uint8ClampedArray(testSize * testSize * 3).fill(128);
      const testImage = new RawImage(testPixels, testSize, testSize, 3);
      const inputs = await this.#processor(testImage);
      const input_points = new Tensor('float32', [128.0, 128.0], [1, 1, 1, 2]);
      const input_labels = new Tensor('int64', [1n], [1, 1, 1]);
      const verifyStart = performance.now();
      let outputs;
      if (typeof this.#model.get_image_embeddings === 'function') {
        const embeddings = await this.#model.get_image_embeddings(inputs);
        outputs = await this.#model({ ...embeddings, input_points, input_labels });
      } else {
        outputs = await this.#model({ ...inputs, input_points, input_labels });
      }
      const verifyTime = performance.now() - verifyStart;
      const hasMask = outputs.pred_masks && outputs.pred_masks.data.length > 0;
      if (!hasMask) throw new Error('Test inference produced no mask');
      if (dev === 'webgpu' && verifyTime > 30000) {
        throw new Error(`GPU too slow (${Math.round(verifyTime)}ms > 30000ms threshold)`);
      }
      this.#log(`Model verified (${Math.round(verifyTime)}ms)`);
      return dev;
    };

    let finalDevice = device;
    try {
      finalDevice = await loadAndVerify(device);
    } catch (e) {
      if (device === 'webgpu') {
        this.#log(`WebGPU failed: ${e.message} — retrying with WASM`, 'warn');
        if (this.#model && this.#model.dispose) this.#model.dispose();
        this.#model = null;
        delete env.backends.onnx.webgpu;
        env.backends.onnx.wasm.numThreads = navigator.hardwareConcurrency || 4;
        this.#progress(0.5);
        finalDevice = await loadAndVerify('wasm');
      } else {
        this.#log(`Verification warning: ${e.message}`, 'warn');
      }
    }

    this.#ready = true;
    this.#device = finalDevice;
    this.#progress(1.0);
    this.#log(`${modelInfo.name} loaded on ${finalDevice.toUpperCase()}`);

    return { device: finalDevice, cached, model: modelKey };
  }

  /**
   * Load model directly from a FileSystemDirectoryHandle (USB/portable).
   * Intercepts fetch calls to serve local files instead of CDN.
   */
  async #loadFromDirHandle(dirHandle, device, model_id, tf) {
    const { env, SamModel, AutoProcessor } = tf;

    let mh;
    try { mh = await dirHandle.getFileHandle('manifest.json'); }
    catch { this.#log('No manifest.json in folder', 'error'); return false; }

    const manifest = JSON.parse(await (await mh.getFile()).text());
    this.#log(`Found ${manifest.length} model files in folder`);
    this.#progress(0.15);

    const localURLs = {};
    for (const entry of manifest) {
      const file = await (await dirHandle.getFileHandle(entry.fileName)).getFile();
      localURLs[entry.originalUrl] = URL.createObjectURL(file);
    }

    const originalFetch = window.fetch;
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      return localURLs[url] ? originalFetch(localURLs[url], init) : originalFetch(input, init);
    };

    try {
      env.useBrowserCache = false;
      this.#processor = await AutoProcessor.from_pretrained(model_id);
      this.#progress(0.5);
      await new Promise(r => setTimeout(r, 50));
      this.#model = await SamModel.from_pretrained(model_id, { dtype: 'fp32', device });
      this.#progress(0.9);
    } finally {
      window.fetch = originalFetch;
      env.useBrowserCache = true;
    }

    for (const u of Object.values(localURLs)) URL.revokeObjectURL(u);

    this.#ready = true;
    this.#device = device;
    const label = device === 'wasm' ? 'CPU/WASM' : device.toUpperCase();
    this.#log(`Model loaded from USB (${label})`);
    this.#progress(1.0);
    return true;
  }

  /**
   * Try to auto-load from a previously saved USB model path.
   * @returns {Promise<boolean>} true if auto-load succeeded
   */
  async tryAutoLoadFromUSB() {
    const saved = await getSavedModelDirHandle();
    if (!saved) return false;

    const { dirHandle, mode, modelKey } = saved;
    try {
      const perm = await dirHandle.requestPermission({ mode: 'read' });
      if (perm !== 'granted') {
        this.#log('USB model path remembered — grant permission to auto-load', 'warn');
        return false;
      }
      this.#log('Auto-loading model from saved USB path...');
      const device = mode === 'cpu' ? 'wasm' : 'auto';
      await this.loadModel({ fromUSB: dirHandle, device, model: modelKey || 'sam-vit-base' });
      return true;
    } catch (err) {
      this.#log(`Auto-load failed: ${err.message}`, 'warn');
      return false;
    }
  }

  /**
   * Export the browser-cached model to a user-selected folder (for USB portability).
   * @returns {Promise<{fileCount: number, totalBytes: number}>}
   */
  async exportModelToFolder() {
    if (!window.showDirectoryPicker) throw new Error('File System Access API not supported');

    const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    const modelDir = await dirHandle.getDirectoryHandle('sam-vit-base-backup', { create: true });

    const cacheNames = await caches.keys();
    const tfCaches = cacheNames.filter(k => k.includes('transformers'));
    if (!tfCaches.length) throw new Error('No cached model found — load model first');

    let fileCount = 0, totalBytes = 0;
    const manifest = [];

    for (const cacheName of tfCaches) {
      const cache = await caches.open(cacheName);
      const requests = await cache.keys();
      for (const request of requests) {
        const response = await cache.match(request);
        const blob = await response.blob();
        const fileName = new URL(request.url).pathname.split('/').filter(Boolean).join('__').replace(/[^a-zA-Z0-9._\-]/g, '_');
        const fh = await modelDir.getFileHandle(fileName, { create: true });
        const wr = await fh.createWritable();
        await wr.write(blob);
        await wr.close();
        manifest.push({
          originalUrl: request.url,
          fileName,
          size: blob.size,
          contentType: response.headers.get('content-type') || 'application/octet-stream'
        });
        fileCount++;
        totalBytes += blob.size;
      }
    }

    const mh = await modelDir.getFileHandle('manifest.json', { create: true });
    const mw = await mh.createWritable();
    await mw.write(JSON.stringify(manifest, null, 2));
    await mw.close();

    // Also export the transformers library so USB load works fully offline
    try {
      const libResponse = await fetch('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.1/dist/transformers.min.js');
      if (libResponse.ok) {
        const libBlob = await libResponse.blob();
        const libFh = await modelDir.getFileHandle('transformers.min.js', { create: true });
        const libWr = await libFh.createWritable();
        await libWr.write(libBlob);
        await libWr.close();
        fileCount++;
        totalBytes += libBlob.size;
        this.#log('Included transformers.min.js in backup for offline USB use');
      }
    } catch (e) {
      this.#log('Could not include transformers library in backup (non-critical)', 'warn');
    }

    this.#log(`Backup: ${fileCount} files, ${(totalBytes / (1024 * 1024)).toFixed(1)} MB`);
    return { fileCount, totalBytes };
  }

  /**
   * Import model from a user-selected folder back into browser cache, then load it.
   * @param {object} options
   * @param {'webgpu'|'wasm'|'auto'} [options.device='auto']
   * @returns {Promise<{device: string, cached: boolean, model: string}>}
   */
  async importModelFromFolder(options = {}) {
    if (!window.showDirectoryPicker) throw new Error('File System Access API not supported');

    const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
    let mh;
    try { mh = await dirHandle.getFileHandle('manifest.json'); }
    catch { throw new Error('No manifest.json found in folder'); }

    // Pre-load transformers library from the folder if available (for offline use)
    await loadTransformersFromDir(dirHandle);

    const manifest = JSON.parse(await (await mh.getFile()).text());
    const cache = await caches.open('transformers-cache');
    let restored = 0, totalBytes = 0;

    for (const entry of manifest) {
      const file = await (await dirHandle.getFileHandle(entry.fileName)).getFile();
      const buf = await file.arrayBuffer();
      await cache.put(
        new Request(entry.originalUrl),
        new Response(buf, {
          status: 200,
          headers: { 'content-type': entry.contentType, 'cache-control': 'public, max-age=31536000' }
        })
      );
      restored++;
      totalBytes += file.size;
    }

    this.#log(`Restored ${restored} files, ${(totalBytes / (1024 * 1024)).toFixed(1)} MB to cache`);
    return this.loadModel(options);
  }

  /**
   * Unload the model and free resources (VRAM/RAM).
   */
  async unloadModel() {
    if (this.#model && this.#model.dispose) {
      await this.#model.dispose();
    }
    if (this.#processor && this.#processor.dispose) {
      await this.#processor.dispose();
    }
    this.#model = null;
    this.#processor = null;
    this.#ready = false;
    await clearModelDirHandle();
    this.#log('Model unloaded — VRAM freed');
  }

  /**
   * Set a table mask for composite scoring (from prior CNC table detection).
   * @param {{data: Uint8Array|Float32Array, w: number, h: number}} tableMask
   */
  setTableMask(tableMask) {
    this.#tableMask = tableMask;
  }

  getTableMaskFull() {
    return this.#tableMaskFull;
  }

  /**
   * Detect the hide (leather/material) boundary and holes in an image.
   * @param {HTMLImageElement|HTMLCanvasElement|File} imageSource
   * @param {object} params
   * @returns {Promise<{polygon: Array, holes: Array, areaPx: number, mask: {data, w, h}}>}
   */
  async detectHide(imageSource, params = {}) {
    if (!this.#ready) throw new Error('Model not loaded — call loadModel() first');

    const {
      gridSize: requestedGridSize = 8,
      maskThreshold = 0.85,
      epsilon = 2.0,
      minAreaPercent = 1,
      holeMinPercent = 1,
      detectDamageMarks = false,
      damageSensitivity = 35,
      damageMinPercent = 0
    } = params;

    // Bug fix #2: WASM grid size cap — when WebGPU is unavailable, cap gridSize at 8
    let gridSize = requestedGridSize;
    if (this.#device === 'wasm' && gridSize > 8) {
      this.#log(`WASM mode: capping gridSize from ${gridSize} to 8`, 'warn');
      gridSize = 8;
    }

    const tf = await loadTransformers();
    const { RawImage, Tensor } = tf;

    // Convert source to canvas
    const { canvas: srcCanvas, w: imgW, h: imgH } = await imageSourceToCanvas(imageSource);
    const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });

    this.#log(`Image: ${imgW}x${imgH}`);
    this.#progress(0.05);

    // Resize to SAM native input (1024x1024)
    const SAM_DIM = 1024;
    const resizeCanvas = document.createElement('canvas');
    resizeCanvas.width = SAM_DIM;
    resizeCanvas.height = SAM_DIM;
    const resizeCtx = resizeCanvas.getContext('2d');
    resizeCtx.imageSmoothingEnabled = true;
    resizeCtx.imageSmoothingQuality = 'high';
    resizeCtx.drawImage(srcCanvas, 0, 0, imgW, imgH, 0, 0, SAM_DIM, SAM_DIM);

    // Apply specular suppression
    let imageData = resizeCtx.getImageData(0, 0, SAM_DIM, SAM_DIM);
    imageData = suppressSpecular(imageData);
    resizeCtx.putImageData(imageData, 0, 0);
    imageData = resizeCtx.getImageData(0, 0, SAM_DIM, SAM_DIM);

    // Convert RGBA to RGB
    const rgbaData = imageData.data;
    const pixelCount = SAM_DIM * SAM_DIM;
    const rgbData = new Uint8ClampedArray(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
      rgbData[i * 3] = rgbaData[i * 4];
      rgbData[i * 3 + 1] = rgbaData[i * 4 + 1];
      rgbData[i * 3 + 2] = rgbaData[i * 4 + 2];
    }
    const rawImage = new RawImage(rgbData, SAM_DIM, SAM_DIM, 3);

    // Get image embeddings
    this.#log('Encoding image embeddings...');
    this.#progress(0.10);
    const inputs = await this.#processor(rawImage);
    this.#progress(0.20);

    let imageEmbeddings;
    if (typeof this.#model.get_image_embeddings === 'function') {
      imageEmbeddings = await this.#model.get_image_embeddings(inputs);
    } else {
      imageEmbeddings = inputs;
    }
    this.#progress(0.30);

    // Generate point grid and collect candidate masks
    const gridPoints = generatePointGrid(SAM_DIM, SAM_DIM, gridSize);
    this.#log(`Running ${gridPoints.length} grid points...`);

    const candidateMasks = [];
    let successCount = 0, errorCount = 0;

    for (let i = 0; i < gridPoints.length; i++) {
      const point = gridPoints[i];
      try {
        const input_points = new Tensor('float32', [point.x, point.y], [1, 1, 1, 2]);
        const input_labels = new Tensor('int64', [1n], [1, 1, 1]);
        const outputs = await this.#model({ ...imageEmbeddings, input_points, input_labels });
        const scores = outputs.iou_scores.data;
        const numMasks = scores.length;

        for (let m = 0; m < numMasks; m++) {
          const score = Number(scores[m]);
          if (score < maskThreshold) continue;
          const maskDims = outputs.pred_masks.dims;
          const maskH = maskDims[maskDims.length - 2];
          const maskW = maskDims[maskDims.length - 1];
          const maskSize = maskW * maskH;
          const maskOffset = m * maskSize;
          const maskSlice = outputs.pred_masks.data.slice(maskOffset, maskOffset + maskSize);
          let area = 0;
          for (let p = 0; p < maskSize; p++) if (maskSlice[p] > 0) area++;
          const areaPercent = (area / maskSize) * 100;
          if (areaPercent < 0.5) continue;
          candidateMasks.push({ data: maskSlice, w: maskW, h: maskH, area, areaPercent, score });
        }
        successCount++;
      } catch (e) {
        errorCount++;
        continue;
      }
      this.#progress(0.30 + ((i / gridPoints.length) * 0.50));
      // Yield to the event loop periodically
      if (i % 4 === 0) await new Promise(r => setTimeout(r, 0));
    }
    this.#log(`Grid complete: ${successCount} ok, ${errorCount} err, ${candidateMasks.length} masks`);

    // -----------------------------------------------
    // Bucket masks by area (tolerance 8%)
    // -----------------------------------------------
    candidateMasks.sort((a, b) => a.areaPercent - b.areaPercent);
    const BUCKET_TOLERANCE = 8;
    const buckets = [];
    for (const mask of candidateMasks) {
      let placed = false;
      for (const bucket of buckets) {
        if (Math.abs(mask.areaPercent - bucket.avgArea) < BUCKET_TOLERANCE) {
          bucket.masks.push(mask);
          bucket.avgArea = bucket.masks.reduce((s, m) => s + m.areaPercent, 0) / bucket.masks.length;
          bucket.bestScore = Math.max(bucket.bestScore, mask.score);
          placed = true;
          break;
        }
      }
      if (!placed) {
        buckets.push({ masks: [mask], avgArea: mask.areaPercent, bestScore: mask.score });
      }
    }
    buckets.sort((a, b) => b.masks.length - a.masks.length);

    // Pre-compute properties for each bucket
    for (const b of buckets) {
      b.masks.sort((a, b2) => b2.score - a.score);
      b.repMask = b.masks[0];
      b.bbox = computeMaskBbox(b.repMask.data, b.repMask.w, b.repMask.h);
      b.totalVotes = b.masks.length;
      b.edgeTouches = countEdgeTouches(b.repMask.data, b.repMask.w, b.repMask.h);
      const bbArea = Math.max(1, b.bbox.w * b.bbox.h);
      const imgArea = Math.max(1, b.repMask.w * b.repMask.h);
      b.compactness = b.repMask.area / bbArea;
      b.bboxCoverage = bbArea / imgArea;
      b.isMeshLike = b.bboxCoverage > 0.85 && b.compactness < 0.55;
    }
    const totalVotes = buckets.reduce((s, b) => s + b.totalVotes, 0) || 1;

    // -----------------------------------------------
    // Score buckets for SHEET detection
    // -----------------------------------------------
    const MAX_HIDE_AREA = 65;
    const MIN_HIDE_AREA = 3;
    const scored = buckets.map(b => {
      const voteShare = b.totalVotes / totalVotes;
      const sizeOk = b.avgArea >= MIN_HIDE_AREA && b.avgArea <= MAX_HIDE_AREA;
      const sizePenalty = !sizeOk ? -1 : 0;
      const _bw = b.repMask.w, _bh = b.repMask.h;
      const sigEdgeW = _bw * 0.25, sigEdgeH = _bh * 0.25;
      let edgePenalty = 0, heavyEdges = 0;
      if (b.edgeTouches.top > sigEdgeW) heavyEdges++;
      if (b.edgeTouches.bottom > sigEdgeW) heavyEdges++;
      if (b.edgeTouches.left > sigEdgeH) heavyEdges++;
      if (b.edgeTouches.right > sigEdgeH) heavyEdges++;
      if (heavyEdges >= 3) edgePenalty = -2.0;
      else if (heavyEdges === 2) edgePenalty = -0.6;
      else if (heavyEdges === 1) edgePenalty = -0.15;

      let containsCount = 0, containedPixelRatio = 0;
      for (const other of buckets) {
        if (other === b || other.avgArea >= b.avgArea) continue;
        const ratio = maskContains(b.repMask, other.repMask);
        if (ratio > 0.7) { containsCount++; containedPixelRatio += other.avgArea; }
      }
      const containmentBonus = containsCount > 0
        ? Math.min(0.4, containsCount * 0.15 + containedPixelRatio / 100) : 0;
      const samScore = Math.min(1, b.bestScore || 0);
      let shapePenalty = 0;
      if (b.isMeshLike) shapePenalty -= 0.8;
      else if (b.compactness < 0.4) shapePenalty -= 0.3;
      const shapeBonus = b.compactness >= 0.5 && b.compactness <= 0.85 ? 0.15 : 0;

      // Feature #4: tableOverlapPenalty — penalize buckets overlapping with known table mask
      let tableOverlapPenalty = 0;
      if (this.#tableMask) {
        const tm = this.#tableMask;
        const rep = b.repMask;
        if (tm.w === rep.w && tm.h === rep.h) {
          let overlapPx = 0, bucketPx = 0;
          for (let p = 0; p < rep.data.length; p++) {
            if (rep.data[p] > 0) { bucketPx++; if (tm.data[p] > 0) overlapPx++; }
          }
          const overlapRatio = bucketPx > 0 ? overlapPx / bucketPx : 0;
          if (overlapRatio > 0.75) tableOverlapPenalty = -3.0;
          else if (overlapRatio > 0.50) tableOverlapPenalty = -1.5;
        }
      }

      const composite = voteShare * 0.40 + samScore * 0.15 + containmentBonus * 0.20 +
                         shapeBonus + sizePenalty + edgePenalty + shapePenalty + tableOverlapPenalty;
      return { bucket: b, composite, voteShare, containmentBonus, edgePenalty, tableOverlapPenalty };
    });
    scored.sort((a, b) => b.composite - a.composite);

    let bestMask = null;
    let selectedBucket = null;
    if (scored.length && scored[0].composite > 0) {
      selectedBucket = scored[0].bucket;
    }

    // Fallback: invert the largest mask
    if (!selectedBucket && buckets.length) {
      const bucketsByArea = [...buckets].sort((a, b) => b.avgArea - a.avgArea);
      this.#log('No viable sheet — inverting largest mask', 'warn');
      const bgMask = bucketsByArea[0].repMask;
      const inverted = new Float32Array(bgMask.data.length);
      let invArea = 0;
      for (let p = 0; p < bgMask.data.length; p++) {
        inverted[p] = bgMask.data[p] > 0 ? 0 : 1;
        if (inverted[p] > 0) invArea++;
      }
      bestMask = {
        data: inverted, w: bgMask.w, h: bgMask.h,
        area: invArea, areaPercent: (invArea / bgMask.data.length) * 100,
        score: bgMask.score
      };
    }

    if (!bestMask && selectedBucket) {
      bestMask = selectedBucket.repMask;
      this.#log(`Sheet: ${selectedBucket.avgArea.toFixed(1)}%, ${selectedBucket.totalVotes} votes`);
    }

    // -----------------------------------------------
    // Adjacency-based union for multi-region hides
    // Feature #5: background overlap guard in merge
    // -----------------------------------------------
    if (bestMask && selectedBucket) {
      const W = bestMask.w, H = bestMask.h;
      const merged = new Float32Array(bestMask.data.length);
      for (let i = 0; i < merged.length; i++) merged[i] = bestMask.data[i] > 0 ? 1 : 0;
      const dilateRadius = Math.max(8, Math.round(Math.min(W, H) * 0.05));
      const dilated = dilateMask(merged, W, H, dilateRadius);
      let mergedCount = 0;
      const MIN_MERGE_VOTES = Math.max(4, Math.ceil(selectedBucket.totalVotes * 0.25));

      // Identify background bucket (largest area >70%)
      const bgBucket = [...buckets].sort((a, b) => b.avgArea - a.avgArea)[0];
      const bgMaskRef = bgBucket && bgBucket !== selectedBucket && bgBucket.avgArea > 70
        ? bgBucket.repMask : null;

      for (const other of buckets) {
        if (other === selectedBucket) continue;
        if (other.avgArea > 70 || other.totalVotes < MIN_MERGE_VOTES || other.isMeshLike) continue;

        // Skip buckets that overlap heavily with the background (table/frame)
        if (bgMaskRef && other.repMask.w === bgMaskRef.w && other.repMask.h === bgMaskRef.h) {
          let bgOvlp = 0, oTotal = 0;
          for (let p = 0; p < other.repMask.data.length; p++) {
            if (other.repMask.data[p] > 0) { oTotal++; if (bgMaskRef.data[p] > 0) bgOvlp++; }
          }
          if (oTotal > 0 && bgOvlp / oTotal > 0.70) {
            this.#log(`Merge skip: ${other.avgArea.toFixed(1)}% bucket overlaps ${((bgOvlp / oTotal) * 100).toFixed(0)}% with background`);
            continue;
          }
        }

        // Also skip if tableMask is known and overlaps heavily
        if (this.#tableMask && this.#tableMask.w === other.repMask.w && this.#tableMask.h === other.repMask.h) {
          let tOvlp = 0, tTotal = 0;
          for (let p = 0; p < other.repMask.data.length; p++) {
            if (other.repMask.data[p] > 0) { tTotal++; if (this.#tableMask.data[p] > 0) tOvlp++; }
          }
          if (tTotal > 0 && tOvlp / tTotal > 0.6) continue;
        }

        let overlapPixels = 0, siblingPixels = 0, coreInOther = 0, corePixels = 0;
        for (let i = 0; i < dilated.length; i++) {
          const inOther = other.repMask.data[i] > 0;
          const inDilated = dilated[i] > 0;
          const inCore = merged[i] > 0;
          if (inOther) { siblingPixels++; if (inDilated) overlapPixels++; }
          if (inCore) { corePixels++; if (inOther) coreInOther++; }
        }
        const overlapRatio = siblingPixels > 0 ? overlapPixels / siblingPixels : 0;
        const supersetRatio = corePixels > 0 ? coreInOther / corePixels : 0;
        const isAdjacent = overlapRatio > 0.4 && other.avgArea < selectedBucket.avgArea * 3.5;
        const isSuperset = supersetRatio > 0.85 && other.avgArea > selectedBucket.avgArea &&
                           other.totalVotes >= selectedBucket.totalVotes && other.compactness >= 0.5;
        const isOverlap = overlapRatio > 0.2 && other.avgArea < 50;
        if (isAdjacent || isSuperset || isOverlap) {
          for (let i = 0; i < merged.length; i++) {
            if (other.repMask.data[i] > 0) merged[i] = 1;
          }
          mergedCount++;
        }
      }
      if (mergedCount > 0) {
        morphClose(merged, W, H, 2);
        let newArea = 0;
        for (let i = 0; i < merged.length; i++) if (merged[i] > 0) newArea++;
        bestMask = {
          data: merged, w: W, h: H,
          area: newArea, areaPercent: (newArea / merged.length) * 100,
          score: bestMask.score
        };
        this.#log(`Merged ${mergedCount} adjacent regions`);
      }
    }

    if (!bestMask) {
      this.#log('No sheet detected', 'warn');
      return { polygon: [], holes: [], areaPx: 0, mask: { data: new Uint8Array(0), w: 0, h: 0 } };
    }

    // -----------------------------------------------
    // Upscale mask to original image resolution
    // -----------------------------------------------
    this.#progress(0.85);
    const { data: maskArray, w: maskW, h: maskH } = bestMask;
    const upscaledMask = upscaleMaskBilinear(maskArray, maskW, maskH, imgW, imgH);
    morphClose(upscaledMask, imgW, imgH, 2);

    // -----------------------------------------------
    // Feature #3: Refine sheet mask by color
    // Carves out outlier brightness regions from the mask
    // -----------------------------------------------
    const srcPixelData = srcCtx.getImageData(0, 0, imgW, imgH).data;
    await this.#refineSheetMaskByColor(upscaledMask, imgW, imgH, srcPixelData);

    // -----------------------------------------------
    // Find holes (interior OFF regions not touching edges)
    // -----------------------------------------------
    this.#log('Detecting holes...');
    const holeContours = findHoles(upscaledMask, imgW, imgH, holeMinPercent);
    this.#log(`Found ${holeContours.length} hole(s)`);

    // -----------------------------------------------
    // Extract outer contour (with scan fallback per cncVisionPRO_B line 1361)
    // -----------------------------------------------
    let outerContour = maskToContourMarching(upscaledMask, imgW, imgH);
    if (outerContour.length < 10) outerContour = maskToContourScan(upscaledMask, imgW, imgH);
    outerContour = smoothContour(outerContour, 2);
    let simplified = rdpSimplifyXY(outerContour, epsilon);
    // Safety: retry with smaller epsilon if over-simplified
    if (outerContour.length > 100 && simplified.length < 8) {
      for (const eps of [epsilon * 0.5, epsilon * 0.25, 0.5]) {
        const retry = rdpSimplifyXY(outerContour, eps);
        if (retry.length >= 12) { simplified = retry; break; }
      }
    }

    // Convert to [[x,y],...] format
    const polygon = simplified.map(p => [p.x, p.y]);

    // Process holes
    const holes = holeContours.map(h => {
      const pts = rdpSimplifyXY(smoothContour(h.contour, 2), epsilon);
      return { points: pts.map(p => [p.x, p.y]), area: h.area, isDamage: false };
    });

    // Damage mark detection
    if (detectDamageMarks) {
      this.#log('Scanning for damage marks...');
      const damageHoles = this.#detectDamageMarks(
        upscaledMask, imgW, imgH, damageSensitivity, srcPixelData, epsilon, damageMinPercent
      );
      for (const d of damageHoles) {
        holes.push(d);
      }
      if (damageHoles.length > 0) {
        this.#log(`Added ${damageHoles.length} damage mark(s) as exclusion zones`);
      }
    }

    // Compute total mask area in pixels
    let areaPx = 0;
    for (let i = 0; i < upscaledMask.length; i++) {
      if (upscaledMask[i]) areaPx++;
    }

    this.#progress(1.0);
    this.#log(`Detection complete: ${polygon.length} vertices, ${holes.length} holes`);

    // Store for later use by rectifyAndDetect, export, etc.
    this.#lastPolygon = polygon;
    this.#lastHoles = holes;

    return {
      polygon,
      holes,
      areaPx,
      mask: { data: upscaledMask, w: imgW, h: imgH }
    };
  }

  /**
   * Feature #3: refineSheetMaskByColor()
   * Samples brightness of the detected sheet mask, finds outlier regions
   * (dark patches below median-MAD*2, bright patches above median+30),
   * flood-fills connected outlier regions, and carves them from the mask
   * if they exceed 0.3% of total area.
   */
  async #refineSheetMaskByColor(mask, w, h, pixelData) {
    const px = pixelData;

    // Sample brightness of ON pixels
    const vals = [];
    let totalOnPixels = 0;
    const step = Math.max(1, Math.floor(Math.sqrt(w * h / 50000)));
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = y * w + x;
        if (!mask[i]) continue;
        totalOnPixels++;
        const idx = i * 4;
        vals.push(0.299 * px[idx] + 0.587 * px[idx + 1] + 0.114 * px[idx + 2]);
      }
    }
    if (vals.length < 200) return;

    vals.sort((a, b) => a - b);
    const median = vals[Math.floor(vals.length / 2)];
    const q1 = vals[Math.floor(vals.length * 0.25)];
    const q3 = vals[Math.floor(vals.length * 0.75)];
    const iqr = q3 - q1;

    // Thresholds for outlier regions (IQR-based)
    const loThresh = median - Math.max(25, iqr * 2);
    const hiThresh = median + Math.max(25, iqr * 2);
    this.#log(`Mask refine: median=${median.toFixed(0)}, IQR=${iqr.toFixed(1)}, lo=${loThresh.toFixed(0)}, hi=${hiThresh.toFixed(0)}`);

    // Mark outlier pixels within the sheet mask
    // Skip pixels inside calibration paper region if already calibrated
    const paperPoly = this.#calibration && this.#calibration.paperCorners || null;
    const outlierMask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        if (paperPoly && pointInPolygon({ x, y }, paperPoly)) continue;
        const idx = i * 4;
        const br = 0.299 * px[idx] + 0.587 * px[idx + 1] + 0.114 * px[idx + 2];
        if (br < loThresh || br > hiThresh) outlierMask[i] = 1;
      }
      if (y % 200 === 0) await new Promise(r => setTimeout(r, 0));
    }

    // Morphological close to merge nearby pixels into regions
    morphClose(outlierMask, w, h, 4);

    // Flood fill to find connected outlier regions
    const labels = new Int32Array(w * h);
    let nextLabel = 1;
    const regionInfo = [];
    const stack = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!outlierMask[i] || labels[i]) continue;
        const lbl = nextLabel++;
        let count = 0, touchesMaskEdge = false;
        stack.length = 0;
        stack.push(i);
        labels[i] = lbl;
        while (stack.length) {
          const p = stack.pop();
          count++;
          const py = (p / w) | 0, px2 = p - py * w;
          if (px2 > 0 && !mask[p - 1]) touchesMaskEdge = true;
          if (px2 < w - 1 && !mask[p + 1]) touchesMaskEdge = true;
          if (py > 0 && !mask[p - w]) touchesMaskEdge = true;
          if (py < h - 1 && !mask[p + w]) touchesMaskEdge = true;
          const nbrs = [
            px2 > 0 ? p - 1 : -1, px2 < w - 1 ? p + 1 : -1,
            py > 0 ? p - w : -1, py < h - 1 ? p + w : -1,
          ];
          for (const np of nbrs) {
            if (np >= 0 && outlierMask[np] && !labels[np]) {
              labels[np] = lbl;
              stack.push(np);
            }
          }
        }
        regionInfo.push({ label: lbl, area: count, touchesMaskEdge });
      }
    }

    // Only carve out interior regions (don't touch the sheet edges)
    // and with significant size (>0.3% of mask area)
    const maskArea = totalOnPixels * step * step;
    const minCarvePixels = maskArea * 0.003;
    let carved = 0;
    for (const region of regionInfo) {
      if (region.touchesMaskEdge) continue;
      if (region.area < minCarvePixels) continue;
      for (let i = 0; i < labels.length; i++) {
        if (labels[i] === region.label) mask[i] = 0;
      }
      carved++;
      this.#log(`  Carved region: ${region.area}px (${((region.area / maskArea) * 100).toFixed(1)}% of sheet)`);
    }
    // Second pass: detect bright patches (e.g. white material on gray sheet).
    // Uses a tighter threshold than the general outlier pass — any region
    // whose mean brightness exceeds the sheet median by >30 and covers >0.5%
    // of the mask is carved out as a hole.
    const brightThresh = median + 30;
    if (brightThresh < 255) {
      const brightMask = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (!mask[i]) continue;
          if (paperPoly && pointInPolygon({ x, y }, paperPoly)) continue;
          const idx = i * 4;
          const br = 0.299 * px[idx] + 0.587 * px[idx + 1] + 0.114 * px[idx + 2];
          if (br > brightThresh) brightMask[i] = 1;
        }
      }
      morphClose(brightMask, w, h, 5);
      const bLabels = new Int32Array(w * h);
      let bNext = 1;
      const bRegions = [];
      const bStack = [];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (!brightMask[i] || bLabels[i]) continue;
          const lbl = bNext++;
          let cnt = 0, touchEdge = false;
          bStack.length = 0;
          bStack.push(i);
          bLabels[i] = lbl;
          while (bStack.length) {
            const p = bStack.pop();
            cnt++;
            const py = (p / w) | 0, px2 = p - py * w;
            if (px2 > 0 && !mask[p - 1]) touchEdge = true;
            if (px2 < w - 1 && !mask[p + 1]) touchEdge = true;
            if (py > 0 && !mask[p - w]) touchEdge = true;
            if (py < h - 1 && !mask[p + w]) touchEdge = true;
            const nbrs = [
              px2 > 0 ? p - 1 : -1, px2 < w - 1 ? p + 1 : -1,
              py > 0 ? p - w : -1, py < h - 1 ? p + w : -1,
            ];
            for (const np of nbrs) {
              if (np >= 0 && brightMask[np] && !bLabels[np]) {
                bLabels[np] = lbl;
                bStack.push(np);
              }
            }
          }
          bRegions.push({ label: lbl, area: cnt, touchEdge });
        }
      }
      const minBrightPixels = maskArea * 0.005;
      for (const region of bRegions) {
        if (region.touchEdge) continue;
        if (region.area < minBrightPixels) continue;
        for (let i = 0; i < bLabels.length; i++) {
          if (bLabels[i] === region.label) mask[i] = 0;
        }
        carved++;
        this.#log(`  Carved bright patch: ${region.area}px (${((region.area / maskArea) * 100).toFixed(1)}% of sheet)`);
      }
    }

    if (carved > 0) this.#log(`Color refinement: carved ${carved} region(s) from mask (incl. bright patches)`);
  }

  /**
   * Internal: detect dark marks (chalk/pencil/marker) on the sheet surface.
   */
  #detectDamageMarks(sheetMask, w, h, sensitivity, pixelData, epsilon, damageMinPercent = 0) {
    const totalArea = w * h;
    const minMarkPixels = Math.max(50, (damageMinPercent / 100) * totalArea);
    const px = pixelData;

    // Collect brightness of ON-mask pixels
    const sheetBrightness = [];
    for (let i = 0; i < w * h; i++) {
      if (!sheetMask[i]) continue;
      const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
      sheetBrightness.push(0.299 * r + 0.587 * g + 0.114 * b);
    }
    if (sheetBrightness.length < 100) return [];

    sheetBrightness.sort((a, b) => a - b);
    const median = sheetBrightness[Math.floor(sheetBrightness.length / 2)];
    const deviations = sheetBrightness.map(v => Math.abs(v - median));
    deviations.sort((a, b) => a - b);
    const mad = Math.max(5, deviations[Math.floor(deviations.length / 2)]);

    const factor = 1.5 + (100 - sensitivity) / 25;
    const darkThreshold = median - factor * mad;

    // Build binary mask of dark marks within the sheet
    const markMask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (!sheetMask[i]) continue;
      const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
      const br = 0.299 * r + 0.587 * g + 0.114 * b;
      if (br < darkThreshold) markMask[i] = 1;
    }

    morphClose(markMask, w, h, 3);

    // Flood-fill to find connected regions
    const labels = new Int32Array(w * h);
    let nextLabel = 1;
    const regions = [];
    const stack = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (!markMask[idx] || labels[idx]) continue;
        const lbl = nextLabel++;
        let count = 0;
        stack.length = 0;
        stack.push(idx);
        labels[idx] = lbl;
        while (stack.length) {
          const p = stack.pop();
          count++;
          const py = (p / w) | 0, px2 = p - py * w;
          if (px2 > 0 && markMask[p - 1] && !labels[p - 1]) { labels[p - 1] = lbl; stack.push(p - 1); }
          if (px2 < w - 1 && markMask[p + 1] && !labels[p + 1]) { labels[p + 1] = lbl; stack.push(p + 1); }
          if (py > 0 && markMask[p - w] && !labels[p - w]) { labels[p - w] = lbl; stack.push(p - w); }
          if (py < h - 1 && markMask[p + w] && !labels[p + w]) { labels[p + w] = lbl; stack.push(p + w); }
        }
        regions.push({ label: lbl, area: count });
      }
    }

    const marks = [];
    for (const region of regions) {
      if (region.area < minMarkPixels) continue;
      const rMask = new Uint8Array(w * h);
      for (let i = 0; i < labels.length; i++) {
        if (labels[i] === region.label) rMask[i] = 1;
      }
      const dilated = dilateMask(rMask, w, h, 3);
      for (let i = 0; i < dilated.length; i++) {
        if (!sheetMask[i]) dilated[i] = 0;
      }
      const contour = maskToContourMarching(dilated, w, h);
      if (contour.length >= 6) {
        const pts = rdpSimplifyXY(smoothContour(contour, 2), epsilon);
        marks.push({ points: pts.map(p => [p.x, p.y]), area: region.area, isDamage: true });
      }
    }
    marks.sort((a, b) => b.area - a.area);
    return marks;
  }

  /**
   * Calibrate using 4 corner points of a known rectangle.
   * @param {{x:number, y:number}[]} points - 4 corner points in image pixels [TL, TR, BR, BL]
   * @param {number} knownW - Known width of the rectangle in mm
   * @param {number} knownH - Known height of the rectangle in mm
   * @returns {{homography: number[][], pixelsPerMm: number}}
   */
  async calibrate(points, knownW, knownH) {
    if (!points || points.length !== 4) {
      throw new Error('Exactly 4 corner points required');
    }

    const dstPts = [
      { x: 0, y: 0 },
      { x: knownW, y: 0 },
      { x: knownW, y: knownH },
      { x: 0, y: knownH }
    ];

    const H = computeHomography(points, dstPts);
    if (!H) {
      throw new Error('Failed to compute homography (degenerate points)');
    }

    // Calculate pixelsPerMm from edge lengths
    const edgeA = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
    const edgeB = Math.hypot(points[2].x - points[1].x, points[2].y - points[1].y);
    const edgeC = Math.hypot(points[3].x - points[2].x, points[3].y - points[2].y);
    const edgeD = Math.hypot(points[0].x - points[3].x, points[0].y - points[3].y);
    const avgPixelW = (edgeA + edgeC) / 2;
    const avgPixelH = (edgeB + edgeD) / 2;
    const pixelsPerMm = ((avgPixelW / knownW) + (avgPixelH / knownH)) / 2;

    this.#calibration = { homography: H, pixelsPerMm, points, paperCorners: points };
    this.#log(`Calibrated: ${pixelsPerMm.toFixed(3)} px/mm`);

    return { homography: H, pixelsPerMm };
  }

  /**
   * Get the current calibration data.
   * @returns {{homography: number[][], pixelsPerMm: number}|null}
   */
  getCalibration() {
    return this.#calibration;
  }

  resetCalibration() {
    this.#calibration = null;
  }

  /**
   * Convert a pixel polygon ([[x,y],...]) to mm using current calibration.
   * @param {number[][]} polygon - Array of [x, y] vertices in pixels
   * @returns {number[][]|null} Array of [x, y] in mm, or null if not calibrated
   */
  polygonToMm(polygon) {
    if (!this.#calibration) return null;
    const H = this.#calibration.homography;
    if (H) {
      return polygon.map(([x, y]) => {
        const p = applyHomography(H, x, y);
        return [p.x, p.y];
      });
    }
    const ppm = this.#calibration.pixelsPerMm;
    if (ppm) {
      return polygon.map(([x, y]) => [x / ppm, y / ppm]);
    }
    return null;
  }

  // ============================================================
  // Feature #6: autoDetectPaper()
  // Auto-calibration: detect white paper rectangle in image
  // ============================================================

  /**
   * Automatically detect a white/bright paper rectangle for calibration.
   * @param {HTMLImageElement|HTMLCanvasElement|File} imageSource
   * @param {object} options
   * @param {number} options.paperW - Known paper width in mm
   * @param {number} options.paperH - Known paper height in mm
   * @returns {Promise<{corners: {x,y}[], calibration: {homography, pixelsPerMm}}|null>}
   */
  async autoDetectPaper(imageSource, options = {}) {
    const { paperW = 297, paperH = 210 } = options;
    const targetAspect = Math.max(paperW, paperH) / Math.min(paperW, paperH);

    const { canvas, w: imgW, h: imgH } = await imageSourceToCanvas(imageSource);

    // Work at reduced resolution for speed
    const scale = Math.min(1, 800 / Math.max(imgW, imgH));
    const sw = Math.round(imgW * scale);
    const sh = Math.round(imgH * scale);
    const workCanvas = document.createElement('canvas');
    workCanvas.width = sw;
    workCanvas.height = sh;
    const wctx = workCanvas.getContext('2d', { willReadFrequently: true });
    wctx.drawImage(canvas, 0, 0, imgW, imgH, 0, 0, sw, sh);
    const imgData = wctx.getImageData(0, 0, sw, sh);
    const px = imgData.data;

    // Step 1: Compute brightness statistics
    let sumBr = 0, count = 0;
    const brightness = new Float32Array(sw * sh);
    for (let i = 0; i < sw * sh; i++) {
      const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
      const br = 0.299 * r + 0.587 * g + 0.114 * b;
      brightness[i] = br;
      sumBr += br;
      count++;
    }
    const meanBr = sumBr / count;

    // Multi-pass threshold scanning
    const thresholdPasses = [
      { br: Math.max(180, meanBr + 40), sat: 0.3, fill: 0.55 },
      { br: Math.max(160, meanBr + 25), sat: 0.35, fill: 0.50 },
      { br: Math.max(140, meanBr + 15), sat: 0.40, fill: 0.45 },
    ];

    let bestLbl = -1, bestSz = 0, bestCandScore = -1, labels = null;

    for (const pass of thresholdPasses) {
      this.#log(`Paper scan: brightness>=${pass.br.toFixed(0)}, sat<${pass.sat}, fill>${pass.fill}`);

      const binaryMask = new Uint8Array(sw * sh);
      for (let i = 0; i < sw * sh; i++) {
        const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
        const maxC = Math.max(r, g, b);
        const minC = Math.min(r, g, b);
        const sat = maxC > 0 ? (maxC - minC) / maxC : 0;
        binaryMask[i] = (brightness[i] >= pass.br && sat < pass.sat) ? 1 : 0;
      }

      morphClose(binaryMask, sw, sh, 3);

      labels = new Int32Array(sw * sh);
      let nextLabel = 1;
      const compSizes = [0];
      const stack = [];
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
          const idx = y * sw + x;
          if (!binaryMask[idx] || labels[idx]) continue;
          const lbl = nextLabel++;
          let sz = 0;
          stack.length = 0;
          stack.push(idx);
          labels[idx] = lbl;
          while (stack.length) {
            const p = stack.pop();
            sz++;
            const py = (p / sw) | 0, px2 = p - py * sw;
            if (px2 > 0 && binaryMask[p - 1] && !labels[p - 1]) { labels[p - 1] = lbl; stack.push(p - 1); }
            if (px2 < sw - 1 && binaryMask[p + 1] && !labels[p + 1]) { labels[p + 1] = lbl; stack.push(p + 1); }
            if (py > 0 && binaryMask[p - sw] && !labels[p - sw]) { labels[p - sw] = lbl; stack.push(p - sw); }
            if (py < sh - 1 && binaryMask[p + sw] && !labels[p + sw]) { labels[p + sw] = lbl; stack.push(p + sw); }
          }
          compSizes.push(sz);
        }
      }

      const imgArea = sw * sh;
      const candidates = [];
      for (let i = 1; i < compSizes.length; i++) {
        const pct = (compSizes[i] / imgArea) * 100;
        if (pct < 0.5 || pct > 30) continue;
        let bx1 = sw, by1 = sh, bx2 = 0, by2 = 0;
        for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
          if (labels[y * sw + x] === i) {
            if (x < bx1) bx1 = x; if (x > bx2) bx2 = x;
            if (y < by1) by1 = y; if (y > by2) by2 = y;
          }
        }
        const bboxW2 = Math.max(1, bx2 - bx1);
        const bboxH2 = Math.max(1, by2 - by1);
        const bboxArea = bboxW2 * bboxH2;
        const fillRatio = compSizes[i] / bboxArea;
        if (fillRatio < pass.fill) continue;
        candidates.push({ lbl: i, sz: compSizes[i], fillRatio });
      }
      candidates.sort((a, b) => (b.sz * b.fillRatio) - (a.sz * a.fillRatio));

      for (const cand of candidates.slice(0, 5)) {
        const paperMask = new Uint8Array(sw * sh);
        for (let j = 0; j < labels.length; j++) paperMask[j] = labels[j] === cand.lbl ? 1 : 0;
        const boundaryPts = [];
        for (let y = 1; y < sh - 1; y++) {
          for (let x = 1; x < sw - 1; x++) {
            const idx = y * sw + x;
            if (!paperMask[idx]) continue;
            if (!paperMask[idx - 1] || !paperMask[idx + 1] || !paperMask[idx - sw] || !paperMask[idx + sw])
              boundaryPts.push({ x, y });
          }
        }
        if (boundaryPts.length < 20) continue;
        const hull = convexHull(boundaryPts);
        let rectCorners = findQuadCorners(hull);
        if (!rectCorners) rectCorners = minAreaRect(hull);
        if (!rectCorners) continue;

        const sc = sortCornersClockwise(rectCorners);
        const eA = Math.hypot(sc[1].x - sc[0].x, sc[1].y - sc[0].y);
        const eB = Math.hypot(sc[2].x - sc[1].x, sc[2].y - sc[1].y);
        const eC = Math.hypot(sc[3].x - sc[2].x, sc[3].y - sc[2].y);
        const eD = Math.hypot(sc[0].x - sc[3].x, sc[0].y - sc[3].y);
        const aW = (eA + eC) / 2, aH = (eB + eD) / 2;
        const edgeAspect = Math.max(aW, aH) / Math.min(aW, aH);
        const aspectDiff = Math.abs(edgeAspect - targetAspect);
        const candScore = cand.sz * cand.fillRatio * Math.max(0.01, 1 - aspectDiff * 2);
        if (aspectDiff > 0.4) continue;
        if (candScore > bestCandScore) {
          bestCandScore = candScore;
          bestLbl = cand.lbl;
          bestSz = cand.sz;
        }
      }
      if (bestLbl >= 0) break;
    }

    let sorted = null;

    if (bestLbl >= 0) {
      this.#log(`Paper candidate: ${((bestSz / (sw * sh)) * 100).toFixed(1)}% of image`);

      const paperMask = new Uint8Array(sw * sh);
      for (let i = 0; i < labels.length; i++) paperMask[i] = labels[i] === bestLbl ? 1 : 0;

      const boundaryPts = [];
      for (let y = 1; y < sh - 1; y++) {
        for (let x = 1; x < sw - 1; x++) {
          const idx = y * sw + x;
          if (!paperMask[idx]) continue;
          if (!paperMask[idx - 1] || !paperMask[idx + 1] || !paperMask[idx - sw] || !paperMask[idx + sw]) {
            boundaryPts.push({ x, y });
          }
        }
      }

      if (boundaryPts.length >= 20) {
        const hull = convexHull(boundaryPts);
        let rectCorners = findQuadCorners(hull);
        if (!rectCorners) {
          this.#log('Quad corner detection failed, falling back to bounding rect', 'warn');
          rectCorners = minAreaRect(hull);
        }
        if (rectCorners) {
          const imgCorners = rectCorners.map(p => ({ x: p.x / scale, y: p.y / scale }));
          sorted = sortCornersClockwise(imgCorners);
        }
      }
    }

    // SAM fallback: if simple detection fails, try using SAM-detected holes
    if (!sorted && this.#lastHoles && this.#lastHoles.length > 0) {
      this.#log('Color detection failed — checking SAM-detected regions for paper...', 'warn');
      let bestHole = null, bestScore = -Infinity;
      const srcCtx = canvas.getContext('2d', { willReadFrequently: true });
      const fullPx = srcCtx.getImageData(0, 0, imgW, imgH).data;

      for (let hi = 0; hi < this.#lastHoles.length; hi++) {
        const hole = this.#lastHoles[hi];
        if (!hole.points || hole.points.length < 4) continue;
        const hullPts = hole.points.map(p => Array.isArray(p) ? { x: p[0], y: p[1] } : p);
        const hull = convexHull(hullPts);
        let corners = findQuadCorners(hull);
        if (!corners) corners = minAreaRect(hull);
        if (!corners) continue;

        const sc = sortCornersClockwise(corners);
        const eA = Math.hypot(sc[1].x - sc[0].x, sc[1].y - sc[0].y);
        const eB = Math.hypot(sc[2].x - sc[1].x, sc[2].y - sc[1].y);
        const eC = Math.hypot(sc[3].x - sc[2].x, sc[3].y - sc[2].y);
        const eD = Math.hypot(sc[0].x - sc[3].x, sc[0].y - sc[3].y);
        const avgW2 = (eA + eC) / 2;
        const avgH2 = (eB + eD) / 2;
        const aspect = Math.max(avgW2, avgH2) / Math.min(avgW2, avgH2);
        const aspectDiff = Math.abs(aspect - targetAspect);
        if (aspectDiff > 0.4) continue;

        // Sample mean brightness inside this hole region
        let brSum = 0, brCount = 0;
        const bbox = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
        const hPts = Array.isArray(hole.points[0]) ? hole.points.map(p => ({ x: p[0], y: p[1] })) : hole.points;
        for (const p of hPts) {
          if (p.x < bbox.x1) bbox.x1 = p.x;
          if (p.x > bbox.x2) bbox.x2 = p.x;
          if (p.y < bbox.y1) bbox.y1 = p.y;
          if (p.y > bbox.y2) bbox.y2 = p.y;
        }
        const sampleStep = Math.max(1, Math.round(Math.min(bbox.x2 - bbox.x1, bbox.y2 - bbox.y1) / 30));
        for (let y = Math.max(0, Math.round(bbox.y1)); y < Math.min(imgH, Math.round(bbox.y2)); y += sampleStep) {
          for (let x = Math.max(0, Math.round(bbox.x1)); x < Math.min(imgW, Math.round(bbox.x2)); x += sampleStep) {
            if (pointInPolygon({ x, y }, hPts)) {
              const idx = (y * imgW + x) * 4;
              brSum += 0.299 * fullPx[idx] + 0.587 * fullPx[idx + 1] + 0.114 * fullPx[idx + 2];
              brCount++;
            }
          }
        }
        if (brCount === 0) continue;
        const holeMeanBr = brSum / brCount;
        if (holeMeanBr < 150) continue;

        const score = holeMeanBr / 255 - aspectDiff;
        if (score > bestScore) {
          bestScore = score;
          bestHole = { corners: sc, index: hi };
        }
      }

      if (bestHole) {
        // Refine corners: run color-based edge detection within
        // the hole's bounding box for tighter paper alignment
        const hPtsRefine = this.#lastHoles[bestHole.index].points;
        const hPtsXY = Array.isArray(hPtsRefine[0])
          ? hPtsRefine.map(p => ({ x: p[0], y: p[1] }))
          : hPtsRefine;
        const hBbox = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
        for (const p of hPtsXY) {
          if (p.x < hBbox.x1) hBbox.x1 = p.x;
          if (p.x > hBbox.x2) hBbox.x2 = p.x;
          if (p.y < hBbox.y1) hBbox.y1 = p.y;
          if (p.y > hBbox.y2) hBbox.y2 = p.y;
        }
        const margin = Math.max(hBbox.x2 - hBbox.x1, hBbox.y2 - hBbox.y1) * 0.15;
        const rx1 = Math.max(0, Math.round(hBbox.x1 - margin));
        const ry1 = Math.max(0, Math.round(hBbox.y1 - margin));
        const rx2 = Math.min(imgW, Math.round(hBbox.x2 + margin));
        const ry2 = Math.min(imgH, Math.round(hBbox.y2 + margin));
        const rw = rx2 - rx1, rh = ry2 - ry1;

        let refinedCorners = null;
        if (rw > 20 && rh > 20) {
          const srcCtxRef = canvas.getContext('2d', { willReadFrequently: true });
          const regionData = srcCtxRef.getImageData(rx1, ry1, rw, rh);
          const rpx = regionData.data;
          const rBright = new Float32Array(rw * rh);
          for (let i = 0; i < rw * rh; i++) {
            rBright[i] = 0.299 * rpx[i * 4] + 0.587 * rpx[i * 4 + 1] + 0.114 * rpx[i * 4 + 2];
          }
          // Adaptive threshold: midpoint between the bright paper and dark sheet
          const brSorted = Array.from(rBright).sort((a, b) => a - b);
          const lo25 = brSorted[Math.floor(brSorted.length * 0.25)];
          const hi75 = brSorted[Math.floor(brSorted.length * 0.75)];
          const adaptiveThresh = (lo25 + hi75) / 2;
          const rBin = new Uint8Array(rw * rh);
          for (let i = 0; i < rw * rh; i++) {
            rBin[i] = rBright[i] >= adaptiveThresh ? 1 : 0;
          }
          morphClose(rBin, rw, rh, 3);
          // Find largest connected white region
          const rLabels = new Int32Array(rw * rh);
          let rNext = 1, rBestLbl = 0, rBestSz = 0;
          const rStack = [];
          const rSizes = [0];
          for (let y = 0; y < rh; y++) {
            for (let x = 0; x < rw; x++) {
              const idx = y * rw + x;
              if (!rBin[idx] || rLabels[idx]) continue;
              const lbl = rNext++;
              let sz = 0;
              rStack.length = 0;
              rStack.push(idx);
              rLabels[idx] = lbl;
              while (rStack.length) {
                const p = rStack.pop(); sz++;
                const py = (p / rw) | 0, px2 = p - py * rw;
                if (px2 > 0 && rBin[p - 1] && !rLabels[p - 1]) { rLabels[p - 1] = lbl; rStack.push(p - 1); }
                if (px2 < rw - 1 && rBin[p + 1] && !rLabels[p + 1]) { rLabels[p + 1] = lbl; rStack.push(p + 1); }
                if (py > 0 && rBin[p - rw] && !rLabels[p - rw]) { rLabels[p - rw] = lbl; rStack.push(p - rw); }
                if (py < rh - 1 && rBin[p + rw] && !rLabels[p + rw]) { rLabels[p + rw] = lbl; rStack.push(p + rw); }
              }
              rSizes.push(sz);
              if (sz > rBestSz) { rBestSz = sz; rBestLbl = lbl; }
            }
          }
          if (rBestSz > 100) {
            const rBoundary = [];
            for (let y = 1; y < rh - 1; y++) {
              for (let x = 1; x < rw - 1; x++) {
                const idx = y * rw + x;
                if (rLabels[idx] !== rBestLbl) continue;
                if (rLabels[idx - 1] !== rBestLbl || rLabels[idx + 1] !== rBestLbl ||
                    rLabels[idx - rw] !== rBestLbl || rLabels[idx + rw] !== rBestLbl) {
                  rBoundary.push({ x: x + rx1, y: y + ry1 });
                }
              }
            }
            if (rBoundary.length >= 20) {
              const rHull = convexHull(rBoundary);
              let rRect = findQuadCorners(rHull);
              if (!rRect) rRect = minAreaRect(rHull);
              if (rRect) {
                refinedCorners = sortCornersClockwise(rRect);
                this.#log('  Refined paper corners from color within SAM region');
              }
            }
          }
        }

        sorted = refinedCorners || bestHole.corners;
        this.#log(`Using SAM-detected region as paper (score: ${bestScore.toFixed(2)})`);
      }
    }

    if (!sorted) {
      this.#log('No paper detected by color or SAM analysis', 'warn');
      return null;
    }

    // Verify aspect ratio sanity
    const d01 = Math.hypot(sorted[1].x - sorted[0].x, sorted[1].y - sorted[0].y);
    const d12 = Math.hypot(sorted[2].x - sorted[1].x, sorted[2].y - sorted[1].y);
    const d23 = Math.hypot(sorted[3].x - sorted[2].x, sorted[3].y - sorted[2].y);
    const d30 = Math.hypot(sorted[0].x - sorted[3].x, sorted[0].y - sorted[3].y);
    const avgW = (d01 + d23) / 2;
    const avgH = (d12 + d30) / 2;
    const longSide = Math.max(avgW, avgH);
    const shortSide = Math.min(avgW, avgH);
    const aspectRatio = longSide / shortSide;
    if (aspectRatio < 1.05 || aspectRatio > 5.0) {
      this.#log(`Detected shape aspect ratio ${aspectRatio.toFixed(2)} — too extreme`, 'warn');
      return null;
    }

    // Determine orientation
    let knownW, knownH;
    if ((avgW >= avgH) === (paperW >= paperH)) {
      knownW = paperW; knownH = paperH;
    } else {
      knownW = paperH; knownH = paperW;
    }

    // Calibrate with the detected corners
    await this.calibrate(sorted, knownW, knownH);
    this.#log(`Auto-calibration success: ${knownW}x${knownH}mm paper detected`);

    return {
      corners: sorted,
      calibration: this.#calibration
    };
  }

  // ============================================================
  // Feature #7: detectCncTable()
  // SAM-based CNC table detection
  // ============================================================

  /**
   * Detect the CNC cutting table using SAM with strategic prompt points.
   * @param {HTMLImageElement|HTMLCanvasElement|File} imageSource
   * @param {object} options
   * @param {number} options.tableW - Table width in mm
   * @param {number} options.tableH - Table height in mm
   * @returns {Promise<{corners: {x,y}[], homography: number[][], mask: {data, w, h}}|null>}
   */
  async detectCncTable(imageSource, options = {}) {
    if (!this.#ready) throw new Error('Model not loaded — call loadModel() first');

    const { tableW = 600, tableH = 400 } = options;
    this.#log('Auto-detecting CNC table with SAM...');

    const tf = await loadTransformers();
    const { RawImage, Tensor } = tf;

    const { canvas: srcCanvas, w: imgW, h: imgH } = await imageSourceToCanvas(imageSource);

    const SAM_DIM = 1024;
    const resizeCanvas = document.createElement('canvas');
    resizeCanvas.width = SAM_DIM;
    resizeCanvas.height = SAM_DIM;
    const resizeCtx = resizeCanvas.getContext('2d');
    resizeCtx.imageSmoothingEnabled = true;
    resizeCtx.imageSmoothingQuality = 'high';
    resizeCtx.drawImage(srcCanvas, 0, 0, imgW, imgH, 0, 0, SAM_DIM, SAM_DIM);

    let imgData = resizeCtx.getImageData(0, 0, SAM_DIM, SAM_DIM);
    imgData = suppressSpecular(imgData);
    resizeCtx.putImageData(imgData, 0, 0);
    imgData = resizeCtx.getImageData(0, 0, SAM_DIM, SAM_DIM);

    const rgbaData = imgData.data;
    const pixelCount = SAM_DIM * SAM_DIM;
    const rgbData = new Uint8ClampedArray(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
      rgbData[i * 3] = rgbaData[i * 4];
      rgbData[i * 3 + 1] = rgbaData[i * 4 + 1];
      rgbData[i * 3 + 2] = rgbaData[i * 4 + 2];
    }
    const rawImage = new RawImage(rgbData, SAM_DIM, SAM_DIM, 3);
    const inputs = await this.#processor(rawImage);

    let imageEmbeddings;
    if (typeof this.#model.get_image_embeddings === 'function') {
      imageEmbeddings = await this.#model.get_image_embeddings(inputs);
    } else {
      imageEmbeddings = inputs;
    }

    // Strategic prompt points: edges + interior
    const m = 0.10;
    const tablePoints = [
      { x: SAM_DIM * 0.25, y: SAM_DIM * m }, { x: SAM_DIM * 0.50, y: SAM_DIM * m }, { x: SAM_DIM * 0.75, y: SAM_DIM * m },
      { x: SAM_DIM * 0.25, y: SAM_DIM * (1 - m) }, { x: SAM_DIM * 0.50, y: SAM_DIM * (1 - m) }, { x: SAM_DIM * 0.75, y: SAM_DIM * (1 - m) },
      { x: SAM_DIM * m, y: SAM_DIM * 0.25 }, { x: SAM_DIM * m, y: SAM_DIM * 0.50 }, { x: SAM_DIM * m, y: SAM_DIM * 0.75 },
      { x: SAM_DIM * (1 - m), y: SAM_DIM * 0.25 }, { x: SAM_DIM * (1 - m), y: SAM_DIM * 0.50 }, { x: SAM_DIM * (1 - m), y: SAM_DIM * 0.75 },
      { x: SAM_DIM * 0.25, y: SAM_DIM * 0.25 }, { x: SAM_DIM * 0.50, y: SAM_DIM * 0.25 }, { x: SAM_DIM * 0.75, y: SAM_DIM * 0.25 },
      { x: SAM_DIM * 0.25, y: SAM_DIM * 0.50 }, { x: SAM_DIM * 0.50, y: SAM_DIM * 0.50 }, { x: SAM_DIM * 0.75, y: SAM_DIM * 0.50 },
      { x: SAM_DIM * 0.25, y: SAM_DIM * 0.75 }, { x: SAM_DIM * 0.50, y: SAM_DIM * 0.75 }, { x: SAM_DIM * 0.75, y: SAM_DIM * 0.75 },
    ];
    this.#log(`Running ${tablePoints.length} table prompt points...`);

    const candidateMasks = [];
    for (const point of tablePoints) {
      try {
        const input_points = new Tensor('float32', [point.x, point.y], [1, 1, 1, 2]);
        const input_labels = new Tensor('int64', [1n], [1, 1, 1]);
        const outputs = await this.#model({ ...imageEmbeddings, input_points, input_labels });
        const scores = outputs.iou_scores.data;
        const numMasks = scores.length;
        const maskDims = outputs.pred_masks.dims;
        const maskH = maskDims[maskDims.length - 2];
        const maskW = maskDims[maskDims.length - 1];
        const maskSize = maskW * maskH;
        for (let mi = 0; mi < numMasks; mi++) {
          const score = Number(scores[mi]);
          if (score < 0.5) continue;
          const maskSlice = outputs.pred_masks.data.slice(mi * maskSize, (mi + 1) * maskSize);
          let area = 0;
          for (let p = 0; p < maskSize; p++) if (maskSlice[p] > 0) area++;
          const areaPercent = (area / maskSize) * 100;
          if (areaPercent < 25) continue;
          candidateMasks.push({ data: maskSlice, w: maskW, h: maskH, area, areaPercent, score });
        }
      } catch (e) { /* skip failed points */ }
    }
    this.#log(`Table SAM: ${candidateMasks.length} candidate masks collected`);

    if (candidateMasks.length === 0) {
      this.#log('No table detected', 'warn');
      return null;
    }

    // Group by area, select table bucket (30-80% area)
    const BUCKET_TOL = 8;
    const buckets = [];
    const sortedMasks = [...candidateMasks].sort((a, b) => b.areaPercent - a.areaPercent);
    for (const mask of sortedMasks) {
      let placed = false;
      for (const bucket of buckets) {
        if (Math.abs(mask.areaPercent - bucket.avgArea) < BUCKET_TOL) {
          bucket.masks.push(mask);
          bucket.avgArea = bucket.masks.reduce((s, m) => s + m.areaPercent, 0) / bucket.masks.length;
          bucket.bestScore = Math.max(bucket.bestScore, mask.score);
          placed = true;
          break;
        }
      }
      if (!placed) buckets.push({ masks: [mask], avgArea: mask.areaPercent, bestScore: mask.score });
    }

    buckets.sort((a, b) => b.avgArea - a.avgArea);
    let tableBucket = null;
    for (const b of buckets) {
      if (b.avgArea > 30 && b.avgArea <= 80) { tableBucket = b; break; }
    }
    if (!tableBucket) {
      this.#log('No mask in valid table area range (30-80%)', 'warn');
      return null;
    }

    const bestMask = tableBucket.masks[0];
    this.#log(`Table mask: ${bestMask.areaPercent.toFixed(1)}% area, score=${bestMask.score.toFixed(3)}`);

    // Upscale to image resolution
    const upscaled = upscaleMaskBilinear(bestMask.data, bestMask.w, bestMask.h, imgW, imgH);
    morphClose(upscaled, imgW, imgH, 3);

    // Store table mask at SAM resolution (for scoring) and full resolution (for overlay)
    this.#tableMask = { data: bestMask.data, w: bestMask.w, h: bestMask.h, areaPercent: bestMask.areaPercent };
    this.#tableMaskFull = { data: upscaled, w: imgW, h: imgH };

    // Extract contour and find 4 corners
    let contour = maskToContourMarching(upscaled, imgW, imgH);
    if (contour.length < 10) {
      this.#log('Table contour too short', 'warn');
      return null;
    }
    contour = smoothContour(contour, 3);
    const simplified = rdpSimplifyXY(contour, 3.0);
    const hull = convexHull(simplified);
    if (hull.length < 4) {
      this.#log('Table hull invalid', 'warn');
      return null;
    }
    const corners = findQuadCorners(hull);
    if (!corners || corners.length !== 4) {
      this.#log('Could not find 4 table corners', 'warn');
      return null;
    }
    const sortedCorners = sortCornersClockwise(corners);

    // Validate aspect ratio
    const topPx = Math.hypot(sortedCorners[1].x - sortedCorners[0].x, sortedCorners[1].y - sortedCorners[0].y);
    const botPx = Math.hypot(sortedCorners[2].x - sortedCorners[3].x, sortedCorners[2].y - sortedCorners[3].y);
    const leftPx = Math.hypot(sortedCorners[3].x - sortedCorners[0].x, sortedCorners[3].y - sortedCorners[0].y);
    const rightPx = Math.hypot(sortedCorners[2].x - sortedCorners[1].x, sortedCorners[2].y - sortedCorners[1].y);
    const avgWpx = (topPx + botPx) / 2;
    const avgHpx = (leftPx + rightPx) / 2;

    // Match orientation
    let knownW = tableW, knownH = tableH;
    if ((avgWpx >= avgHpx) !== (tableW >= tableH)) {
      knownW = tableH; knownH = tableW;
    }

    const dstPts = [
      { x: 0, y: 0 }, { x: knownW, y: 0 },
      { x: knownW, y: knownH }, { x: 0, y: knownH }
    ];
    const Ht = computeHomography(sortedCorners, dstPts);
    if (!Ht) {
      this.#log('Table homography failed', 'warn');
      return null;
    }

    this.#log(`Table detected: ${knownW}x${knownH}mm`);
    return {
      corners: sortedCorners,
      homography: Ht,
      widthMm: knownW,
      heightMm: knownH,
      mask: { data: upscaled, w: imgW, h: imgH }
    };
  }

  // ============================================================
  // Feature #8: rectifyAndDetect()
  // Perspective rectification + detection
  // ============================================================

  /**
   * Rectify the image to top-down view using calibration, then run detectHide.
   * @param {HTMLImageElement|HTMLCanvasElement|File} imageSource
   * @param {object} params - Same params as detectHide
   * @returns {Promise<{polygon, holes, areaPx, mask, rectified: {canvas, w, h, H_rect, H_rect_inv}}>}
   */
  async rectifyAndDetect(imageSource, params = {}) {
    if (!this.#ready) throw new Error('Model not loaded — call loadModel() first');
    if (!this.#calibration || !this.#calibration.homography || !this.#calibration.pixelsPerMm) {
      throw new Error('Calibrate first — rectification requires a calibration homography');
    }

    const { canvas: srcCanvas, w: imgW, h: imgH } = await imageSourceToCanvas(imageSource);

    // Build rectification transform
    this.#log('Building rectification transform...');
    const transform = buildRectificationTransform(this.#calibration, this.#lastPolygon);
    if (!transform || !transform.H_rect || !transform.H_rect_inv) {
      throw new Error('Failed to compute rectification homography');
    }

    const { H_rect, H_rect_inv, dstW, dstH } = transform;
    this.#log(`Warping image to ${dstW}x${dstH} rectified space...`);

    // Warp the source image to top-down view
    const rectCanvas = await warpImage(srcCanvas, H_rect_inv, dstW, dstH);

    // Run detection on the rectified image
    const result = await this.detectHide(rectCanvas, params);

    // Convert rectified pixels to mm directly (NOT via homography)
    // In rectified space, pixel coordinates are proportional to mm
    const { minX, minY, effScaleX, effScaleY } = transform;

    // The rectified pixel → mm mapping is:
    // mm_x = rectPixel_x / effScaleX + minX
    // mm_y = rectPixel_y / effScaleY + minY
    if (result.polygon) {
      result.polygon = result.polygon.map(([x, y]) => [
        x / effScaleX + minX,
        y / effScaleY + minY
      ]);
      if (result.holes) {
        result.holes = result.holes.map(h => {
          const newHole = { ...h };
          if (Array.isArray(newHole.points)) {
            newHole.points = newHole.points.map(([x, y]) => [
              x / effScaleX + minX,
              y / effScaleY + minY
            ]);
          } else if (Array.isArray(newHole)) {
            // It could be an array of arrays
            return newHole.map(([x, y]) => [
              x / effScaleX + minX,
              y / effScaleY + minY
            ]);
          }
          return newHole;
        });
      }
      result._isInMm = true;  // flag so app.js knows not to call polygonToMm again
    }

    return {
      ...result,
      rectified: {
        canvas: rectCanvas,
        w: dstW,
        h: dstH,
        H_rect,
        H_rect_inv
      }
    };
  }

  // ============================================================
  // Feature #9: Export methods
  // ============================================================

  /**
   * Export the detected hide polygon + holes as DXF.
   * @param {object} options
   * @param {number[][]} [options.polygon] - Override polygon (default: last detected)
   * @param {Array} [options.holes] - Override holes (default: last detected)
   * @returns {string} DXF file content
   */
  exportDXF(options = {}) {
    const polygon = options.polygon || this.#lastPolygon;
    const holes = options.holes || this.#lastHoles || [];
    if (!polygon || polygon.length < 3) throw new Error('No polygon to export');
    if (!this.#calibration) throw new Error('Calibrate first');

    const outerMm = this.polygonToMm(polygon);
    if (!outerMm) throw new Error('Calibration error');

    let maxY = -Infinity;
    for (const p of outerMm) if (p[1] > maxY) maxY = p[1];

    let dxf = '0\nSECTION\n2\nENTITIES\n';

    // Outer boundary
    dxf += '0\nLWPOLYLINE\n8\nSHEET_BOUNDARY\n62\n3\n70\n1\n';
    dxf += `90\n${outerMm.length}\n`;
    for (const p of outerMm) dxf += `10\n${p[0].toFixed(3)}\n20\n${(maxY - p[1]).toFixed(3)}\n`;

    // Each hole as separate polyline
    for (let hi = 0; hi < holes.length; hi++) {
      const hole = holes[hi];
      if (!hole.points || hole.points.length < 3) continue;
      const holeMm = this.polygonToMm(hole.points);
      if (!holeMm) continue;
      const layer = hole.isDamage ? `DAMAGE_${hi + 1}` : `HOLE_${hi + 1}`;
      const color = hole.isDamage ? 40 : 1;
      dxf += `0\nLWPOLYLINE\n8\n${layer}\n62\n${color}\n70\n1\n`;
      dxf += `90\n${holeMm.length}\n`;
      for (const p of holeMm) dxf += `10\n${p[0].toFixed(3)}\n20\n${(maxY - p[1]).toFixed(3)}\n`;
    }

    dxf += '0\nENDSEC\n0\nEOF\n';
    return dxf;
  }

  /**
   * Export the detected hide polygon + holes as SVG.
   * @param {object} options
   * @param {number[][]} [options.polygon] - Override polygon
   * @param {Array} [options.holes] - Override holes
   * @returns {string} SVG file content
   */
  exportSVG(options = {}) {
    const polygon = options.polygon || this.#lastPolygon;
    const holes = options.holes || this.#lastHoles || [];
    if (!polygon || polygon.length < 3) throw new Error('No polygon to export');
    if (!this.#calibration) throw new Error('Calibrate first');

    const outerMm = this.polygonToMm(polygon);
    if (!outerMm) throw new Error('Calibration error');

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of outerMm) {
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
    }
    const margin = 5;
    minX -= margin; minY -= margin; maxX += margin; maxY += margin;
    const svgW = maxX - minX, svgH = maxY - minY;

    const outerPath = outerMm.map((p, i) => `${i === 0 ? 'M' : 'L'}${(p[0] - minX).toFixed(2)},${(p[1] - minY).toFixed(2)}`).join(' ') + ' Z';

    let holePaths = '';
    for (const hole of holes) {
      if (!hole.points || hole.points.length < 3) continue;
      const holeMm = this.polygonToMm(hole.points);
      if (!holeMm) continue;
      const hStroke = hole.isDamage ? '#fa0' : '#f00';
      holePaths += '\n  <path d="' + holeMm.map((p, i) => `${i === 0 ? 'M' : 'L'}${(p[0] - minX).toFixed(2)},${(p[1] - minY).toFixed(2)}`).join(' ') + ` Z" fill="none" stroke="${hStroke}" stroke-width="0.3" stroke-dasharray="2,2"/>`;
    }

    const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${svgW.toFixed(1)}mm" height="${svgH.toFixed(1)}mm" viewBox="0 0 ${svgW.toFixed(1)} ${svgH.toFixed(1)}">\n  <path d="${outerPath}" fill="none" stroke="#000" stroke-width="0.5"/>${holePaths}\n</svg>`;
    return svg;
  }

  /**
   * Export the detected hide polygon + holes as JSON.
   * @param {object} options
   * @param {number[][]} [options.polygon] - Override polygon
   * @param {Array} [options.holes] - Override holes
   * @returns {string} JSON string
   */
  exportJSON(options = {}) {
    const polygon = options.polygon || this.#lastPolygon;
    const holes = options.holes || this.#lastHoles || [];
    if (!polygon || polygon.length < 3) throw new Error('No polygon to export');

    const outerMm = this.#calibration ? this.polygonToMm(polygon) : null;
    const calibrated = outerMm !== null;

    const data = {
      type: 'cncVisionPRO_remnant',
      unit: calibrated ? 'mm' : 'px',
      outerBoundary: (calibrated ? outerMm : polygon).map(p => ({ x: +p[0].toFixed(3), y: +p[1].toFixed(3) })),
      holes: holes.map(h => {
        const hMm = calibrated ? this.polygonToMm(h.points) : h.points;
        return {
          vertices: hMm ? hMm.map(p => ({ x: +p[0].toFixed(3), y: +p[1].toFixed(3) })) : [],
          areaMm2: calibrated && hMm ? +shoelaceArea(hMm.map(p => ({ x: p[0], y: p[1] }))).toFixed(3) : null,
          type: h.isDamage ? 'damage' : 'hole'
        };
      }),
      sheetAreaMm2: calibrated ? +shoelaceArea(outerMm.map(p => ({ x: p[0], y: p[1] }))).toFixed(3) : null,
      holeCount: holes.length,
    };
    return JSON.stringify(data, null, 2);
  }

  // ============================================================
  // Feature #10: pushToNesting()
  // ============================================================

  /**
   * Write polygon + holes + cncTable offset to IndexedDB PatternIQ_VisionPush store.
   * Y-flip applied for CAD convention (Y-up).
   * @param {object} options
   * @param {number[][]} [options.polygon] - Override polygon
   * @param {Array} [options.holes] - Override holes
   * @param {{tableWidth: number, tableHeight: number, materialOffsetX: number, materialOffsetY: number}|null} [options.cncTable]
   * @returns {Promise<void>}
   */
  async pushToNesting(options = {}) {
    const polygon = options.polygon || this.#lastPolygon;
    const holes = options.holes || this.#lastHoles || [];
    const cncTable = options.cncTable || null;

    if (!polygon || polygon.length < 3) throw new Error('No polygon — detect first');
    if (!this.#calibration) throw new Error('Calibrate first');

    const outerMm = this.polygonToMm(polygon);
    if (!outerMm) throw new Error('Calibration error');

    // Y-flip for CAD convention
    let maxY = -Infinity;
    for (const p of outerMm) if (p[1] > maxY) maxY = p[1];

    const pts = outerMm.map(p => [+p[0].toFixed(2), +(maxY - p[1]).toFixed(2)]);
    const holesMm = [];
    for (const h of holes) {
      if (h.isDamage || !h.points || h.points.length < 3) continue;
      const hMm = this.polygonToMm(h.points);
      if (hMm) holesMm.push(hMm.map(p => [+p[0].toFixed(2), +(maxY - p[1]).toFixed(2)]));
    }

    const rec = {
      id: 'hide',
      pts,
      holes: holesMm,
      cncTable: cncTable || null
    };

    return new Promise((resolve, reject) => {
      const req = indexedDB.open('PatternIQ_VisionPush', 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('hide')) db.createObjectStore('hide', { keyPath: 'id' });
      };
      req.onsuccess = e => {
        const db = e.target.result;
        const tx = db.transaction('hide', 'readwrite');
        tx.objectStore('hide').put(rec);
        tx.oncomplete = () => {
          this.#log('Pushed to NestingPro via IndexedDB');
          resolve();
        };
        tx.onerror = () => reject(new Error('Push failed'));
      };
      req.onerror = () => reject(new Error('Could not open push database'));
    });
  }
}
