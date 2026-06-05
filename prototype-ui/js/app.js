/**
 * app.js — Main controller for CadShot Professional
 * Wires together UI (index.html), CanvasRenderer, NestingEngine,
 * parsers, and export modules into a working leather pattern nesting application.
 */

import { polyArea, polyBbox } from './modules/geometry.js';
import { parseDXF, parseSVG, parseHide } from './modules/parsers.js';
import { NestingEngine } from './modules/nesting-engine.js';
import { exportDXF, exportGcode, downloadFile } from './modules/export.js';
import { CanvasRenderer } from './modules/canvas-renderer.js';
import { HideDetector } from './modules/hide-detector.js';
import * as DataBridge from './modules/data-bridge.js';
import { PatternLibrary } from './modules/pattern-library.js';
import { PatternDigitizer } from './modules/digitizer.js';
import { CheckoutManager } from './modules/checkout.js';
import { KeyboardManager } from './modules/keyboard-shortcuts.js';

// ─── Utilities ─────────────────────────────────────────────────────────────
function escapeHTML(str) {
  return String(str).replace(/[&<>'"]/g, tag => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag]));
}

// ─── Page Router ───────────────────────────────────────────────────────────
// Replaces multi-page <a href> navigation between patternINQ/patternOutQ/PatterNestQ
// with page-level container switching. AppState (including GPU/SAM models) persists.

const PageRouter = {
  _current: 'nesting',
  _pages: ['library', 'patterninq', 'nesting', 'digitizer'],

  get current() { return this._current; },

  navigateTo(pageId) {
    if (!this._pages.includes(pageId)) return;
    if (pageId === this._current) return;

    // Hide all page containers
    document.querySelectorAll('.page-container').forEach(p => {
      p.style.display = 'none';
    });

    // Show requested page
    const activePage = document.getElementById(`page-${pageId}`);
    if (activePage) {
      activePage.style.display = '';
    }

    this._current = pageId;

    // Update nav link active state
    document.querySelectorAll('[data-nav-view]').forEach(el => {
      el.classList.toggle('active', el.dataset.navView === pageId);
    });

    // Re-initialize page-specific context
    this._handlePageInit(pageId);

    window.history.replaceState({ view: pageId }, '', `#${pageId}`);
  },

  _handlePageInit(pageId) {
    switch (pageId) {
      case 'nesting':
        // Canvas must resize after being hidden to avoid zero-dimension render
        if (AppState.renderer) {
          AppState.renderer.resize();
          AppState.renderer.render();
        }
        break;
      case 'library':
      case 'patterninq':
      case 'digitizer':
        // iframes handle their own state — nothing to re-init
        break;
    }
  },

  init() {
    const hash = window.location.hash.replace('#', '');
    if (this._pages.includes(hash)) {
      this._current = hash;
    }

    // Bind nav link clicks
    document.querySelectorAll('[data-nav-view]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        this.navigateTo(el.dataset.navView);
      });
    });

    // Handle browser back/forward
    window.addEventListener('popstate', (e) => {
      if (e.state && e.state.view) {
        this.navigateTo(e.state.view);
      }
    });

    // Apply initial page visibility
    document.querySelectorAll('.page-container').forEach(p => {
      p.style.display = 'none';
    });
    const initial = document.getElementById(`page-${this._current}`);
    if (initial) initial.style.display = '';

    document.querySelectorAll('[data-nav-view]').forEach(el => {
      el.classList.toggle('active', el.dataset.navView === this._current);
    });
  }
};

// ─── App State ──────────────────────────────────────────────────────────────

const AppState = {
  phase: 'IDLE', // IDLE, HIDE_LOADED, PARTS_LOADED, NESTING, COMPLETE
  hide: null,    // {poly, holes, bb, sourceFile}
  hideImage: null, // HTMLImageElement of loaded hide photo
  parts: [],     // [{id, name, boundary, children, qty, bb, color, material, sourceFile}]
  placements: [], // from nesting engine
  efficiency: 0,
  sheetW: 1200,
  sheetH: 600,
  spacing: 5,
  rotSteps: 4,
  gravity: 'bl',
  sortStrat: 'area-desc',
  compactPasses: 3,
  multishake: 'all4',
  nestingEngine: null,
  renderer: null,
  hideDetector: null,
  dataBridge: null,
  patternLibrary: null,
  digitizer: null,
  checkoutManager: null,
  keyboardManager: null,
  selectedPlacement: null,
  selectedIndex: -1,
  // Detection strategy
  strategy: 'base',
  calibrationMode: null,
  calibrationClicks: [],
  cameraStream: null,
  frozenFrame: false,
  cncTable: null,
  correctedPolygon: null,
  measureMode: false,
  measureClicks: [],
  holeMode: null,
  holeClicks: [],
  // Page routing
  pageRouter: PageRouter,
};

// ─── DOM References ─────────────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const els = {
  canvas: $('#nesting-canvas'),
  placeholder: $('#canvas-placeholder'),
  hud: $('#canvas-hud'),
  statusState: $('#status-state'),
  toastContainer: $('#toast-container'),
  rightPanel: $('#right-panel'),
  // Panels
  panelGetStarted: $('#panel-get-started'),
  panelHideProps: $('#panel-hide-props'),
  panelNestingParams: $('#panel-nesting-params'),
  panelLiveStats: $('#panel-live-stats'),
  panelResults: $('#panel-results'),
  panelPartsList: $('#panel-parts-list'),
  // HUD values
  hudZoom: $('#hud-zoom'),
  hudEfficiency: $('#hud-efficiency'),
  hudPlaced: $('#hud-placed'),
  // Stats
  statArea: $('#stat-area'),
  statPerimeter: $('#stat-perimeter'),
  statVertices: $('#stat-vertices'),
  statCalibration: $('#stat-calibration'),
  statProgress: $('#stat-progress'),
  statPlacements: $('#stat-placements'),
  statLiveEfficiency: $('#stat-live-efficiency'),
  statAreaUsed: $('#stat-area-used'),
  statFinalEfficiency: $('#stat-final-efficiency'),
  statFinalArea: $('#stat-final-area'),
  statNests: $('#stat-nests'),
  statTotalPlacements: $('#stat-total-placements'),
  // Progress
  nestingProgress: $('#nesting-progress'),
  // Params
  paramSpacing: $('#param-spacing'),
  paramMaterial: $('#param-material'),
  paramRotations: $('#param-rotations'),
  paramEfficiency: $('#param-efficiency'),
  paramSortStrategy: $('#param-sort-strategy'),
  paramGravity: $('#param-gravity'),
  paramMultishake: $('#param-multishake'),
  // Parts
  partsCount: $('#parts-count'),
  partsListContainer: $('#parts-list-container'),
  // Buttons
  btnLoadHide: $('#btn-load-hide'),
  btnLoadPartsPanel: $('#btn-load-parts-panel'),
  btnStartNesting: $('#btn-start-nesting'),
  btnStopNesting: $('#btn-stop-nesting'),
  btnPauseNesting: $('#btn-pause-nesting'),
  btnExportDxf: $('#btn-export-dxf'),
  btnSaveSession: $('#btn-save-session'),
  btnNewNesting: $('#btn-new-nesting'),
  btnClearHide: $('#btn-clear-hide'),
};

// ─── Initialization ─────────────────────────────────────────────────────────

function init() {
  try {
    setupCanvas();
    initModules();
    initGlobalEvents();
    bindAllUI();
    checkSystemHealth();

    // Restore previous session or set initial state
    if (!restoreSessionState()) {
      setState('IDLE');
    }
  } catch (e) {
    handleInitError(e);
  }
}

function setupCanvas() {
  AppState.renderer = new CanvasRenderer(els.canvas, {
    onZoomChange: (zoom) => updateHUD({ zoom }),
    onHover: (placement, index) => {
      AppState.selectedPlacement = placement;
      AppState.selectedIndex = index;
      updateStatusBarFields();
    },
    onSelect: (placement, index) => {
      AppState.selectedPlacement = placement;
      AppState.selectedIndex = index;
      updateStatusBarFields();
    },
    onContextMenu: (info) => {
      if (info.placement) {
        AppState.selectedPlacement = info.placement;
        AppState.selectedIndex = info.placementIndex;
        updateStatusBarFields();
        showContextMenu('ctx-menu-placement', info.screenX, info.screenY);
      } else {
        showContextMenu('ctx-menu-canvas', info.screenX, info.screenY);
      }
    },
  });

  AppState.renderer.resize();
  AppState.renderer.enableInteraction();
}

function initModules() {
  AppState.hideDetector = new HideDetector();
  AppState.dataBridge = DataBridge;
  AppState.patternLibrary = new PatternLibrary();
  AppState.digitizer = new PatternDigitizer();
  AppState.checkoutManager = new CheckoutManager();
  AppState.keyboardManager = new KeyboardManager();
}

function initGlobalEvents() {
  // Window resize handler
  window.addEventListener('resize', () => {
    AppState.renderer.resize();
  });

  // Re-render when returning from another tab (browser discards canvas backing store)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && AppState.renderer) {
      AppState.renderer.resize();
    }
  });

  // Init page router (replaces multi-page href navigation)
  PageRouter.init();

  // Listen for navigation messages from iframes (e.g. Library "Push to Nesting")
  window.addEventListener('message', async (e) => {
    if (e.data && e.data.type === 'navigate' && PageRouter._pages.includes(e.data.view)) {
      if (e.data.view === 'nesting') {
        // Read the push payload from IndexedDB HERE (parent context) before
        // navigating, then relay it directly to PatterNestQ so its startup
        // _checkPushedJob() cannot race-delete the record first.
        (async () => {
          let pushedJob = null;
          try {
            pushedJob = await new Promise((resolve) => {
              const req = indexedDB.open('PatternIQ_NestPush', 1);
              req.onsuccess = (ev) => {
                const db = ev.target.result;
                if (!db.objectStoreNames.contains('push')) { resolve(null); return; }
                const tx = db.transaction('push', 'readonly');
                const r  = tx.objectStore('push').get('push');
                r.onsuccess = () => resolve(r.result || null);
                r.onerror   = () => resolve(null);
              };
              req.onerror = () => resolve(null);
            });
          } catch (_) { pushedJob = null; }

          PageRouter.navigateTo('nesting');

          const nestFrame = document.getElementById('iframe-nesting');
          if (!nestFrame || !nestFrame.contentWindow) return;

          if (pushedJob && pushedJob.parts && pushedJob.parts.length) {
            // Relay full payload — PatterNestQ re-writes + calls _loadPushedJob
            const sendDirect = () =>
              nestFrame.contentWindow.postMessage({ type: 'push-parts-direct', job: pushedJob }, '*');
            sendDirect();
            setTimeout(sendDirect, 300);
            setTimeout(sendDirect, 800);
          } else {
            // Fallback: nothing in DB yet, use normal check path
            const ping = () =>
              nestFrame.contentWindow.postMessage({ type: 'check-pushed-parts' }, '*');
            ping();
            setTimeout(ping, 300);
            setTimeout(ping, 800);
            setTimeout(ping, 1800);
          }
        })();
        return;
      }
      PageRouter.navigateTo(e.data.view);
      if (e.data.view === 'patterninq') {
        const inqFrame = document.getElementById('iframe-patterninq');
        if (inqFrame && inqFrame.contentWindow) {
          inqFrame.contentWindow.postMessage({ type: 'check-pushed-pieces' }, '*');
          setTimeout(() => inqFrame.contentWindow.postMessage({ type: 'check-pushed-pieces' }, '*'), 300);
        }
      }
    }
  });
}

function bindAllUI() {
  bindToolbarButtons();
  bindPanelButtons();
  bindMenuItems();
  bindParameterInputs();
  bindKeyboardShortcuts();
  bindStrategySelector();
  bindCalibrationUI();
  bindCncTableUI();
  bindCameraUI();
  bindDropZone();
  bindCheckoutWizard();
  bindNestingSidebar();
  bindCanvasClickHandler();
  bindSiblingDetection();
}

function checkSystemHealth() {
  if (!window.isSecureContext) {
    console.warn('[CadShot] Not a secure context — WebGPU and Clipboard APIs unavailable. Serve over HTTPS or localhost.');
    showToast('Warning: Not a secure context. AI model (WebGPU) and clipboard will not work. Use HTTPS or localhost.', 'error');
  }
}

function handleInitError(e) {
  console.error('CadShot init failed:', e);
  document.body.insertAdjacentHTML('beforeend',
    `<div style="position:fixed;bottom:20px;left:20px;right:20px;background:#dc2626;color:white;padding:12px 16px;border-radius:8px;font-size:13px;z-index:9999">
      Init error: ${e.message} — Check browser console (F12)
    </div>`);
}

// ─── State Management ───────────────────────────────────────────────────────

function setState(phase) {
  AppState.phase = phase;
  updatePanelVisibility();

  // Hide right panel and show nesting sidebar only when in NESTING mode or parts are loaded (ready to nest)
  const rightPanel = document.getElementById('right-panel');
  const nestingSidebar = document.getElementById('nesting-sidebar');
  if (phase === 'NESTING' || phase === 'PARTS_LOADED' || phase === 'COMPLETE') {
    if (rightPanel) rightPanel.style.display = 'none';
    if (nestingSidebar) nestingSidebar.style.display = 'flex';
  } else {
    if (rightPanel) rightPanel.style.display = 'flex';
    if (nestingSidebar) nestingSidebar.style.display = 'none';
  }

  updateToolbarState();
  updateStatusBar();
  updateHUD({});

  // Need to wait slightly for display changes to apply so canvas bounding rect is correct
  setTimeout(() => {
    AppState.renderer.resize();
    AppState.renderer.render();
  }, 10);
}

function updatePanelVisibility() {
  const panels = [
    els.panelGetStarted,
    els.panelHideProps,
    els.panelNestingParams,
    els.panelLiveStats,
    els.panelResults,
    els.panelPartsList,
  ];

  // Hide all panels
  panels.forEach(p => { if (p) p.style.display = 'none'; });

  switch (AppState.phase) {
    case 'IDLE':
      if (els.placeholder) els.placeholder.style.display = '';
      if (els.hud) els.hud.style.display = 'none';
      if (els.panelGetStarted) els.panelGetStarted.style.display = '';
      break;

    case 'HIDE_LOADED':
      if (els.placeholder) els.placeholder.style.display = 'none';
      if (els.hud) els.hud.style.display = '';
      if (els.panelHideProps) els.panelHideProps.style.display = '';
      if (els.panelNestingParams) els.panelNestingParams.style.display = '';
      break;

    case 'PARTS_LOADED':
      if (els.placeholder) els.placeholder.style.display = 'none';
      if (els.hud) els.hud.style.display = '';
      if (els.panelHideProps) els.panelHideProps.style.display = '';
      if (els.panelNestingParams) els.panelNestingParams.style.display = '';
      if (els.panelPartsList) els.panelPartsList.style.display = '';
      break;

    case 'NESTING':
      if (els.placeholder) els.placeholder.style.display = 'none';
      if (els.hud) els.hud.style.display = '';
      if (els.panelLiveStats) els.panelLiveStats.style.display = '';
      break;

    case 'COMPLETE':
      if (els.placeholder) els.placeholder.style.display = 'none';
      if (els.hud) els.hud.style.display = '';
      if (els.panelResults) els.panelResults.style.display = '';
      if (els.panelPartsList) els.panelPartsList.style.display = '';
      break;
  }
}

function updateToolbarState() {
  const nestBtn = $('[data-tool="nest"]');
  const stopBtn = $('[data-tool="stop"]');

  switch (AppState.phase) {
    case 'IDLE':
      if (nestBtn) nestBtn.disabled = true;
      if (stopBtn) stopBtn.disabled = true;
      if (els.btnStartNesting) els.btnStartNesting.disabled = true;
      break;
    case 'HIDE_LOADED':
      if (nestBtn) nestBtn.disabled = true;
      if (stopBtn) stopBtn.disabled = true;
      if (els.btnStartNesting) els.btnStartNesting.disabled = true;
      break;
    case 'PARTS_LOADED':
      if (nestBtn) nestBtn.disabled = false;
      if (stopBtn) stopBtn.disabled = true;
      if (els.btnStartNesting) els.btnStartNesting.disabled = false;
      break;
    case 'NESTING':
      if (nestBtn) nestBtn.disabled = true;
      if (stopBtn) stopBtn.disabled = false;
      if (els.btnStartNesting) els.btnStartNesting.disabled = true;
      break;
    case 'COMPLETE':
      if (nestBtn) nestBtn.disabled = false;
      if (stopBtn) stopBtn.disabled = true;
      if (els.btnStartNesting) els.btnStartNesting.disabled = false;
      break;
  }
}

function updateStatusBar() {
  if (!els.statusState) return;
  const labels = {
    IDLE: 'Ready',
    HIDE_LOADED: 'Hide Loaded',
    PARTS_LOADED: 'Parts Loaded — Ready to Nest',
    NESTING: 'Nesting in Progress...',
    COMPLETE: 'Nesting Complete',
  };
  els.statusState.textContent = labels[AppState.phase] || AppState.phase;
}

function updateHUD({ zoom, efficiency, placed }) {
  const renderer = AppState.renderer;
  if (els.hudZoom) {
    els.hudZoom.textContent = Math.round((zoom ?? renderer?.zoom ?? 1) * 100) + '%';
  }
  if (els.hudEfficiency) {
    const eff = efficiency ?? AppState.efficiency;
    els.hudEfficiency.textContent = eff > 0 ? eff.toFixed(1) + '%' : '—';
  }
  if (els.hudPlaced) {
    els.hudPlaced.textContent = placed ?? AppState.placements.length;
  }
}

// ─── Toolbar Binding ────────────────────────────────────────────────────────

function setActiveToolState(activeBtn, groupSelector) {
  $$(groupSelector).forEach(b => {
    b.classList.remove('active');
    b.setAttribute('aria-pressed', 'false');
  });
  activeBtn.classList.add('active');
  activeBtn.setAttribute('aria-pressed', 'true');
}

function bindToolbarButtons() {
  // Legacy .tool-btn buttons (collapse panel, etc.)
  $$('.tool-btn[data-tool]').forEach(btn => {
    btn.addEventListener('click', function() {
      if (this.disabled) return;
      const tool = this.dataset.tool;

      // Selection-type tools
      if (['select', 'move', 'measure'].includes(tool)) {
        setActiveToolState(this, '.tool-btn');
        return;
      }

      switch (tool) {
        case 'load-image':
          triggerLoadHide();
          break;
        case 'load-parts':
          triggerLoadParts();
          break;
        case 'nest':
          startNesting();
          break;
        case 'stop':
          stopNesting();
          break;
        case 'fit':
          AppState.renderer.zoomToFit();
          break;
        case 'collapse-panel':
          toggleRightPanel();
          break;
        case 'detect':
          detectHide();
          break;
        case 'camera':
          startCamera();
          break;
        case 'settings':
          showToast('Settings panel coming soon', 'info');
          break;
      }
    });
  });

  // Icon toolbar buttons (.icon-tool-btn)
  $$('.icon-tool-btn[data-tool]').forEach(btn => {
    btn.addEventListener('click', function() {
      if (this.disabled) return;
      const tool = this.dataset.tool;

      // Mode-selection tools (toggle active state within icon toolbar)
      const modeTools = ['nest-place', 'move-free', 'auto-fit', 'free-zoom', 'snap-h', 'snap-v', 'select', 'measure'];
      if (modeTools.includes(tool)) {
        setActiveToolState(this, '.icon-tool-btn');
        return;
      }

      switch (tool) {
        case 'load-image':
          triggerLoadHide();
          break;
        case 'load-parts':
          triggerLoadParts();
          break;
        case 'detect':
          detectHide();
          break;
        case 'duplicate':
          showToast('Duplicate: select a placed part first', 'info');
          break;
        case 'align-left':
          showToast('Align: select parts first', 'info');
          break;
        case 'rotate-cw':
          showToast('Rotate: select a part first', 'info');
          break;
        case 'flip-h':
          showToast('Flip: select a part first', 'info');
          break;
      }
    });
  });

  // Toolbox section collapse/expand toggles
  $$('.toolbox-section-header').forEach(header => {
    function toggleSection() {
      const section = header.parentElement;
      section.classList.toggle('collapsed');
      header.setAttribute('aria-expanded', !section.classList.contains('collapsed'));
    }
    header.addEventListener('click', toggleSection);
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleSection();
      }
    });
  });

  // Split divider drag (resize parts library)
  const divider = $('#split-divider');
  if (divider) {
    let startY = 0;
    let startHeight = 0;
    const partsLib = $('#parts-library');

    divider.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startY = e.clientY;
      startHeight = partsLib.offsetHeight;
      document.addEventListener('mousemove', onDividerMove);
      document.addEventListener('mouseup', onDividerUp);
    });

    function onDividerMove(e) {
      const dy = e.clientY - startY;
      const newHeight = Math.max(60, Math.min(500, startHeight + dy));
      partsLib.style.height = newHeight + 'px';
      AppState.renderer.resize();
    }

    function onDividerUp() {
      document.removeEventListener('mousemove', onDividerMove);
      document.removeEventListener('mouseup', onDividerUp);
    }
  }
}

// ─── Panel Buttons ──────────────────────────────────────────────────────────

function bindPanelButtons() {
  if (els.btnLoadHide) {
    els.btnLoadHide.addEventListener('click', triggerLoadHide);
  }
  if (els.btnLoadPartsPanel) {
    els.btnLoadPartsPanel.addEventListener('click', triggerLoadParts);
  }
  if (els.btnStartNesting) {
    els.btnStartNesting.addEventListener('click', startNesting);
  }
  if (els.btnStopNesting) {
    els.btnStopNesting.addEventListener('click', stopNesting);
  }
  if (els.btnPauseNesting) {
    els.btnPauseNesting.addEventListener('click', stopNesting);
  }
  if (els.btnExportDxf) {
    els.btnExportDxf.addEventListener('click', doExportDXF);
  }
  if (els.btnNewNesting) {
    els.btnNewNesting.addEventListener('click', newNesting);
  }
  const btnTransferPending = $('#btn-transfer-pending');
  if (btnTransferPending) {
    btnTransferPending.addEventListener('click', transferPendingToNewJob);
  }
  if (els.btnClearHide) {
    els.btnClearHide.addEventListener('click', clearHide);
  }
  if (els.btnSaveSession) {
    els.btnSaveSession.addEventListener('click', saveSessionState);
  }

  const btnExportSvg = $('#btn-export-svg');
  if (btnExportSvg) btnExportSvg.addEventListener('click', doExportSVG);

  const btnExportGcode = $('#btn-export-gcode');
  if (btnExportGcode) btnExportGcode.addEventListener('click', doExportGcode);

  const btnLoadDemo = $('#btn-load-demo');
  if (btnLoadDemo) btnLoadDemo.addEventListener('click', loadDemoPatterns);

  const btnExportDxfLegacy = $('#btn-export-dxf-legacy');
  if (btnExportDxfLegacy) btnExportDxfLegacy.addEventListener('click', doExportDXF);

  const btnLibLoad = $('#btn-lib-load');
  if (btnLibLoad) btnLibLoad.addEventListener('click', triggerLoadParts);

  const btnLibDemo = $('#btn-lib-demo');
  if (btnLibDemo) btnLibDemo.addEventListener('click', loadDemoPatterns);

  bindSamModelPanel();
}

// ─── SAM Model Panel ─────────────────────────────────────────────────────

function bindSamModelPanel() {
  const btnLoadModel = $('#btn-load-model');
  const btnUnloadModel = $('#btn-unload-model');
  const modelSelect = $('#model-select');
  const modelStatusText = $('#model-status-text');
  const modelDeviceText = $('#model-device-text');
  const modelProgressFill = $('#model-progress-fill');

  function updateModelProgress(value) {
    if (modelProgressFill) modelProgressFill.style.width = `${Math.round(value * 100)}%`;
  }
  function updateModelUI(status, device) {
    if (modelStatusText) modelStatusText.textContent = status;
    if (modelDeviceText) modelDeviceText.textContent = device;
  }

  if (btnLoadModel) {
    btnLoadModel.addEventListener('click', async () => {
      const detector = AppState.hideDetector;
      if (detector.modelReady) { showToast('Model already loaded', 'info'); return; }
      const selectedModel = modelSelect ? modelSelect.value : 'sam-vit-base';
      btnLoadModel.disabled = true;
      btnLoadModel.textContent = 'Loading...';
      updateModelUI('Downloading...', '—');
      detector._onProgress = updateModelProgress;
      const loadTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Download timed out (600s) — check network or use USB load')), 600000));
      try {
        const result = await Promise.race([
          detector.loadModel({ model: selectedModel, device: 'auto' }),
          loadTimeout
        ]);
        updateModelUI(`${selectedModel} active`, result.device.toUpperCase());
        btnLoadModel.textContent = 'Model Active';
        if (btnUnloadModel) btnUnloadModel.style.display = '';
        if (modelSelect) modelSelect.disabled = true;
        showToast(`SAM ${selectedModel} loaded on ${result.device.toUpperCase()}`, 'success');
      } catch (e) {
        updateModelUI('Not loaded', '—');
        btnLoadModel.textContent = 'Retry Load';
        btnLoadModel.disabled = false;
        const hint = e.message.includes('transformers') || e.message.includes('CDN')
          ? ' — Try "Load from USB" or "Restore USB → Cache" if offline'
          : '';
        showToast('Model load failed: ' + e.message + hint, 'error');
      }
      updateModelProgress(0);
    });
  }

  if (btnUnloadModel) {
    btnUnloadModel.addEventListener('click', async () => {
      await AppState.hideDetector.unloadModel();
      updateModelUI('Not loaded', '—');
      if (btnLoadModel) { btnLoadModel.textContent = 'Load SAM Model'; btnLoadModel.disabled = false; }
      btnUnloadModel.style.display = 'none';
      if (modelSelect) modelSelect.disabled = false;
      showToast('Model unloaded — VRAM freed', 'info');
    });
  }

  // USB buttons
  const btnLoadUsbGpu = $('#btn-load-usb-gpu');
  const btnLoadUsbCpu = $('#btn-load-usb-cpu');
  const btnExportModel = $('#btn-export-model');
  const btnImportModel = $('#btn-import-model');

  if (btnLoadUsbGpu) {
    btnLoadUsbGpu.addEventListener('click', async () => {
      if (!window.showDirectoryPicker) { showToast('Browser does not support folder picker', 'error'); return; }
      try {
        const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
        const selectedModel = modelSelect ? modelSelect.value : 'sam-vit-base';
        updateModelUI('Loading from USB (GPU)...', '—');
        await AppState.hideDetector.loadModel({ fromUSB: dirHandle, device: 'webgpu', model: selectedModel });
        updateModelUI(`${selectedModel} (USB)`, 'WEBGPU');
        if (btnLoadModel) { btnLoadModel.textContent = 'Model Active'; btnLoadModel.disabled = true; }
        if (btnUnloadModel) btnUnloadModel.style.display = '';
        showToast('Model loaded from USB (GPU)', 'success');
      } catch (e) {
        updateModelUI('USB load failed', '—');
        showToast('USB load failed: ' + e.message, 'error');
      }
    });
  }

  if (btnLoadUsbCpu) {
    btnLoadUsbCpu.addEventListener('click', async () => {
      if (!window.showDirectoryPicker) { showToast('Browser does not support folder picker', 'error'); return; }
      try {
        const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
        const selectedModel = modelSelect ? modelSelect.value : 'sam-vit-base';
        updateModelUI('Loading from USB (CPU)...', '—');
        await AppState.hideDetector.loadModel({ fromUSB: dirHandle, device: 'wasm', model: selectedModel });
        updateModelUI(`${selectedModel} (USB)`, 'CPU/WASM');
        if (btnLoadModel) { btnLoadModel.textContent = 'Model Active'; btnLoadModel.disabled = true; }
        if (btnUnloadModel) btnUnloadModel.style.display = '';
        showToast('Model loaded from USB (CPU/WASM)', 'success');
      } catch (e) {
        updateModelUI('USB load failed', '—');
        showToast('USB load failed: ' + e.message, 'error');
      }
    });
  }

  if (btnExportModel) {
    btnExportModel.addEventListener('click', async () => {
      try {
        const result = await AppState.hideDetector.exportModelToFolder();
        showToast(`Backed up ${result.fileCount} files (${(result.totalBytes / (1024*1024)).toFixed(0)} MB)`, 'success');
      } catch (e) {
        if (e.name !== 'AbortError') showToast('Backup failed: ' + e.message, 'error');
      }
    });
  }

  if (btnImportModel) {
    btnImportModel.addEventListener('click', async () => {
      try {
        updateModelUI('Restoring from USB...', '—');
        await AppState.hideDetector.importModelFromFolder({ device: 'auto' });
        updateModelUI(`Model active (from USB)`, AppState.hideDetector.currentModel || 'base');
        if (btnLoadModel) { btnLoadModel.textContent = 'Model Active'; btnLoadModel.disabled = true; }
        if (btnUnloadModel) btnUnloadModel.style.display = '';
        showToast('Model restored from USB and loaded', 'success');
      } catch (e) {
        if (e.name !== 'AbortError') showToast('Import failed: ' + e.message, 'error');
        updateModelUI('Not loaded', '—');
      }
    });
  }
}

// ─── Menu Items ─────────────────────────────────────────────────────────────

function bindMenuItems() {
  $$('.menu-dropdown-item').forEach(item => {
    item.addEventListener('click', (e) => {
      const label = item.childNodes[0].textContent.trim();

      switch (label) {
        // File menu
        case 'New Project':
          resetAll();
          break;
        case 'Open Project':
          triggerLoadHide();
          break;
        case 'Save Session':
          saveSessionState();
          break;
        case 'Save As...':
          showToast('Save As: coming soon', 'info');
          break;
        case 'Import DXF/SVG...':
          triggerLoadParts();
          break;
        case 'Export DXF':
          doExportDXF();
          break;
        case 'Export SVG':
          doExportSVG();
          break;
        case 'Export JSON':
          doExportJSON();
          break;
        case 'Export CUT Only':
          doExportDXF('cut');
          break;
        case 'Export MARK Only':
          doExportDXF('mark');
          break;
        case 'Generate G-code':
          doExportGcode();
          break;
        case 'Exit':
          window.close();
          break;

        // Nesting menu
        case 'Start Nesting':
          startNesting();
          break;
        case 'Stop Nesting':
          stopNesting();
          break;
        case 'Pause':
          pauseNesting();
          break;
        case 'Clear All Placements':
          newNesting();
          break;
        case 'Nesting Parameters...':
          showNestingParamsPanel();
          break;

        // Patterns menu
        case 'Load Parts...':
          triggerLoadParts();
          break;
        case 'Add Single Part':
          triggerLoadParts();
          break;
        case 'Part Library':
          openPartLibrary();
          break;
        case 'Checkout...':
          CheckoutWizard.open();
          break;
        case 'Clear All Parts':
          clearParts();
          break;

        // Tools menu
        case 'Detect Hide':
          detectHide();
          break;
        case 'Calibrate':
          calibrate();
          break;
        case 'Auto-Detect Paper':
          autoDetectPaper();
          break;
        case 'Reset Calibration':
          resetCalibration();
          break;
        case 'Measure Distance':
          measureDistance();
          break;
        case 'Inspect Part':
          inspectPart();
          break;
        case 'Add Hole':
          addHole();
          break;
        case 'Remove Hole':
          removeHole();
          break;
        case 'Edit Vertices':
          editVertices();
          break;
        case 'Toggle Mask Overlay':
          toggleMaskOverlay();
          break;
        case 'Debug Collision Map':
          debugCollisionMap();
          break;
        case 'Load Demo Patterns':
          loadDemoPatterns();
          break;

        // View menu
        case 'Toggle Grid':
          AppState.renderer.setOption('showGrid', !AppState.renderer.options.showGrid);
          break;
        case 'Toggle Hide Outline':
          AppState.renderer.setOption('showOutline', !AppState.renderer.options.showOutline);
          break;
        case 'Toggle Info Overlay':
          AppState.renderer.setOption('showHUD', !AppState.renderer.options.showHUD);
          break;
        case 'Zoom to Fit':
          AppState.renderer.zoomToFit();
          break;
        case 'Zoom 100%':
          AppState.renderer.setZoom(1.0);
          AppState.renderer.render();
          break;
        case 'Collapse Right Panel':
          toggleRightPanel();
          break;
        case 'Keyboard Shortcuts...':
          showToast('Keyboard Shortcuts: coming soon', 'info');
          break;
      }
    });
  });
}

// ─── Parameter Binding ──────────────────────────────────────────────────────

function bindParameterInputs() {
  if (els.paramSpacing) {
    els.paramSpacing.addEventListener('change', () => {
      AppState.spacing = parseFloat(els.paramSpacing.value) || 5;
    });
  }
  if (els.paramRotations) {
    els.paramRotations.addEventListener('change', () => {
      AppState.rotSteps = parseInt(els.paramRotations.value, 10) || 4;
    });
  }
  if (els.paramEfficiency) {
    els.paramEfficiency.addEventListener('change', () => {
      // Store target efficiency (informational only for now)
    });
  }
  if (els.paramMaterial) {
    els.paramMaterial.addEventListener('change', () => {
      // Store selected material (informational only for now)
    });
  }
  if (els.paramSortStrategy) {
    els.paramSortStrategy.addEventListener('change', () => {
      AppState.sortStrat = els.paramSortStrategy.value || 'area-desc';
    });
  }
  if (els.paramGravity) {
    els.paramGravity.addEventListener('change', () => {
      AppState.gravity = els.paramGravity.value || 'bl';
    });
  }
  if (els.paramMultishake) {
    els.paramMultishake.addEventListener('change', () => {
      AppState.multishake = els.paramMultishake.value || 'all4';
    });
  }
}

// ─── Keyboard Shortcuts ─────────────────────────────────────────────────────

function bindKeyboardShortcuts() {
  let isPanning = false;

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') {
      return;
    }

    // Space = pan mode
    if (e.key === ' ' && !e.repeat) {
      e.preventDefault();
      isPanning = true;
      els.canvas.style.cursor = 'grab';
      return;
    }

    // Ctrl/Cmd combos
    if (e.ctrlKey || e.metaKey) {
      switch (e.key.toLowerCase()) {
        case 'n':
          e.preventDefault();
          resetAll();
          return;
        case 'o':
          e.preventDefault();
          triggerLoadHide();
          return;
        case 's':
          e.preventDefault();
          showToast('Session saved', 'success');
          return;
        case 'q':
          e.preventDefault();
          window.close();
          return;
        case 'e':
          e.preventDefault();
          doExportDXF();
          return;
        case 'z':
          e.preventDefault();
          if (e.shiftKey) {
            showToast('Redo: not yet implemented', 'info');
          } else {
            showToast('Undo: not yet implemented', 'info');
          }
          return;
      }
    }

    switch (e.key) {
      case 'Delete':
      case 'Backspace':
        if (AppState.selectedPlacement) {
          showToast('Delete selected: coming soon', 'info');
        }
        break;
      case 'Escape':
        AppState.selectedPlacement = null;
        AppState.selectedIndex = -1;
        updateStatusBarFields();
        AppState.renderer.render();
        break;
      case '+':
      case '=':
        AppState.renderer.setZoom((AppState.renderer.zoom || 1) * 1.2);
        AppState.renderer.render();
        break;
      case '-':
        AppState.renderer.setZoom((AppState.renderer.zoom || 1) / 1.2);
        AppState.renderer.render();
        break;
    }

    switch (e.key.toLowerCase()) {
      case 'r':
        if (e.shiftKey) {
          stopNesting();
        } else {
          if (AppState.phase === 'PARTS_LOADED' || AppState.phase === 'COMPLETE') {
            startNesting();
          }
        }
        break;
      case 'v':
        activateTool('select');
        break;
      case 'm':
        activateTool('move');
        break;
      case 'h':
        AppState.renderer.setOption('showGrid', !AppState.renderer.options.showGrid);
        break;
      case 'i':
        AppState.renderer.setOption('showHUD', !AppState.renderer.options.showHUD);
        break;
      case 'd':
        detectHide();
        break;
      case 'g':
        AppState.renderer.setOption('showOutline', !AppState.renderer.options.showOutline);
        break;
      case 'p':
        pauseNesting();
        break;
    }

    if (e.key === '!' || (e.shiftKey && e.code === 'Digit1')) {
      AppState.renderer.setZoom(1.0);
      AppState.renderer.render();
    }
    if (e.key === '@' || (e.shiftKey && e.code === 'Digit2')) {
      AppState.renderer.zoomToFit();
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.key === ' ') {
      isPanning = false;
      els.canvas.style.cursor = '';
    }
  });
}

function activateTool(toolName) {
  const btn = $(`[data-tool="${toolName}"]`);
  if (btn) {
    setActiveToolState(btn, '.tool-btn');
  }
}

// ─── Load Hide ──────────────────────────────────────────────────────────────

function triggerLoadHide() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*,.dxf,.svg';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const ext = file.name.split('.').pop().toLowerCase();

    if (ext === 'dxf' || ext === 'svg') {
      // Parse hide from vector file
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target.result;
        const hide = parseHide(text, file.name);
        if (hide) {
          AppState.hide = hide;
          AppState.sheetW = hide.bb.w;
          AppState.sheetH = hide.bb.h;
          AppState.renderer.setHide(hide.poly, hide.holes || []);
          updateHideProps(hide);
        } else {
          setRectangularSheet();
        }
        AppState.renderer.resize();
        AppState.renderer.zoomToFit();
        transitionAfterHideLoad();
      };
      reader.readAsText(file);
    } else {
      // Image file: load image, use its dimensions as sheet, display on canvas
      const img = new Image();
      img.onload = () => {
        AppState.sheetW = img.naturalWidth;
        AppState.sheetH = img.naturalHeight;
        AppState.hideImage = img;
        setRectangularSheet();
        AppState.renderer.setBackgroundImage(img);
        AppState.renderer.resize();
        AppState.renderer.zoomToFit();
        transitionAfterHideLoad();
        showToast(`Image loaded: ${img.naturalWidth} × ${img.naturalHeight} px — click Detect to find hide boundary`, 'info');
      };
      img.onerror = () => {
        showToast('Failed to load image file', 'error');
      };
      img.src = URL.createObjectURL(file);
    }
  };
  input.click();
}

function setRectangularSheet() {
  AppState.hide = {
    poly: [[0, 0], [AppState.sheetW, 0], [AppState.sheetW, AppState.sheetH], [0, AppState.sheetH]],
    holes: [],
    bb: { x0: 0, y0: 0, x1: AppState.sheetW, y1: AppState.sheetH, w: AppState.sheetW, h: AppState.sheetH },
    sourceFile: 'rectangular-sheet',
  };
  AppState.renderer.setSheet(AppState.sheetW, AppState.sheetH);
  updateHideProps(AppState.hide);
}

function transitionAfterHideLoad() {
  if (AppState.parts.length > 0) {
    setState('PARTS_LOADED');
  } else {
    setState('HIDE_LOADED');
  }
  showToast('Hide loaded successfully', 'success');
}

function updateHideProps(hide) {
  if (!hide) return;
  const area = Math.abs(polyArea(hide.poly));
  if (els.statArea) els.statArea.textContent = formatArea(area);
  if (els.statPerimeter) els.statPerimeter.textContent = formatLength(calcPerimeter(hide.poly));
  if (els.statVertices) els.statVertices.textContent = hide.poly.length;
  if (els.statCalibration) els.statCalibration.textContent = '1.0 mm/px';
}

function formatArea(areaMm2) {
  if (areaMm2 > 1e6) return (areaMm2 / 1e6).toFixed(2) + ' m²';
  if (areaMm2 > 1e4) return (areaMm2 / 100).toFixed(1) + ' cm²';
  return areaMm2.toFixed(0) + ' mm²';
}

function formatLength(mm) {
  if (mm > 1000) return (mm / 1000).toFixed(2) + ' m';
  return mm.toFixed(0) + ' mm';
}

function calcPerimeter(poly) {
  let len = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const dx = poly[i][0] - poly[j][0];
    const dy = poly[i][1] - poly[j][1];
    len += Math.sqrt(dx * dx + dy * dy);
  }
  return len;
}

// ─── Load Parts ─────────────────────────────────────────────────────────────

function triggerLoadParts() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.dxf,.svg';
  input.multiple = true;
  input.onchange = async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    let newParts = [];
    let errors = 0;

    for (const file of files) {
      const text = await readFileAsText(file);
      const ext = file.name.split('.').pop().toLowerCase();
      let parsed = null;

      if (ext === 'dxf') {
        parsed = parseDXF(text, file.name);
      } else if (ext === 'svg') {
        parsed = parseSVG(text, file.name);
      }

      if (parsed && parsed.length > 0) {
        newParts = newParts.concat(parsed);
      } else {
        errors++;
        console.warn(`Failed to parse: ${file.name}`);
      }
    }

    if (newParts.length > 0) {
      AppState.parts = AppState.parts.concat(newParts);
      AppState.renderer.setPreviewParts(AppState.parts);
      updatePartsList();

      // If no hide loaded yet, auto-create rectangular sheet
      if (!AppState.hide) {
        setRectangularSheet();
        AppState.renderer.zoomToFit();
      }

      setState('PARTS_LOADED');
      showToast(`${newParts.length} part(s) loaded from ${files.length} file(s)`, 'success');
    }

    if (errors > 0) {
      showToast(`${errors} file(s) could not be parsed`, 'error');
    }
  };
  input.click();
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

function generatePartSvg(boundary, color = '#6b7280') {
  if (!boundary || boundary.length < 3) return '';

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  boundary.forEach(([x, y]) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  });

  const w = maxX - minX;
  const h = maxY - minY;
  const padding = Math.max(w, h) * 0.1;
  const vbMinX = minX - padding;
  const vbMinY = minY - padding;
  const vbW = w + padding * 2;
  const vbH = h + padding * 2;

  const pts = boundary.map(p => `${p[0]},${p[1]}`).join(' ');
  const strokeW = vbW * 0.015;

  return `<svg viewBox="${vbMinX} ${vbMinY} ${vbW} ${vbH}" preserveAspectRatio="xMidYMid meet" width="100%" height="100%">
    <polygon points="${pts}" fill="${color}40" stroke="${color}" stroke-width="${strokeW}" />
  </svg>`;
}

function updatePartsList() {
  const partsPlaceholder = $('#parts-placeholder');
  const partsLibList = $('#parts-library-list');
  const partsLibCanvas = $('#parts-library-canvas');

  // Group parts by base name with nuclear sanitization (strips ALL non-alphanumeric for key)
  const groupedParts = new Map();
  AppState.parts.forEach(part => {
    let rawName = part.partName || part.name || 'Unnamed';
    rawName = rawName.split('_sz')[0];
    rawName = rawName.replace(/_[LR]$|-[LR]$/i, '');

    let displayName = String(rawName).toUpperCase().replace(/_/g, ' ').trim();

    // Nuclear key: strip EVERYTHING except A-Z and 0-9
    let groupKey = displayName.replace(/[^A-Z0-9]/g, '');

    if (!groupedParts.has(groupKey)) {
      groupedParts.set(groupKey, {
        displayName: displayName,
        representative: part,
        totalQty: 0,
        placedQty: 0,
        sizes: new Set()
      });
    }

    const group = groupedParts.get(groupKey);
    group.totalQty += parseInt(part.qty || 1, 10);

    // Count placed instances of this part
    const placedCount = AppState.placements.filter(p => p.id === part.id).length;
    group.placedQty += placedCount;

    // Extract size from _sizeLbl, sizeLabel, or filename pattern _sz##
    const sz = part._sizeLbl || part.sizeLabel || part.size || (part.name.match(/_sz(\d+)/) || [])[1];
    if (sz) group.sizes.add(sz);
  });

  if (els.partsCount) {
    const uniqueCount = groupedParts.size;
    const totalCount = AppState.parts.length;
    els.partsCount.textContent = uniqueCount > 0
      ? `(${uniqueCount} unique parts — ${totalCount} total)`
      : '(0 pieces)';
  }

  // Toggle placeholder vs list in visible parts library
  if (AppState.parts.length > 0) {
    if (partsPlaceholder) partsPlaceholder.style.display = 'none';
    if (partsLibCanvas) partsLibCanvas.style.display = 'none';
    if (partsLibList) partsLibList.style.display = '';
  } else {
    if (partsPlaceholder) partsPlaceholder.style.display = '';
    if (partsLibCanvas) partsLibCanvas.style.display = '';
    if (partsLibList) partsLibList.style.display = 'none';
  }

  // Render grouped tiles into a container
  function renderGroupedTiles(container) {
    container.innerHTML = '';
    groupedParts.forEach((group) => {
      const rep = group.representative;
      const remaining = group.totalQty - group.placedQty;

      // Format size range
      let sizeArr = Array.from(group.sizes).map(s => parseInt(s, 10)).filter(n => !isNaN(n)).sort((a, b) => a - b);
      let sizeText = '';
      if (sizeArr.length === 1) sizeText = `Sz ${sizeArr[0]}`;
      else if (sizeArr.length > 1) sizeText = `Sz ${sizeArr[0]} - ${sizeArr[sizeArr.length - 1]}`;
      else if (group.sizes.size > 0) sizeText = Array.from(group.sizes).join(', ');

      const card = document.createElement('div');
      card.className = 'parts-tile-card';
      if (remaining === 0 && group.placedQty > 0) card.style.opacity = '0.5';

      const svgWrapper = document.createElement('div');
      svgWrapper.className = 'part-svg-wrapper';
      svgWrapper.innerHTML = generatePartSvg(rep.boundary, rep.color);

      const info = document.createElement('div');
      info.className = 'part-info';

      const name = document.createElement('div');
      name.className = 'ptc-name';
      name.title = group.displayName;
      name.textContent = group.displayName;

      const meta = document.createElement('div');
      meta.className = 'ptc-meta';

      // Show size range (or fallback to dimensions if no size data)
      const sizeDisplay = sizeText || `${Math.round(rep.bb.w)} × ${Math.round(rep.bb.h)} mm`;
      const qtyColor = remaining === 0 && group.placedQty > 0 ? 'var(--text-muted, #6b7280)' : 'var(--accent, #22c55e)';
      const progressText = group.placedQty > 0
        ? `${group.placedQty}/${group.totalQty} placed`
        : `×${group.totalQty}`;

      meta.innerHTML = `<span style="color: var(--accent-secondary, #3b82f6); font-weight: 600;">${escapeHTML(sizeDisplay)}</span>` +
        `<br><span class="ptc-qty" style="color: ${qtyColor};">${escapeHTML(progressText)}</span>`;

      info.appendChild(name);
      info.appendChild(meta);
      card.appendChild(svgWrapper);
      card.appendChild(info);
      container.appendChild(card);
    });
  }

  if (partsLibList) renderGroupedTiles(partsLibList);
  if (els.partsListContainer) renderGroupedTiles(els.partsListContainer);
}

// ─── Load Pushed Parts from Library (IndexedDB) ────────────────────────────

async function loadPushedParts() {
  const payload = await DataBridge.receiveNestPush();
  if (!payload || !payload.parts || !payload.parts.length) return;

  const newParts = payload.parts.map((p, i) => {
    // Normalize part to local origin (0,0) so collision engine doesn't fail on offsets
    let boundary = p.boundary;
    let children = p.children || [];
    let bb = p.bb || { x0: 0, y0: 0, x1: 100, y1: 100, w: 100, h: 100 };

    if (boundary && boundary.length > 0) {
      // Re-calculate bbox to ensure accuracy
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const pt of boundary) {
        if (pt[0] < minX) minX = pt[0];
        if (pt[1] < minY) minY = pt[1];
        if (pt[0] > maxX) maxX = pt[0];
        if (pt[1] > maxY) maxY = pt[1];
      }
      bb = { x0: 0, y0: 0, x1: maxX - minX, y1: maxY - minY, w: maxX - minX, h: maxY - minY };

      boundary = boundary.map(pt => [pt[0] - minX, pt[1] - minY]);
      children = children.map(child => {
        if (!child.poly) return child;
        return {
          ...child,
          poly: child.poly.map(pt => [pt[0] - minX, pt[1] - minY])
        };
      });
    }

    return {
      id: `push_${Date.now()}_${i}`,
      name: p.name || `Part ${i + 1}`,
      boundary: boundary,
      children: children,
      qty: p.qty || 1,
      bb: bb,
      color: p.color || '#60a5fa',
      material: p.material || 'Unassigned',
      sourceFile: payload.patternName || 'NestPush',
      _sizeLbl: p.sizeLbl || '',
      partName: p.partName || '',
      _side: p.side || '',
    };
  });

  AppState.parts = newParts;
  AppState.renderer.setPreviewParts(AppState.parts);
  updatePartsList();
  updateNestingSidebar();

  if (!AppState.hide) {
    setRectangularSheet();
    AppState.renderer.zoomToFit();
  }

  setState('PARTS_LOADED');
  showToast(`${newParts.length} part(s) loaded from "${payload.patternName || 'Library'}"`, 'success');

  await DataBridge.clearNestPush();
}

// ─── Nesting ────────────────────────────────────────────────────────────────

async function startNesting() {
  if (AppState.phase === 'NESTING') return;
  if (AppState.parts.length === 0) {
    showToast('Load parts before nesting', 'error');
    return;
  }

  // Read params from whichever panel is active (sidebar takes precedence)
  const nestingSidebar = document.getElementById('nesting-sidebar');
  if (nestingSidebar && nestingSidebar.style.display !== 'none') {
    syncNestingParamsFromSidebar();
  } else {
    readParams();
  }

  setState('NESTING');

  // Reset progress UI
  if (els.nestingProgress) els.nestingProgress.style.width = '0%';
  if (els.statProgress) els.statProgress.textContent = '0%';
  if (els.statPlacements) els.statPlacements.textContent = '0';
  if (els.statLiveEfficiency) els.statLiveEfficiency.textContent = '0%';
  if (els.statAreaUsed) els.statAreaUsed.textContent = '0 mm²';

  // Create nesting engine
  console.log('[NEST DEBUG] sheetW:', AppState.sheetW, 'sheetH:', AppState.sheetH);
  console.log('[NEST DEBUG] hide:', AppState.hide ? { source: AppState.hide.sourceFile, bb: AppState.hide.bb, polyLen: AppState.hide.poly.length } : 'NULL');
  console.log('[NEST DEBUG] parts[0] bb:', AppState.parts[0]?.bb);
  console.log('[NEST DEBUG] spacing:', AppState.spacing, 'rotSteps:', AppState.rotSteps, 'gravity:', AppState.gravity, 'compact:', AppState.compactPasses, 'shake:', AppState.multishake);
  const engine = new NestingEngine({
    sheetW: AppState.sheetW,
    sheetH: AppState.sheetH,
    spacing: AppState.spacing,
    rotSteps: AppState.rotSteps,
    gravity: AppState.gravity,
    sortStrat: AppState.sortStrat,
    compactPasses: AppState.compactPasses,
    multishake: AppState.multishake,
    hide: AppState.hide ? { poly: AppState.hide.poly, holes: AppState.hide.holes } : null,
    onProgress: onNestingProgress,
  });

  AppState.nestingEngine = engine;

  // Add all parts
  engine.addParts(AppState.parts);

  try {
    const result = await engine.start();
    onNestingComplete(result);
  } catch (err) {
    console.error('Nesting error:', err);
    showToast('Nesting failed: ' + err.message, 'error');
    setState('PARTS_LOADED');
  }
}

function onNestingProgress({ placed, total, efficiency, phase }) {
  const pct = total > 0 ? Math.round((placed / total) * 100) : 0;

  if (els.nestingProgress) els.nestingProgress.style.width = pct + '%';
  if (els.statProgress) els.statProgress.textContent = pct + '%';
  if (els.statPlacements) els.statPlacements.textContent = `${placed} / ${total}`;
  if (els.statLiveEfficiency) els.statLiveEfficiency.textContent = efficiency.toFixed(1) + '%';

  // Update area used
  const usedArea = (efficiency / 100) * AppState.sheetW * AppState.sheetH;
  if (els.statAreaUsed) els.statAreaUsed.textContent = formatArea(usedArea);

  // Update HUD
  updateHUD({ efficiency, placed });

  // Live update renderer with current placements
  const currentPlacements = AppState.nestingEngine ? AppState.nestingEngine.getPlaced() : [];
  AppState.placements = currentPlacements;
  AppState.renderer.setPlacements(currentPlacements);
  AppState.renderer.render();

  // Throttled parts list update (every 5 placements) for live progress
  if (placed % 5 === 0 || placed === total) {
    updatePartsList();
  }
}

function onNestingComplete(result) {
  AppState.placements = result.placements;
  AppState.efficiency = result.efficiency;
  AppState.nestingEngine = null;

  // Update renderer
  AppState.renderer.setPlacements(AppState.placements);
  AppState.renderer.setPreviewParts([]); // Clear preview since parts are placed
  AppState.renderer.render();
  AppState.renderer.zoomToFit();

  // Populate results panel
  if (els.statFinalEfficiency) els.statFinalEfficiency.textContent = result.efficiency.toFixed(1) + '%';
  if (els.statFinalArea) els.statFinalArea.textContent = formatArea(result.stats.placedArea);
  if (els.statNests) els.statNests.textContent = '1';
  if (els.statTotalPlacements) els.statTotalPlacements.textContent = result.placements.length;

  updatePartsList();
  setState('COMPLETE');
  if (!result.stats.aborted) {
    showToast(`Nesting complete: ${result.placements.length} parts placed at ${result.efficiency.toFixed(1)}% efficiency`, 'success');
  }
}

function stopNesting() {
  if (AppState.nestingEngine) {
    AppState.nestingEngine.stop();
    showToast('Nesting stopped — showing partial results', 'info');
  }
}

function readParams() {
  // Read ALL nesting params from the right panel inputs (mirrors PatterNestQ startNesting lines 1641-1646)
  if (els.paramSpacing) {
    AppState.spacing = parseFloat(els.paramSpacing.value) || 5;
  }
  if (els.paramRotations) {
    AppState.rotSteps = parseInt(els.paramRotations.value, 10) || 4;
  }
  if (els.paramGravity) {
    AppState.gravity = els.paramGravity.value || 'bl';
  }
  if (els.paramSortStrategy) {
    AppState.sortStrat = els.paramSortStrategy.value || 'area-desc';
  }
  if (els.paramMultishake) {
    AppState.multishake = els.paramMultishake.value || 'all4';
  }
  // compactPasses has no right-panel input; keep AppState default (3)

  // Sheet dimensions: mimic PatterNestQ sheetDims() logic.
  // If a real hide was detected (not rectangular-sheet), its bounding box IS the sheet.
  // If hide is rectangular-sheet or null, read from input field.
  if (AppState.hide && AppState.hide.sourceFile !== 'rectangular-sheet') {
    if (AppState.cncTable) {
        // The collision workspace is the ENTIRE physical CNC table
        AppState.sheetW = AppState.cncTable.widthMm;
        AppState.sheetH = AppState.cncTable.heightMm;
    } else {
        // Fallback for standard DXF imports without camera calibration
        AppState.sheetW = AppState.hide.bb.w;
        AppState.sheetH = AppState.hide.bb.h;
    }
  } else {
    const tableWEl = document.getElementById('param-table-width');
    const newW = tableWEl ? (parseFloat(tableWEl.value) || 1200) : AppState.sheetW;
    // No height input in right panel — maintain current sheetH (default 600 or from prior load)
    AppState.sheetW = newW;
    // If hide is rectangular-sheet, rebuild it to match new dimensions
    if (AppState.hide && AppState.hide.sourceFile === 'rectangular-sheet') {
      AppState.hide = {
        poly: [[0, 0], [AppState.sheetW, 0], [AppState.sheetW, AppState.sheetH], [0, AppState.sheetH]],
        holes: [],
        bb: { x0: 0, y0: 0, x1: AppState.sheetW, y1: AppState.sheetH, w: AppState.sheetW, h: AppState.sheetH },
        sourceFile: 'rectangular-sheet',
      };
    }
  }
}

/**
 * Wires the AI-detected boundary into the Nesting Sidebar UI
 */
function updateNestingSidebarHideCard(name, w, h, holeCount) {
    const dzH = document.getElementById('ns-dz-hide');
    const hCard = document.getElementById('ns-hide-card');
    const swEl = document.getElementById('ns-sw');
    const shEl = document.getElementById('ns-sh');

    // Hide the drop zone, show the info card
    if (dzH) dzH.style.display = 'none';
    if (hCard) hCard.style.display = 'block';

    // Update names and dimensions
    const hName = document.getElementById('ns-hc-name');
    const hDims = document.getElementById('ns-hc-dims');
    if (hName) hName.textContent = name;
    if (hDims) hDims.textContent = `${Math.round(w)} × ${Math.round(h)} mm${holeCount ? ` · ${holeCount} hole(s)` : ''}`;

    // Lock the inputs so the nesting engine respects the AI boundary
    if (swEl) { swEl.value = Math.round(w); swEl.disabled = true; }
    if (shEl) { shEl.value = Math.round(h); shEl.disabled = true; }
}

// ─── Export ─────────────────────────────────────────────────────────────────

function updateStatusBarFields() {
  const p = AppState.selectedPlacement;
  const sbSelected = $('#sb-selected');
  const sbPerimeter = $('#sb-perimeter');
  const sbArea = $('#sb-area');
  const sbNetArea = $('#sb-net-area');
  const sbLocation = $('#sb-location');
  const sbRotation = $('#sb-rotation');
  const sbNestedDims = $('#sb-nested-dims');
  const sbEfficiency = $('#sb-efficiency');

  if (sbEfficiency) sbEfficiency.textContent = AppState.efficiency > 0 ? AppState.efficiency.toFixed(1) + '%' : '—';
  if (sbNestedDims) sbNestedDims.textContent = `${AppState.sheetW}×${AppState.sheetH} mm`;

  if (p) {
    if (sbSelected) sbSelected.textContent = p.name || `Part #${AppState.selectedIndex + 1}`;
    const area = Math.abs(polyArea(p.boundary));
    if (sbArea) sbArea.textContent = area.toFixed(0) + ' mm²';
    if (sbPerimeter) sbPerimeter.textContent = calcPerimeter(p.boundary).toFixed(0) + ' mm';
    const holeArea = (p.children || []).filter(c => c.kind === 'hole').reduce((sum, c) => sum + Math.abs(polyArea(c.poly)), 0);
    if (sbNetArea) sbNetArea.textContent = (area - holeArea).toFixed(0) + ' mm²';
    if (sbLocation) sbLocation.textContent = `${(p.tx || 0).toFixed(1)}, ${(p.ty || 0).toFixed(1)}`;
    if (sbRotation) sbRotation.textContent = ((p.rot || 0) * 180 / Math.PI).toFixed(1) + '°';
  } else {
    if (sbSelected) sbSelected.textContent = 'None';
    if (sbArea) sbArea.textContent = '—';
    if (sbPerimeter) sbPerimeter.textContent = '—';
    if (sbNetArea) sbNetArea.textContent = '—';
    if (sbLocation) sbLocation.textContent = '—';
    if (sbRotation) sbRotation.textContent = '—';
  }
}

function doExportDXF(mode) {
  if (AppState.placements.length === 0) {
    showToast('No placements to export', 'error');
    return;
  }

  const settings = getMachineSettings();
  const dxf = exportDXF(AppState.placements, {
    mode: mode || 'all',
    sheetW: AppState.sheetW,
    sheetH: AppState.sheetH,
    hide: AppState.hide ? AppState.hide.poly : null,
    pwm: settings.pwm,
  });

  downloadFile('nesting.dxf', dxf, 'application/dxf');
  showToast('DXF exported successfully', 'success');
}

function doExportSVG() {
  if (AppState.placements.length === 0) {
    showToast('No placements to export', 'error');
    return;
  }

  const w = AppState.sheetW;
  const h = AppState.sheetH;
  let paths = '';

  for (const placement of AppState.placements) {
    const { boundary, children = [], tx = 0, ty = 0 } = placement;
    const pts = boundary.map(([x, y]) => `${(x + tx).toFixed(2)},${(y + ty).toFixed(2)}`).join(' ');
    paths += `  <polygon points="${pts}" fill="none" stroke="#00cc66" stroke-width="0.5"/>\n`;

    for (const child of children) {
      const cpts = child.poly.map(([x, y]) => `${(x + tx).toFixed(2)},${(y + ty).toFixed(2)}`).join(' ');
      const color = child.kind === 'hole' ? '#cc0000' : '#0066cc';
      paths += `  <polygon points="${cpts}" fill="none" stroke="${color}" stroke-width="0.3"/>\n`;
    }
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">
${paths}</svg>`;

  downloadFile('nesting.svg', svg, 'image/svg+xml');
  showToast('SVG exported successfully', 'success');
}

function doExportJSON() {
  if (AppState.placements.length === 0) {
    showToast('No placements to export', 'error');
    return;
  }

  const data = {
    sheetW: AppState.sheetW,
    sheetH: AppState.sheetH,
    efficiency: AppState.efficiency,
    placements: AppState.placements.map(p => ({
      name: p.name,
      boundary: p.boundary,
      children: p.children,
      tx: p.tx,
      ty: p.ty,
      rot: p.rot,
    })),
  };

  const json = JSON.stringify(data, null, 2);
  downloadFile('nesting.json', json, 'application/json');
  showToast('JSON exported successfully', 'success');
}

function getMachineSettings() {
  return {
    controller: $('#machine-controller')?.value || 'grbl',
    machineType: $('#machine-type')?.value || 'laser',
    feedRate: parseFloat($('#machine-feed-rate')?.value) || 1000,
    rapidRate: 3000,
    spindleSpeed: parseFloat($('#machine-spindle-speed')?.value) || 1000,
    zSafe: parseFloat($('#machine-z-safe')?.value) || 5,
    zCut: parseFloat($('#machine-z-cut')?.value) || -1,
    homeFirst: $('#machine-home-first')?.checked ?? true,
    laserOn: $('#machine-laser-on')?.value?.trim() || 'M3',
    laserOff: $('#machine-laser-off')?.value?.trim() || 'M5',
    pwm: {
      cut: parseInt($('#pwm-cut')?.value, 10) || 100,
      hole: parseInt($('#pwm-hole')?.value, 10) || 80,
      mark: parseInt($('#pwm-mark')?.value, 10) || 25,
      engrave: parseInt($('#pwm-engrave')?.value, 10) || 15
    },
    useMaterialOffset: false,
    materialOffset: { x: 0, y: 0 },
  };
}

function doExportGcode() {
  if (AppState.placements.length === 0) {
    showToast('No placements to export', 'error');
    return;
  }

  const settings = getMachineSettings();
  const gcode = exportGcode(AppState.placements, settings);

  downloadFile('nesting.gcode', gcode, 'text/plain');
  showToast(`G-code exported (${settings.machineType}, ${settings.controller})`, 'success');
}

// ─── Future Feature Stubs ──────────────────────────────────────────────────

async function detectHide() {
  if (!AppState.hideImage) {
    showToast('Load an image first, then use Detect', 'info');
    return;
  }

  const detector = AppState.hideDetector;

  if (!detector.modelReady) {
    const modelSelect = $('#model-select');
    const selectedModel = modelSelect ? modelSelect.value : 'sam-vit-base';
    showToast(`Loading ${selectedModel} AI model...`, 'info');
    const modelStatusText = $('#model-status-text');
    const modelDeviceText = $('#model-device-text');
    if (modelStatusText) modelStatusText.textContent = 'Downloading...';
    const loadTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Download timed out (600s) — use Load SAM Model panel or USB load')), 600000));
    try {
      const result = await Promise.race([
        detector.loadModel({ model: selectedModel, device: 'auto' }),
        loadTimeout
      ]);
      showToast('SAM model loaded', 'success');
      if (modelStatusText) modelStatusText.textContent = `${selectedModel} active`;
      if (modelDeviceText) modelDeviceText.textContent = result.device.toUpperCase();
    } catch (e) {
      if (modelStatusText) modelStatusText.textContent = 'Not loaded';
      showToast('Failed to load SAM model: ' + e.message, 'error');
      return;
    }
  }

  const params = { gridSize: 8, maskThreshold: 0.80, epsilon: 2.0, minAreaPercent: 1 };
  showToast(`Detecting (${AppState.strategy})...`, 'info');

  try {
    let result;

    switch (AppState.strategy) {
      case 'optionA':
        result = await detector.detectHide(AppState.hideImage, params);
        if (result && result.polygon && detector.getCalibration()) {
          const mmPoly = detector.polygonToMm(result.polygon);
          if (mmPoly) {
            AppState.correctedPolygon = mmPoly;
            showToast('Perspective correction applied', 'success');
          }
        }
        break;

      case 'optionB':
        if (!detector.getCalibration()) {
          const tableW = parseFloat($('#table-width')?.value) || 600;
          const tableH = parseFloat($('#table-height')?.value) || 400;
          try {
            const tableResult = await detector.detectCncTable(AppState.hideImage, { tableW, tableH });
            if (tableResult) {
              AppState.cncTable = tableResult;
              await detector.calibrate(tableResult.corners, tableResult.widthMm, tableResult.heightMm);
              const fb = $('#table-feedback');
              if (fb) { fb.textContent = `Table: ${tableResult.widthMm}x${tableResult.heightMm}mm`; fb.style.color = 'var(--accent-green)'; }
              showToast(`Table detected: ${tableResult.widthMm}x${tableResult.heightMm}mm`, 'success');
            }
          } catch (te) {
            showToast('Table detection skipped: ' + te.message, 'info');
          }
        }
        if (detector.getCalibration()) {
          result = await detector.rectifyAndDetect(AppState.hideImage, params);
        } else {
          result = await detector.detectHide(AppState.hideImage, params);
          showToast('No calibration — using base detection fallback', 'info');
        }
        break;

      default:
        result = await detector.detectHide(AppState.hideImage, params);
    }

    if (result && result.polygon && result.polygon.length >= 3) {
      let poly = result.polygon;
      const rawHoles = result.holes || [];
      // Normalize holes: detector returns {points, area, isDamage} objects; renderer expects [[x,y],...] arrays
      let holes = rawHoles.map(h => Array.isArray(h) ? h : (h.points || []));
      const rawBb = polyBbox(poly);
      const imgW = AppState.hideImage.naturalWidth || AppState.hideImage.width;
      const imgH = AppState.hideImage.naturalHeight || AppState.hideImage.height;
      const minArea = imgW * imgH * 0.01;
      const detectedArea = Math.abs(polyArea(poly));
      if (detectedArea < minArea || rawBb.w < 10 || rawBb.h < 10) {
        showToast('Detection returned too-small region — image preserved. Try adjusting parameters.', 'error');
      } else {

        // Convert to mm if calibrated and not already in mm
        if (detector.getCalibration() && !result._isInMm) {
          const mmPoly = detector.polygonToMm(poly);
          if (mmPoly) {
            poly = mmPoly;
            holes = holes.map(hole => {
              const mmHole = detector.polygonToMm(hole);
              return mmHole || hole;
            });
            // Shift to origin (0,0) so collision engine canvas matches polygon coords
            const mmBB = polyBbox(poly);
            poly = poly.map(([x, y]) => [x - mmBB.x0, y - mmBB.y0]);
            holes = holes.map(hole => hole.map(([x, y]) => [x - mmBB.x0, y - mmBB.y0]));
          }
        }

        const bb = polyBbox(poly);
        AppState.hide = { poly, holes, bb, sourceFile: 'detected' };
        AppState.sheetW = bb.w;
        AppState.sheetH = bb.h;

        // Wire the AI boundary to the Sidebar UI
        updateNestingSidebarHideCard('AI Detected Hide (Option B)', bb.w, bb.h, holes.length);

        AppState.renderer.setHide(poly, holes);

        requestAnimationFrame(() => {
            AppState.renderer.resize();
            AppState.renderer.zoomToFit();
            AppState.renderer.render();
        });
        updateHideProps(AppState.hide);
        setState(AppState.parts.length > 0 ? 'PARTS_LOADED' : 'HIDE_LOADED');
        showToast(`Hide detected: ${poly.length} vertices, ${holes.length} holes`, 'success');
      }
    } else {
      showToast('Detection failed — no hide boundary found. Image preserved.', 'error');
    }
  } catch (e) {
    console.error('detectHide error:', e);
    showToast('Detection error: ' + e.message, 'error');
  }
}

function calibrate() {
  AppState.calibrationMode = 'manual';
  AppState.calibrationClicks = [];
  showToast('Click 4 paper corners on canvas: TL → TR → BR → BL', 'info');
  const fb = $('#cal-feedback');
  if (fb) { fb.textContent = 'Waiting for 4 corner clicks...'; fb.style.color = 'var(--accent-amber)'; }
}

function measureDistance() {
  if (!AppState.hideDetector.getCalibration()) {
    showToast('Calibrate first to measure in real units', 'info');
    return;
  }
  AppState.measureMode = true;
  AppState.measureClicks = [];
  showToast('Click two points on canvas to measure distance', 'info');
}

function inspectPart() {
  if (AppState.selectedPlacement) {
    const p = AppState.selectedPlacement;
    const area = Math.abs(polyArea(p.boundary));
    const perim = calcPerimeter(p.boundary);
    showToast(`${p.name || 'Part'}: ${area.toFixed(0)} mm², perimeter ${perim.toFixed(0)} mm, rot ${((p.rot || 0) * 180 / Math.PI).toFixed(0)}°`, 'info');
  } else {
    showToast('Click a placed part first', 'info');
  }
}

function pauseNesting() {
  if (AppState.nestingEngine) {
    stopNesting();
    showToast('Nesting paused', 'info');
  }
}

async function autoDetectPaper() {
  if (!AppState.hideImage) { showToast('Load an image first', 'info'); return; }
  const detector = AppState.hideDetector;
  if (!detector.modelReady) { showToast('Load AI model first', 'info'); return; }

  const { w, h } = getCalibrationDimensions();
  showToast(`Auto-detecting ${w}×${h}mm paper...`, 'info');

  try {
    const result = await detector.autoDetectPaper(AppState.hideImage, { paperW: w, paperH: h });
    if (result && result.calibration) {
      const cal = result.calibration;
      const fb = $('#cal-feedback');
      if (fb) { fb.textContent = `Calibrated: ${cal.pixelsPerMm.toFixed(2)} px/mm`; fb.style.color = 'var(--accent-green)'; }
      if (els.statCalibration) els.statCalibration.textContent = `${cal.pixelsPerMm.toFixed(2)} px/mm`;
      showToast(`Paper detected. Scale: ${cal.pixelsPerMm.toFixed(2)} px/mm`, 'success');
    } else {
      showToast('Paper not found — try better lighting or manual mode', 'error');
    }
  } catch (e) {
    showToast('Auto-detect failed: ' + e.message, 'error');
  }
}

function getCalibrationDimensions() {
  const sel = $('#cal-paper-size');
  if (!sel) return { w: 279.4, h: 215.9 };
  if (sel.value === 'custom') {
    return { w: parseFloat($('#cal-width')?.value) || 297, h: parseFloat($('#cal-height')?.value) || 210 };
  }
  const [w, h] = sel.value.split(',').map(Number);
  return { w, h };
}

function resetCalibration() {
  if (AppState.hideDetector) AppState.hideDetector.resetCalibration();
  AppState.calibrationMode = null;
  AppState.calibrationClicks = [];
  const fb = $('#cal-feedback');
  if (fb) fb.textContent = '';
  if (els.statCalibration) els.statCalibration.textContent = 'Not set';
  showToast('Calibration reset', 'info');
}

function addHole() {
  if (!AppState.hide) { showToast('Detect hide first', 'info'); return; }
  AppState.holeMode = 'add';
  AppState.holeClicks = [];
  showToast('Click points to define hole. Double-click to close polygon.', 'info');
}

function removeHole() {
  if (!AppState.hide || !AppState.hide.holes || AppState.hide.holes.length === 0) {
    showToast('No holes to remove', 'info'); return;
  }
  AppState.holeMode = 'remove';
  showToast('Click near a hole to remove it', 'info');
}

function editVertices() {
  if (!AppState.hide) { showToast('Detect hide first', 'info'); return; }
  showToast('Edit Vertices: drag polygon vertices to reshape (coming soon)', 'info');
}

// ─── Checkout Wizard ──────────────────────────────────────────────────────

const CheckoutWizard = {
  step: 1,

  open() {
    const cm = AppState.checkoutManager;
    if (!cm.getPattern()) {
      if (AppState.parts.length === 0) { showToast('Load parts first', 'info'); return; }
      cm.loadPattern({
        id: 'session_' + Date.now(),
        name: 'Current Session',
        sizes: [{ id: 'default', label: 'One Size' }],
        parts: AppState.parts.map((p, i) => ({ id: 'part_' + i, name: p.name || ('Part ' + (i + 1)), color: p.color || '#7a8fa8' })),
        pieces: AppState.parts.map((p, i) => ({ pts: p.boundary, sizeId: 'default', partId: 'part_' + i, layer: p.layer || 'CUT', area: Math.abs(polyArea(p.boundary)), bbox: polyBbox(p.boundary), children: p.children || [] })),
        pwm: { cut: 100, hole: 80, mark: 25, engrave: 15 }
      });
    }
    this.step = 1;
    $('#checkout-modal').style.display = 'flex';
    this._render();
  },

  close() {
    $('#checkout-modal').style.display = 'none';
  },

  next() {
    if (this.step === 1) {
      this._saveQuantities();
      this.step = 2;
      this._render();
    } else {
      this._saveMaterials();
      this.close();
      this._pushToNesting();
    }
  },

  back() {
    if (this.step === 2) {
      this._saveMaterials();
      this.step = 1;
      this._render();
    }
  },

  _render() {
    const title = $('#checkout-title');
    const body = $('#checkout-body');
    const summary = $('#checkout-summary');
    const btnBack = $('#checkout-back');
    const btnNext = $('#checkout-next');

    if (this.step === 1) {
      title.textContent = 'Checkout — Step 1: Quantities';
      btnBack.style.display = 'none';
      btnNext.textContent = 'Next: Materials';
      this._renderStep1(body, summary);
    } else {
      title.textContent = 'Checkout — Step 2: Material Assignment';
      btnBack.style.display = '';
      btnNext.textContent = 'Finish & Push to Nesting';
      this._renderStep2(body, summary);
    }
  },

  _renderStep1(body, summary) {
    const cm = AppState.checkoutManager;
    const pat = cm.getPattern();
    const qtys = cm.getQuantities();
    let html = '<div class="checkout-qty-grid">';
    for (const sz of pat.sizes) {
      html += `<div class="checkout-qty-item">
        <label>Size: ${escapeHTML(sz.label)}</label>
        <input type="number" min="0" max="99" data-size-id="${sz.id}" value="${qtys[sz.id] || 0}">
      </div>`;
    }
    html += '</div>';
    html += `<div style="margin-top:12px"><button class="btn-secondary" id="checkout-fill-all">Set all to 1 pair</button></div>`;
    body.innerHTML = html;
    summary.textContent = `${pat.pieces.length} unique piece(s), ${pat.sizes.length} size(s)`;

    body.querySelector('#checkout-fill-all')?.addEventListener('click', () => {
      cm.setAllQuantities(1);
      body.querySelectorAll('input[data-size-id]').forEach(inp => { inp.value = '1'; });
      this._updateSummaryCount(summary);
    });
    body.querySelectorAll('input[data-size-id]').forEach(inp => {
      inp.addEventListener('change', () => {
        cm.setQuantity(inp.dataset.sizeId, parseInt(inp.value, 10) || 0);
        this._updateSummaryCount(summary);
      });
    });
  },

  _renderStep2(body, summary) {
    const cm = AppState.checkoutManager;
    const pat = cm.getPattern();
    const parts = cm.getActiveParts();
    const presets = cm.getMaterialPresets();
    const mats = cm.getMaterials();

    let html = '<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">Assign a material to each part. Parts with the same material will be grouped into one DXF file.</div>';

    // Material presets row
    html += '<div class="mat-presets-row">';
    presets.forEach(m => {
      html += `<span class="mat-preset-btn" data-preset="${escapeHTML(m)}">${escapeHTML(m)}</span>`;
    });
    html += '</div>';

    // Tile grid — one tile per part (patternOutQ gallery card style)
    html += '<div class="material-tile-grid">';
    for (const pt of parts) {
      const val = mats[pt.id] || '';
      const pcCount = pat.pieces ? pat.pieces.filter(p => p.partId === pt.id).length : 0;
      const assigned = val ? ' assigned' : '';
      html += `<div class="mat-tile${assigned}" data-part-id="${pt.id}">
        <div class="mat-tile-header">
          <div class="mat-tile-name">${escapeHTML(pt.name)}</div>
          <div class="mat-tile-stats">${pcCount} pcs across ${pat.sizes ? pat.sizes.length : 0} sizes</div>
        </div>
        <div class="mat-tile-body">
          <div class="mat-tile-chips">
            <span class="mat-tile-chip" style="color:${pt.color};border-color:${pt.color}40;background:${pt.color}12">${escapeHTML(pt.name)}</span>
          </div>
          <select class="mat-tile-select${val ? ' has-value' : ''}" data-part-id="${pt.id}">
            <option value="">— Assign Material —</option>
            ${presets.map(m => `<option value="${escapeHTML(m)}"${val === m ? ' selected' : ''}>${escapeHTML(m)}</option>`).join('')}
          </select>
        </div>
      </div>`;
    }
    html += '</div>';

    // Mirror checkbox
    html += `<div class="checkout-mirror-row"><label><input type="checkbox" id="checkout-mirror"${cm._mirrorPair ? ' checked' : ''}> L/R Pair (produces mirrored left + right exports)</label></div>`;

    // Export preview (grouped by material)
    html += '<div class="mat-group-preview" id="checkout-mat-preview"><div class="mg-title">Export Preview</div><div style="font-size:10px;color:var(--text-muted)">Assign materials above to see grouping</div></div>';

    body.innerHTML = html;
    summary.textContent = `${cm.getTotalPieces()} total piece(s) to nest`;

    // Bind tile select changes
    body.querySelectorAll('select[data-part-id]').forEach(sel => {
      sel.addEventListener('change', () => {
        cm.assignMaterial(sel.dataset.partId, sel.value);
        const tile = sel.closest('.mat-tile');
        if (tile) tile.classList.toggle('assigned', !!sel.value);
        sel.classList.toggle('has-value', !!sel.value);
        this._updateExportPreview(body, cm, pat);
      });
    });

    // Bind preset buttons
    body.querySelectorAll('.mat-preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const filledId = cm.applyPreset(btn.dataset.preset);
        if (filledId) {
          const sel = body.querySelector(`select[data-part-id="${filledId}"]`);
          if (sel) { sel.value = btn.dataset.preset; sel.classList.add('has-value'); }
          const tile = sel?.closest('.mat-tile');
          if (tile) tile.classList.add('assigned');
          this._updateExportPreview(body, cm, pat);
        }
      });
    });

    // Bind mirror checkbox
    body.querySelector('#checkout-mirror')?.addEventListener('change', (e) => {
      cm.setMirrorPair(e.target.checked);
      summary.textContent = `${cm.getTotalPieces()} total piece(s) to nest`;
      this._updateExportPreview(body, cm, pat);
    });

    this._updateExportPreview(body, cm, pat);
  },

  _updateExportPreview(body, cm, pat) {
    const prev = body.querySelector('#checkout-mat-preview');
    if (!prev) return;
    const groups = cm.getUniqueMaterials();
    if (!groups.length) {
      prev.innerHTML = '<div class="mg-title">Export Preview</div><div style="font-size:10px;color:var(--text-muted)">Assign materials above to see grouping</div>';
      return;
    }
    const patSlug = (pat.name || 'pattern').replace(/[^a-zA-Z0-9]/g, '_');
    let html = `<div class="mg-title">Export Preview — ${groups.length} DXF file${groups.length !== 1 ? 's' : ''}</div>`;
    for (const group of groups) {
      const matSlug = group.name.replace(/[^a-zA-Z0-9]/g, '_');
      const partNames = group.partIds.map(pid => {
        const pt = cm.getActiveParts().find(p => p.id === pid);
        return pt ? pt.name : pid;
      });
      html += `<div class="mg-row">
        <div class="mg-mat">${escapeHTML(group.name)}</div>
        <div class="mg-parts">${escapeHTML(partNames.join(', '))}</div>
        <div class="mg-file">${patSlug}_${matSlug}.dxf</div>
      </div>`;
    }
    prev.innerHTML = html;
  },

  _saveQuantities() {
    const cm = AppState.checkoutManager;
    const body = $('#checkout-body');
    body.querySelectorAll('input[data-size-id]').forEach(inp => {
      cm.setQuantity(inp.dataset.sizeId, parseInt(inp.value, 10) || 0);
    });
  },

  _saveMaterials() {
    const cm = AppState.checkoutManager;
    const body = $('#checkout-body');
    body.querySelectorAll('select[data-part-id]').forEach(sel => {
      cm.assignMaterial(sel.dataset.partId, sel.value);
    });
  },

  _updateSummaryCount(summary) {
    summary.textContent = `${AppState.checkoutManager.getTotalPieces()} total piece(s)`;
  },

  async _pushToNesting() {
    const cm = AppState.checkoutManager;
    const total = cm.getTotalPieces();
    if (total === 0) { showToast('Set quantities > 0 first', 'info'); return; }

    try {
      await cm.pushToNesting();
      showToast(`${total} piece(s) pushed to nesting queue`, 'success');

      // Load the pushed parts into the nesting workspace
      await loadPushedParts();

      // Sidebar Swap happens automatically now via setState inside loadPushedParts or similar flow

      // Force canvas recalculation after sidebar width change
      setTimeout(() => {
        if (AppState.renderer) {
          AppState.renderer.resize();
          AppState.renderer.render();
          AppState.renderer.zoomToFit();
        }
      }, 50);
    } catch (e) {
      showToast('Push failed: ' + e.message, 'error');
    }
  }
};

function bindCheckoutWizard() {
  const btnClose = $('#checkout-close');
  const btnBack = $('#checkout-back');
  const btnNext = $('#checkout-next');

  if (btnClose) btnClose.addEventListener('click', () => CheckoutWizard.close());
  if (btnBack) btnBack.addEventListener('click', () => CheckoutWizard.back());
  if (btnNext) btnNext.addEventListener('click', () => CheckoutWizard.next());

  $('#checkout-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'checkout-modal') CheckoutWizard.close();
  });
}

// ─── Nesting Sidebar (PatterNestQ parity) ───────────────────────────────────

async function handlePartFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext !== 'dxf' && ext !== 'svg') return;
  const text = await readFileAsText(file);
  const parsed = ext === 'dxf' ? parseDXF(text, file.name) : parseSVG(text, file.name);
  if (parsed && parsed.length > 0) {
    AppState.parts = AppState.parts.concat(parsed);
    AppState.renderer.setPreviewParts(AppState.parts);
    updatePartsList();
    updateNestingSidebar();
    if (!AppState.hide) {
      setRectangularSheet();
      AppState.renderer.zoomToFit();
    }
    setState('PARTS_LOADED');
    showToast(`${parsed.length} part(s) loaded from "${file.name}"`, 'success');
  }
}

async function handleHideFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext !== 'dxf' && ext !== 'svg') return;
  const text = await readFileAsText(file);
  const hide = parseHide(text, file.name);
  if (!hide) { showToast(`No hide boundary found in "${file.name}"`, 'error'); return; }
  AppState.hide = hide;
  AppState.sheetW = hide.bb.w;
  AppState.sheetH = hide.bb.h;
  AppState.renderer.setHide(hide);
  AppState.renderer.resize();
  AppState.renderer.zoomToFit();
  // Update nesting sidebar hide card
  const dzH = document.getElementById('ns-dz-hide');
  const hCard = document.getElementById('ns-hide-card');
  const swEl = document.getElementById('ns-sw');
  const shEl = document.getElementById('ns-sh');
  if (dzH) dzH.style.display = 'none';
  if (hCard) hCard.style.display = 'block';
  const hName = document.getElementById('ns-hc-name');
  const hDims = document.getElementById('ns-hc-dims');
  if (hName) hName.textContent = file.name;
  if (hDims) hDims.textContent = `${Math.round(hide.bb.w)} × ${Math.round(hide.bb.h)} mm${hide.holes.length ? ` · ${hide.holes.length} hole(s)` : ''}`;
  if (swEl) { swEl.value = Math.round(hide.bb.w); swEl.disabled = true; }
  if (shEl) { shEl.value = Math.round(hide.bb.h); shEl.disabled = true; }
  showToast(`Hide loaded: ${file.name} (${Math.round(hide.bb.w)} × ${Math.round(hide.bb.h)} mm)`, 'success');
}

function bindNestingSidebar() {
  // Section collapse toggles (identical to PatterNestQ toggleSection)
  document.querySelectorAll('#nesting-sidebar .ss h2').forEach(h2 => {
    h2.addEventListener('click', () => {
      const sec = h2.closest('.ss');
      if (sec) sec.classList.toggle('collapsed');
    });
  });

  // Drop zone: parts
  const dzP = document.getElementById('ns-dz-parts');
  const fiP = document.getElementById('ns-fi-parts');
  if (dzP && fiP) {
    dzP.addEventListener('dragover', e => { e.preventDefault(); dzP.classList.add('ns-dz-active'); });
    dzP.addEventListener('dragleave', () => dzP.classList.remove('ns-dz-active'));
    dzP.addEventListener('drop', async e => {
      e.preventDefault(); dzP.classList.remove('ns-dz-active');
      for (const f of e.dataTransfer.files) await handlePartFile(f);
    });
    dzP.addEventListener('click', () => fiP.click());
    fiP.addEventListener('change', async e => {
      for (const f of e.target.files) await handlePartFile(f);
      fiP.value = '';
    });
  }

  // Drop zone: hide
  const dzH = document.getElementById('ns-dz-hide');
  const fiH = document.getElementById('ns-fi-hide');
  if (dzH && fiH) {
    dzH.addEventListener('dragover', e => { e.preventDefault(); dzH.classList.add('ns-dz-active'); });
    dzH.addEventListener('dragleave', () => dzH.classList.remove('ns-dz-active'));
    dzH.addEventListener('drop', async e => {
      e.preventDefault(); dzH.classList.remove('ns-dz-active');
      if (e.dataTransfer.files[0]) await handleHideFile(e.dataTransfer.files[0]);
    });
    dzH.addEventListener('click', () => fiH.click());
    fiH.addEventListener('change', async e => {
      if (e.target.files[0]) await handleHideFile(e.target.files[0]);
      fiH.value = '';
    });
  }

  // Demo button
  document.getElementById('ns-btn-demo')?.addEventListener('click', () => {
    loadDemoPatterns();
    updateNestingSidebar();
  });

  // Start nesting
  document.getElementById('ns-btn-run')?.addEventListener('click', () => {
    syncNestingParamsFromSidebar();
    startNesting();
  });

  // Stop nesting
  document.getElementById('ns-btn-stop')?.addEventListener('click', () => {
    stopNesting();
  });

  // Export buttons
  document.getElementById('ns-btn-all')?.addEventListener('click', () => doExportDXF('all'));
  document.getElementById('ns-btn-cut')?.addEventListener('click', () => doExportDXF('cut'));
  document.getElementById('ns-btn-mark')?.addEventListener('click', () => doExportDXF('mark'));
  document.getElementById('ns-btn-gcode-all')?.addEventListener('click', () => doExportGcode());
  document.getElementById('ns-btn-gcode-cut')?.addEventListener('click', () => doExportGcode());
}

function syncNestingParamsFromSidebar() {
  const val = (id, fallback) => {
    const el = document.getElementById(id);
    return el ? el.value : fallback;
  };
  AppState.spacing = parseFloat(val('ns-sp', '2')) || 2;
  AppState.rotSteps = parseInt(val('ns-rot', '24')) || 24;
  AppState.gravity = val('ns-gravity', 'bl');
  AppState.sortStrat = val('ns-sort-strat', 'area-desc');
  AppState.compactPasses = parseInt(val('ns-compact', '3')) || 0;
  AppState.multishake = val('ns-multishake', 'all4');

  // Sheet dimensions: mimic PatterNestQ sheetDims() logic.
  // If a real hide was detected (not rectangular-sheet), its bounding box IS the sheet.
  if (AppState.hide && AppState.hide.sourceFile !== 'rectangular-sheet') {
    if (AppState.cncTable) {
        // The collision workspace is the ENTIRE physical CNC table
        AppState.sheetW = AppState.cncTable.widthMm;
        AppState.sheetH = AppState.cncTable.heightMm;
    } else {
        // Fallback for standard DXF imports without camera calibration
        AppState.sheetW = AppState.hide.bb.w;
        AppState.sheetH = AppState.hide.bb.h;
    }
  } else {
    const newW = parseFloat(val('ns-sw', '1200')) || 1200;
    const newH = parseFloat(val('ns-sh', '600')) || 600;

    AppState.sheetW = newW;
    AppState.sheetH = newH;
    // If hide is rectangular-sheet, rebuild it to match new dimensions
    if (AppState.hide && AppState.hide.sourceFile === 'rectangular-sheet') {
      AppState.hide = {
        poly: [[0, 0], [newW, 0], [newW, newH], [0, newH]],
        holes: [],
        bb: { x0: 0, y0: 0, x1: newW, y1: newH, w: newW, h: newH },
        sourceFile: 'rectangular-sheet',
      };
    }
  }
}

function updateNestingSidebar() {
  const pcEl = document.getElementById('ns-pc');
  const plEl = document.getElementById('ns-pl');
  const bsbEl = document.getElementById('ns-bsb');
  const bspEl = document.getElementById('ns-bsp');
  const bsnnEl = document.getElementById('ns-bsnn');
  const btnRun = document.getElementById('ns-btn-run');
  const btnAll = document.getElementById('ns-btn-all');
  const btnCut = document.getElementById('ns-btn-cut');
  const btnMark = document.getElementById('ns-btn-mark');

  if (!pcEl) return;

  const totalParts = AppState.parts.length;
  const totalPcs = AppState.parts.reduce((s, p) => s + (p.qty || 1), 0);
  const placedCount = AppState.placements ? AppState.placements.length : 0;
  const pending = totalPcs - placedCount;

  pcEl.textContent = `(${totalParts})`;

  if (bsbEl) bsbEl.style.display = (placedCount > 0 || pending > 0) ? 'block' : 'none';
  if (bspEl) bspEl.textContent = placedCount;
  if (bsnnEl) bsnnEl.textContent = pending;

  // Render parts list identical to PatterNestQ updateUI()
  if (plEl) {
    if (!totalParts) {
      plEl.innerHTML = '<div class="eh">No parts loaded</div>';
    } else {
      plEl.innerHTML = AppState.parts.map(p => {
        const placed = AppState.placements ? AppState.placements.filter(pl => pl.partId === p.id).length : 0;
        const done = placed >= (p.qty || 1);
        const pct = Math.round(placed / (p.qty || 1) * 100);
        return `<div class="pr${done ? ' dn' : ''}">
          <div class="pr-bar"><div class="pr-bar-fill" style="width:${pct}%;background:${p.color || '#3a9eff'}"></div></div>
          <div class="pi">
            <div class="pn" title="${escapeHTML(p.name || '')}">${escapeHTML(p.name || 'Part')}</div>
            <div class="pm">${Math.round(p.bb.w)} × ${Math.round(p.bb.h)} mm${placed > 0 ? ` <span class="pla">· ${placed}/${p.qty || 1}</span>` : ''}</div>
          </div>
          <div class="pr-footer">
            <div class="pq"><em>×</em><span class="pqi">${p.qty || 1}</span></div>
            ${done ? '<span class="ok">✓</span>' : ''}
          </div>
        </div>`;
      }).join('');
    }
  }

  if (btnRun) btnRun.disabled = pending <= 0 || AppState.phase === 'NESTING';
  if (btnRun) btnRun.textContent = placedCount > 0 ? `▶  Nest ${pending} New Part${pending !== 1 ? 's' : ''}` : '▶  Start Nesting';
  const hasPlaced = placedCount > 0;
  if (btnAll) btnAll.disabled = !hasPlaced;
  if (btnCut) btnCut.disabled = !hasPlaced;
  if (btnMark) btnMark.disabled = !hasPlaced;
}

// ─── Strategy Selector ─────────────────────────────────────────────────────

function bindStrategySelector() {
  const stratSelect = $('#strategy-select');
  const stratDesc = $('#strategy-description');
  const cncSection = $('#sec-cnc-table-ui');

  const descriptions = {
    base: 'Standard grid-based detection. Best for overhead orthogonal cameras.',
    optionA: 'Perspective-corrected polygon output. Best for angled/perspective cameras.',
    optionB: 'Rectify & Detect pipeline with table mask exclusion. Best for cluttered backgrounds.',
  };

  if (stratSelect) {
    stratSelect.addEventListener('change', () => {
      AppState.strategy = stratSelect.value;
      if (stratDesc) stratDesc.textContent = descriptions[AppState.strategy];
      if (cncSection) cncSection.style.display = AppState.strategy === 'optionB' ? '' : 'none';
      showToast(`Strategy: ${AppState.strategy}`, 'info');
    });
  }
}

// ─── Calibration UI ────────────────────────────────────────────────────────

function bindCalibrationUI() {
  const paperSelect = $('#cal-paper-size');
  const customRow = $('#cal-custom-row');
  const btnAuto = $('#btn-auto-calibrate');
  const btnManual = $('#btn-manual-calibrate');
  const btnReset = $('#btn-reset-calibration');

  if (paperSelect) {
    paperSelect.addEventListener('change', () => {
      if (customRow) customRow.style.display = paperSelect.value === 'custom' ? '' : 'none';
    });
  }
  if (btnAuto) btnAuto.addEventListener('click', autoDetectPaper);
  if (btnManual) btnManual.addEventListener('click', calibrate);
  if (btnReset) btnReset.addEventListener('click', resetCalibration);
}

// ─── CNC Table UI ──────────────────────────────────────────────────────────

function bindCncTableUI() {
  const btnAutoTable = $('#btn-auto-detect-table');
  const btnResetTable = $('#btn-reset-table');
  const btnManualTable = $('#btn-manual-table');

  if (btnAutoTable) {
    btnAutoTable.addEventListener('click', async () => {
      if (!AppState.hideImage) { showToast('Load an image first', 'info'); return; }
      if (!AppState.hideDetector.modelReady) { showToast('Load AI model first', 'info'); return; }
      const tableW = parseFloat($('#table-width')?.value) || 600;
      const tableH = parseFloat($('#table-height')?.value) || 400;
      showToast('Auto-detecting CNC table...', 'info');
      try {
        const result = await AppState.hideDetector.detectCncTable(AppState.hideImage, { tableW, tableH });
        if (result) {
          AppState.cncTable = result;
          await AppState.hideDetector.calibrate(result.corners, result.widthMm, result.heightMm);
          const fb = $('#table-feedback');
          if (fb) { fb.textContent = `Table: ${result.widthMm}×${result.heightMm}mm`; fb.style.color = 'var(--accent-green)'; }
          showToast(`Table detected: ${result.widthMm}×${result.heightMm}mm`, 'success');
        } else {
          showToast('Table not detected — try manual mode', 'error');
        }
      } catch (e) {
        showToast('Table detection failed: ' + e.message, 'error');
      }
    });
  }

  if (btnResetTable) {
    btnResetTable.addEventListener('click', () => {
      AppState.cncTable = null;
      const fb = $('#table-feedback');
      if (fb) fb.textContent = '';
      showToast('Table reset', 'info');
    });
  }

  if (btnManualTable) {
    btnManualTable.addEventListener('click', () => {
      AppState.calibrationMode = 'manual-table';
      AppState.calibrationClicks = [];
      showToast('Click 4 table corners: TL → TR → BR → BL', 'info');
    });
  }
}

// ─── Camera ────────────────────────────────────────────────────────────────

function bindCameraUI() {
  const btnCapture = $('#btn-camera-capture');
  const btnResume = $('#btn-camera-resume');
  const btnStop = $('#btn-camera-stop');

  if (btnCapture) btnCapture.addEventListener('click', freezeFrame);
  if (btnResume) btnResume.addEventListener('click', resumeCamera);
  if (btnStop) btnStop.addEventListener('click', stopCamera);
}

async function startCamera() {
  try {
    const video = $('#camera-video');
    const controls = $('#camera-controls');
    if (!video) { showToast('Camera element not found', 'error'); return; }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 } }
    });
    video.srcObject = stream;
    video.style.display = '';
    if (controls) controls.style.display = 'flex';
    AppState.cameraStream = stream;
    AppState.frozenFrame = false;
    await video.play();
    showToast(`Camera: ${video.videoWidth}×${video.videoHeight}`, 'success');
  } catch (e) {
    showToast('Camera error: ' + e.message, 'error');
  }
}

function freezeFrame() {
  const video = $('#camera-video');
  if (!video || !AppState.cameraStream) return;

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);

  const img = new Image();
  img.onload = () => {
    AppState.hideImage = img;
    AppState.sheetW = img.naturalWidth;
    AppState.sheetH = img.naturalHeight;
    AppState.renderer.setBackgroundImage(img);
    AppState.renderer.resize();
    AppState.renderer.zoomToFit();
    transitionAfterHideLoad();
  };
  img.src = canvas.toDataURL();
  AppState.frozenFrame = true;
  video.pause();
  const btnResume = $('#btn-camera-resume');
  if (btnResume) btnResume.style.display = '';
  showToast('Frame captured — ready to detect', 'success');
}

function resumeCamera() {
  const video = $('#camera-video');
  if (video) { video.play(); AppState.frozenFrame = false; }
  const btnResume = $('#btn-camera-resume');
  if (btnResume) btnResume.style.display = 'none';
}

function stopCamera() {
  if (AppState.cameraStream) {
    AppState.cameraStream.getTracks().forEach(t => t.stop());
    AppState.cameraStream = null;
  }
  const video = $('#camera-video');
  const controls = $('#camera-controls');
  if (video) video.style.display = 'none';
  if (controls) controls.style.display = 'none';
  AppState.frozenFrame = false;
  showToast('Camera stopped', 'info');
}

// ─── Drag & Drop ────────────────────────────────────────────────────────────

function bindDropZone() {
  const target = els.canvas || document.getElementById('canvas-area');
  if (!target) return;

  target.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    target.classList.add('drop-active');
  });
  target.addEventListener('dragleave', () => {
    target.classList.remove('drop-active');
  });
  target.addEventListener('drop', async (e) => {
    e.preventDefault();
    target.classList.remove('drop-active');
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    const imageFiles = [];
    const vectorFiles = [];
    for (const f of files) {
      const ext = f.name.split('.').pop().toLowerCase();
      if (ext === 'dxf' || ext === 'svg') vectorFiles.push(f);
      else if (f.type.startsWith('image/')) imageFiles.push(f);
    }

    if (imageFiles.length > 0) {
      const file = imageFiles[0];
      const img = new Image();
      img.onload = () => {
        AppState.sheetW = img.naturalWidth;
        AppState.sheetH = img.naturalHeight;
        AppState.hideImage = img;
        setRectangularSheet();
        AppState.renderer.setBackgroundImage(img);
        AppState.renderer.resize();
        AppState.renderer.zoomToFit();
        transitionAfterHideLoad();
        showToast(`Image dropped: ${img.naturalWidth} × ${img.naturalHeight} px`, 'success');
      };
      img.src = URL.createObjectURL(file);
    }

    if (vectorFiles.length > 0) {
      let newParts = [];
      for (const file of vectorFiles) {
        const text = await readFileAsText(file);
        const ext = file.name.split('.').pop().toLowerCase();
        const parsed = ext === 'dxf' ? parseDXF(text, file.name) : parseSVG(text, file.name);
        if (parsed && parsed.length > 0) newParts = newParts.concat(parsed);
      }
      if (newParts.length > 0) {
        AppState.parts = AppState.parts.concat(newParts);
        AppState.renderer.setPreviewParts(AppState.parts);
        updatePartsList();
        if (!AppState.hide) {
          setRectangularSheet();
          AppState.renderer.zoomToFit();
        }
        setState('PARTS_LOADED');
        showToast(`${newParts.length} part(s) loaded via drop`, 'success');
      }
    }
  });
}

// ─── Canvas Click Handler (calibration, measure, holes) ────────────────────

function bindCanvasClickHandler() {
  if (!els.canvas) return;
  els.canvas.addEventListener('click', (e) => {
    const rect = els.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const world = AppState.renderer.screenToWorld(sx, sy);

    // Manual calibration (4 clicks)
    if (AppState.calibrationMode === 'manual' || AppState.calibrationMode === 'manual-table') {
      AppState.calibrationClicks.push({ x: world.x, y: world.y });
      showToast(`Corner ${AppState.calibrationClicks.length}/4`, 'info');

      if (AppState.calibrationClicks.length === 4) {
        const mode = AppState.calibrationMode;
        AppState.calibrationMode = null;
        const clicks = AppState.calibrationClicks.map(c => [c.x, c.y]);
        AppState.calibrationClicks = [];

        if (mode === 'manual-table') {
          const tableW = parseFloat($('#table-width')?.value) || 600;
          const tableH = parseFloat($('#table-height')?.value) || 400;
          AppState.hideDetector.calibrate(clicks, tableW, tableH).then(() => {
            const fb = $('#table-feedback');
            if (fb) { fb.textContent = `Table calibrated: ${tableW}×${tableH}mm`; fb.style.color = 'var(--accent-green)'; }
            showToast('Table calibrated manually', 'success');
          }).catch(err => showToast('Table calibration failed: ' + err.message, 'error'));
        } else {
          const { w, h } = getCalibrationDimensions();
          AppState.hideDetector.calibrate(clicks, w, h).then((cal) => {
            const fb = $('#cal-feedback');
            if (fb) { fb.textContent = `Calibrated: ${cal.pixelsPerMm.toFixed(2)} px/mm`; fb.style.color = 'var(--accent-green)'; }
            if (els.statCalibration) els.statCalibration.textContent = `${cal.pixelsPerMm.toFixed(2)} px/mm`;
            showToast(`Calibrated: ${cal.pixelsPerMm.toFixed(2)} px/mm`, 'success');
          }).catch(err => showToast('Calibration failed: ' + err.message, 'error'));
        }
      }
      return;
    }

    // Measure distance (2 clicks)
    if (AppState.measureMode) {
      AppState.measureClicks.push(world);
      if (AppState.measureClicks.length === 2) {
        const [p1, p2] = AppState.measureClicks;
        const cal = AppState.hideDetector.getCalibration();
        const distPx = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        const distMm = cal && cal.pixelsPerMm ? distPx / cal.pixelsPerMm : distPx;
        const unit = cal && cal.pixelsPerMm ? 'mm' : 'px';
        showToast(`Distance: ${distMm.toFixed(1)} ${unit}`, 'success');
        AppState.measureMode = false;
        AppState.measureClicks = [];
      } else {
        showToast('Click second point...', 'info');
      }
      return;
    }

    // Remove hole mode
    if (AppState.holeMode === 'remove' && AppState.hide && AppState.hide.holes) {
      let closest = -1, closestDist = Infinity;
      for (let i = 0; i < AppState.hide.holes.length; i++) {
        const hole = AppState.hide.holes[i];
        const pts = hole.points || hole;
        if (!Array.isArray(pts) || pts.length === 0) continue;
        for (const pt of pts) {
          const d = Math.hypot((pt[0] || pt.x) - world.x, (pt[1] || pt.y) - world.y);
          if (d < closestDist) { closestDist = d; closest = i; }
        }
      }
      if (closest >= 0 && closestDist < 50) {
        AppState.hide.holes.splice(closest, 1);
        AppState.renderer.setHide(AppState.hide.poly, AppState.hide.holes);
        AppState.renderer.render();
        showToast('Hole removed', 'success');
      }
      AppState.holeMode = null;
      return;
    }
  });

  // Double-click to close hole polygon
  els.canvas.addEventListener('dblclick', (e) => {
    if (AppState.holeMode === 'add' && AppState.holeClicks.length >= 3) {
      const holePoly = AppState.holeClicks.map(c => [c.x, c.y]);
      if (!AppState.hide.holes) AppState.hide.holes = [];
      AppState.hide.holes.push(holePoly);
      AppState.renderer.setHide(AppState.hide.poly, AppState.hide.holes);
      AppState.renderer.render();
      showToast(`Hole added (${holePoly.length} vertices)`, 'success');
      AppState.holeMode = null;
      AppState.holeClicks = [];
    }
  });

  // Track hole-add clicks (single click when in add mode)
  els.canvas.addEventListener('mousedown', (e) => {
    if (AppState.holeMode === 'add' && e.button === 0) {
      const rect = els.canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const world = AppState.renderer.screenToWorld(sx, sy);
      AppState.holeClicks.push(world);
    }
  });
}

function toggleMaskOverlay() {
  AppState.renderer.setOption('debugOverlay', !AppState.renderer.options.debugOverlay);
  showToast('Mask overlay toggled', 'info');
}

function debugCollisionMap() {
  AppState.renderer.setOption('debugOverlay', !AppState.renderer.options.debugOverlay);
  showToast('Collision map debug toggled', 'info');
}

function loadDemoPatterns() {
  const demoParts = [];
  const shapes = ['Vamp', 'Quarter', 'Tongue', 'Counter', 'Heel', 'Toe Cap', 'Lining', 'Insole'];
  for (let i = 0; i < shapes.length; i++) {
    const w = 60 + Math.random() * 80;
    const h = 40 + Math.random() * 60;
    demoParts.push({
      id: 'demo_' + i,
      name: shapes[i],
      boundary: [[0, 0], [w, 0], [w, h], [0, h]],
      children: [],
      qty: 2,
      bb: { x0: 0, y0: 0, x1: w, y1: h, w, h },
      color: PART_COLORS_DEMO[i % 10],
      material: null,
      sourceFile: 'demo'
    });
  }
  AppState.parts = AppState.parts.concat(demoParts);
  AppState.renderer.setPreviewParts(AppState.parts);
  updatePartsList();
  if (!AppState.hide) setRectangularSheet();
  setState('PARTS_LOADED');
  showToast('8 demo patterns loaded', 'success');
}

const PART_COLORS_DEMO = [
  '#b8ff47', '#00d4ff', '#ffaa00', '#ff4466', '#8855ff',
  '#00cc88', '#ff9500', '#3a9eff', '#ff6b5b', '#ffc542'
];

function showNestingParamsPanel() {
  if (els.panelNestingParams) {
    els.panelNestingParams.style.display = '';
    els.panelNestingParams.scrollIntoView({ behavior: 'smooth' });
  }
}

// ─── Reset / Clear ──────────────────────────────────────────────────────────

function newNesting() {
  AppState.placements = [];
  AppState.efficiency = 0;
  AppState.renderer.setPlacements([]);
  AppState.renderer.setPreviewParts(AppState.parts);
  AppState.renderer.render();

  if (AppState.parts.length > 0) {
    setState('PARTS_LOADED');
  } else if (AppState.hide) {
    setState('HIDE_LOADED');
  } else {
    setState('IDLE');
  }
  showToast('Placements cleared', 'info');
}

function transferPendingToNewJob() {
  let totalPending = 0;
  const newPartsList = [];

  AppState.parts.forEach(part => {
    const placedCount = AppState.placements.filter(p => p.id === part.id).length;
    const unplacedQty = (part.qty || 1) - placedCount;

    if (unplacedQty > 0) {
      newPartsList.push({ ...part, qty: unplacedQty });
      totalPending += unplacedQty;
    }
  });

  if (totalPending === 0) {
    showToast('No pending parts to transfer.', 'info');
    return;
  }

  if (!confirm(`Transfer ${totalPending} unplaced pieces to a new sheet?\nThis will clear current placements.`)) {
    return;
  }

  AppState.parts = newPartsList;
  AppState.placements = [];
  AppState.efficiency = 0;

  AppState.renderer.setPlacements([]);
  AppState.renderer.setPreviewParts(AppState.parts);
  AppState.renderer.render();

  updatePartsList();
  setState('PARTS_LOADED');
  showToast(`New job loaded with ${totalPending} pieces. Drop a new hide to continue.`, 'success');
}

function clearParts() {
  AppState.parts = [];
  AppState.placements = [];
  AppState.efficiency = 0;
  AppState.renderer.setPlacements([]);
  AppState.renderer.setPreviewParts([]);
  AppState.renderer.render();
  updatePartsList();

  if (AppState.hide) {
    setState('HIDE_LOADED');
  } else {
    setState('IDLE');
  }
  showToast('All parts cleared', 'info');
}

// ─── Part Library (load patterns from IndexedDB NestingDB) ─────────────────

async function openPartLibrary() {
  try {
    const patterns = await DataBridge.getNestingDBPatterns();

    if (!patterns || patterns.length === 0) {
      showToast('No saved patterns — import DXF/SVG files or use Demo', 'info');
      return;
    }

    // Pick the most recent pattern (by savedAt, lastUsedAt, or ts)
    const sorted = patterns.slice().sort((a, b) => {
      const tsA = a.lastUsedAt || new Date(a.savedAt || 0).getTime() || a.ts || 0;
      const tsB = b.lastUsedAt || new Date(b.savedAt || 0).getTime() || b.ts || 0;
      return tsB - tsA;
    });
    const latest = sorted[0];

    // Convert NestingDB pieces to AppState.parts format
    const pieces = latest.pieces || [];
    if (pieces.length === 0) {
      showToast(`Pattern "${latest.name}" has no pieces`, 'warning');
      return;
    }

    const partColors = [
      '#b8ff47', '#00d4ff', '#ffaa00', '#ff4466', '#8855ff',
      '#00cc88', '#ff9500', '#3a9eff', '#ff6b5b', '#ffc542'
    ];

    // Build a part-name color map from the stored pattern metadata
    const partMap = new Map();
    if (latest.parts && Array.isArray(latest.parts)) {
      latest.parts.forEach(p => partMap.set(p.id, p));
    }

    const newParts = [];
    let colorIdx = 0;

    for (const piece of pieces) {
      const boundary = piece.boundary || piece.pts || [];
      if (!boundary || boundary.length < 3) continue;

      const bb = piece.bbox || polyBbox(boundary);
      const partMeta = piece.partId ? partMap.get(piece.partId) : null;
      const partName = partMeta ? partMeta.name : (piece.name || piece.layer || 'Part');
      const sizeMeta = piece.sizeId && latest.sizes
        ? latest.sizes.find(s => s.id === piece.sizeId)
        : null;
      const name = sizeMeta ? `${partName}_${sizeMeta.label}` : partName;

      const color = partMeta ? (partMeta.color || partColors[colorIdx % partColors.length]) : partColors[colorIdx % partColors.length];
      colorIdx++;

      newParts.push({
        id: piece.id || ('lib_' + Date.now() + '_' + newParts.length),
        name,
        boundary,
        children: piece.children || [],
        qty: 1,
        bb: { x0: bb.x, y0: bb.y, x1: bb.x + bb.w, y1: bb.y + bb.h, w: bb.w, h: bb.h },
        color,
        material: piece.material || null,
        sourceFile: `NestingDB: ${latest.name}`
      });
    }

    if (newParts.length === 0) {
      showToast(`No valid pieces in pattern "${latest.name}"`, 'warning');
      return;
    }

    // Append to current parts
    AppState.parts = AppState.parts.concat(newParts);
    AppState.renderer.setPreviewParts(AppState.parts);
    updatePartsList();

    if (!AppState.hide) {
      setRectangularSheet();
      AppState.renderer.zoomToFit();
    }

    setState('PARTS_LOADED');

    const moreText = sorted.length > 3 ? ` (+${sorted.length - 3} more in DB)` : '';
    showToast(`Loaded ${newParts.length} piece(s) from "${latest.name}"${moreText}`, 'success');
  } catch (err) {
    console.error('[Part Library] Failed to load from NestingDB:', err);
    showToast('Failed to load Part Library: ' + err.message, 'error');
  }
}

function clearHide() {
  AppState.hide = null;
  AppState.renderer.setSheet(0, 0);
  AppState.renderer.setPlacements([]);
  AppState.renderer.setPreviewParts(AppState.parts);
  AppState.placements = [];
  AppState.efficiency = 0;
  AppState.renderer.render();

  // Reset the Nesting Sidebar Card
  const dzH = document.getElementById('ns-dz-hide');
  const hCard = document.getElementById('ns-hide-card');
  const swEl = document.getElementById('ns-sw');
  const shEl = document.getElementById('ns-sh');
  if (dzH) dzH.style.display = 'block'; // Show drop zone
  if (hCard) hCard.style.display = 'none'; // Hide info card
  if (swEl) { swEl.value = 1200; swEl.disabled = false; } // Unlock inputs
  if (shEl) { shEl.value = 600; shEl.disabled = false; }

  setState('IDLE');
  showToast('Hide cleared', 'info');
}

// ─── Session Persistence ──────────────────────────────────────────────────

const SESSION_KEY = 'cadshot_session';

function saveSessionState() {
  const state = {
    hide: AppState.hide,
    parts: AppState.parts,
    placements: AppState.placements,
    sheetW: AppState.sheetW,
    sheetH: AppState.sheetH,
    spacing: AppState.spacing,
    rotSteps: AppState.rotSteps,
    gravity: AppState.gravity,
    sortStrat: AppState.sortStrat,
    compactPasses: AppState.compactPasses,
    multishake: AppState.multishake,
    efficiency: AppState.efficiency,
    phase: AppState.phase,
    hideImageSrc: null
  };

  if (AppState.hideImage) {
    try {
      const c = document.createElement('canvas');
      c.width = AppState.hideImage.naturalWidth;
      c.height = AppState.hideImage.naturalHeight;
      c.getContext('2d').drawImage(AppState.hideImage, 0, 0);
      state.hideImageSrc = c.toDataURL('image/jpeg', 0.8);
    } catch (e) { /* cross-origin image, skip */ }
  }

  DataBridge.saveSession(SESSION_KEY, state);
  showToast('Session saved', 'success');
}

function restoreSessionState() {
  const state = DataBridge.loadSession(SESSION_KEY);
  if (!state) return false;

  AppState.sheetW = state.sheetW || 1200;
  AppState.sheetH = state.sheetH || 600;
  AppState.spacing = state.spacing || 5;
  AppState.rotSteps = state.rotSteps || 4;
  AppState.gravity = state.gravity || 'bl';
  AppState.sortStrat = state.sortStrat || 'area-desc';
  AppState.compactPasses = state.compactPasses || 3;
  AppState.multishake = state.multishake || 'all4';
  AppState.efficiency = state.efficiency || 0;

  if (state.hide) {
    AppState.hide = state.hide;
    AppState.renderer.setHide(state.hide.poly, state.hide.holes || []);
    AppState.renderer.setSheet(AppState.sheetW, AppState.sheetH);
  }

  if (state.parts && state.parts.length > 0) {
    AppState.parts = state.parts;
    AppState.renderer.setPreviewParts(AppState.parts);
    updatePartsList();
  }

  if (state.placements && state.placements.length > 0) {
    AppState.placements = state.placements;
    AppState.renderer.setPlacements(AppState.placements);
  }

  if (state.hideImageSrc) {
    const img = new Image();
    img.onload = () => {
      AppState.hideImage = img;
      AppState.renderer.setBackgroundImage(img);
      AppState.renderer.resize();
      AppState.renderer.zoomToFit();
    };
    img.src = state.hideImageSrc;
  }

  // Sync UI selectors with restored state
  if ($('#param-spacing')) $('#param-spacing').value = AppState.spacing;
  if ($('#param-rotations')) $('#param-rotations').value = AppState.rotSteps;
  if ($('#param-sort-strategy')) $('#param-sort-strategy').value = AppState.sortStrat;
  if ($('#param-gravity')) $('#param-gravity').value = AppState.gravity;
  if ($('#param-multishake')) $('#param-multishake').value = AppState.multishake;

  const phase = state.phase || 'IDLE';
  if (phase !== 'NESTING') {
    setState(phase);
  } else {
    setState('PARTS_LOADED');
  }

  AppState.renderer.resize();
  AppState.renderer.zoomToFit();
  return true;
}

function resetAll() {
  AppState.hide = null;
  AppState.parts = [];
  AppState.placements = [];
  AppState.efficiency = 0;
  AppState.nestingEngine = null;

  AppState.renderer.setSheet(0, 0);
  AppState.renderer.setPlacements([]);
  AppState.renderer.setPreviewParts([]);
  AppState.renderer.render();
  updatePartsList();

  setState('IDLE');
  showToast('Project reset', 'info');
}

// ─── Utility ────────────────────────────────────────────────────────────────

function toggleRightPanel() {
  if (els.rightPanel) {
    els.rightPanel.classList.toggle('collapsed');
  }
}

function showToast(message, type = '') {
  const container = els.toastContainer;
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast' + (type ? ' ' + type : '');
  toast.textContent = message;
  container.appendChild(toast);

  // Auto-remove after 3 seconds
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ─── Context Menus ─────────────────────────────────────────────────────────

let _activeContextMenu = null;

function showContextMenu(menuId, x, y) {
  hideContextMenu();
  const menu = document.getElementById(menuId);
  if (!menu) return;

  menu.style.display = 'block';
  menu.style.left = Math.min(x, window.innerWidth - 200) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - menu.offsetHeight - 10) + 'px';
  _activeContextMenu = menu;

  // Focus first item
  const firstItem = menu.querySelector('.ctx-item');
  if (firstItem) firstItem.focus();
}

function hideContextMenu() {
  document.querySelectorAll('.context-menu').forEach(m => m.style.display = 'none');
  if (_activeContextMenu) {
    _activeContextMenu = null;
    if (els.canvas) els.canvas.focus();
  }
}

function ctxMenuNavigate(direction) {
  if (!_activeContextMenu) return;
  const items = [..._activeContextMenu.querySelectorAll('.ctx-item')];
  if (items.length === 0) return;
  const current = document.activeElement;
  let idx = items.indexOf(current);
  if (direction === 'down') idx = (idx + 1) % items.length;
  else if (direction === 'up') idx = (idx - 1 + items.length) % items.length;
  else if (direction === 'home') idx = 0;
  else if (direction === 'end') idx = items.length - 1;
  items[idx].focus();
}

document.addEventListener('click', hideContextMenu);
document.addEventListener('keydown', (e) => {
  if (!_activeContextMenu) return;
  switch (e.key) {
    case 'Escape':
      e.preventDefault();
      hideContextMenu();
      break;
    case 'ArrowDown':
      e.preventDefault();
      ctxMenuNavigate('down');
      break;
    case 'ArrowUp':
      e.preventDefault();
      ctxMenuNavigate('up');
      break;
    case 'Home':
      e.preventDefault();
      ctxMenuNavigate('home');
      break;
    case 'End':
      e.preventDefault();
      ctxMenuNavigate('end');
      break;
    case 'Enter':
    case ' ':
      e.preventDefault();
      if (document.activeElement && document.activeElement.classList.contains('ctx-item')) {
        document.activeElement.click();
      }
      break;
  }
});

document.querySelectorAll('.ctx-item[data-action]').forEach(item => {
  item.addEventListener('click', (e) => {
    e.stopPropagation();
    const action = item.dataset.action;
    hideContextMenu();

    switch (action) {
      case 'delete':
        if (AppState.selectedIndex >= 0 && AppState.placements.length > 0) {
          AppState.placements.splice(AppState.selectedIndex, 1);
          AppState.renderer.setPlacements(AppState.placements);
          AppState.renderer.render();
          AppState.selectedPlacement = null;
          AppState.selectedIndex = -1;
          updateStatusBarFields();
          showToast('Placement deleted', 'success');
        }
        break;
      case 'rotate-90':
        if (AppState.selectedPlacement) {
          const p = AppState.placements[AppState.selectedIndex];
          if (p) {
            p.rot = ((p.rot || 0) + Math.PI / 2) % (Math.PI * 2);
            const cos = Math.cos(Math.PI / 2), sin = Math.sin(Math.PI / 2);
            p.boundary = p.boundary.map(([x, y]) => [x * cos - y * sin, x * sin + y * cos]);
            AppState.renderer.setPlacements(AppState.placements);
            AppState.renderer.render();
            showToast('Rotated 90°', 'success');
          }
        }
        break;
      case 'flip-h':
        if (AppState.selectedPlacement) {
          const p = AppState.placements[AppState.selectedIndex];
          if (p) {
            p.boundary = p.boundary.map(([x, y]) => [-x, y]);
            AppState.renderer.setPlacements(AppState.placements);
            AppState.renderer.render();
            showToast('Flipped horizontal', 'success');
          }
        }
        break;
      case 'flip-v':
        if (AppState.selectedPlacement) {
          const p = AppState.placements[AppState.selectedIndex];
          if (p) {
            p.boundary = p.boundary.map(([x, y]) => [x, -y]);
            AppState.renderer.setPlacements(AppState.placements);
            AppState.renderer.render();
            showToast('Flipped vertical', 'success');
          }
        }
        break;
      case 'move-front':
        if (AppState.selectedIndex >= 0 && AppState.selectedIndex < AppState.placements.length - 1) {
          const [item] = AppState.placements.splice(AppState.selectedIndex, 1);
          AppState.placements.push(item);
          AppState.selectedIndex = AppState.placements.length - 1;
          AppState.renderer.setPlacements(AppState.placements);
          AppState.renderer.render();
          showToast('Moved to front', 'info');
        }
        break;
      case 'move-back':
        if (AppState.selectedIndex > 0) {
          const [item] = AppState.placements.splice(AppState.selectedIndex, 1);
          AppState.placements.unshift(item);
          AppState.selectedIndex = 0;
          AppState.renderer.setPlacements(AppState.placements);
          AppState.renderer.render();
          showToast('Moved to back', 'info');
        }
        break;
      case 'duplicate':
        if (AppState.selectedPlacement) {
          const src = AppState.placements[AppState.selectedIndex];
          if (src) {
            const dup = JSON.parse(JSON.stringify(src));
            dup.tx = (dup.tx || 0) + 10;
            dup.ty = (dup.ty || 0) + 10;
            AppState.placements.push(dup);
            AppState.renderer.setPlacements(AppState.placements);
            AppState.renderer.render();
            showToast('Duplicated', 'success');
          }
        }
        break;
      case 'inspect':
        if (AppState.selectedPlacement) {
          const p = AppState.selectedPlacement;
          const area = Math.abs(polyArea(p.boundary));
          showToast(`${p.name || 'Part'}: ${area.toFixed(0)} mm², rot ${((p.rot || 0) * 180 / Math.PI).toFixed(0)}°`, 'info');
        }
        break;
      case 'clear-all':
        newNesting();
        break;
      case 'undo':
        if (AppState.placements.length > 0) {
          AppState.placements.pop();
          AppState.renderer.setPlacements(AppState.placements);
          AppState.renderer.render();
          showToast('Last placement removed', 'info');
        }
        break;
      case 'zoom-fit':
        AppState.renderer.zoomToFit();
        break;
      case 'zoom-100':
        AppState.renderer.setZoom(1.0);
        AppState.renderer.render();
        break;
      case 'toggle-grid':
        AppState.renderer.setOption('showGrid', !AppState.renderer.options.showGrid);
        break;
    }
  });
});

// ─── Sibling Detection ────────────────────────────────────────────────────
// Verifies iframe sources are reachable and listens for cross-tab DB updates.

function bindSiblingDetection() {
  // Verify patternOutQ.html is accessible for the Library iframe
  AppState.patternLibrary.detectSibling('patternOutQ.html').then(found => {
    if (!found) {
      console.warn('[PageRouter] patternOutQ.html not found — Library page may not load');
    }
  });

  // Verify patternINQ.html is accessible for the PatternINQ iframe
  AppState.patternLibrary.detectSibling('patternINQ.html').then(found => {
    if (!found) {
      console.warn('[PageRouter] patternINQ.html not found — PatternINQ page may not load');
    }
  });

  // Listen for cross-tab nesting DB updates (iframe pages write to shared IndexedDB/localStorage)
  DataBridge.onStorageChange('patterniq_nesting_db', (newValue) => {
    if (newValue) {
      showToast('Nesting DB updated', 'info');
    }
  });
}

// ─── Start App ──────────────────────────────────────────────────────────────

init();
