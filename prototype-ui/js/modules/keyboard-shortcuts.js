/**
 * keyboard-shortcuts.js
 * ES module that manages all keyboard shortcuts for the CadShot Professional nesting application.
 */

const SHORTCUT_DEFINITIONS = [
  // Global shortcuts
  { key: 'z', ctrl: true, shift: false, action: 'undo', description: 'Undo last action', category: 'Global' },
  { key: 'z', ctrl: true, shift: true, action: 'redo', description: 'Redo', category: 'Global' },
  { key: 's', ctrl: true, shift: false, action: 'save-session', description: 'Save current session', category: 'Global' },
  { key: 'e', ctrl: true, shift: false, action: 'export-dxf', description: 'Export DXF', category: 'Global' },
  { key: 'n', ctrl: true, shift: false, action: 'new-project', description: 'New project', category: 'Global' },
  { key: 'o', ctrl: true, shift: false, action: 'open-project', description: 'Open/load file', category: 'Global' },
  { key: 'q', ctrl: true, shift: false, action: 'quit', description: 'Exit (close tab)', category: 'Global' },

  // Canvas shortcuts
  { key: ' ', ctrl: false, shift: false, action: 'pan-mode', description: 'Enable pan (with drag)', category: 'Canvas', held: true },
  { key: '+', ctrl: false, shift: false, action: 'zoom-in', description: 'Zoom in', category: 'Canvas' },
  { key: '=', ctrl: false, shift: false, action: 'zoom-in', description: 'Zoom in', category: 'Canvas' },
  { key: '-', ctrl: false, shift: false, action: 'zoom-out', description: 'Zoom out', category: 'Canvas' },
  { key: '_', ctrl: false, shift: false, action: 'zoom-out', description: 'Zoom out', category: 'Canvas' },
  { key: '!', ctrl: false, shift: true, action: 'zoom-100', description: 'Zoom to 100%', category: 'Canvas' },
  { key: '@', ctrl: false, shift: true, action: 'zoom-fit', description: 'Zoom to fit all', category: 'Canvas' },
  { key: 'Delete', ctrl: false, shift: false, action: 'delete-selected', description: 'Remove selected placement', category: 'Canvas' },
  { key: 'Backspace', ctrl: false, shift: false, action: 'delete-selected', description: 'Remove selected placement', category: 'Canvas' },
  { key: 'h', ctrl: false, shift: false, action: 'toggle-grid', description: 'Toggle grid overlay', category: 'Canvas' },
  { key: 'g', ctrl: false, shift: false, action: 'toggle-hide-outline', description: 'Show/hide hide outline', category: 'Canvas' },
  { key: 'i', ctrl: false, shift: false, action: 'toggle-info', description: 'Toggle info overlay', category: 'Canvas' },
  { key: 'Escape', ctrl: false, shift: false, action: 'deselect', description: 'Clear selection', category: 'Canvas' },

  // Nesting shortcuts
  { key: 'r', ctrl: false, shift: false, action: 'start-nesting', description: 'Start nesting', category: 'Nesting' },
  { key: 'R', ctrl: false, shift: true, action: 'stop-nesting', description: 'Stop nesting', category: 'Nesting' },
  { key: 'p', ctrl: false, shift: false, action: 'pause-nesting', description: 'Pause/resume', category: 'Nesting' },

  // Tools shortcuts
  { key: 'v', ctrl: false, shift: false, action: 'tool-select', description: 'Select tool', category: 'Tools' },
  { key: 'm', ctrl: false, shift: false, action: 'tool-move', description: 'Move tool', category: 'Tools' },
  { key: 'd', ctrl: false, shift: false, action: 'tool-detect', description: 'Detect hide', category: 'Tools' },
];

/**
 * Determines if the active element is an input field where shortcuts should be suppressed.
 * @returns {boolean}
 */
function isInputFocused() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (el.isContentEditable) return true;
  return false;
}

/**
 * Checks if the modifier key (Ctrl on Windows/Linux, Cmd on Mac) is pressed.
 * @param {KeyboardEvent} event
 * @returns {boolean}
 */
function isModifierPressed(event) {
  return event.ctrlKey || event.metaKey;
}

export class KeyboardManager {
  /**
   * @param {Object} options
   * @param {function(string): void} options.onAction - Callback receiving the action name string
   */
  constructor(options = {}) {
    this._onAction = options.onAction || (() => {});
    this._enabled = false;
    this._spaceHeld = false;

    // Bind handlers so we can add/remove them
    this._handleKeyDown = this._handleKeyDown.bind(this);
    this._handleKeyUp = this._handleKeyUp.bind(this);
  }

  /**
   * Start listening for keyboard events.
   */
  enable() {
    if (this._enabled) return;
    this._enabled = true;
    document.addEventListener('keydown', this._handleKeyDown);
    document.addEventListener('keyup', this._handleKeyUp);
  }

  /**
   * Stop listening for keyboard events.
   */
  disable() {
    if (!this._enabled) return;
    this._enabled = false;
    this._spaceHeld = false;
    document.removeEventListener('keydown', this._handleKeyDown);
    document.removeEventListener('keyup', this._handleKeyUp);
  }

  /**
   * Returns all registered shortcuts for rendering a help dialog.
   * @returns {Array<{key: string, action: string, description: string, category: string}>}
   */
  getShortcutMap() {
    // Deduplicate entries that share the same action within the same category
    const seen = new Set();
    const result = [];

    for (const def of SHORTCUT_DEFINITIONS) {
      const label = this._formatKeyLabel(def);
      const uniqueKey = `${def.action}:${def.category}`;

      if (seen.has(uniqueKey)) {
        // Append alternate key to existing entry
        const existing = result.find(r => r.action === def.action && r.category === def.category);
        if (existing && !existing.key.includes(label)) {
          existing.key += ` / ${label}`;
        }
        continue;
      }

      seen.add(uniqueKey);
      result.push({
        key: label,
        action: def.action,
        description: def.description,
        category: def.category,
      });
    }

    return result;
  }

  /**
   * Formats a human-readable key label for a shortcut definition.
   * @param {Object} def
   * @returns {string}
   */
  _formatKeyLabel(def) {
    const parts = [];
    if (def.ctrl) parts.push('Ctrl');
    if (def.shift) parts.push('Shift');

    let keyName = def.key;
    // Friendly names for special keys
    if (keyName === ' ') keyName = 'Space';
    else if (keyName === 'Escape') keyName = 'Esc';
    else if (keyName === 'Delete') keyName = 'Del';
    else if (keyName === 'Backspace') keyName = 'Backspace';
    else if (keyName === '!') keyName = '1';
    else if (keyName === '@') keyName = '2';
    else if (keyName.length === 1) keyName = keyName.toUpperCase();

    parts.push(keyName);
    return parts.join('+');
  }

  /**
   * Internal keydown handler.
   * @param {KeyboardEvent} event
   */
  _handleKeyDown(event) {
    if (!this._enabled) return;

    const inputFocused = isInputFocused();
    const ctrl = isModifierPressed(event);
    const shift = event.shiftKey;
    const key = event.key;

    // --- Space held for pan mode ---
    if (key === ' ' && !ctrl && !shift && !inputFocused) {
      if (!this._spaceHeld) {
        this._spaceHeld = true;
        this._onAction('pan-mode');
      }
      event.preventDefault();
      return;
    }

    // Skip non-modifier shortcuts when typing in an input
    if (inputFocused && !ctrl) return;

    // --- Match against shortcut definitions ---
    const action = this._matchShortcut(key, ctrl, shift);

    if (action) {
      event.preventDefault();
      this._onAction(action);
    }
  }

  /**
   * Internal keyup handler.
   * @param {KeyboardEvent} event
   */
  _handleKeyUp(event) {
    if (!this._enabled) return;

    if (event.key === ' ' && this._spaceHeld) {
      this._spaceHeld = false;
      this._onAction('pan-mode-end');
    }
  }

  /**
   * Attempts to match the key event parameters against registered shortcuts.
   * @param {string} key - event.key value
   * @param {boolean} ctrl - whether Ctrl/Cmd is held
   * @param {boolean} shift - whether Shift is held
   * @returns {string|null} action name or null
   */
  _matchShortcut(key, ctrl, shift) {
    // Normalize key for comparison
    const keyLower = key.toLowerCase();

    for (const def of SHORTCUT_DEFINITIONS) {
      // Skip the space/held shortcut — handled separately
      if (def.held) continue;

      const defCtrl = !!def.ctrl;
      const defShift = !!def.shift;

      if (defCtrl !== ctrl) continue;
      if (defShift !== shift) continue;

      // Match key
      const defKey = def.key;

      // For modifier shortcuts (Ctrl+key), compare lowercase
      if (defCtrl) {
        if (keyLower === defKey.toLowerCase()) {
          return def.action;
        }
        continue;
      }

      // For shifted character shortcuts (Shift+1 produces '!', Shift+2 produces '@', Shift+R produces 'R')
      if (defShift) {
        if (key === defKey) {
          return def.action;
        }
        continue;
      }

      // Non-modifier, non-shift: compare case-insensitively for letter keys, exactly for special keys
      if (defKey.length === 1 && defKey.match(/[a-z]/i)) {
        if (keyLower === defKey.toLowerCase()) {
          return def.action;
        }
      } else {
        // Special keys: Delete, Backspace, Escape, +, -, =, _
        if (key === defKey) {
          return def.action;
        }
      }
    }

    return null;
  }
}
