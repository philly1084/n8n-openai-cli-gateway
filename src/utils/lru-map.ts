/**
 * Simple LRU (Least Recently Used) Map implementation.
 * Automatically evicts oldest entries when size limit is reached.
 */
export class LruMap<K, V> extends Map<K, V> {
  private readonly maxSize: number;

  constructor(maxSize: number) {
    super();
    this.maxSize = Math.max(1, maxSize);
  }

  get(key: K): V | undefined {
    const value = super.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      super.delete(key);
      super.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): this {
    // Delete first to ensure we move to end if key exists
    super.delete(key);
    super.set(key, value);

    // Evict oldest entries if over limit
    while (super.size > this.maxSize) {
      const firstKey = super.keys().next().value;
      if (firstKey !== undefined) {
        super.delete(firstKey);
      }
    }

    return this;
  }

  peek(key: K): V | undefined {
    // Get without moving to end
    return super.get(key);
  }
}
