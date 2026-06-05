// Pattern Digitizer module — wraps pattern digitization functionality from
// cadShot.html and patternDigitizer.html as a reusable ES module.
// Allows users to photograph physical pattern pieces and extract vector outlines
// using the SAM AI model.

import { polyArea, rdpSimplify, applyHomography } from './geometry.js';
import { HideDetector } from './hide-detector.js';
import CryptoJS from '../vendor/crypto-js.mjs';
import { getOrCreateEncryptionKey } from './data-bridge.js';

// ============================================================
// Dynamic loading of @huggingface/transformers
// ============================================================
let transformers = null;
async function loadTransformers() {
  if (!transformers) {
    transformers = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.1/dist/transformers.min.js');
  }
  return transformers;
}

// ============================================================
// Session persistence keys
// ============================================================
const SESSION_STORAGE_KEY = 'PatternDigitizer_Session';
const IDB_PUSH_DB = 'PatternIQ_DigitizerPush';
const IDB_PUSH_STORE = 'patterns';
const MAX_PIECES = 30;

// ============================================================
// Internal helper functions
// ============================================================

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
 * Morphological open (erode then dilate) using separable filters.
 */
function morphOpen(mask, w, h, radius = 2) {
  // Erode: horizontal pass
  const hPass = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let zeroCount = 0;
    for (let x = 0; x <= Math.min(radius, w - 1); x++) {
      if (!mask[row + x]) zeroCount++;
    }
    for (let x = 0; x < w; x++) {
      hPass[row + x] = zeroCount === 0 ? 1 : 0;
      const addX = x + radius + 1;
      const removeX = x - radius;
      if (addX < w && !mask[row + addX]) zeroCount++;
      if (removeX >= 0 && !mask[row + removeX]) zeroCount--;
    }
  }
  const eroded = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let zeroCount = 0;
    for (let y = 0; y <= Math.min(radius, h - 1); y++) {
      if (!hPass[y * w + x]) zeroCount++;
    }
    for (let y = 0; y < h; y++) {
      eroded[y * w + x] = zeroCount === 0 ? 1 : 0;
      const addY = y + radius + 1;
      const removeY = y - radius;
      if (addY < h && !hPass[addY * w + x]) zeroCount++;
      if (removeY >= 0 && !hPass[removeY * w + x]) zeroCount--;
    }
  }
  // Dilate: horizontal pass
  const hPass2 = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let count = 0;
    for (let x = 0; x <= Math.min(radius, w - 1); x++) {
      if (eroded[row + x]) count++;
    }
    for (let x = 0; x < w; x++) {
      if (count > 0) hPass2[row + x] = 1;
      const addX = x + radius + 1;
      const removeX = x - radius;
      if (addX < w && eroded[row + addX]) count++;
      if (removeX >= 0 && eroded[row + removeX]) count--;
    }
  }
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y <= Math.min(radius, h - 1); y++) {
      if (hPass2[y * w + x]) count++;
    }
    for (let y = 0; y < h; y++) {
      mask[y * w + x] = count > 0 ? 1 : 0;
      const addY = y + radius + 1;
      const removeY = y - radius;
      if (addY < h && hPass2[addY * w + x]) count++;
      if (removeY >= 0 && hPass2[removeY * w + x]) count--;
    }
  }
}

/**
 * Dilate a mask by given radius (returns new array).
 */
function dilateMask(mask, w, h, radius) {
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
  const dilated = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y <= Math.min(radius, h - 1); y++) {
      if (hPass[y * w + x]) count++;
    }
    for (let y = 0; y < h; y++) {
      dilated[y * w + x] = count > 0 ? 1 : 0;
      const addY = y + radius + 1;
      const removeY = y - radius;
      if (addY < h && hPass[addY * w + x]) count++;
      if (removeY >= 0 && hPass[removeY * w + x]) count--;
    }
  }
  return dilated;
}

/**
 * Erode a mask by given radius (returns new array).
 */
function erodeMask(mask, w, h, radius) {
  const hPass = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let zeroCount = 0;
    for (let x = 0; x <= Math.min(radius, w - 1); x++) {
      if (!mask[row + x]) zeroCount++;
    }
    for (let x = 0; x < w; x++) {
      hPass[row + x] = zeroCount === 0 ? 1 : 0;
      const addX = x + radius + 1;
      const removeX = x - radius;
      if (addX < w && !mask[row + addX]) zeroCount++;
      if (removeX >= 0 && !mask[row + removeX]) zeroCount--;
    }
  }
  const eroded = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let zeroCount = 0;
    for (let y = 0; y <= Math.min(radius, h - 1); y++) {
      if (!hPass[y * w + x]) zeroCount++;
    }
    for (let y = 0; y < h; y++) {
      eroded[y * w + x] = zeroCount === 0 ? 1 : 0;
      const addY = y + radius + 1;
      const removeY = y - radius;
      if (addY < h && !hPass[addY * w + x]) zeroCount++;
      if (removeY >= 0 && !hPass[removeY * w + x]) zeroCount--;
    }
  }
  return eroded;
}

/**
 * Extract outer boundary contour from a binary mask using Moore neighborhood tracing.
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
 * RDP simplification for {x,y} point arrays.
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
 * Flood-fill interior OFF regions of the mask to find holes.
 * Regions touching image edges are considered background, not holes.
 */
function findHoles(mask, w, h, minAreaPercent) {
  const totalArea = w * h;
  const minHolePixels = Math.max(50, (minAreaPercent / 100) * totalArea);
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
 * Compute IoU (intersection over union) between two binary masks.
 */
function computeIoU(maskA, maskB, length) {
  let intersection = 0, union = 0;
  for (let i = 0; i < length; i++) {
    const a = maskA[i] > 0;
    const b = maskB[i] > 0;
    if (a && b) intersection++;
    if (a || b) union++;
  }
  return union > 0 ? intersection / union : 0;
}

/**
 * Connected-component labeling on a binary mask.
 * Returns array of components: [{label, pixels: [idx,...], area}]
 */
function connectedComponents(mask, w, h) {
  const labels = new Int32Array(w * h);
  let nextLabel = 1;
  const components = [];
  const stack = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!mask[idx] || labels[idx]) continue;
      const lbl = nextLabel++;
      const pixels = [];
      stack.length = 0;
      stack.push(idx);
      labels[idx] = lbl;
      while (stack.length) {
        const p = stack.pop();
        pixels.push(p);
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
      components.push({ label: lbl, pixels, area: pixels.length });
    }
  }
  return components;
}

/**
 * Refine mask by eroding pixels near boundary that match background color.
 */
function refineMaskByBackground(mask, w, h, imageData, erodeRadius = 3) {
  // Sample background color from corners of the image
  const sampleSize = Math.min(20, Math.floor(Math.min(w, h) * 0.05));
  let bgR = 0, bgG = 0, bgB = 0, bgCount = 0;

  for (let y = 0; y < sampleSize; y++) {
    for (let x = 0; x < sampleSize; x++) {
      const idx = (y * w + x) * 4;
      bgR += imageData[idx]; bgG += imageData[idx + 1]; bgB += imageData[idx + 2];
      bgCount++;
    }
  }
  for (let y = 0; y < sampleSize; y++) {
    for (let x = w - sampleSize; x < w; x++) {
      const idx = (y * w + x) * 4;
      bgR += imageData[idx]; bgG += imageData[idx + 1]; bgB += imageData[idx + 2];
      bgCount++;
    }
  }
  if (bgCount === 0) return;
  bgR = Math.round(bgR / bgCount);
  bgG = Math.round(bgG / bgCount);
  bgB = Math.round(bgB / bgCount);

  const colorThreshold = 50;

  // Find boundary pixels and check if they match background
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!mask[idx]) continue;
      // Check if this is near the boundary
      let nearBoundary = false;
      for (let dy = -erodeRadius; dy <= erodeRadius && !nearBoundary; dy++) {
        for (let dx = -erodeRadius; dx <= erodeRadius && !nearBoundary; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) { nearBoundary = true; break; }
          if (!mask[ny * w + nx]) nearBoundary = true;
        }
      }
      if (!nearBoundary) continue;

      // Check color distance from background
      const pIdx = idx * 4;
      const dr = imageData[pIdx] - bgR;
      const dg = imageData[pIdx + 1] - bgG;
      const db = imageData[pIdx + 2] - bgB;
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);
      if (dist < colorThreshold) {
        mask[idx] = 0;
      }
    }
  }
}

/**
 * Euclidean color distance.
 */
function colorDistance(c1, c2) {
  return Math.sqrt((c1.r - c2.r) ** 2 + (c1.g - c2.g) ** 2 + (c1.b - c2.b) ** 2);
}

/**
 * Generate a cycling color for piece identification.
 */
const PIECE_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A',
  '#98D8C8', '#F7DC6F', '#BB8FCE', '#82E0AA',
  '#F1948A', '#85C1E9', '#F0B27A', '#A3E4D7'
];

function getPieceColor(index) {
  return PIECE_COLORS[index % PIECE_COLORS.length];
}

// ============================================================
// PatternDigitizer class
// ============================================================

export class PatternDigitizer {

  async loadModelFromUSB() {
    const statusEl = document.getElementById('digitizer-usb-status');
    if (!statusEl) return;
    try {
        // ADD THIS GUARD: Check if the browser actually supports the USB API
        if (typeof window.showDirectoryPicker !== 'function') {
            throw new Error("Offline USB loading requires Google Chrome or Microsoft Edge.");
        }

        // 1. Prompt the user to select the USB folder containing the .onnx files
        const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
        statusEl.textContent = "Checking folder contents...";
        statusEl.style.color = "var(--acc2)";

        // 2. Verify the required ONNX files exist in the chosen folder
        let modelFileHandle, encoderFileHandle;
        for await (const entry of dirHandle.values()) {
            if (entry.name.includes('decoder') && entry.name.endsWith('.onnx')) {
                modelFileHandle = entry;
            } else if (entry.name.includes('encoder') && entry.name.endsWith('.onnx')) {
                encoderFileHandle = entry;
            }
        }

        if (!modelFileHandle) {
            throw new Error("No valid SAM .onnx files found in this folder.");
        }

        statusEl.textContent = "Loading model to GPU/CPU...";

        // 3. Read the file directly into memory as an ArrayBuffer
        const file = await modelFileHandle.getFile();
        const arrayBuffer = await file.arrayBuffer();

        // 4. Initialize ONNX Runtime with the local buffer instead of a URL
        if (!window.ort) window.ort = {};
        if (!window.ort.env) window.ort.env = {};
        if (!window.ort.env.wasm) window.ort.env.wasm = {};
        window.ort.env.wasm.profiling = false;

        let provider = navigator.gpu ? 'webgpu' : 'wasm';

        this.session = await window.ort.InferenceSession.create(arrayBuffer, {
            executionProviders: [provider]
        });

        // 5. Save the directory handle to IndexedDB so we don't have to ask next time
        await this._saveDirHandleToDB(dirHandle);

        statusEl.textContent = `✓ Loaded from USB (${provider})`;
        statusEl.style.color = "var(--lime)";

    } catch (err) {
        console.error("USB Load Error:", err);
        statusEl.textContent = "Error: " + err.message;
        statusEl.style.color = "var(--dan)";
    }
  }

  // Helper to save the handle
  async _saveDirHandleToDB(handle) {
    if (!window.DataBridge) return;
    const db = await window.DataBridge.getDB('PatternIQ_VisionPush', 2); // Or your preferred DB
    const tx = db.transaction('models', 'readwrite');
    tx.objectStore('models').put({ id: 'digitizer_sam_dir', handle: handle });
    return tx.done;
  }

  // Internal state
  #hideDetector = null;
  #model = null;
  #processor = null;
  #imageEmbeddings = null;
  #sourceCanvas = null;
  #imgW = 0;
  #imgH = 0;
  #pieces = [];
  #nextPieceId = 1;

  // Multi-point mode
  #positivePoints = [];
  #negativePoints = [];

  // Camera state
  #videoElement = null;
  #cameraStream = null;
  #animFrameId = null;
  #frozen = false;
  #frozenCanvas = null;

  // Size series mode
  #sizeSeriesMode = false;
  #sizeList = [];
  #activeSize = '';
  #parts = [];
  #activePart = null;
  #doneParts = new Set(); // Set of "partName_sizeLabel" strings

  // Foot pedal / gamepad / HID
  #gamepadIndex = null;
  #gamepadPollId = null;
  #hidDevice = null;
  #lastGamepadPress = 0;

  // Callbacks
  #onProgress = null;
  #onLog = null;
  #onPieceDetected = null;
  #onCaptureTriggered = null;

  /**
   * @param {object} options
   * @param {function} [options.onProgress] - Progress callback (0-1)
   * @param {function} [options.onLog] - Log callback (message, level)
   * @param {function} [options.onPieceDetected] - Callback when a piece is detected
   * @param {function} [options.onCaptureTriggered] - Callback when capture is triggered by pedal/gamepad/keyboard
   */
  constructor(options = {}) {
    this.#onProgress = options.onProgress || null;
    this.#onLog = options.onLog || null;
    this.#onPieceDetected = options.onPieceDetected || null;
    this.#onCaptureTriggered = options.onCaptureTriggered || null;

    // Create an internal HideDetector instance for SAM model management
    this.#hideDetector = new HideDetector({
      onProgress: this.#onProgress,
      onLog: this.#onLog
    });

    // Setup keyboard listener for spacebar capture
    this.#setupKeyboardCapture();
  }

  #log(msg, level = 'info') {
    if (this.#onLog) this.#onLog(msg, level);
  }

  #progress(value) {
    if (this.#onProgress) this.#onProgress(value);
  }

  // ============================================================
  // Model (delegates to HideDetector for SAM)
  // ============================================================

  /**
   * Load the SAM model. Pass-through to HideDetector.loadModel.
   * Also stores internal references to model and processor for direct inference.
   * @param {object} options
   * @param {'webgpu'|'wasm'|'auto'} [options.device='auto']
   * @param {FileSystemDirectoryHandle|null} [options.fromUSB=null]
   * @returns {Promise<{device: string, cached: boolean}>}
   */
  async loadModel(options = {}) {
    const result = await this.#hideDetector.loadModel(options);

    // Also load transformers locally for direct point-prompt inference
    const tf = await loadTransformers();
    const { SamModel, AutoProcessor } = tf;
    const model_id = 'Xenova/sam-vit-base';

    // Re-use cached model/processor (already downloaded by HideDetector)
    const { device: preferredDevice = 'auto' } = options;
    let device = 'wasm';
    if (preferredDevice === 'webgpu' || preferredDevice === 'auto') {
      if (typeof navigator !== 'undefined' && navigator.gpu) {
        try {
          const adapter = await navigator.gpu.requestAdapter();
          if (adapter) device = 'webgpu';
        } catch (e) { /* fallback */ }
      }
    }
    if (preferredDevice === 'wasm') device = 'wasm';

    this.#processor = await AutoProcessor.from_pretrained(model_id);
    this.#model = await SamModel.from_pretrained(model_id, { dtype: 'fp32', device });

    return result;
  }

  /**
   * Whether the SAM model is loaded and ready for inference.
   */
  get modelReady() {
    return this.#hideDetector.modelReady;
  }

  // ============================================================
  // Image Input
  // ============================================================

  /**
   * Load an image file, render to internal canvas, and compute SAM embeddings.
   * Applies image preprocessing (specular highlight suppression + CLAHE-like
   * local contrast enhancement) before computing embeddings.
   * @param {File|HTMLImageElement|HTMLCanvasElement} file
   * @returns {Promise<{width: number, height: number}>}
   */
  async loadImage(file) {
    if (!this.modelReady) throw new Error('Model not loaded — call loadModel() first');

    const tf = await loadTransformers();
    const { RawImage } = tf;

    // Convert to canvas
    let canvas, w, h;
    if (file instanceof HTMLCanvasElement) {
      canvas = file;
      w = canvas.width;
      h = canvas.height;
    } else if (file instanceof HTMLImageElement) {
      w = file.naturalWidth || file.width;
      h = file.naturalHeight || file.height;
      const MAX_DIM = 4096;
      if (w > MAX_DIM || h > MAX_DIM) {
        const scale = MAX_DIM / Math.max(w, h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }
      canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(file, 0, 0, w, h);
    } else if (file instanceof File) {
      const bitmap = await createImageBitmap(file);
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
      throw new Error('file must be File, HTMLImageElement, or HTMLCanvasElement');
    }

    this.#sourceCanvas = canvas;
    this.#imgW = w;
    this.#imgH = h;

    this.#log(`Image loaded: ${w}x${h}`);
    this.#progress(0.1);

    // Resize to SAM input size (1024x1024) and compute embeddings
    const SAM_DIM = 1024;
    const resizeCanvas = document.createElement('canvas');
    resizeCanvas.width = SAM_DIM;
    resizeCanvas.height = SAM_DIM;
    const resizeCtx = resizeCanvas.getContext('2d');
    resizeCtx.imageSmoothingEnabled = true;
    resizeCtx.imageSmoothingQuality = 'high';
    resizeCtx.drawImage(canvas, 0, 0, w, h, 0, 0, SAM_DIM, SAM_DIM);

    // Image preprocessing: specular highlight suppression + CLAHE
    const imageData = resizeCtx.getImageData(0, 0, SAM_DIM, SAM_DIM);
    this.#suppressSpecularHighlights(imageData.data);
    await this.#enhanceLocalContrast(imageData);
    resizeCtx.putImageData(imageData, 0, 0);

    const rgbaData = imageData.data;
    const pixelCount = SAM_DIM * SAM_DIM;
    const rgbData = new Uint8ClampedArray(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
      rgbData[i * 3] = rgbaData[i * 4];
      rgbData[i * 3 + 1] = rgbaData[i * 4 + 1];
      rgbData[i * 3 + 2] = rgbaData[i * 4 + 2];
    }
    const rawImage = new RawImage(rgbData, SAM_DIM, SAM_DIM, 3);

    this.#log('Computing image embeddings...');
    this.#progress(0.3);

    const inputs = await this.#processor(rawImage);
    if (typeof this.#model.get_image_embeddings === 'function') {
      this.#imageEmbeddings = await this.#model.get_image_embeddings(inputs);
    } else {
      this.#imageEmbeddings = inputs;
    }

    this.#progress(1.0);
    this.#log('Embeddings ready');

    // Clear previous points and pieces for new image
    this.clearPoints();

    return { width: w, height: h };
  }

  /**
   * Start the webcam and render to a video element.
   * @param {HTMLVideoElement} videoElement
   * @returns {Promise<void>}
   */
  async startCamera(videoElement) {
    if (!videoElement) throw new Error('videoElement required');

    this.#videoElement = videoElement;
    this.#frozen = false;

    const constraints = {
      video: {
        facingMode: 'environment',
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      }
    };

    this.#cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
    videoElement.srcObject = this.#cameraStream;
    await videoElement.play();

    this.#log(`Camera started: ${videoElement.videoWidth}x${videoElement.videoHeight}`);
  }

  /**
   * Stop the webcam and release resources.
   */
  stopCamera() {
    if (this.#animFrameId) {
      cancelAnimationFrame(this.#animFrameId);
      this.#animFrameId = null;
    }
    if (this.#cameraStream) {
      for (const track of this.#cameraStream.getTracks()) {
        track.stop();
      }
      this.#cameraStream = null;
    }
    if (this.#videoElement) {
      this.#videoElement.srcObject = null;
      this.#videoElement = null;
    }
    this.#frozen = false;
    this.#frozenCanvas = null;
    this.#log('Camera stopped');
  }

  /**
   * Capture the current video frame for detection.
   * Freezes the camera feed and computes embeddings on the frozen frame.
   * @returns {Promise<{width: number, height: number}>}
   */
  async freezeFrame() {
    if (!this.#videoElement) throw new Error('Camera not started');

    const video = this.#videoElement;
    const w = video.videoWidth;
    const h = video.videoHeight;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(video, 0, 0, w, h);

    this.#frozen = true;
    this.#frozenCanvas = canvas;

    // Pause the video to show frozen frame
    video.pause();

    this.#log('Frame frozen, computing embeddings...');

    // Load image from frozen canvas
    return await this.loadImage(canvas);
  }

  /**
   * Resume the camera after a freeze.
   */
  resumeCamera() {
    if (!this.#videoElement) return;
    this.#frozen = false;
    this.#frozenCanvas = null;
    this.#imageEmbeddings = null;
    this.#videoElement.play();
    this.#log('Camera resumed');
  }

  // ============================================================
  // Image Preprocessing (Feature #12)
  // ============================================================

  /**
   * Suppress specular highlights - bright, low-saturation pixels get toned down.
   * Ported from patternDigitizer.html.
   */
  #suppressSpecularHighlights(data) {
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const br = (r + g + b) / 3;
      const sat = Math.max(r, g, b) > 0
        ? (Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(r, g, b)
        : 0;
      if (br > 200 && sat < 0.15) {
        data[i] = Math.round(r * 0.6 + 128 * 0.4);
        data[i + 1] = Math.round(g * 0.6 + 128 * 0.4);
        data[i + 2] = Math.round(b * 0.6 + 128 * 0.4);
      }
    }
  }

  /**
   * CLAHE-like local contrast enhancement.
   * Ported from cadShot.html enhanceLocalContrast.
   */
  async #enhanceLocalContrast(imageData) {
    const d = imageData.data;
    const w = imageData.width, h = imageData.height;
    const tileSize = 128;
    const tilesX = Math.ceil(w / tileSize);
    const tilesY = Math.ceil(h / tileSize);
    const clipLimit = 3.0;
    let tilesDone = 0;

    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        const x0 = tx * tileSize, y0 = ty * tileSize;
        const x1 = Math.min(x0 + tileSize, w);
        const y1 = Math.min(y0 + tileSize, h);
        const count = (x1 - x0) * (y1 - y0);

        const hist = new Int32Array(256);
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const idx = (y * w + x) * 4;
            const lum = Math.round(0.299 * d[idx] + 0.587 * d[idx + 1] + 0.114 * d[idx + 2]);
            hist[lum]++;
          }
        }

        const limit = Math.max(1, Math.round(clipLimit * count / 256));
        let excess = 0;
        for (let i = 0; i < 256; i++) {
          if (hist[i] > limit) { excess += hist[i] - limit; hist[i] = limit; }
        }
        const bonus = Math.floor(excess / 256);
        for (let i = 0; i < 256; i++) hist[i] += bonus;

        const cdf = new Int32Array(256);
        cdf[0] = hist[0];
        for (let i = 1; i < 256; i++) cdf[i] = cdf[i - 1] + hist[i];
        const cdfMin = cdf.find(v => v > 0) || 0;
        const denom = Math.max(1, cdf[255] - cdfMin);

        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const idx = (y * w + x) * 4;
            const lum = Math.round(0.299 * d[idx] + 0.587 * d[idx + 1] + 0.114 * d[idx + 2]);
            const newLum = Math.round(((cdf[lum] - cdfMin) / denom) * 255);
            const ratio = lum > 0 ? newLum / lum : 1;
            d[idx] = Math.min(255, Math.round(d[idx] * ratio));
            d[idx + 1] = Math.min(255, Math.round(d[idx + 1] * ratio));
            d[idx + 2] = Math.min(255, Math.round(d[idx + 2] * ratio));
          }
        }

        tilesDone++;
        if (tilesDone % 8 === 0) await new Promise(r => setTimeout(r, 0));
      }
    }
  }

  // ============================================================
  // Single-Click Segment
  // ============================================================

  /**
   * Run SAM with a single positive point prompt.
   * @param {number} imgX - X coordinate in original image pixels
   * @param {number} imgY - Y coordinate in original image pixels
   * @returns {Promise<{mask: Uint8Array, contour: number[][], holes: Array, area: number, score: number}|null>}
   */
  async segmentAtPoint(imgX, imgY) {
    if (!this.#imageEmbeddings) throw new Error('No image loaded — call loadImage() first');

    const tf = await loadTransformers();
    const { Tensor } = tf;

    // Scale point to SAM coordinate space (1024x1024)
    const SAM_DIM = 1024;
    const samX = (imgX / this.#imgW) * SAM_DIM;
    const samY = (imgY / this.#imgH) * SAM_DIM;

    // Create tensors for single positive point
    const input_points = new Tensor('float32', [samX, samY], [1, 1, 1, 2]);
    const input_labels = new Tensor('int64', [1n], [1, 1, 1]);

    // Run inference
    let outputs;
    try {
      outputs = await this.#model({ ...this.#imageEmbeddings, input_points, input_labels });
    } catch (e) {
      this.#log(`Segmentation error: ${e.message}`, 'error');
      return null;
    }

    // Pick best mask by IoU score
    const scores = outputs.iou_scores.data;
    const maskDims = outputs.pred_masks.dims;
    const maskH = maskDims[maskDims.length - 2];
    const maskW = maskDims[maskDims.length - 1];
    const maskSize = maskW * maskH;
    const numMasks = scores.length;

    let bestIdx = 0, bestScore = -1;
    for (let m = 0; m < numMasks; m++) {
      const score = Number(scores[m]);
      if (score > bestScore) { bestScore = score; bestIdx = m; }
    }

    if (bestScore < 0.5) return null;

    // Extract best mask
    const maskOffset = bestIdx * maskSize;
    const rawMask = outputs.pred_masks.data.slice(maskOffset, maskOffset + maskSize);

    // Binarize
    const binaryMask = new Uint8Array(maskSize);
    for (let i = 0; i < maskSize; i++) {
      binaryMask[i] = rawMask[i] > 0 ? 1 : 0;
    }

    // Upscale mask to image resolution
    const upscaled = upscaleMaskBilinear(binaryMask, maskW, maskH, this.#imgW, this.#imgH);

    // MorphClose to clean up
    morphClose(upscaled, this.#imgW, this.#imgH, 2);

    // Compute area
    let area = 0;
    for (let i = 0; i < upscaled.length; i++) {
      if (upscaled[i]) area++;
    }

    // Extract outer contour via marching-squares boundary tracing
    const rawContour = maskToContourMarching(upscaled, this.#imgW, this.#imgH);
    if (rawContour.length < 3) return null;

    // Smooth and simplify
    const smoothed = smoothContour(rawContour, 2);
    const simplified = rdpSimplifyXY(smoothed, 2.0);
    const contour = simplified.map(p => [p.x, p.y]);

    // Find holes within the mask
    const holeResults = findHoles(upscaled, this.#imgW, this.#imgH, 0.1);
    const holes = holeResults.map(h => {
      const pts = rdpSimplifyXY(smoothContour(h.contour, 2), 2.0);
      return pts.map(p => [p.x, p.y]);
    });

    return { mask: upscaled, contour, holes, area, score: bestScore };
  }

  // ============================================================
  // Multi-Point Mode
  // ============================================================

  /**
   * Add a positive (foreground) point for multi-point segmentation.
   * @param {number} imgX - X coordinate in original image pixels
   * @param {number} imgY - Y coordinate in original image pixels
   */
  addPositivePoint(imgX, imgY) {
    this.#positivePoints.push({ x: imgX, y: imgY });
  }

  /**
   * Add a negative (background) point for multi-point segmentation.
   * @param {number} imgX - X coordinate in original image pixels
   * @param {number} imgY - Y coordinate in original image pixels
   */
  addNegativePoint(imgX, imgY) {
    this.#negativePoints.push({ x: imgX, y: imgY });
  }

  /**
   * Run SAM with all accumulated positive and negative points.
   * Uses coverage-weighted mask scoring (Feature #2) and geodesic constraint (Feature #1).
   * @returns {Promise<{mask: Uint8Array, contour: number[][], holes: Array, area: number, score: number}|null>}
   */
  async segmentWithPoints() {
    if (!this.#imageEmbeddings) throw new Error('No image loaded — call loadImage() first');

    const totalPoints = this.#positivePoints.length + this.#negativePoints.length;
    if (totalPoints === 0) {
      this.#log('No points added — use addPositivePoint/addNegativePoint first', 'warn');
      return null;
    }

    const tf = await loadTransformers();
    const { Tensor } = tf;

    const SAM_DIM = 1024;

    // Build points and labels arrays
    const pointCoords = [];
    const labelValues = [];

    for (const p of this.#positivePoints) {
      pointCoords.push((p.x / this.#imgW) * SAM_DIM);
      pointCoords.push((p.y / this.#imgH) * SAM_DIM);
      labelValues.push(1n);
    }
    for (const p of this.#negativePoints) {
      pointCoords.push((p.x / this.#imgW) * SAM_DIM);
      pointCoords.push((p.y / this.#imgH) * SAM_DIM);
      labelValues.push(0n);
    }

    const input_points = new Tensor('float32', new Float32Array(pointCoords), [1, 1, totalPoints, 2]);
    const input_labels = new Tensor('int64', new BigInt64Array(labelValues), [1, 1, totalPoints]);

    // Run inference
    let outputs;
    try {
      outputs = await this.#model({ ...this.#imageEmbeddings, input_points, input_labels });
    } catch (e) {
      this.#log(`Multi-point segmentation error: ${e.message}`, 'error');
      return null;
    }

    // Coverage-weighted mask scoring (Feature #2)
    const scores = outputs.iou_scores.data;
    const maskDims = outputs.pred_masks.dims;
    const maskH = maskDims[maskDims.length - 2];
    const maskW = maskDims[maskDims.length - 1];
    const maskSize = maskW * maskH;
    const numMasks = scores.length;

    // Map positive points to mask coordinates
    const ptsMaskCoords = this.#positivePoints.map(p => ({
      mx: Math.round((p.x / this.#imgW) * (maskW - 1)),
      my: Math.round((p.y / this.#imgH) * (maskH - 1))
    }));

    // Compute bounding box of clicked points in mask space
    let minMx = maskW, maxMx = 0, minMy = maskH, maxMy = 0;
    for (const pt of ptsMaskCoords) {
      minMx = Math.min(minMx, pt.mx); maxMx = Math.max(maxMx, pt.mx);
      minMy = Math.min(minMy, pt.my); maxMy = Math.max(maxMy, pt.my);
    }
    const clickBboxArea = Math.max(1, (maxMx - minMx + 1) * (maxMy - minMy + 1));

    let bestIdx = 0;
    let bestComposite = -Infinity;

    for (let m = 0; m < numMasks; m++) {
      const score = Number(scores[m]);
      if (score < 0.3) continue;

      const offset = m * maskSize;

      // Count how many click points fall inside this mask (coverage)
      let coveredCount = 0;
      let maskArea = 0;
      for (const pt of ptsMaskCoords) {
        let covered = false;
        for (let dy = -2; dy <= 2 && !covered; dy++) {
          for (let dx = -2; dx <= 2 && !covered; dx++) {
            const cy = pt.my + dy, cx = pt.mx + dx;
            if (cy < 0 || cy >= maskH || cx < 0 || cx >= maskW) continue;
            if (outputs.pred_masks.data[offset + cy * maskW + cx] > 0) covered = true;
          }
        }
        if (covered) coveredCount++;
      }
      for (let p = 0; p < maskSize; p++) {
        if (outputs.pred_masks.data[offset + p] > 0) maskArea++;
      }

      // Composite score: coverage 60%, IoU 30%, area penalty 10%
      const coverageFrac = coveredCount / this.#positivePoints.length;
      const areaRatio = maskArea / Math.max(1, clickBboxArea);
      const areaPenalty = areaRatio > 8 ? Math.log2(areaRatio / 8) * 0.1 : 0;
      const composite = coverageFrac * 0.6 + score * 0.3 - areaPenalty + (coverageFrac >= 0.8 ? 0.1 : 0);

      if (composite > bestComposite) {
        bestComposite = composite;
        bestIdx = m;
      }
    }

    if (bestComposite < 0) {
      // Fallback to highest IoU score
      let bestScore = -1;
      for (let m = 0; m < numMasks; m++) {
        if (Number(scores[m]) > bestScore) { bestScore = Number(scores[m]); bestIdx = m; }
      }
      if (bestScore < 0.3) return null;
    }

    // Extract and process mask
    const maskOffset = bestIdx * maskSize;
    const rawMask = outputs.pred_masks.data.slice(maskOffset, maskOffset + maskSize);
    const binaryMask = new Uint8Array(maskSize);
    for (let i = 0; i < maskSize; i++) {
      binaryMask[i] = rawMask[i] > 0 ? 1 : 0;
    }

    const upscaled = upscaleMaskBilinear(binaryMask, maskW, maskH, this.#imgW, this.#imgH);
    morphClose(upscaled, this.#imgW, this.#imgH, 2);

    // Apply geodesic constraint (Feature #1) for multi-point mode
    if (this.#positivePoints.length >= 3) {
      this.#constrainMaskToClickedRegion(upscaled, this.#imgW, this.#imgH, this.#positivePoints);
    }

    let area = 0;
    for (let i = 0; i < upscaled.length; i++) {
      if (upscaled[i]) area++;
    }

    const rawContour = maskToContourMarching(upscaled, this.#imgW, this.#imgH);
    if (rawContour.length < 3) return null;

    const smoothed = smoothContour(rawContour, 2);
    const simplified = rdpSimplifyXY(smoothed, 2.0);
    const contour = simplified.map(p => [p.x, p.y]);

    const holeResults = findHoles(upscaled, this.#imgW, this.#imgH, 0.1);
    const holes = holeResults.map(h => {
      const pts = rdpSimplifyXY(smoothContour(h.contour, 2), 2.0);
      return pts.map(p => [p.x, p.y]);
    });

    return { mask: upscaled, contour, holes, area, score: Number(scores[bestIdx]) };
  }

  /**
   * Clear all accumulated positive and negative points.
   */
  clearPoints() {
    this.#positivePoints = [];
    this.#negativePoints = [];
  }

  // ============================================================
  // Geodesic Constraint (Feature #1)
  // ============================================================

  /**
   * BFS distance map from click points; prune pixels beyond maxDist.
   * Prevents merging adjacent pieces when using multi-point mode.
   * Ported from cadShot.html constrainMaskToClickedRegion.
   */
  #constrainMaskToClickedRegion(mask, w, h, clickedPoints) {
    if (clickedPoints.length < 3) return;

    // Compute bounding box of clicked points
    let cpMinX = w, cpMaxX = 0, cpMinY = h, cpMaxY = 0;
    for (const p of clickedPoints) {
      if (p.x < cpMinX) cpMinX = p.x;
      if (p.x > cpMaxX) cpMaxX = p.x;
      if (p.y < cpMinY) cpMinY = p.y;
      if (p.y > cpMaxY) cpMaxY = p.y;
    }
    const cpW = cpMaxX - cpMinX;
    const cpH = cpMaxY - cpMinY;

    // Compute mask bounding box
    let mMinX = w, mMaxX = 0, mMinY = h, mMaxY = 0;
    let maskPixels = 0;
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 50000)));
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        if (mask[y * w + x]) {
          maskPixels++;
          if (x < mMinX) mMinX = x;
          if (x > mMaxX) mMaxX = x;
          if (y < mMinY) mMinY = y;
          if (y > mMaxY) mMaxY = y;
        }
      }
    }
    const mW = mMaxX - mMinX;
    const mH = mMaxY - mMinY;
    const maskBboxArea = mW * mH;

    const marginX = Math.max(cpW * 0.4, 50);
    const marginY = Math.max(cpH * 0.4, 50);
    const expandedClickArea = (cpW + 2 * marginX) * (cpH + 2 * marginY);

    const maskDensity = (maskPixels * step * step) / maskBboxArea;
    if (maskBboxArea < expandedClickArea * 3.5) return;
    if (maskDensity > 0.6 && maskBboxArea < expandedClickArea * 5) return;

    // Quick CC count — skip if single connected component
    const compLabels = new Uint8Array(w * h);
    let numComponents = 0;
    const floodStack = [];
    const sampleStep = Math.max(1, Math.floor(Math.sqrt((w * h) / 200000)));
    for (let y = 0; y < h; y += sampleStep) {
      for (let x = 0; x < w; x += sampleStep) {
        const i = y * w + x;
        if (!mask[i] || compLabels[i]) continue;
        numComponents++;
        if (numComponents > 3) break;
        floodStack.length = 0;
        floodStack.push(i);
        compLabels[i] = numComponents;
        while (floodStack.length) {
          const p = floodStack.pop();
          const py2 = (p / w) | 0, px2 = p - py2 * w;
          if (px2 > 0 && mask[p - 1] && !compLabels[p - 1]) { compLabels[p - 1] = numComponents; floodStack.push(p - 1); }
          if (px2 < w - 1 && mask[p + 1] && !compLabels[p + 1]) { compLabels[p + 1] = numComponents; floodStack.push(p + 1); }
          if (py2 > 0 && mask[p - w] && !compLabels[p - w]) { compLabels[p - w] = numComponents; floodStack.push(p - w); }
          if (py2 < h - 1 && mask[p + w] && !compLabels[p + w]) { compLabels[p + w] = numComponents; floodStack.push(p + w); }
        }
      }
      if (numComponents > 3) break;
    }

    if (numComponents <= 1) return;

    // BFS distance map from all click points
    const maxDist = Math.max(cpW, cpH, mW * 0.7, mH * 0.7);
    const distMap = new Float32Array(w * h);
    distMap.fill(Infinity);

    const queue = [];
    for (const p of clickedPoints) {
      const px = Math.round(p.x), py = Math.round(p.y);
      if (px >= 0 && px < w && py >= 0 && py < h) {
        const idx = py * w + px;
        distMap[idx] = 0;
        queue.push(idx);
      }
    }

    let qi = 0;
    while (qi < queue.length) {
      const idx = queue[qi++];
      const py = (idx / w) | 0, px = idx - py * w;
      const curDist = distMap[idx];
      if (curDist > maxDist) continue;

      const neighbors = [
        py > 0 ? idx - w : -1,
        py < h - 1 ? idx + w : -1,
        px > 0 ? idx - 1 : -1,
        px < w - 1 ? idx + 1 : -1
      ];
      for (const ni of neighbors) {
        if (ni < 0 || !mask[ni]) continue;
        const newDist = curDist + 1;
        if (newDist < distMap[ni]) {
          distMap[ni] = newDist;
          queue.push(ni);
        }
      }
    }

    // Prune pixels beyond maxDist
    let removed = 0;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] && distMap[i] > maxDist) {
        mask[i] = 0;
        removed++;
      }
    }
    if (removed > 0) {
      this.#log(`Geodesic constraint: removed ${removed} distant pixels`);
    }
  }

  // ============================================================
  // Background Mask Detection (Feature #3)
  // ============================================================

  /**
   * Determine if a mask is likely background/table surface.
   * Uses median edge color sampling, core-color check, texture gradient analysis,
   * aspect-ratio exception, and compactness check.
   * Ported from cadShot.html isBackgroundMask.
   */
  #isBackgroundMask(mask, w, h, imageData, score = 0) {
    // Sample background color from image edges (median approach)
    const edgeMargin = Math.floor(Math.min(w, h) * 0.03);
    const edgeStep = Math.max(1, Math.floor(Math.min(w, h) / 40));
    const bgRVals = [], bgGVals = [], bgBVals = [];
    for (let x = edgeMargin; x < w - edgeMargin; x += edgeStep) {
      for (const ey of [edgeMargin, h - edgeMargin - 1]) {
        const idx = (ey * w + x) * 4;
        bgRVals.push(imageData[idx]); bgGVals.push(imageData[idx + 1]); bgBVals.push(imageData[idx + 2]);
      }
    }
    for (let y = edgeMargin; y < h - edgeMargin; y += edgeStep) {
      for (const ex of [edgeMargin, w - edgeMargin - 1]) {
        const idx = (y * w + ex) * 4;
        bgRVals.push(imageData[idx]); bgGVals.push(imageData[idx + 1]); bgBVals.push(imageData[idx + 2]);
      }
    }
    if (bgRVals.length < 20) return false;
    bgRVals.sort((a, b) => a - b);
    bgGVals.sort((a, b) => a - b);
    bgBVals.sort((a, b) => a - b);
    const mid = Math.floor(bgRVals.length / 2);
    const bgColor = { r: bgRVals[mid], g: bgGVals[mid], b: bgBVals[mid] };

    // Compute spread for adaptive threshold
    const q1 = Math.floor(bgRVals.length * 0.25);
    const q3 = Math.floor(bgRVals.length * 0.75);
    const spread = Math.sqrt(
      (bgRVals[q3] - bgRVals[q1]) ** 2 +
      (bgGVals[q3] - bgGVals[q1]) ** 2 +
      (bgBVals[q3] - bgBVals[q1]) ** 2
    );

    // Average mask color
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 20000)));
    let rSum = 0, gSum = 0, bSum = 0, mCount = 0;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        if (!mask[y * w + x]) continue;
        const idx = (y * w + x) * 4;
        rSum += imageData[idx]; gSum += imageData[idx + 1]; bSum += imageData[idx + 2];
        mCount++;
      }
    }
    if (mCount === 0) return false;
    const maskColor = { r: rSum / mCount, g: gSum / mCount, b: bSum / mCount };

    const dist = colorDistance(maskColor, bgColor);
    let threshold = Math.max(25, spread * 1.2);
    if (score > 0.85) threshold *= 0.7;

    if (dist >= threshold) return false;
    if (score > 0.88) return false;

    // Aspect-ratio exception: elongated pieces are likely real
    let minX = w, maxX = 0, minY = h, maxY = 0;
    let maskArea = 0;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        if (mask[y * w + x]) {
          maskArea++;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    const bw = maxX - minX, bh = maxY - minY;
    const aspectRatio = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh));
    if (aspectRatio > 3.5 && score > 0.7) return false;

    // Compactness check
    const bboxArea = bw * bh;
    const scaledMaskArea = maskArea * (step * step);
    const compactness = bboxArea > 0 ? scaledMaskArea / bboxArea : 0;
    if (compactness > 0.6 && score > 0.75) return false;

    // Core color check
    const insetX = Math.floor(bw * 0.25), insetY = Math.floor(bh * 0.25);
    let coreR = 0, coreG = 0, coreB = 0, coreCount = 0;
    for (let y = minY + insetY; y < maxY - insetY; y += step) {
      for (let x = minX + insetX; x < maxX - insetX; x += step) {
        if (!mask[y * w + x]) continue;
        const idx = (y * w + x) * 4;
        coreR += imageData[idx]; coreG += imageData[idx + 1]; coreB += imageData[idx + 2];
        coreCount++;
      }
    }
    if (coreCount > 10) {
      const coreColor = { r: coreR / coreCount, g: coreG / coreCount, b: coreB / coreCount };
      const coreDist = colorDistance(coreColor, bgColor);
      if (coreDist >= threshold) return false;

      // Texture gradient analysis on core
      const gradStep = Math.max(2, Math.floor(Math.sqrt(bw * bh / 5000)));
      let edgeSum = 0, eCnt = 0;
      for (let y = minY + insetY; y < maxY - insetY - gradStep; y += gradStep) {
        for (let x = minX + insetX; x < maxX - insetX - gradStep; x += gradStep) {
          if (!mask[y * w + x]) continue;
          const idx0 = (y * w + x) * 4;
          const idxR = (y * w + x + gradStep) * 4;
          const idxD = ((y + gradStep) * w + x) * 4;
          const lum0 = 0.299 * imageData[idx0] + 0.587 * imageData[idx0 + 1] + 0.114 * imageData[idx0 + 2];
          const lumR = 0.299 * imageData[idxR] + 0.587 * imageData[idxR + 1] + 0.114 * imageData[idxR + 2];
          const lumD = 0.299 * imageData[idxD] + 0.587 * imageData[idxD + 1] + 0.114 * imageData[idxD + 2];
          edgeSum += Math.abs(lum0 - lumR) + Math.abs(lum0 - lumD);
          eCnt++;
        }
      }
      const coreEdgeDensity = eCnt > 0 ? edgeSum / eCnt : 0;
      if (coreEdgeDensity > 4) return false;
      if (score > 0.75 && coreEdgeDensity > 3) return false;
      if (aspectRatio > 2.5 && coreEdgeDensity > 2) return false;
      return true;
    }

    return true;
  }

  // ============================================================
  // Paper Detection (Feature #4)
  // ============================================================

  /**
   * Auto-detect rectangular calibration paper in a mask.
   * Checks rectangularity > 0.88, aspect ratio < 2.0, low color variance, low texture gradient.
   * Returns paper info for auto-calibration, or null if not paper.
   * Ported from cadShot.html detectCalibrationPaper.
   */
  detectCalibrationPaper(mask, w, h) {
    // Compute bounding box of mask
    let minX = w, maxX = 0, minY = h, maxY = 0;
    let maskArea = 0;
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 50000)));
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        if (mask[y * w + x]) {
          maskArea++;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    maskArea *= (step * step); // approximate

    const bboxW = maxX - minX;
    const bboxH = maxY - minY;
    const bboxArea = bboxW * bboxH;
    if (bboxArea === 0) return null;

    const rectangularity = maskArea / bboxArea;
    if (rectangularity < 0.88) return null;

    const aspect = Math.max(bboxW, bboxH) / Math.min(bboxW, bboxH);
    if (aspect > 2.0) return null;

    // Color uniformity check via source canvas
    if (!this.#sourceCanvas) return null;
    const ctx = this.#sourceCanvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;

    let rSum = 0, gSum = 0, bSum = 0, sampleCount = 0;
    const sStep = Math.max(1, Math.floor(Math.sqrt(maskArea / 500)));
    for (let y = minY; y <= maxY; y += sStep) {
      for (let x = minX; x <= maxX; x += sStep) {
        if (mask[y * w + x]) {
          const idx = (y * w + x) * 4;
          rSum += d[idx]; gSum += d[idx + 1]; bSum += d[idx + 2];
          sampleCount++;
        }
      }
    }
    if (sampleCount === 0) return null;
    const avgR = rSum / sampleCount, avgG = gSum / sampleCount, avgB = bSum / sampleCount;

    // Color variance
    let variance = 0;
    for (let y = minY; y <= maxY; y += sStep) {
      for (let x = minX; x <= maxX; x += sStep) {
        if (mask[y * w + x]) {
          const idx = (y * w + x) * 4;
          variance += (d[idx] - avgR) ** 2 + (d[idx + 1] - avgG) ** 2 + (d[idx + 2] - avgB) ** 2;
        }
      }
    }
    variance /= (sampleCount * 3);
    const stdDev = Math.sqrt(variance);
    if (stdDev > 45) return null;

    // Texture gradient check
    const gradStep = Math.max(1, Math.floor(Math.sqrt(maskArea / 3000)));
    const coreInsetX = Math.floor(bboxW * 0.15);
    const coreInsetY = Math.floor(bboxH * 0.15);
    let gradSum = 0, gradCount = 0;
    for (let y = minY + coreInsetY; y < maxY - coreInsetY - gradStep; y += gradStep) {
      for (let x = minX + coreInsetX; x < maxX - coreInsetX - gradStep; x += gradStep) {
        if (!mask[y * w + x]) continue;
        const idx0 = (y * w + x) * 4;
        const idxR = (y * w + x + gradStep) * 4;
        const idxD = ((y + gradStep) * w + x) * 4;
        const lum0 = 0.299 * d[idx0] + 0.587 * d[idx0 + 1] + 0.114 * d[idx0 + 2];
        const lumR = 0.299 * d[idxR] + 0.587 * d[idxR + 1] + 0.114 * d[idxR + 2];
        const lumD = 0.299 * d[idxD] + 0.587 * d[idxD + 1] + 0.114 * d[idxD + 2];
        gradSum += Math.abs(lum0 - lumR) + Math.abs(lum0 - lumD);
        gradCount++;
      }
    }
    const avgGradient = gradCount > 0 ? gradSum / gradCount : 0;
    if (avgGradient > 5) return null;

    const areaPercent = (maskArea / (w * h)) * 100;
    if (areaPercent < 2) return null;

    return {
      bbox: { x: minX, y: minY, w: bboxW, h: bboxH },
      rectangularity, aspect, stdDev, maskArea, areaPercent
    };
  }

  // ============================================================
  // Split by Background Gap (Feature #7)
  // ============================================================

  /**
   * Split mask by interior background-colored gaps.
   * Uses morphOpen + morphClose to find gap regions, CC labeling,
   * and keeps only the component containing the click point.
   * Ported from cadShot.html splitMaskByBackgroundGap.
   */
  splitMaskByBackgroundGap(mask, w, h, clickPoint) {
    if (!this.#sourceCanvas) return;
    const ctx = this.#sourceCanvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 30000)));

    // Sample background from image edges (median)
    const edgeMargin = Math.floor(Math.min(w, h) * 0.03);
    const edgeStep = Math.max(1, Math.floor(Math.min(w, h) / 40));
    const bgRVals = [], bgGVals = [], bgBVals = [];
    for (let x = edgeMargin; x < w - edgeMargin; x += edgeStep) {
      for (const ey of [edgeMargin, h - edgeMargin - 1]) {
        const idx = (ey * w + x) * 4;
        bgRVals.push(d[idx]); bgGVals.push(d[idx + 1]); bgBVals.push(d[idx + 2]);
      }
    }
    for (let y = edgeMargin; y < h - edgeMargin; y += edgeStep) {
      for (const ex of [edgeMargin, w - edgeMargin - 1]) {
        const idx = (y * w + ex) * 4;
        bgRVals.push(d[idx]); bgGVals.push(d[idx + 1]); bgBVals.push(d[idx + 2]);
      }
    }
    if (bgRVals.length < 20) return;
    bgRVals.sort((a, b) => a - b);
    bgGVals.sort((a, b) => a - b);
    bgBVals.sort((a, b) => a - b);
    const midIdx = Math.floor(bgRVals.length / 2);
    const bg = { r: bgRVals[midIdx], g: bgGVals[midIdx], b: bgBVals[midIdx] };

    // Core color
    let minX = w, maxX = 0, minY = h, maxY = 0;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        if (mask[y * w + x]) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    const cxMin = minX + (maxX - minX) * 0.25, cxMax = minX + (maxX - minX) * 0.75;
    const cyMin = minY + (maxY - minY) * 0.25, cyMax = minY + (maxY - minY) * 0.75;
    let coreR = 0, coreG = 0, coreB = 0, coreCount = 0;
    for (let y = Math.floor(cyMin); y < cyMax; y += step) {
      for (let x = Math.floor(cxMin); x < cxMax; x += step) {
        const i = y * w + x;
        if (!mask[i]) continue;
        const idx = i * 4;
        coreR += d[idx]; coreG += d[idx + 1]; coreB += d[idx + 2];
        coreCount++;
      }
    }
    if (coreCount < 50) return;
    const fg = { r: coreR / coreCount, g: coreG / coreCount, b: coreB / coreCount };
    const fgBgDist = colorDistance(fg, bg);

    if (fgBgDist < 8) {
      this.splitMaskByErosion(mask, w, h, clickPoint);
      return;
    }

    // Find interior bg-colored pixels
    const maxGapDist = fgBgDist < 40 ? fgBgDist * 0.75 : fgBgDist * 0.5;
    const gapMask = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        const idx = i * 4;
        const px = { r: d[idx], g: d[idx + 1], b: d[idx + 2] };
        const distToBg = colorDistance(px, bg);
        const distToFg = colorDistance(px, fg);
        if (distToBg < distToFg * 0.7 && distToBg < maxGapDist) {
          gapMask[i] = 1;
        }
      }
    }

    morphOpen(gapMask, w, h, 2);
    morphClose(gapMask, w, h, 3);

    // Remove gap from mask, find connected components
    const testMask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) {
      testMask[i] = (mask[i] && !gapMask[i]) ? 1 : 0;
    }

    const components = connectedComponents(testMask, w, h);
    if (components.length < 2) return;

    const totalArea = components.reduce((s, c) => s + c.area, 0);
    const significant = components.filter(c => c.area > totalArea * 0.05);
    if (significant.length < 2) return;

    // Keep component containing click point
    let keepComp = significant[0];
    let keepSet = null;
    if (clickPoint) {
      const cpIdx = Math.round(clickPoint.y) * w + Math.round(clickPoint.x);
      for (const comp of significant) {
        const compSet = new Set(comp.pixels);
        if (compSet.has(cpIdx)) {
          keepComp = comp;
          keepSet = compSet;
          break;
        }
      }
    }

    // Apply split
    if (!keepSet) keepSet = new Set(keepComp.pixels);
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] && testMask[i] && !keepSet.has(i)) {
        mask[i] = 0;
      }
    }
    this.#log(`Split by background gap: kept ${keepComp.area} of ${totalArea} pixels`);
  }

  // ============================================================
  // Split by Erosion (Feature #8)
  // ============================================================

  /**
   * Progressive erosion to break thin bridges between same-color pieces.
   * CC labels the eroded mask, dilates back the component containing the click point.
   * Ported from cadShot.html splitMaskByErosion.
   */
  splitMaskByErosion(mask, w, h, clickPoint) {
    let maskArea = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) maskArea++;
    if (maskArea < 200) return;

    const minDim = Math.min(w, h);
    const maxRadius = Math.max(3, Math.floor(minDim * 0.015));

    for (let radius = 2; radius <= maxRadius; radius++) {
      const eroded = erodeMask(mask, w, h, radius);

      // Count connected components in eroded mask
      const components = connectedComponents(eroded, w, h);
      if (components.length < 2) continue;

      const totalArea = components.reduce((s, c) => s + c.area, 0);
      const significant = components.filter(c => c.area > totalArea * 0.08);
      if (significant.length < 2) continue;

      // Find component containing click point
      let keepComp = significant[0];
      if (clickPoint) {
        const cpx = Math.round(clickPoint.x), cpy = Math.round(clickPoint.y);
        for (const comp of significant) {
          for (const pIdx of comp.pixels) {
            const py = (pIdx / w) | 0, px = pIdx - py * w;
            if (Math.abs(px - cpx) < 5 && Math.abs(py - cpy) < 5) {
              keepComp = comp;
              break;
            }
          }
        }
      }

      // Create mask of kept component, dilate back
      const keptMask = new Uint8Array(w * h);
      for (const pIdx of keepComp.pixels) keptMask[pIdx] = 1;
      const dilated = dilateMask(keptMask, w, h, radius);

      // Intersect with original
      let removed = 0;
      for (let i = 0; i < mask.length; i++) {
        if (mask[i] && !dilated[i]) {
          mask[i] = 0;
          removed++;
        }
      }
      if (removed > 0) {
        this.#log(`Erosion split at radius=${radius}: removed ${removed}px`);
      }
      return;
    }
  }

  // ============================================================
  // Auto-Detect All (with offset grid - Feature #9)
  // ============================================================

  /**
   * Run grid-based auto-detection to find all pattern pieces in the image.
   * Includes offset grid (second pass shifted by half-step) to catch pieces
   * at grid intersections.
   * @param {object} params
   * @param {number} [params.gridSize=8] - Grid density for point sampling
   * @param {number} [params.maskThreshold=0.85] - Minimum SAM score to accept
   * @param {number} [params.epsilon=2.0] - RDP simplification tolerance
   * @param {number} [params.minPieceAreaPercent=1] - Minimum piece area as % of image
   * @returns {Promise<Array<{id: number, contour: number[][], holes: Array, area: number, score: number, color: string}>>}
   */
  async autoDetectAll(params = {}) {
    if (!this.#imageEmbeddings) throw new Error('No image loaded — call loadImage() first');

    const {
      gridSize = 12,
      maskThreshold = 0.80,
      epsilon = 2.0,
      minPieceAreaPercent = 2
    } = params;

    const tf = await loadTransformers();
    const { Tensor } = tf;

    const SAM_DIM = 1024;
    const imgArea = this.#imgW * this.#imgH;
    const minAreaPixels = (minPieceAreaPercent / 100) * imgArea;

    // Step 1: Generate grid points + offset grid (Feature #9)
    const gridPoints = [];
    const stepX = SAM_DIM / gridSize;
    const stepY = SAM_DIM / gridSize;

    // Primary grid
    for (let gy = 0; gy < gridSize; gy++) {
      for (let gx = 0; gx < gridSize; gx++) {
        gridPoints.push({
          x: Math.round(stepX * (gx + 0.5)),
          y: Math.round(stepY * (gy + 0.5))
        });
      }
    }
    // Offset grid (shifted by half-step)
    for (let gy = 0; gy < gridSize - 1; gy++) {
      for (let gx = 0; gx < gridSize - 1; gx++) {
        gridPoints.push({
          x: Math.round(stepX * (gx + 1.0)),
          y: Math.round(stepY * (gy + 1.0))
        });
      }
    }

    this.#log(`Auto-detect: ${gridPoints.length} grid points (incl. offset pass), threshold=${maskThreshold}`);
    this.#progress(0.05);

    // Get image data for background filtering
    let imageDataArr = null;
    if (this.#sourceCanvas) {
      const ctx = this.#sourceCanvas.getContext('2d');
      const imgD = ctx.getImageData(0, 0, this.#imgW, this.#imgH);
      imageDataArr = imgD.data;
    }

    // Step 2: For each point, run segmentation and collect valid masks
    const candidateMasks = [];

    for (let i = 0; i < gridPoints.length; i++) {
      const point = gridPoints[i];
      try {
        const input_points = new Tensor('float32', [point.x, point.y], [1, 1, 1, 2]);
        const input_labels = new Tensor('int64', [1n], [1, 1, 1]);
        const outputs = await this.#model({ ...this.#imageEmbeddings, input_points, input_labels });

        const scores = outputs.iou_scores.data;
        const maskDims = outputs.pred_masks.dims;
        const maskH = maskDims[maskDims.length - 2];
        const maskW = maskDims[maskDims.length - 1];
        const maskSize = maskW * maskH;
        const numMasks = scores.length;

        for (let m = 0; m < numMasks; m++) {
          const score = Number(scores[m]);
          if (score < maskThreshold) continue;

          const maskOffset = m * maskSize;
          const rawSlice = outputs.pred_masks.data.slice(maskOffset, maskOffset + maskSize);
          const binaryMask = new Uint8Array(maskSize);
          let area = 0;
          for (let p = 0; p < maskSize; p++) {
            if (rawSlice[p] > 0) { binaryMask[p] = 1; area++; }
          }
          const areaPercent = (area / maskSize) * 100;
          if (areaPercent < (minPieceAreaPercent * 0.5)) continue;

          candidateMasks.push({
            data: binaryMask, w: maskW, h: maskH,
            area, areaPercent, score
          });
        }
      } catch (e) {
        continue;
      }

      this.#progress(0.05 + (i / gridPoints.length) * 0.55);
      if (i % 4 === 0) await new Promise(r => setTimeout(r, 0));
    }

    this.#log(`Collected ${candidateMasks.length} candidate masks`);
    this.#progress(0.60);

    // Step 3: Deduplicate by IoU > 0.7
    candidateMasks.sort((a, b) => b.score - a.score);
    const kept = [];
    const discarded = new Set();

    for (let i = 0; i < candidateMasks.length; i++) {
      if (discarded.has(i)) continue;
      const maskA = candidateMasks[i];
      kept.push(maskA);

      for (let j = i + 1; j < candidateMasks.length; j++) {
        if (discarded.has(j)) continue;
        const maskB = candidateMasks[j];
        if (maskA.w !== maskB.w || maskA.h !== maskB.h) continue;
        const iou = computeIoU(maskA.data, maskB.data, maskA.w * maskA.h);
        if (iou > 0.7) {
          discarded.add(j);
        }
      }
    }

    this.#log(`After IoU dedup: ${kept.length} masks`);
    this.#progress(0.70);

    // Step 4: Filter background masks (edge-touching + color-based)
    const nonBackground = [];
    for (const mask of kept) {
      const edgeInfo = countEdgeTouches(mask.data, mask.w, mask.h);
      if (edgeInfo.count >= 3) continue;

      // Color-based background filter (Feature #3)
      if (imageDataArr) {
        const upscaled = upscaleMaskBilinear(mask.data, mask.w, mask.h, this.#imgW, this.#imgH);
        if (this.#isBackgroundMask(upscaled, this.#imgW, this.#imgH, imageDataArr, mask.score)) {
          continue;
        }
      }

      nonBackground.push(mask);
    }

    this.#log(`After background filter: ${nonBackground.length} masks`);
    this.#progress(0.75);

    // Step 5: Paper detection (Feature #4)
    let paperIdx = -1;
    const pieces = [];

    for (let mi = 0; mi < nonBackground.length; mi++) {
      const mask = nonBackground[mi];
      const upscaled = upscaleMaskBilinear(mask.data, mask.w, mask.h, this.#imgW, this.#imgH);

      // Per-mask post-processing: refineMaskByBackground then splitMaskByBackgroundGap
      if (imageDataArr) {
        refineMaskByBackground(upscaled, this.#imgW, this.#imgH, imageDataArr);
      }

      // Compute mask centroid as proxy click point for splitMaskByBackgroundGap
      let centroidX = 0, centroidY = 0, centroidCount = 0;
      const centroidStep = Math.max(1, Math.floor(Math.sqrt((this.#imgW * this.#imgH) / 50000)));
      for (let y = 0; y < this.#imgH; y += centroidStep) {
        for (let x = 0; x < this.#imgW; x += centroidStep) {
          if (upscaled[y * this.#imgW + x]) {
            centroidX += x;
            centroidY += y;
            centroidCount++;
          }
        }
      }
      if (centroidCount > 0) {
        const clickPoint = { x: centroidX / centroidCount, y: centroidY / centroidCount };
        this.splitMaskByBackgroundGap(upscaled, this.#imgW, this.#imgH, clickPoint);
      }

      morphClose(upscaled, this.#imgW, this.#imgH, 2);

      // Check for calibration paper
      const paperInfo = this.detectCalibrationPaper(upscaled, this.#imgW, this.#imgH);
      if (paperInfo && paperInfo.rectangularity > 0.88) {
        paperIdx = mi;
        this.#log(`Paper detected: ${paperInfo.areaPercent.toFixed(1)}% of image`);
        continue; // Exclude paper from pieces
      }

      // Connected-component labeling
      const components = connectedComponents(upscaled, this.#imgW, this.#imgH);

      for (const comp of components) {
        if (pieces.length >= MAX_PIECES) break;
        if (comp.area < minAreaPixels) continue;

        const compMask = new Uint8Array(this.#imgW * this.#imgH);
        for (const pIdx of comp.pixels) {
          compMask[pIdx] = 1;
        }

        const rawContour = maskToContourMarching(compMask, this.#imgW, this.#imgH);
        if (rawContour.length < 6) continue;

        const smoothed = smoothContour(rawContour, 2);
        const simplified = rdpSimplifyXY(smoothed, epsilon);
        const contour = simplified.map(p => [p.x, p.y]);

        if (contour.length < 4) continue;

        const holeResults = findHoles(compMask, this.#imgW, this.#imgH, 0.05);
        const holes = holeResults.map(h => {
          const pts = rdpSimplifyXY(smoothContour(h.contour, 2), epsilon);
          return pts.map(p => [p.x, p.y]);
        });

        // Deduplicate at image scale
        let isDuplicate = false;
        for (const existing of pieces) {
          if (existing._mask) {
            const iou = computeIoU(compMask, existing._mask, this.#imgW * this.#imgH);
            if (iou > 0.7) { isDuplicate = true; break; }
          }
        }
        if (isDuplicate) continue;

        const id = this.#nextPieceId++;
        const piece = {
          id, contour, holes,
          area: comp.area,
          score: mask.score,
          color: getPieceColor(pieces.length),
          accepted: false,
          _mask: compMask
        };
        pieces.push(piece);

        if (this.#onPieceDetected) {
          this.#onPieceDetected(piece);
        }
      }

      this.#progress(0.75 + (mi / nonBackground.length) * 0.20);
    }

    for (const piece of pieces) {
      this.#pieces.push(piece);
    }

    this.#progress(1.0);
    this.#log(`Auto-detect complete: ${pieces.length} pieces found`);

    return pieces.map(p => ({
      id: p.id, contour: p.contour, holes: p.holes,
      area: p.area, score: p.score, color: p.color
    }));
  }

  // ============================================================
  // Contour Processing
  // ============================================================

  /**
   * Optimize a contour with RDP simplification and optional smoothing passes.
   */
  optimizeContour(contour, params = {}) {
    const { epsilon = 2.0, smoothPasses = 1 } = params;
    let pts = contour.map(([x, y]) => ({ x, y }));
    for (let i = 0; i < smoothPasses; i++) {
      pts = smoothContour(pts, 2);
    }
    pts = rdpSimplifyXY(pts, epsilon);
    return pts.map(p => [p.x, p.y]);
  }

  /**
   * Detect notches (sharp concavities) on a contour.
   */
  detectNotches(contour, pixelsPerMm = 1) {
    if (contour.length < 10) return [];

    const notches = [];
    const n = contour.length;
    const perimeterPx = this.#computePerimeter(contour);
    const avgSpacing = perimeterPx / n;
    const targetStepPx = 5 * pixelsPerMm;
    const step = Math.max(2, Math.min(Math.round(targetStepPx / avgSpacing), Math.floor(n / 4)));
    const angleThreshold = Math.PI * 0.55;
    const minDepth = 2 * pixelsPerMm;

    for (let i = 0; i < n; i++) {
      const prevIdx = ((i - step) % n + n) % n;
      const nextIdx = (i + step) % n;
      const curr = contour[i], prev = contour[prevIdx], next = contour[nextIdx];

      const vPrevX = prev[0] - curr[0], vPrevY = prev[1] - curr[1];
      const vNextX = next[0] - curr[0], vNextY = next[1] - curr[1];
      const magPrev = Math.sqrt(vPrevX * vPrevX + vPrevY * vPrevY);
      const magNext = Math.sqrt(vNextX * vNextX + vNextY * vNextY);
      if (magPrev < 1 || magNext < 1) continue;

      const dot = vPrevX * vNextX + vPrevY * vNextY;
      const cosAngle = dot / (magPrev * magNext);
      const angle = Math.acos(Math.max(-1, Math.min(1, cosAngle)));
      const cross = vPrevX * vNextY - vPrevY * vNextX;

      if (angle >= angleThreshold) continue;

      const lineX = next[0] - prev[0], lineY = next[1] - prev[1];
      const lineLen = Math.sqrt(lineX * lineX + lineY * lineY);
      if (lineLen < 1) continue;
      const depth = Math.abs(lineY * curr[0] - lineX * curr[1] + next[0] * prev[1] - next[1] * prev[0]) / lineLen;
      if (depth < minDepth) continue;
      if (cross >= 0) continue;

      notches.push({ index: i, point: [curr[0], curr[1]], angle, depth });
    }

    // Deduplicate nearby notches
    const filtered = [];
    for (const notch of notches) {
      let tooClose = false;
      for (const existing of filtered) {
        const idxDist = Math.min(Math.abs(notch.index - existing.index), n - Math.abs(notch.index - existing.index));
        if (idxDist < step) {
          if (notch.angle < existing.angle) {
            filtered.splice(filtered.indexOf(existing), 1);
          } else {
            tooClose = true;
          }
          break;
        }
      }
      if (!tooClose) filtered.push(notch);
    }
    return filtered;
  }

  #computePerimeter(contour) {
    let len = 0;
    const n = contour.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const dx = contour[j][0] - contour[i][0];
      const dy = contour[j][1] - contour[i][1];
      len += Math.sqrt(dx * dx + dy * dy);
    }
    return len;
  }

  // ============================================================
  // Pieces Management
  // ============================================================

  getPieces() {
    return this.#pieces.map(p => ({
      id: p.id, contour: p.contour, holes: p.holes,
      area: p.area, score: p.score, color: p.color,
      accepted: p.accepted, partName: p.partName || '', sizeLabel: p.sizeLabel || ''
    }));
  }

  acceptPiece(id) {
    const piece = this.#pieces.find(p => p.id === id);
    if (piece) { piece.accepted = true; this.#log(`Piece ${id} accepted`); }
  }

  rejectPiece(id) {
    const idx = this.#pieces.findIndex(p => p.id === id);
    if (idx >= 0) { this.#pieces.splice(idx, 1); this.#log(`Piece ${id} rejected`); }
  }

  clearPieces() {
    this.#pieces = [];
    this.#nextPieceId = 1;
    this.#log('All pieces cleared');
  }

  /**
   * Set part name and size label for a piece.
   */
  setPieceMetadata(id, { partName, sizeLabel, foot } = {}) {
    const piece = this.#pieces.find(p => p.id === id);
    if (!piece) return;
    if (partName !== undefined) piece.partName = partName;
    if (sizeLabel !== undefined) piece.sizeLabel = sizeLabel;
    if (foot !== undefined) piece.foot = foot;
  }

  // ============================================================
  // Size Series Mode (Feature #5)
  // ============================================================

  /**
   * Toggle between single and series mode.
   */
  setSizeSeriesMode(enabled) {
    this.#sizeSeriesMode = enabled;
    this.#log(`Mode: ${enabled ? 'Size Series' : 'Single'}`);
  }

  get sizeSeriesMode() { return this.#sizeSeriesMode; }

  /**
   * Generate size list from range.
   */
  generateSizeList(from, to) {
    this.#sizeList = [];
    for (let s = from; s <= to; s++) this.#sizeList.push(String(s));
    if (!this.#activeSize && this.#sizeList.length) this.#activeSize = this.#sizeList[0];
    return this.#sizeList;
  }

  get sizeList() { return [...this.#sizeList]; }
  get activeSize() { return this.#activeSize; }
  set activeSize(sz) { this.#activeSize = sz; }

  /**
   * Part name management.
   */
  addPart(name) {
    name = name.trim();
    if (!name || this.#parts.includes(name)) return;
    this.#parts.push(name);
  }

  removePart(name) {
    this.#parts = this.#parts.filter(p => p !== name);
  }

  get parts() { return [...this.#parts]; }
  get activePart() { return this.#activePart; }
  set activePart(name) { this.#activePart = name; }

  /**
   * Per-part-per-size done tracking.
   */
  markDone(partName, sizeLabel) {
    this.#doneParts.add(`${partName}_${sizeLabel}`);
  }

  isDone(partName, sizeLabel) {
    return this.#doneParts.has(`${partName}_${sizeLabel}`);
  }

  get doneParts() { return new Set(this.#doneParts); }

  /**
   * Trigger capture flow (for size series mode).
   * Freezes frame if camera is active, detects pieces, auto-sorts by area,
   * and assigns size labels linearly.
   */
  async triggerCapture() {
    if (!this.modelReady) { this.#log('Model not loaded', 'warn'); return null; }
    if (!this.#imgW) { this.#log('No image', 'warn'); return null; }

    if (this.#onCaptureTriggered) this.#onCaptureTriggered();

    // If camera active and not frozen, freeze
    if (this.#videoElement && !this.#frozen) {
      await this.freezeFrame();
    }

    // Auto-detect
    const pieces = await this.autoDetectAll();

    // In series mode, auto-sort by area and assign sizes
    if (this.#sizeSeriesMode && pieces.length > 1 && this.#sizeList.length > 0) {
      pieces.sort((a, b) => a.area - b.area);
      const from = parseInt(this.#sizeList[0]) || 0;
      const to = parseInt(this.#sizeList[this.#sizeList.length - 1]) || 0;
      const count = pieces.length;
      const step = count > 1 ? (to - from) / (count - 1) : 0;
      pieces.forEach((p, i) => {
        const sizeLabel = String(Math.round(from + i * step));
        const piece = this.#pieces.find(pp => pp.id === p.id);
        if (piece) {
          piece.sizeLabel = sizeLabel;
          piece.partName = this.#activePart || '';
        }
      });
    }

    return pieces;
  }

  // ============================================================
  // Foot Pedal / Gamepad / WebHID Support (Feature #6)
  // ============================================================

  /**
   * Setup keyboard spacebar listener.
   */
  #setupKeyboardCapture() {
    if (typeof document === 'undefined') return;
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !e.repeat && this.modelReady && this.#imgW > 0) {
        e.preventDefault();
        this.triggerCapture();
      }
    });
  }

  /**
   * Setup gamepad polling. Call after `gamepadconnected` event.
   */
  setupGamepad() {
    if (typeof window === 'undefined') return;
    window.addEventListener('gamepadconnected', (e) => {
      this.#gamepadIndex = e.gamepad.index;
      this.#log(`Gamepad connected: ${e.gamepad.id}`);
      this.#pollGamepad();
    });
  }

  #pollGamepad() {
    if (this.#gamepadIndex === null) return;
    const gp = navigator.getGamepads()[this.#gamepadIndex];
    if (gp && gp.buttons.some(b => b.pressed)) {
      const now = Date.now();
      if (now - this.#lastGamepadPress > 500) {
        this.#lastGamepadPress = now;
        this.triggerCapture();
      }
    }
    this.#gamepadPollId = requestAnimationFrame(() => this.#pollGamepad());
  }

  /**
   * Request and connect a WebHID device (foot pedal).
   * @returns {Promise<boolean>} true if connected
   */
  async connectHIDDevice() {
    if (!navigator.hid) {
      this.#log('WebHID not supported — use spacebar or gamepad', 'warn');
      return false;
    }
    try {
      const devices = await navigator.hid.requestDevice({ filters: [] });
      if (devices.length) {
        const device = devices[0];
        await device.open();
        device.addEventListener('inputreport', () => this.triggerCapture());
        this.#hidDevice = device;
        this.#log(`HID pedal connected: ${device.productName}`);
        return true;
      }
    } catch (e) {
      if (e.name !== 'AbortError') this.#log(`HID error: ${e.message}`, 'warn');
    }
    return false;
  }

  // ============================================================
  // Calibration (delegates to HideDetector)
  // ============================================================

  async calibrate(points, knownW, knownH) {
    return await this.#hideDetector.calibrate(points, knownW, knownH);
  }

  getCalibration() {
    return this.#hideDetector.getCalibration();
  }

  contourToMm(contour) {
    return this.#hideDetector.polygonToMm(contour);
  }

  // ============================================================
  // Session Persistence (Feature #10)
  // ============================================================

  /**
   * Save current session (pieces, parts, sizes, done tracking) to localStorage.
   */
  saveSession() {
    try {
      const data = {
        pieces: this.#pieces.map(p => ({
          id: p.id, contour: p.contour, holes: p.holes,
          area: p.area, score: p.score, color: p.color,
          accepted: p.accepted, partName: p.partName || '',
          sizeLabel: p.sizeLabel || '', foot: p.foot || ''
        })),
        parts: this.#parts,
        sizeList: this.#sizeList,
        activeSize: this.#activeSize,
        activePart: this.#activePart,
        doneParts: [...this.#doneParts],
        sizeSeriesMode: this.#sizeSeriesMode,
        nextPieceId: this.#nextPieceId,
        timestamp: Date.now()
      };

      const jsonStr = JSON.stringify(data);
      const encryptionKey = getOrCreateEncryptionKey();
      const encryptedStr = CryptoJS.AES.encrypt(jsonStr, encryptionKey).toString();
      localStorage.setItem(SESSION_STORAGE_KEY, encryptedStr);

      this.#log('Session saved');
    } catch (e) {
      this.#log(`Session save error: ${e.message}`, 'warn');
    }
  }

  /**
   * Load session from localStorage.
   * @returns {boolean} true if session was loaded
   */
  loadSession() {
    try {
      const encryptedStr = localStorage.getItem(SESSION_STORAGE_KEY);
      if (!encryptedStr) return false;

      let dataStr;
      try {
        const encryptionKey = getOrCreateEncryptionKey();
        const bytes = CryptoJS.AES.decrypt(encryptedStr, encryptionKey);
        dataStr = bytes.toString(CryptoJS.enc.Utf8);
      } catch (decryptionErr) {
        // Fallback for unencrypted legacy data
        this.#log('Decryption failed, falling back to raw parse', 'warn');
        dataStr = encryptedStr;
      }

      if (!dataStr) return false;
      const data = JSON.parse(dataStr);

      if (data.pieces) {
        this.#pieces = data.pieces;
        this.#nextPieceId = data.nextPieceId || (data.pieces.length + 1);
      }
      if (data.parts) this.#parts = data.parts;
      if (data.sizeList) this.#sizeList = data.sizeList;
      if (data.activeSize) this.#activeSize = data.activeSize;
      if (data.activePart) this.#activePart = data.activePart;
      if (data.doneParts) this.#doneParts = new Set(data.doneParts);
      if (data.sizeSeriesMode !== undefined) this.#sizeSeriesMode = data.sizeSeriesMode;
      this.#log('Session loaded');
      return true;
    } catch (e) {
      this.#log(`Session load error: ${e.message}`, 'warn');
      return false;
    }
  }

  /**
   * Clear saved session.
   */
  clearSession() {
    try {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch (e) { /* ignore */ }
    this.#pieces = [];
    this.#parts = [];
    this.#sizeList = [];
    this.#activeSize = '';
    this.#activePart = null;
    this.#doneParts.clear();
    this.#nextPieceId = 1;
    this.#log('Session cleared');
  }

  // ============================================================
  // IndexedDB Push to PatternIQ (Feature #11)
  // ============================================================

  /**
   * Push accepted pieces to PatternIQ via IndexedDB.
   * Writes to `PatternIQ_DigitizerPush` store with polygon/holes/partName/sizeLabel/foot.
   * @returns {Promise<boolean>} true on success
   */
  async pushToPatternIQ() {
    const accepted = this.#pieces.filter(p => p.accepted);
    if (accepted.length === 0) {
      this.#log('No accepted pieces to push', 'warn');
      return false;
    }

    const calibration = this.getCalibration();
    const isCalibrated = calibration !== null;

    const pieces = accepted.map(p => {
      let polygon = p.contour;
      let holes = p.holes;
      if (isCalibrated) {
        polygon = this.contourToMm(polygon) || polygon;
        holes = holes.map(h => this.contourToMm(h) || h);
      }
      return {
        pts: polygon.map(pt => [+(Array.isArray(pt) ? pt[0] : pt.x).toFixed(2), +(Array.isArray(pt) ? pt[1] : pt.y).toFixed(2)]),
        holes: holes.map(h => h.map(pt => [+(Array.isArray(pt) ? pt[0] : pt.x).toFixed(2), +(Array.isArray(pt) ? pt[1] : pt.y).toFixed(2)])),
        partName: p.partName || '',
        sizeLabel: p.sizeLabel || '',
        foot: p.foot || ''
      };
    });

    return new Promise((resolve) => {
      const req = indexedDB.open(IDB_PUSH_DB, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_PUSH_STORE)) {
          db.createObjectStore(IDB_PUSH_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction(IDB_PUSH_STORE, 'readwrite');
        tx.objectStore(IDB_PUSH_STORE).put({
          id: 'digitizer_push',
          pieces,
          timestamp: Date.now()
        });
        tx.oncomplete = () => {
          this.#log(`Pushed ${pieces.length} piece(s) to PatternIQ`);
          resolve(true);
        };
        tx.onerror = () => {
          this.#log('IndexedDB write error', 'error');
          resolve(false);
        };
      };
      req.onerror = () => {
        this.#log('IndexedDB open error', 'error');
        resolve(false);
      };
    });
  }

  // ==========================================================================
  // Navigation
  // ==========================================================================

  bindNavigationLinks() {
    const linkPatterninq = document.getElementById('link-patterninq');
    if (linkPatterninq) {
      linkPatterninq.addEventListener('click', (e) => {
        e.preventDefault();
        if (window.parent !== window) {
          window.parent.postMessage({ type: 'navigate', view: 'patterninq' }, '*');
        } else {
          window.location.href = 'patternINQ.html';
        }
      });
    }

    const linkNestq = document.getElementById('link-nestq');
    if (linkNestq) {
      linkNestq.addEventListener('click', (e) => {
        e.preventDefault();
        if (window.parent !== window) {
          window.parent.postMessage({ type: 'navigate', view: 'nesting' }, '*');
        } else {
          window.location.href = 'PatterNestQ.html';
        }
      });
    }

    const btnOpenNest = document.getElementById('btnOpenNest');
    if (btnOpenNest) {
        btnOpenNest.replaceWith(btnOpenNest.cloneNode(true));
        const newBtnOpenNest = document.getElementById('btnOpenNest');
        newBtnOpenNest.addEventListener('click', () => {
            if (window.parent !== window) {
                window.parent.postMessage({ type: 'navigate', view: 'nesting' }, '*');
            } else {
                window.open('PatterNestQ.html', '_blank');
            }
        });
    }
  }

  // ============================================================
  // Export
  // ============================================================

  /**
   * Get session data ready for push to pattern library.
   */
  getSessionData() {
    const calibration = this.getCalibration();
    const isCalibrated = calibration !== null;

    const pieces = this.#pieces
      .filter(p => p.accepted)
      .map(p => {
        let polygon = p.contour;
        let holes = p.holes;

        if (isCalibrated) {
          polygon = this.contourToMm(polygon) || polygon;
          holes = holes.map(h => this.contourToMm(h) || h);
        }

        return {
          polygon, holes,
          partName: p.partName || '',
          sizeLabel: p.sizeLabel || '',
          foot: p.foot || '',
          isCalibrated
        };
      });

    return { pieces };
  }

  // ============================================================
  // Cleanup
  // ============================================================

  /**
   * Dispose of all resources.
   */
  dispose() {
    this.stopCamera();
    if (this.#gamepadPollId) {
      cancelAnimationFrame(this.#gamepadPollId);
      this.#gamepadPollId = null;
    }
    if (this.#hidDevice) {
      try { this.#hidDevice.close(); } catch (e) { /* ignore */ }
      this.#hidDevice = null;
    }
    this.#model = null;
    this.#processor = null;
    this.#imageEmbeddings = null;
  }
}
