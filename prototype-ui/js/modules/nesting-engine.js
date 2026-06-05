/**
 * NestingEngine - High-level controller that orchestrates the nesting algorithm.
 * Uses CollisionEngine for placement and geometry utilities for area calculations.
 * Ported from PatterNestQ v9 nesting logic.
 */

import { CollisionEngine } from "./collision-engine.js";
import { polyArea, polyBbox, polyCentroid, rotateGroup } from "./geometry.js";

/**
 * Orchestrates pattern nesting: sorting, placement, compaction, and efficiency calculation.
 */
export class NestingEngine {
  /**
   * @param {object} options
   * @param {number} options.sheetW - Sheet width in mm
   * @param {number} options.sheetH - Sheet height in mm
   * @param {number} options.spacing - Minimum gap between pieces (mm)
   * @param {number} options.rotSteps - Number of rotation candidates (1,2,4,8,12,24)
   * @param {string} options.gravity - Packing direction: 'tl'|'tr'|'bl'|'br'|'co'
   * @param {string} options.sortStrat - Sort strategy: 'area-desc'|'large-first'|'small-first'
   * @param {number} options.compactPasses - Number of compaction (shake) passes
   * @param {string} options.multishake - Multi-shake mode: 'none'|'lr'|'all4'|'all5'
   * @param {object|null} options.hide - Hide shape {poly, holes} or null for rectangular
   * @param {function} options.onProgress - Progress callback({placed, total, efficiency, phase})
   * @param {function} options.onLog - Log callback(message)
   * @param {Set|null} options.nestMaterials - If provided, only nest parts with matching material
   */
  constructor(options = {}) {
    this._sheetW = options.sheetW || 1000;
    this._sheetH = options.sheetH || 1000;
    this._spacing = options.spacing || 2;
    this._rotSteps = options.rotSteps || 4;
    this._gravity = options.gravity || "tl";
    this._sortStrat = options.sortStrat || "area-desc";
    this._compactPasses = options.compactPasses || 0;
    this._multishake = options.multishake || "none";
    this._hide = options.hide || null;
    this._onProgress = options.onProgress || null;
    this._onLog = options.onLog || null;
    this._nestMaterials = options.nestMaterials || null;

    this._parts = [];
    this._placements = [];
    this._overflow = [];
    this._abort = false;
    this._running = false;
    this._efficiency = 0;
    this._engine = null;
  }

  /**
   * Add parts to the nesting queue.
   * @param {Array} parts - [{id, name, boundary, children, qty, bb, color, material}]
   */
  addParts(parts) {
    for (const part of parts) {
      this._parts.push({
        id: part.id,
        name: part.name,
        boundary: part.boundary,
        children: part.children || [],
        qty: part.qty || 1,
        bb: part.bb || polyBbox(part.boundary),
        color: part.color || "#cccccc",
        material: part.material || null,
        area: part.area || Math.abs(polyArea(part.boundary)),
      });
    }
  }

  /**
   * Run the full nesting algorithm.
   * @returns {Promise<{placements: Array, efficiency: number, stats: object}>}
   */
  async start() {
    this._abort = false;
    this._running = true;
    this._placements = [];
    this._overflow = [];

    this._log("Nesting started");

    // Filter by material if nestMaterials set is provided
    let eligibleParts = this._parts;
    if (this._nestMaterials) {
      eligibleParts = [];
      for (const part of this._parts) {
        if (part.material && this._nestMaterials.has(part.material)) {
          eligibleParts.push(part);
        } else if (!part.material) {
          // Parts with no material are always included
          eligibleParts.push(part);
        } else {
          // Material not in allowed set: overflow
          for (let i = 0; i < part.qty; i++) {
            this._overflow.push({
              ...part,
              copyIndex: i,
              reason: "material-filtered",
            });
          }
        }
      }
    }

    // Step 1: Sort parts
    const sorted = this._sortParts(eligibleParts);
    this._log(
      `Sorted ${sorted.length} unique parts by strategy: ${this._sortStrat}`,
    );

    // Step 2: Build placement queue (expand by qty)
    const queue = [];
    for (const part of sorted) {
      for (let i = 0; i < part.qty; i++) {
        queue.push({ ...part, copyIndex: i });
      }
    }
    this._log(`Placement queue: ${queue.length} items total`);

    const totalItems = queue.length;

    // Step 3: Initialize CollisionEngine
    this._engine = this._createEngine(this._gravity);

    // Step 4: Two-phase placement (split at median area)
    // Phase 1: parts >= median area (large pieces first)
    // Phase 2: parts < median area (void fill - smaller pieces fill gaps)
    let phase1 = queue;
    let phase2 = [];

    if (this._sortStrat === "small-first") {
      // Respect explicit small-first sort: no split
      phase1 = queue;
      phase2 = [];
    } else if (queue.length > 2) {
      const areas = queue.map((p) => p.area).sort((a, b) => a - b);
      const median = areas[Math.floor(areas.length / 2)];
      phase1 = queue.filter((p) => p.area >= median);
      phase2 = queue.filter((p) => p.area < median);
      // Sort each phase large-to-small
      phase1.sort((a, b) => b.area - a.area);
      phase2.sort((a, b) => b.area - a.area);
      this._log(
        `Phase 1: ${phase1.length} large parts, Phase 2: ${phase2.length} void-fill parts`,
      );
    }

    // Run Phase 1
    this._log("Phase 1: placing large parts");
    let failed1 = await this._runPlacementPhase(phase1, totalItems, "P1");

    if (this._abort) {
      this._engine = null;
      this._running = false;
      return this._buildResult();
    }

    // Run Phase 2 (void fill)
    let failed2 = [];
    if (phase2.length > 0 && !this._abort) {
      this._log(`Phase 2: void-filling ${phase2.length} small parts into gaps`);
      failed2 = await this._runPlacementPhase(phase2, totalItems, "P2");
    }

    if (this._abort) {
      this._engine = null;
      this._running = false;
      return this._buildResult();
    }

    // Retry phase: parts that failed in earlier phases get one more attempt
    const allFailed = [...failed1, ...failed2];
    if (allFailed.length > 0 && !this._abort) {
      this._log(`Retry: ${allFailed.length} part(s) for final gap-fill`);
      const stillFailed = await this._runPlacementPhase(
        allFailed,
        totalItems,
        "Retry",
      );
      // Remaining failures go to overflow
      for (const item of stillFailed) {
        this._overflow.push({ ...item, reason: "no-fit" });
      }
    }

    this._log(
      `Placement complete: ${this._placements.length}/${totalItems} placed`,
    );

    // Step 5: Compaction DISABLED — causes boundary violations.
    // TODO: Rewrite from PatterNestQ.html runCompaction() which uses
    // direct _gpuFind/_canvasFind calls instead of findPlacementExact.
    // if (this._compactPasses > 0 && this._placements.length > 1 && !this._abort) {
    //   await this._runCompaction(totalItems);
    // }

    // Step 6: Calculate final stats
    this._efficiency = this._calcEfficiency(this._placements);
    this._log(`Nesting complete. Efficiency: ${this._efficiency.toFixed(1)}%`);

    this._engine = null;
    this._running = false;
    return this._buildResult();
  }

  /**
   * Abort the nesting run.
   */
  stop() {
    this._abort = true;
    this._log("Stop requested");
  }

  /**
   * Returns current placements array.
   * @returns {Array}
   */
  getPlaced() {
    return this._placements.slice();
  }

  /**
   * Returns current efficiency percentage.
   * @returns {number}
   */
  getEfficiency() {
    return this._efficiency;
  }

  // ─── PRIVATE ──────────────────────────────────────────────────────────────

  /**
   * Run a placement phase, returning items that failed to place.
   * @param {Array} items - Items to attempt placing
   * @param {number} totalItems - Total items for progress reporting
   * @param {string} label - Phase label for logging
   * @returns {Promise<Array>} Items that could not be placed
   */
  async _runPlacementPhase(items, totalItems, label) {
    const failed = [];

    for (let i = 0; i < items.length; i++) {
      if (this._abort) {
        // Put remaining items into failed so they can be retried or overflow'd
        failed.push(...items.slice(i));
        break;
      }

      const item = items[i];
      const result = await this._engine.findPlacement(item, this._rotSteps);

      if (result) {
        // Hard reject: if any vertex exceeds sheet bounds, treat as failed placement
        const pbb = polyBbox(result.boundary);
        const outRight = result.tx + pbb.w > this._sheetW;
        const outBottom = result.ty + pbb.h > this._sheetH;
        const outLeft = result.tx < 0;
        const outTop = result.ty < 0;
        if (outRight || outBottom || outLeft || outTop) {
          console.warn(`[NEST] Rejected "${item.name}" — exceeds bounds: tx=${result.tx.toFixed(0)} ty=${result.ty.toFixed(0)} partW=${pbb.w.toFixed(0)} partH=${pbb.h.toFixed(0)} sheet=${this._sheetW}x${this._sheetH}`);
          failed.push(item);
          continue;
        }
        this._engine.commit(result.boundary, result.tx, result.ty);
        const placement = {
          id: item.id,
          name: item.name,
          copyIndex: item.copyIndex,
          boundary: result.boundary,
          children: result.children,
          tx: result.tx,
          ty: result.ty,
          rot: result.rot,
          color: item.color,
          material: item.material,
          area: item.area,
          bb: polyBbox(result.boundary),
        };
        this._placements.push(placement);
      } else {
        failed.push(item);
      }

      // Update efficiency incrementally
      this._efficiency = this._calcEfficiency(this._placements);

      if (this._onProgress) {
        this._onProgress({
          placed: this._placements.length,
          total: totalItems,
          efficiency: this._efficiency,
          phase: "nesting",
        });
      }

      // Yield for UI updates
      await new Promise((r) => setTimeout(r, 0));
    }

    return failed;
  }

  /**
   * Sort parts by the configured strategy.
   * @param {Array} parts
   * @returns {Array} Sorted copy
   */
  _sortParts(parts) {
    const sorted = parts.slice();

    switch (this._sortStrat) {
      case "area-desc":
        sorted.sort((a, b) => {
          const areaA = a.area;
          const areaB = b.area;
          return areaB - areaA;
        });
        break;

      case "large-first":
        sorted.sort((a, b) => {
          const areaA = a.area;
          const areaB = b.area;
          return areaB - areaA;
        });
        break;

      case "small-first":
        sorted.sort((a, b) => {
          const areaA = a.area;
          const areaB = b.area;
          return areaA - areaB;
        });
        break;

      default:
        // No sort, use insertion order
        break;
    }

    return sorted;
  }

  /**
   * Create a CollisionEngine with the given gravity direction.
   * @param {string} gravity
   * @returns {CollisionEngine}
   */
  _createEngine(gravity) {
    let centerX = this._sheetW / 2;
    let centerY = this._sheetH / 2;
    if (this._hide && this._hide.poly && this._hide.poly.length >= 3) {
      const c = polyCentroid(this._hide.poly);
      centerX = c[0];
      centerY = c[1];
    }
    return new CollisionEngine(
      this._sheetW,
      this._sheetH,
      this._spacing,
      this._hide,
      {
        gravity,
        centerX,
        centerY,
      },
    );
  }

  /**
   * Compute raw gravity score (distance to gravity anchor in mm).
   * Lower = closer = better.
   * @param {number} tx
   * @param {number} ty
   * @param {Array} boundary
   * @param {string} gravity
   * @param {object} [b] - Pre-calculated bounding box to optimize performance
   * @returns {number}
   */
  _gravityScore(tx, ty, boundary, gravity, b = null) {
    b = b || polyBbox(boundary);
    if (gravity === "co") {
      let cx = this._sheetW / 2;
      let cy = this._sheetH / 2;
      if (this._hide && this._hide.poly && this._hide.poly.length >= 3) {
        const c = polyCentroid(this._hide.poly);
        cx = c[0];
        cy = c[1];
      }
      const pcx = tx + b.w / 2;
      const pcy = ty + b.h / 2;
      return Math.sqrt((pcx - cx) ** 2 + (pcy - cy) ** 2);
    }
    const right = this._sheetW - tx - b.w;
    const bottom = this._sheetH - ty - b.h;
    if (gravity === "tr") return right + ty;
    if (gravity === "bl") return tx + bottom;
    if (gravity === "br") return right + bottom;
    return tx + ty; // tl default
  }

  /**
   * Area-weighted gravity selection score.
   * Large parts are prioritized during compaction.
   * @param {number} tx
   * @param {number} ty
   * @param {Array} boundary
   * @param {string} gravity
   * @param {object} [b] - Pre-calculated bounding box to optimize performance
   * @returns {number}
   */
  _gravitySelectScore(tx, ty, boundary, gravity, b = null) {
    b = b || polyBbox(boundary);
    return (
      (this._gravityScore(tx, ty, boundary, gravity, b) / (b.w * b.h + 1)) *
      10000
    );
  }

  /**
   * Run compaction passes including multi-shake directions.
   * Uses incremental uncommit/settle algorithm (not full re-pack).
   * @param {number} totalItems - Total items in queue for progress reporting
   */
  async _runCompaction(totalItems) {
    const directions = this._getShakeDirections();

    if (directions.length === 0) {
      // Single direction: run incremental compaction with current gravity
      this._log(`Compacting with gravity: ${this._gravity}`);
      await this._incrementalCompact(this._gravity, totalItems);
      return;
    }

    // Multi-shake: each direction uses incremental settle, then tries overflow placement
    this._log(
      `Multi-shake mode: ${this._multishake} (${directions.length} directions)`,
    );

    let totalNewlyPlaced = 0;

    for (let dirIdx = 0; dirIdx < directions.length; dirIdx++) {
      if (this._abort) break;

      const dir = directions[dirIdx];
      const dirLabel =
        {
          tl: "top-left",
          tr: "top-right",
          bl: "bottom-left",
          br: "bottom-right",
          co: "center",
        }[dir] || dir;
      this._log(
        `Shake ${dirIdx + 1}/${directions.length}: ${dirLabel} — ${this._compactPasses} compaction passes`,
      );

      // Run incremental compaction passes for this direction
      await this._incrementalCompact(dir, totalItems);

      if (this._abort) break;

      // After compacting in this direction, attempt to place overflow items in freed gaps
      const overflowToRetry = this._overflow.filter(
        (o) => o.reason === "no-fit",
      );
      if (overflowToRetry.length > 0 && !this._abort) {
        // Sort smallest first — compaction opens small gaps
        overflowToRetry.sort((a, b) => a.area - b.area);
        this._log(
          `  Trying ${overflowToRetry.length} overflow part(s) in freed gaps`,
        );

        const placed = [];
        for (const item of overflowToRetry) {
          if (this._abort) break;
          const result = await this._engine.findPlacement(item, this._rotSteps);
          if (result) {
            this._engine.commit(result.boundary, result.tx, result.ty);
            this._placements.push({
              id: item.id,
              name: item.name,
              copyIndex: item.copyIndex,
              boundary: result.boundary,
              children: result.children,
              tx: result.tx,
              ty: result.ty,
              rot: result.rot,
              color: item.color,
              material: item.material,
              bb: polyBbox(result.boundary),
            });
            placed.push(item);
            totalNewlyPlaced++;
          }
          await new Promise((r) => setTimeout(r, 0));
        }

        // Remove successfully placed items from overflow
        if (placed.length > 0) {
          const placedSet = new Set(placed);
          this._overflow = this._overflow.filter((o) => !placedSet.has(o));
          this._log(`  Placed ${placed.length} overflow part(s) after shake`);
        }
      }

      // If all overflow resolved, stop shaking
      if (this._overflow.filter((o) => o.reason === "no-fit").length === 0) {
        this._log("All parts placed — stopping shake early");
        break;
      }
    }

    if (totalNewlyPlaced > 0) {
      this._log(
        `Multi-shake complete: ${totalNewlyPlaced} extra part(s) placed through shaking`,
      );
    }
  }

  /**
   * Run incremental compaction passes for a single gravity direction.
   * Uses the correct algorithm: iterate placed parts newest-first, uncommit each,
   * try the same boundary at +-15 degree rotations using the gravity-biased sweep,
   * keep the result with the lowest gravitySelectScore, re-commit.
   *
   * Tracks gravityScore convergence: stops early when delta < 1 between passes.
   *
   * @param {string} gravity - Gravity direction for this compaction
   * @param {number} totalItems - Total items for progress reporting
   */
  async _incrementalCompact(gravity, totalItems) {
    // Rebuild the engine with the correct gravity and all current placements committed
    this._engine = this._createEngine(gravity);
    for (const p of this._placements) {
      this._engine.commit(p.boundary, p.tx, p.ty);
    }

    let prevGravitySum = this._placements.reduce(
      (sum, p) =>
        sum + this._gravityScore(p.tx, p.ty, p.boundary, gravity, p.bb),
      0,
    );

    for (let pass = 0; pass < this._compactPasses; pass++) {
      if (this._abort) break;

      this._log(
        `  Compaction pass ${pass + 1}/${this._compactPasses} (gravity: ${gravity})`,
      );

      let improved = 0;
      const n = this._placements.length;

      // Work newest-first: recently-placed parts have worst positions
      for (let i = n - 1; i >= 0; i--) {
        if (this._abort) break;

        const p = this._placements[i];
        const currentScore = this._gravitySelectScore(
          p.tx,
          p.ty,
          p.boundary,
          gravity,
          p.bb,
        );

        // Uncommit this part from occupancy
        this._engine.uncommit(p.boundary, p.tx, p.ty);

        // Rotation candidates: current rotation +- 15 and +-30 degrees
        const baseDeg = p.rot || 0;
        const unique = [
          ...new Set(
            [-30, -15, 0, 15, 30].map((d) => (baseDeg + d + 360) % 360),
          ),
        ];

        let bestScore = currentScore;
        let bestResult = null;

        for (const deg of unique) {
          if (this._abort) break;

          // Find the original part data to rotate from scratch
          const partData = this._parts.find((x) => x.id === p.id);
          if (!partData) continue;

          const g = rotateGroup(partData.boundary, partData.children, deg);
          const bb = polyBbox(g.boundary);
          if (bb.w > this._sheetW || bb.h > this._sheetH) continue;

          // Normalize to origin — collision engine works in origin-relative coords
          const normBoundary = g.boundary.map(([x, y]) => [x - bb.x0, y - bb.y0]);
          const normChildren = g.children.map(c => ({
            ...c,
            poly: c.poly.map(([x, y]) => [x - bb.x0, y - bb.y0])
          }));
          const normBB = polyBbox(normBoundary);

          const result = await this._engine.findPlacementExact({
            boundary: normBoundary,
            children: normChildren,
            bb: normBB,
          });

          if (!result) continue;
          const score = this._gravitySelectScore(
            result.tx,
            result.ty,
            normBoundary,
            gravity,
            normBB,
          );
          if (score < bestScore) {
            bestScore = score;
            bestResult = {
              boundary: normBoundary,
              children: normChildren,
              tx: result.tx,
              ty: result.ty,
              rot: deg,
              bb: normBB,
            };
          }
        }

        if (this._abort) break;

        // Apply improvement or restore original
        if (bestResult) {
          this._placements[i] = { ...this._placements[i], ...bestResult };
          improved++;
        }

        // Re-commit (original or improved position)
        this._engine.commit(
          this._placements[i].boundary,
          this._placements[i].tx,
          this._placements[i].ty,
        );

        // Progress update
        if (this._onProgress) {
          this._onProgress({
            placed: this._placements.length,
            total: totalItems,
            efficiency: this._calcEfficiency(this._placements),
            phase: "compacting",
          });
        }

        // Yield for UI
        await new Promise((r) => setTimeout(r, 0));
      }

      this._log(`  Pass ${pass + 1} done: ${improved}/${n} parts resettled`);

      // Gravity score convergence check
      const currentGravitySum = this._placements.reduce(
        (sum, p) =>
          sum + this._gravityScore(p.tx, p.ty, p.boundary, gravity, p.bb),
        0,
      );
      const delta = prevGravitySum - currentGravitySum; // positive = improvement
      prevGravitySum = currentGravitySum;

      this._log(`  Gravity score delta: ${delta.toFixed(1)}mm`);

      // Stop early if converged (delta < 1mm improvement)
      if (delta < 1) {
        this._log(
          `  Converged — stopping compaction early at pass ${pass + 1}`,
        );
        break;
      }
    }

    this._efficiency = this._calcEfficiency(this._placements);
  }

  /**
   * Get shake directions based on multishake setting.
   * @returns {string[]} Array of gravity directions to try
   */
  _getShakeDirections() {
    const OPPOSITE = { tl: "br", tr: "bl", bl: "tr", br: "tl", co: "co" };

    switch (this._multishake) {
      case "lr":
        return [this._gravity, OPPOSITE[this._gravity]];
      case "all4":
        return ["tl", "tr", "bl", "br"];
      case "all5":
        return ["tl", "tr", "bl", "br", "co"];
      case "none":
      default:
        return [];
    }
  }

  /**
   * Calculate nesting efficiency as percentage.
   * efficiency = (total placed polygon area / usable sheet area) * 100
   * @param {Array} placements
   * @returns {number}
   */
  _calcEfficiency(placements) {
    if (placements.length === 0) return 0;

    // Sum placed polygon areas
    let placedArea = 0;
    for (const p of placements) {
      placedArea += p.area;
    }

    // Determine usable sheet area
    const usableArea = this._getUsableArea();
    if (usableArea <= 0) return 0;

    return (placedArea / usableArea) * 100;
  }

  /**
   * Get the usable area of the sheet/hide.
   * For hide: polyArea(hide.poly) - sum(polyArea(holes))
   * For rectangle: sheetW * sheetH
   * @returns {number}
   */
  _getUsableArea() {
    if (this._hide) {
      let area = Math.abs(polyArea(this._hide.poly));
      if (this._hide.holes && this._hide.holes.length) {
        for (const hole of this._hide.holes) {
          area -= Math.abs(polyArea(hole));
        }
      }
      return area;
    }
    return this._sheetW * this._sheetH;
  }

  /**
   * Build the final result object.
   * @returns {{placements: Array, efficiency: number, stats: object}}
   */
  _buildResult() {
    return {
      placements: this._placements,
      efficiency: this._efficiency,
      stats: {
        placed: this._placements.length,
        overflow: this._overflow.length,
        overflowItems: this._overflow,
        usableArea: this._getUsableArea(),
        placedArea: this._placements.reduce((sum, p) => sum + p.area, 0),
        sheetW: this._sheetW,
        sheetH: this._sheetH,
        aborted: this._abort,
      },
    };
  }

  /**
   * Emit a log message.
   * @param {string} msg
   */
  _log(msg) {
    if (this._onLog) {
      this._onLog(msg);
    }
  }
}
