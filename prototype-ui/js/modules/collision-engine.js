/**
 * CollisionEngine — direct port from PatterNestQ.html v9.
 * WebGL2 GPU sweep for fast placement, canvas fallback guaranteed correct.
 */

import { polyBbox, polyArea, rotateGroup } from './geometry.js';

let MAX_GPU_FP = 14000;

export class CollisionEngine {
  constructor(sw, sh, spacing, hide, options = {}) {
    this.sw = sw;
    this.sh = sh;
    this.spacing = spacing;
    this.hide = hide || null;
    this.ppm = 1;
    this.cw = Math.ceil(sw);
    this.ch = Math.ceil(sh);
    this.gpuMode = false;
    this._gravity = options.gravity || 'bl';
    this._centerX = options.centerX || sw / 2;
    this._centerY = options.centerY || sh / 2;

    const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
    this._maskCtx = mk(this.cw, this.ch).getContext('2d', { willReadFrequently: true });
    this._partsCtx = mk(this.cw, this.ch).getContext('2d', { willReadFrequently: true });
    this._tmpCtx = mk(this.cw, this.ch).getContext('2d', { willReadFrequently: true });

    this._buildMask();

    const glc = mk(this.cw, this.ch);
    const gl = glc.getContext('webgl2');
    if (gl) { this.gl = gl; try { this._setupGL(); this.gpuMode = true; } catch (e) { console.warn('WebGL2:', e); } }
  }

  _buildMask() {
    const ctx = this._maskCtx, { cw, ch, ppm: s } = this;
    if (!this.hide) { ctx.clearRect(0, 0, cw, ch); return; }
    ctx.fillStyle = 'rgba(255,255,255,1)';
    ctx.fillRect(0, 0, cw, ch);
    const tmp = document.createElement('canvas'); tmp.width = cw; tmp.height = ch;
    const tc = tmp.getContext('2d');
    tc.fillStyle = 'rgba(255,255,255,1)';
    tc.beginPath();
    this.hide.poly.forEach(([x, y], i) => i === 0 ? tc.moveTo(x * s, y * s) : tc.lineTo(x * s, y * s));
    tc.closePath(); tc.fill();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(tmp, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(255,255,255,1)';
    if (this.hide.holes) {
      for (const hole of this.hide.holes) {
        ctx.beginPath();
        hole.forEach(([x, y], i) => i === 0 ? ctx.moveTo(x * s, y * s) : ctx.lineTo(x * s, y * s));
        ctx.closePath(); ctx.fill();
      }
    }
    const sp = Math.max(1, this.spacing) * s;
    ctx.strokeStyle = 'rgba(255,255,255,1)';
    ctx.lineWidth = sp * 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    this.hide.poly.forEach(([x, y], i) => i === 0 ? ctx.moveTo(x * s, y * s) : ctx.lineTo(x * s, y * s));
    ctx.closePath(); ctx.stroke();
  }

  _setupGL() {
    const gl = this.gl, { cw, ch } = this;
    const maxTexW = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    MAX_GPU_FP = Math.min(Math.floor(maxTexW / 2), 32000);
    const mkS = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const mkP = (vs, fs) => { const p = gl.createProgram(); gl.attachShader(p, mkS(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mkS(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); return p; };
    const vs = `#version 300 es\nin vec2 a;\nvoid main(){gl_Position=vec4(a,0,1);}`;
    const fs = `#version 300 es
precision highp float;precision highp sampler2D;
uniform sampler2D u_mask,u_parts,u_fp;
uniform int u_fp_n;
uniform ivec2 u_ext,u_sz;
out vec4 o;
void main(){
  ivec2 P=ivec2(gl_FragCoord.xy);
  if(P.x+u_ext.x>u_sz.x||P.y+u_ext.y>u_sz.y){o=vec4(1,0,0,1);return;}
  for(int i=0;i<${MAX_GPU_FP};i++){
    if(i>=u_fp_n)break;
    vec4 fp=texelFetch(u_fp,ivec2(i,0),0);
    int fx=int(fp.r*255.0+0.5)+int(fp.g*255.0+0.5)*256;
    int fy=int(fp.b*255.0+0.5)+int(fp.a*255.0+0.5)*256;
    ivec2 sp=P+ivec2(fx,fy);
    if(texelFetch(u_mask,sp,0).r>0.5||texelFetch(u_parts,sp,0).r>0.5){o=vec4(1,0,0,1);return;}
  }
  o=vec4(0,1,0,1);
}`;
    this._prog = mkP(vs, fs);
    this._SL = { a: gl.getAttribLocation(this._prog, 'a'), mask: gl.getUniformLocation(this._prog, 'u_mask'), parts: gl.getUniformLocation(this._prog, 'u_parts'), fp: gl.getUniformLocation(this._prog, 'u_fp'), fpN: gl.getUniformLocation(this._prog, 'u_fp_n'), ext: gl.getUniformLocation(this._prog, 'u_ext'), sz: gl.getUniformLocation(this._prog, 'u_sz') };
    this._qbuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._qbuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const mkT = (ifmt, w, h, d, fmt, type) => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, d); [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER, gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T].forEach((p, idx) => gl.texParameteri(gl.TEXTURE_2D, p, [gl.NEAREST, gl.NEAREST, gl.CLAMP_TO_EDGE, gl.CLAMP_TO_EDGE][idx])); return t; };
    const maskData = this._maskCtx.getImageData(0, 0, cw, ch);
    const maskR8 = new Uint8Array(cw * ch);
    for (let i = 0; i < cw * ch; i++) maskR8[i] = (maskData.data[i * 4 + 3] > 64) ? 255 : 0;
    this._maskTex = mkT(gl.R8, cw, ch, maskR8, gl.RED, gl.UNSIGNED_BYTE);
    this._partsTex = mkT(gl.R8, cw, ch, null, gl.RED, gl.UNSIGNED_BYTE);
    this._fpTex = mkT(gl.RGBA8, 1, 1, new Uint8Array(4), gl.RGBA, gl.UNSIGNED_BYTE);
    this._validTex = mkT(gl.RGBA8, cw, ch, null, gl.RGBA, gl.UNSIGNED_BYTE);
    this._fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._validTex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('FBO');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._readBuf = new Uint8Array(cw * ch * 4);
    this._partsR8 = new Uint8Array(cw * ch);
    this._validMap = new Uint8Array(cw * ch);
    this._fpPackBuf = new Uint8Array(MAX_GPU_FP * 4);
    this._partsDirty = true;
  }

  reset() {
    this._partsCtx.clearRect(0, 0, this.cw, this.ch);
    if (this.gpuMode) {
      this._partsR8.fill(0);
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this._partsTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, this.cw, this.ch, 0, gl.RED, gl.UNSIGNED_BYTE, this._partsR8);
      this._partsDirty = false;
    }
  }

  commit(boundary, tx, ty) {
    const ctx = this._partsCtx, lw = Math.max(1, this.spacing * 2) * this.ppm, s = this.ppm;
    ctx.fillStyle = 'rgba(255,255,255,1)'; ctx.strokeStyle = 'rgba(255,255,255,1)';
    ctx.lineWidth = lw; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    boundary.forEach(([lx, ly], i) => i === 0 ? ctx.moveTo((lx + tx) * s, (ly + ty) * s) : ctx.lineTo((lx + tx) * s, (ly + ty) * s));
    ctx.closePath(); ctx.fill(); ctx.stroke();
    if (this.gpuMode) this._partsDirty = true;
  }

  uncommit(boundary, tx, ty) {
    const ctx = this._partsCtx, lw = (Math.max(1, this.spacing * 2) + 2) * this.ppm, s = this.ppm;
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(255,255,255,1)'; ctx.strokeStyle = 'rgba(255,255,255,1)';
    ctx.lineWidth = lw; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    boundary.forEach(([lx, ly], i) => i === 0 ? ctx.moveTo((lx + tx) * s, (ly + ty) * s) : ctx.lineTo((lx + tx) * s, (ly + ty) * s));
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
    if (this.gpuMode) this._partsDirty = true;
  }

  rebuildFrom(placed) { this.reset(); for (const p of placed) this.commit(p.boundary, p.tx, p.ty); }

  _rasteriseTmp(boundary, tx, ty) {
    const ctx = this._tmpCtx, { cw, ch, spacing, ppm: s } = this;
    ctx.clearRect(0, 0, cw, ch);
    const lw = Math.max(1, spacing * 2) * s;
    ctx.fillStyle = 'rgba(255,255,255,1)'; ctx.strokeStyle = 'rgba(255,255,255,1)';
    ctx.lineWidth = lw; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    boundary.forEach(([lx, ly], i) => i === 0 ? ctx.moveTo((lx + tx) * s, (ly + ty) * s) : ctx.lineTo((lx + tx) * s, (ly + ty) * s));
    ctx.closePath(); ctx.fill(); ctx.stroke();
    return ctx.getImageData(0, 0, cw, ch);
  }

  _footprint(boundary) {
    const imgData = this._rasteriseTmp(boundary, 0, 0);
    const d = imgData.data, { cw, ch } = this;
    const b = polyBbox(boundary), sp = Math.ceil(this.spacing) + 1;
    const x0 = Math.max(0, Math.floor(b.x0) - sp), y0 = Math.max(0, Math.floor(b.y0) - sp);
    const x1 = Math.min(cw - 1, Math.ceil(b.x1) + sp), y1 = Math.min(ch - 1, Math.ceil(b.y1) + sp);
    const fp = []; let maxFX = 0, maxFY = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (d[(y * cw + x) * 4 + 3] > 64) { fp.push(x, y); if (x > maxFX) maxFX = x; if (y > maxFY) maxFY = y; }
    }
    return { fp, extX: maxFX + 1, extY: maxFY + 1, n: fp.length / 2 };
  }

  async _gpuFind(boundary) {
    const gl = this.gl, { cw, ch } = this;
    const { fp, extX, extY, n: fpN } = this._footprint(boundary);
    if (fpN === 0) return { tx: -1, ty: -1 };

    if (this._partsDirty) {
      const pd = this._partsCtx.getImageData(0, 0, cw, ch).data;
      for (let i = 0; i < cw * ch; i++) this._partsR8[i] = (pd[i * 4 + 3] > 64) ? 255 : 0;
      gl.bindTexture(gl.TEXTURE_2D, this._partsTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, cw, ch, 0, gl.RED, gl.UNSIGNED_BYTE, this._partsR8);
      this._partsDirty = false;
    }

    const validMap = this._validMap;
    validMap.fill(1);

    const nChunks = Math.ceil(fpN / MAX_GPU_FP);
    for (let c = 0; c < nChunks; c++) {
      const start = c * MAX_GPU_FP, end = Math.min(start + MAX_GPU_FP, fpN);
      const chunkN = end - start;
      const buf = this._fpPackBuf;
      for (let i = 0; i < chunkN; i++) {
        const fx = fp[(start + i) * 2], fy = fp[(start + i) * 2 + 1];
        buf[i * 4] = fx & 0xFF; buf[i * 4 + 1] = (fx >> 8) & 0xFF;
        buf[i * 4 + 2] = fy & 0xFF; buf[i * 4 + 3] = (fy >> 8) & 0xFF;
      }
      gl.bindTexture(gl.TEXTURE_2D, this._fpTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, chunkN, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, buf.subarray(0, chunkN * 4));

      gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo);
      gl.viewport(0, 0, cw, ch);
      gl.useProgram(this._prog);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this._maskTex); gl.uniform1i(this._SL.mask, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this._partsTex); gl.uniform1i(this._SL.parts, 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this._fpTex); gl.uniform1i(this._SL.fp, 2);
      gl.uniform1i(this._SL.fpN, chunkN);
      gl.uniform2i(this._SL.ext, extX, extY);
      gl.uniform2i(this._SL.sz, cw, ch);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._qbuf);
      gl.enableVertexAttribArray(this._SL.a);
      gl.vertexAttribPointer(this._SL.a, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.readPixels(0, 0, cw, ch, gl.RGBA, gl.UNSIGNED_BYTE, this._readBuf);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      for (let i = 0; i < cw * ch; i++) {
        if (this._readBuf[i * 4 + 1] < 128) validMap[i] = 0;
      }
      if (c < nChunks - 1) await new Promise(r => setTimeout(r, 0));
    }

    // Scan validMap by gravity
    if (this._gravity === 'co') {
      const cx = this._centerX * this.ppm, cy = this._centerY * this.ppm;
      let bd = Infinity, bx = -1, by = -1;
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
        if (validMap[y * cw + x]) { const dx = x - cx, dy = y - cy, d = dx * dx + dy * dy; if (d < bd) { bd = d; bx = x; by = y; } }
      }
      return bx === -1 ? { tx: -1, ty: -1 } : { tx: bx, ty: by };
    }
    if (this._gravity === 'tr') {
      for (let y = 0; y < ch; y++) for (let x = cw - 1; x >= 0; x--) { if (validMap[y * cw + x]) return { tx: x, ty: y }; }
    } else if (this._gravity === 'bl') {
      for (let y = ch - 1; y >= 0; y--) for (let x = 0; x < cw; x++) { if (validMap[y * cw + x]) return { tx: x, ty: y }; }
    } else if (this._gravity === 'br') {
      for (let y = ch - 1; y >= 0; y--) for (let x = cw - 1; x >= 0; x--) { if (validMap[y * cw + x]) return { tx: x, ty: y }; }
    } else {
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { if (validMap[y * cw + x]) return { tx: x, ty: y }; }
    }
    return { tx: -1, ty: -1 };
  }

  _canvasFind(boundary) {
    const { cw, ch } = this;
    const { fp, extX, extY, n: fpN } = this._footprint(boundary);
    if (fpN === 0) return null;

    const md = this._maskCtx.getImageData(0, 0, cw, ch).data;
    const pd = this._partsCtx.getImageData(0, 0, cw, ch).data;
    const occ = new Uint8Array(cw * ch);
    for (let i = 0; i < cw * ch; i++) occ[i] = (md[i * 4 + 3] > 64 || pd[i * 4 + 3] > 64) ? 1 : 0;

    const maxTX = cw - extX, maxTY = ch - extY;

    const testPos = (tx, ty) => {
      for (let k = 0; k < fp.length; k += 2) {
        const px = tx + fp[k], py = ty + fp[k + 1];
        if (px < cw && py < ch && occ[py * cw + px]) return false;
      }
      return true;
    };

    if (this._gravity === 'co') {
      const cx = this._centerX * this.ppm, cy = this._centerY * this.ppm;
      let bd = Infinity, best = null;
      for (let ty = 0; ty <= maxTY; ty++) for (let tx = 0; tx <= maxTX; tx++)
        if (testPos(tx, ty)) { const d = (tx + extX / 2 - cx) ** 2 + (ty + extY / 2 - cy) ** 2; if (d < bd) { bd = d; best = { tx, ty }; } }
      return best;
    }
    if (this._gravity === 'tr') {
      for (let ty = 0; ty <= maxTY; ty++) for (let tx = maxTX; tx >= 0; tx--) if (testPos(tx, ty)) return { tx, ty };
    } else if (this._gravity === 'bl') {
      for (let ty = maxTY; ty >= 0; ty--) for (let tx = 0; tx <= maxTX; tx++) if (testPos(tx, ty)) return { tx, ty };
    } else if (this._gravity === 'br') {
      for (let ty = maxTY; ty >= 0; ty--) for (let tx = maxTX; tx >= 0; tx--) if (testPos(tx, ty)) return { tx, ty };
    } else {
      for (let ty = 0; ty <= maxTY; ty++) for (let tx = 0; tx <= maxTX; tx++) if (testPos(tx, ty)) return { tx, ty };
    }
    return null;
  }

  _rotCands(part, steps) {
    const key = `_rot${steps}`;
    if (part[key]) return part[key];
    const cands = Array.from({ length: steps }, (_, i) => {
      const deg = i * (360 / steps), g = rotateGroup(part.boundary, part.children || [], deg);
      const b = polyBbox(g.boundary); return { deg, ...g, area: b.w * b.h };
    }).sort((a, b) => a.area - b.area);
    part[key] = cands;
    return cands;
  }

  async _tryCand(cand) {
    if (this.gpuMode) {
      const r = await this._gpuFind(cand.boundary);
      return (r.tx === -1) ? null : r;
    }
    return this._canvasFind(cand.boundary);
  }

  async findPlacement(part, rotSteps) {
    const cands = this._rotCands(part, rotSteps);
    for (const cand of cands) {
      const pos = await this._tryCand(cand);
      if (pos) return { boundary: cand.boundary, children: cand.children, tx: pos.tx, ty: pos.ty, rot: cand.deg };
    }
    if (rotSteps < 24) {
      const coarseDeg = new Set(cands.map(c => Math.round(c.deg)));
      const fineCands = Array.from({ length: 24 }, (_, i) => {
        const deg = i * 15;
        if (coarseDeg.has(deg)) return null;
        const g = rotateGroup(part.boundary, part.children || [], deg);
        const b = polyBbox(g.boundary); return { deg, ...g, area: b.w * b.h };
      }).filter(Boolean).sort((a, b) => a.area - b.area);
      for (const cand of fineCands) {
        const pos = await this._tryCand(cand);
        if (pos) return { boundary: cand.boundary, children: cand.children, tx: pos.tx, ty: pos.ty, rot: cand.deg };
      }
    }
    return null;
  }

  async findPlacementExact(part) {
    const pos = await this._tryCand({ boundary: part.boundary, children: part.children || [] });
    if (pos) return { boundary: part.boundary, children: part.children || [], tx: pos.tx, ty: pos.ty, rot: 0 };
    return null;
  }

  saveSnapshot() { return this._partsCtx.getImageData(0, 0, this.cw, this.ch); }
  restoreSnapshot(snapshot) { this._partsCtx.putImageData(snapshot, 0, 0); this._partsDirty = true; }

  getDebugCanvas() {
    if (!this._debugCanvas || this._debugCanvas.width !== this.cw) {
      this._debugCanvas = document.createElement('canvas');
      this._debugCanvas.width = this.cw;
      this._debugCanvas.height = this.ch;
      this._debugCtx = this._debugCanvas.getContext('2d');
    }
    const ctx = this._debugCtx;
    ctx.clearRect(0, 0, this.cw, this.ch);
    ctx.drawImage(this._maskCtx.canvas, 0, 0);
    ctx.globalAlpha = 0.9;
    ctx.drawImage(this._partsCtx.canvas, 0, 0);
    ctx.globalAlpha = 1;
    return this._debugCanvas;
  }
}
