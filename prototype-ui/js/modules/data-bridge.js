/**
 * data-bridge.js
 * ES module handling all IndexedDB and localStorage communication
 * between app components: digitizer -> library -> checkout -> nesting
 */

import CryptoJS from '../vendor/crypto-js.mjs';

// ─── Key Management ──────────────────────────────────────────────────────────

/**
 * Get or create a session-specific encryption key stored securely in sessionStorage.
 * This ensures the key only lives as long as the browser tab/session and prevents
 * hardcoded secrets in the source code.
 */
export function getOrCreateEncryptionKey() {
    const KEY_NAME = 'CadShotPro_Dynamic_Key';
    let key = sessionStorage.getItem(KEY_NAME);
    if (!key) {
        // Generate a random 256-bit key
        key = CryptoJS.lib.WordArray.random(256 / 8).toString();
        sessionStorage.setItem(KEY_NAME, key);
    }
    return key;
}

// ─── Database name constants ─────────────────────────────────────────────────

export const DB_VISION_PUSH = 'PatternIQ_VisionPush';
export const DB_DIGITIZER_PUSH = 'PatternIQ_DigitizerPush';
export const DB_NESTING = 'PatternIQ_NestingDB';
export const DB_NEST_PUSH = 'PatternIQ_NestPush';
export const DB_REMNANT_LIBRARY = 'cncVisionPRO_Library';

// ─── Generic Database Operations ─────────────────────────────────────────────

/**
 * Open or create a named IndexedDB database.
 * @param {string} dbName
 * @param {number} version
 * @param {Array<{name: string, keyPath: string}>} storeConfigs
 * @returns {Promise<IDBDatabase>}
 */
export async function openDB(dbName, version, storeConfigs) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, version);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            for (const config of storeConfigs) {
                if (!db.objectStoreNames.contains(config.name)) {
                    db.createObjectStore(config.name, { keyPath: config.keyPath });
                }
            }
        };

        request.onsuccess = (event) => {
            resolve(event.target.result);
        };

        request.onerror = (event) => {
            reject(new Error(`Failed to open database '${dbName}': ${event.target.error}`));
        };
    });
}

/**
 * Put (insert or update) a record into an object store.
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {object} record
 * @returns {Promise<IDBValidKey>}
 */
export async function dbPut(db, storeName, record) {
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            const request = store.put(record);

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(new Error(`dbPut failed on '${storeName}': ${request.error}`));
        } catch (err) {
            reject(err);
        }
    });
}

/**
 * Get a single record by key.
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {IDBValidKey} key
 * @returns {Promise<object|undefined>}
 */
export async function dbGet(db, storeName, key) {
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const request = store.get(key);

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(new Error(`dbGet failed on '${storeName}': ${request.error}`));
        } catch (err) {
            reject(err);
        }
    });
}

/**
 * Get all records from an object store.
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @returns {Promise<Array<object>>}
 */
export async function dbGetAll(db, storeName) {
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const request = store.getAll();

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(new Error(`dbGetAll failed on '${storeName}': ${request.error}`));
        } catch (err) {
            reject(err);
        }
    });
}

/**
 * Delete a single record by key.
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {IDBValidKey} key
 * @returns {Promise<void>}
 */
export async function dbDelete(db, storeName, key) {
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            const request = store.delete(key);

            request.onsuccess = () => resolve();
            request.onerror = () => reject(new Error(`dbDelete failed on '${storeName}': ${request.error}`));
        } catch (err) {
            reject(err);
        }
    });
}

/**
 * Clear all records from an object store.
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @returns {Promise<void>}
 */
export async function dbClear(db, storeName) {
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            const request = store.clear();

            request.onsuccess = () => resolve();
            request.onerror = () => reject(new Error(`dbClear failed on '${storeName}': ${request.error}`));
        } catch (err) {
            reject(err);
        }
    });
}

// ─── Nesting DB Configuration ───────────────────────────────────────────────
// Must match patternINQ.html which creates this DB at version 2 with 5 stores.

const NESTING_DB_VERSION = 2;
const NESTING_DB_STORES = [
    { name: 'patterns', keyPath: 'id' },
    { name: 'images', keyPath: 'id' },
    { name: 'backups', keyPath: 'id' },
    { name: 'archive', keyPath: 'id' },
    { name: 'archive_images', keyPath: 'id' }
];

// ─── App-Specific Bridges ────────────────────────────────────────────────────

/**
 * Push hide polygon from vision/detection to nesting.
 * @param {object} hideData - {polygon: [[x,y],...], holes: [[[x,y],...],...], cncTable: {tableWidth, tableHeight, materialOffsetX, materialOffsetY}|null}
 * @returns {Promise<void>}
 */
export async function pushHideToNesting(hideData) {
    const db = await openDB(DB_VISION_PUSH, 1, [{ name: 'hide', keyPath: 'id' }]);
    try {
        await dbPut(db, 'hide', { id: 'hide', ...hideData });
    } finally {
        db.close();
    }
}

/**
 * Receive hide polygon in nesting app.
 * @returns {Promise<object|null>} hideData or null if not found
 */
export async function receiveHideFromVision() {
    const db = await openDB(DB_VISION_PUSH, 1, [{ name: 'hide', keyPath: 'id' }]);
    try {
        const record = await dbGet(db, 'hide', 'hide');
        if (!record) return null;
        const { id, ...hideData } = record;
        return hideData;
    } finally {
        db.close();
    }
}

/**
 * Push digitized pieces from digitizer to library.
 * @param {object} sessionData - {pieces: [{polygon, holes, partName, sizeLabel},...], timestamp}
 * @returns {Promise<void>}
 */
export async function pushFromDigitizer(sessionData) {
    const db = await openDB(DB_DIGITIZER_PUSH, 1, [{ name: 'patterns', keyPath: 'id' }]);
    try {
        await dbPut(db, 'patterns', { id: 'digitizer_push', ...sessionData });
    } finally {
        db.close();
    }
}

/**
 * Receive digitized pieces in library.
 * @returns {Promise<object|null>} sessionData or null
 */
export async function receiveFromDigitizer() {
    const db = await openDB(DB_DIGITIZER_PUSH, 1, [{ name: 'patterns', keyPath: 'id' }]);
    try {
        const record = await dbGet(db, 'patterns', 'digitizer_push');
        if (!record) return null;
        const { id, ...sessionData } = record;
        return sessionData;
    } finally {
        db.close();
    }
}

/**
 * Clear the digitizer push store after successful transition to library.
 * Prevents orphan sessions from accumulating in IndexedDB.
 * @returns {Promise<void>}
 */
export async function clearDigitizerPush() {
    try {
        const db = await openDB(DB_DIGITIZER_PUSH, 1, [{ name: 'patterns', keyPath: 'id' }]);
        await dbClear(db, 'patterns');
        db.close();
    } catch (e) {
        console.warn('[data-bridge] clearDigitizerPush failed:', e.message);
    }
}

/**
 * Push pattern from library to checkout (Nesting DB).
 * Dual-write: IndexedDB + localStorage.
 * @param {object} patternData - {id, name, savedAt, sizes, parts, pieces, pwm}
 * @returns {Promise<void>}
 */
export async function publishToNestingDB(patternData) {
    const db = await openDB(DB_NESTING, NESTING_DB_VERSION, NESTING_DB_STORES);
    try {
        await dbPut(db, 'patterns', patternData);
    } finally {
        db.close();
    }

    // Dual-write to localStorage
    try {
        const existing = loadSession('patterniq_nesting_db') || [];
        const idx = existing.findIndex((p) => p.id === patternData.id);
        if (idx >= 0) {
            existing[idx] = patternData;
        } else {
            existing.push(patternData);
        }
        saveSession('patterniq_nesting_db', existing);
    } catch (err) {
        console.warn('[data-bridge] localStorage dual-write failed:', err.message);
    }
}

/**
 * Get all patterns from Nesting DB.
 * @returns {Promise<Array<object>>}
 */
export async function getNestingDBPatterns() {
    const db = await openDB(DB_NESTING, NESTING_DB_VERSION, NESTING_DB_STORES);
    try {
        return await dbGetAll(db, 'patterns');
    } finally {
        db.close();
    }
}

/**
 * Push from checkout to nesting engine.
 * @param {object} payload - {ts, patternName, mirrorPair, pwm, parts:[{name, boundary, children, material, qty, bb, sizeLbl, partName, side, color}]}
 * @returns {Promise<void>}
 */
export async function pushToNesting(payload) {
    const db = await openDB(DB_NEST_PUSH, 1, [{ name: 'push', keyPath: 'id' }]);
    try {
        await dbPut(db, 'push', { id: 'push', ...payload });
    } finally {
        db.close();
    }
}

/**
 * Receive in nesting engine.
 * @returns {Promise<object|null>} payload or null
 */
export async function receiveNestPush() {
    const db = await openDB(DB_NEST_PUSH, 1, [{ name: 'push', keyPath: 'id' }]);
    try {
        const record = await dbGet(db, 'push', 'push');
        if (!record) return null;
        const { id, ...payload } = record;
        return payload;
    } finally {
        db.close();
    }
}

export async function clearNestPush() {
    try {
        const db = await openDB(DB_NEST_PUSH, 1, [{ name: 'push', keyPath: 'id' }]);
        await dbClear(db, 'push');
        db.close();
    } catch (e) {
        console.warn('[data-bridge] clearNestPush failed:', e.message);
    }
}

/**
 * Save a remnant (detected hide) to the remnant library.
 * @param {object} remnantData - {id, name, polygon, holes, calibration, areaMm2, thumbnail}
 * @returns {Promise<void>}
 */
export async function saveRemnant(remnantData) {
    const db = await openDB(DB_REMNANT_LIBRARY, 1, [{ name: 'remnants', keyPath: 'id' }]);
    try {
        await dbPut(db, 'remnants', remnantData);
    } finally {
        db.close();
    }
}

/**
 * Load all remnants from the remnant library.
 * @returns {Promise<Array<object>>}
 */
export async function loadRemnants() {
    const db = await openDB(DB_REMNANT_LIBRARY, 1, [{ name: 'remnants', keyPath: 'id' }]);
    try {
        return await dbGetAll(db, 'remnants');
    } finally {
        db.close();
    }
}

/**
 * Delete a remnant by id.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteRemnant(id) {
    const db = await openDB(DB_REMNANT_LIBRARY, 1, [{ name: 'remnants', keyPath: 'id' }]);
    try {
        await dbDelete(db, 'remnants', id);
    } finally {
        db.close();
    }
}

// ─── Session Persistence ─────────────────────────────────────────────────────

/**
 * Save current work state to localStorage.
 * Wraps localStorage.setItem with JSON.stringify and AES encryption, catches quota errors.
 * @param {string} key
 * @param {*} data
 */
export function saveSession(key, data) {
    try {
        const encryptionKey = getOrCreateEncryptionKey();
        const jsonStr = JSON.stringify(data);
        const encryptedStr = CryptoJS.AES.encrypt(jsonStr, encryptionKey).toString();
        localStorage.setItem(key, encryptedStr);
    } catch (err) {
        if (err.name === 'QuotaExceededError' || err.code === 22) {
            console.warn(`[data-bridge] localStorage quota exceeded for key '${key}'. Data not saved.`);
        } else {
            throw err;
        }
    }
}

/**
 * Load session data from localStorage.
 * @param {string} key
 * @returns {object|null} Parsed object or null
 */
export function loadSession(key) {
    try {
        const encryptedStr = localStorage.getItem(key);
        if (encryptedStr === null) return null;

        const encryptionKey = getOrCreateEncryptionKey();

        // Attempt to decrypt
        let jsonStr;
        try {
            const bytes = CryptoJS.AES.decrypt(encryptedStr, encryptionKey);
            jsonStr = bytes.toString(CryptoJS.enc.Utf8);
        } catch (decryptionErr) {
            // If decryption fails (e.g., legacy unencrypted data or corrupted data)
            console.warn(`[data-bridge] Decryption failed for key '${key}', attempting fallback to raw JSON parse.`);
            jsonStr = encryptedStr;
        }

        if (!jsonStr) return null;
        return JSON.parse(jsonStr);
    } catch (err) {
        console.warn(`[data-bridge] Failed to parse session for key '${key}':`, err.message);
        return null;
    }
}

/**
 * Listen for cross-tab localStorage changes filtered by key.
 * @param {string} key
 * @param {function} callback - Called with parsed newValue when key changes
 */
export function onStorageChange(key, callback) {
    window.addEventListener('storage', (event) => {
        if (event.key !== key) return;
        try {
            let newValue = null;
            if (event.newValue) {
                const encryptionKey = getOrCreateEncryptionKey();
                try {
                    const bytes = CryptoJS.AES.decrypt(event.newValue, encryptionKey);
                    const jsonStr = bytes.toString(CryptoJS.enc.Utf8);
                    newValue = jsonStr ? JSON.parse(jsonStr) : null;
                } catch (decryptionErr) {
                    // Fallback to raw JSON parse
                    newValue = JSON.parse(event.newValue);
                }
            }
            callback(newValue);
        } catch (err) {
            console.warn(`[data-bridge] Failed to parse storage event for key '${key}':`, err.message);
        }
    });
}
