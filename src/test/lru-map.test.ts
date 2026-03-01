import { describe, it } from "node:test";
import assert from "node:assert";
import { LruMap } from "../utils/lru-map";

describe("LruMap", () => {
  it("should store and retrieve values", () => {
    const map = new LruMap<string, number>(3);
    map.set("a", 1);
    map.set("b", 2);
    
    assert.strictEqual(map.get("a"), 1);
    assert.strictEqual(map.get("b"), 2);
  });

  it("should return undefined for missing keys", () => {
    const map = new LruMap<string, number>(3);
    assert.strictEqual(map.get("missing"), undefined);
  });

  it("should evict oldest entries when max size is reached", () => {
    const map = new LruMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3); // Should evict "a"
    
    assert.strictEqual(map.get("a"), undefined);
    assert.strictEqual(map.get("b"), 2);
    assert.strictEqual(map.get("c"), 3);
  });

  it("should move accessed entries to most recent", () => {
    const map = new LruMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    map.get("a"); // Move "a" to recent
    map.set("c", 3); // Should evict "b", not "a"
    
    assert.strictEqual(map.get("a"), 1);
    assert.strictEqual(map.get("b"), undefined);
    assert.strictEqual(map.get("c"), 3);
  });

  it("should update existing keys without eviction", () => {
    const map = new LruMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    map.set("a", 10); // Update "a"
    
    assert.strictEqual(map.get("a"), 10);
    assert.strictEqual(map.get("b"), 2);
  });

  it("should peek without changing order", () => {
    const map = new LruMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    map.peek("a"); // Peek doesn't move "a"
    map.set("c", 3); // Should evict "a"
    
    assert.strictEqual(map.get("a"), undefined);
    assert.strictEqual(map.get("b"), 2);
  });

  it("should handle size 1 correctly", () => {
    const map = new LruMap<string, number>(1);
    map.set("a", 1);
    map.set("b", 2);
    
    assert.strictEqual(map.get("a"), undefined);
    assert.strictEqual(map.get("b"), 2);
  });

  it("should delete entries", () => {
    const map = new LruMap<string, number>(3);
    map.set("a", 1);
    map.set("b", 2);
    map.delete("a");
    
    assert.strictEqual(map.get("a"), undefined);
    assert.strictEqual(map.get("b"), 2);
  });
});
