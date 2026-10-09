// Event journal: an append-only, capacity-bounded audit trail of what the
// agent noticed, decided, and why. Timestamps use the observation clock (t),
// not wall time, so simulations replay deterministically.

export class Journal {
  constructor({ capacity = 2000 } = {}) {
    this.capacity = capacity;
    this.entries = [];
    this._seq = 0;
  }

  record(entry = {}) {
    this._seq += 1;
    this.entries.push({ seq: this._seq, ...entry });
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
  }

  byType(type) {
    return this.entries.filter((entry) => entry.type === type);
  }

  get size() {
    return this.entries.length;
  }

  clear() {
    this.entries = [];
    this._seq = 0;
  }

  export() {
    return { entries: [...this.entries] };
  }
}
