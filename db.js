// IndexedDB persistence for captured requests and extension logs.
//
// Writes are batched: records are queued in memory and flushed in ONE readwrite
// transaction (default every 200 ms). The previous design opened a transaction
// per network event (a put on request, then a get+put per response update and
// another per body), so a busy page cost several transactions per request.
// Reads flush first, so a reader never misses queued records.

const DB_NAME = 'ChromeFiddlerDB';
// v4: records are keyed by `${tabId}:${requestId}:${hop}`. Chrome reuses the
// requestId for every redirect hop, and requestIds are only unique within a
// debugging session, so keying by requestId alone overwrote redirect hops and
// could collide across tabs.
const DB_VERSION = 4;
const FLUSH_DELAY_MS = 200;
const MAX_LOGS = 1000;

class FiddlerDB {
  constructor() {
    this.dbPromise = null;
    this.pending = new Map(); // key -> record (latest snapshot wins)
    this.flushTimer = null;
    this.flushing = null;
    this.logsSinceTrim = 0;
  }

  open() {
    if (this.dbPromise === null) {
      this.dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (event) => {
          const db = request.result;
          // Captures are transient (cleared on browser start and periodically),
          // so older layouts are dropped rather than migrated.
          if (event.oldVersion < 4) {
            for (const name of Array.from(db.objectStoreNames)) { db.deleteObjectStore(name); }
          }
          const requests = db.createObjectStore('requests', { keyPath: 'key' });
          requests.createIndex('tabId', 'tabId', { unique: false });
          requests.createIndex('pageOrigin', 'pageOrigin', { unique: false });
          requests.createIndex('timestamp', 'timestamp', { unique: false });
          const logs = db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
          logs.createIndex('timestamp', 'timestamp', { unique: false });
        };
        request.onsuccess = () => {
          const db = request.result;
          // Another context upgrading the schema must not be blocked by us.
          db.onversionchange = () => { db.close(); this.dbPromise = null; };
          resolve(db);
        };
        request.onerror = () => { this.dbPromise = null; reject(request.error); };
        request.onblocked = () => reject(new Error('IndexedDB open blocked by another connection'));
      });
    }
    return this.dbPromise;
  }

  // --- writes ---------------------------------------------------------------

  /** Queue a full record snapshot for writing. */
  put(record) {
    this.pending.set(record.key, record);
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, FLUSH_DELAY_MS);
    }
  }

  /** Write every queued record in a single transaction. */
  async flush() {
    if (this.flushing) { await this.flushing; }
    if (this.pending.size === 0) { return; }
    if (this.flushTimer !== null) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    const batch = Array.from(this.pending.values());
    this.pending.clear();
    this.flushing = (async () => {
      const db = await this.open();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('requests', 'readwrite');
        const store = tx.objectStore('requests');
        for (const record of batch) { store.put(record); }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
      });
    })();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }

  async addLog(level, message, context = {}) {
    const db = await this.open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('logs', 'readwrite');
      tx.objectStore('logs').add({ level, message, context, timestamp: new Date().toISOString() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    // Bound the log store; trimming every write would be wasteful.
    this.logsSinceTrim += 1;
    if (this.logsSinceTrim >= 100) {
      this.logsSinceTrim = 0;
      await this.trimLogs();
    }
  }

  async trimLogs() {
    const db = await this.open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('logs', 'readwrite');
      const store = tx.objectStore('logs');
      const countReq = store.count();
      countReq.onsuccess = () => {
        let excess = countReq.result - MAX_LOGS;
        if (excess <= 0) { return; }
        store.openKeyCursor().onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor || excess <= 0) { return; }
          store.delete(cursor.primaryKey);
          excess -= 1;
          cursor.continue();
        };
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // --- reads ----------------------------------------------------------------

  async _getAll(indexName, range) {
    await this.flush();
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const store = db.transaction('requests', 'readonly').objectStore('requests');
      const source = indexName ? store.index(indexName) : store;
      const req = source.getAll(range);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async getRequest(key) {
    const queued = this.pending.get(key);
    if (queued) { return queued; }
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const req = db.transaction('requests', 'readonly').objectStore('requests').get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  getRequests(tabId) { return this._getAll('tabId', IDBKeyRange.only(tabId)); }
  getRequestsByPageOrigin(pageOrigin) { return this._getAll('pageOrigin', IDBKeyRange.only(pageOrigin)); }
  getAllRequests() { return this._getAll(null, undefined); }

  async getUniqueOrigins() {
    await this.flush();
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const index = db.transaction('requests', 'readonly').objectStore('requests').index('pageOrigin');
      const origins = [];
      // 'nextunique' visits each distinct key once instead of every record.
      const req = index.openKeyCursor(null, 'nextunique');
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(origins); return; }
        if (cursor.key) { origins.push(cursor.key); }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  async getLogs() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const req = db.transaction('logs', 'readonly').objectStore('logs').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // --- deletes --------------------------------------------------------------

  async _deleteByIndex(indexName, value) {
    // Queued records for the same scope must not be written after the delete.
    for (const [ key, record ] of this.pending) {
      if (record[indexName] === value) { this.pending.delete(key); }
    }
    await this.flush();
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('requests', 'readwrite');
      const store = tx.objectStore('requests');
      const req = store.index(indexName).openKeyCursor(IDBKeyRange.only(value));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { return; }
        store.delete(cursor.primaryKey);
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  clearTab(tabId) { return this._deleteByIndex('tabId', tabId); }

  async clearAll() {
    this.pending.clear();
    if (this.flushTimer !== null) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.flushing) { await this.flushing.catch(() => {}); }
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([ 'requests', 'logs' ], 'readwrite');
      tx.objectStore('requests').clear();
      tx.objectStore('logs').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

const db = new FiddlerDB();
export default db;
