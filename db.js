const DB_NAME = 'ChromeFiddlerDB';
const DB_VERSION = 3;

/**
 * DB class for Chrome Fiddler.
 * Handles persistence for captured requests and internal logs using IndexedDB.
 */
class FiddlerDB {
  constructor() {
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        // Store requests per tab and origin
        let requestStore;
        if (!db.objectStoreNames.contains('requests')) {
          requestStore = db.createObjectStore('requests', { keyPath: 'requestId' });
          requestStore.createIndex('tabId', 'tabId', { unique: false });
        } else {
          requestStore = event.target.transaction.objectStore('requests');
        }
        
        if (!requestStore.indexNames.contains('origin')) {
          requestStore.createIndex('origin', 'origin', { unique: false });
        }
        if (!requestStore.indexNames.contains('pageOrigin')) {
          requestStore.createIndex('pageOrigin', 'pageOrigin', { unique: false });
        }
        
        // Store internal extension logs
        if (!db.objectStoreNames.contains('logs')) {
          const logStore = db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
          logStore.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve(this.db);
      };

      request.onerror = (event) => reject(event.target.error);
    });
  }

  async getRequestsByPageOrigin(pageOrigin) {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['requests'], 'readonly');
      const store = transaction.objectStore('requests');
      const index = store.index('pageOrigin');
      const request = index.getAll(IDBKeyRange.only(pageOrigin));

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async addRequest(requestData) {
    // Use put to allow updates by requestId
    return this._perform('requests', 'put', requestData);
  }

  async updateRequest(requestId, updateData) {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['requests'], 'readwrite');
      const store = transaction.objectStore('requests');
      const request = store.get(requestId);

      request.onsuccess = () => {
        const data = request.result;
        if (data) {
          Object.assign(data, updateData);
          store.put(data);
          resolve(data);
        } else {
          resolve(null);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getRequests(tabId) {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['requests'], 'readonly');
      const store = transaction.objectStore('requests');
      const index = store.index('tabId');
      const request = index.getAll(IDBKeyRange.only(tabId));

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getRequestsByOrigin(origin) {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['requests'], 'readonly');
      const store = transaction.objectStore('requests');
      const index = store.index('origin');
      const request = index.getAll(IDBKeyRange.only(origin));

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async addLog(level, message, context = {}) {
    const logEntry = {
      level,
      message,
      context,
      timestamp: new Date().toISOString()
    };
    return this._perform('logs', 'add', logEntry);
  }

  async getLogs() {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['logs'], 'readonly');
      const store = transaction.objectStore('logs');
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async clearTab(tabId) {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['requests'], 'readwrite');
      const store = transaction.objectStore('requests');
      const index = store.index('tabId');
      const request = index.openKeyCursor(IDBKeyRange.only(tabId));

      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          store.delete(cursor.primaryKey);
          cursor.continue();
        } else {
          resolve();
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async clearAll() {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['requests', 'logs'], 'readwrite');
      transaction.objectStore('requests').clear();
      transaction.objectStore('logs').clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = (event) => reject(event.target.error);
    });
  }

  async clearOrigin(origin) {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['requests'], 'readwrite');
      const store = transaction.objectStore('requests');
      const index = store.index('origin');
      const cursorRequest = index.openKeyCursor(IDBKeyRange.only(origin));

      cursorRequest.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          store.delete(cursor.primaryKey);
          cursor.continue();
        } else {
          resolve();
        }
      };
      cursorRequest.onerror = () => reject(cursorRequest.error);
    });
  }

  async getUniqueOrigins() {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['requests'], 'readonly');
      const store = transaction.objectStore('requests');
      const index = store.index('pageOrigin');
      const origins = new Set();
      
      const request = index.openKeyCursor();
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          if (cursor.key) origins.add(cursor.key);
          cursor.continue();
        } else {
          resolve(Array.from(origins).filter(Boolean));
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getAllRequests() {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['requests'], 'readonly');
      const store = transaction.objectStore('requests');
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async _perform(storeName, method, data) {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store[method](data);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}

// Export a singleton instance
const db = new FiddlerDB();
export default db;
