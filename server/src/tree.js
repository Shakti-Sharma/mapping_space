import { kindOf } from './media.js';

// Shared in-memory tree model used by every provider (local, gdrive, demo).
// Node: { id, name, isDir, size, count, children[], parent, other? }
// `other` = aggregate of small files not kept individually (memory saver).

export function makeNode(id, name, isDir, size = 0, parent = null) {
  const n = { id, name, isDir, size, count: isDir ? 0 : 1, parent };
  if (isDir) n.children = [];
  return n;
}

export class Tree {
  constructor(root) {
    this.root = root;
    this.index = new Map();
    if (root) this.add(root);
  }

  add(node) {
    this.index.set(node.id, node);
    return node;
  }

  get(id) {
    return id == null || id === '' ? this.root : this.index.get(id);
  }

  // Bottom-up size/count aggregation (call once after building).
  finalize(node = this.root) {
    if (!node.isDir) return;
    let size = node.other ? node.other.size : 0;
    let count = node.other ? node.other.count : 0;
    for (const c of node.children) {
      this.finalize(c);
      size += c.size;
      count += c.count;
    }
    node.size = size;
    node.count = count;
    node.children.sort((a, b) => b.size - a.size);
  }

  ancestors(node) {
    const out = [];
    for (let n = node; n; n = n.parent) out.unshift({ id: n.id, name: n.name });
    return out;
  }

  // Remove a node and fix sizes up the chain.
  remove(node) {
    const p = node.parent;
    if (!p) throw new Error('Cannot remove root');
    p.children = p.children.filter((c) => c !== node);
    for (let a = p; a; a = a.parent) {
      a.size -= node.size;
      a.count -= node.count;
    }
    const drop = (n) => {
      this.index.delete(n.id);
      if (n.children) n.children.forEach(drop);
    };
    drop(node);
  }

  // Serializable view, `depth` levels deep, top `limit` children per level.
  view(node, depth = 2, limit = 300) {
    const v = {
      id: node.id,
      name: node.name,
      isDir: node.isDir,
      size: node.size,
      count: node.count,
    };
    if (node.meta) v.meta = node.meta;
    const kind = kindOf(node);
    if (kind) v.kind = kind;
    if (node.isDir) {
      v.childCount = node.children.length + (node.other ? 1 : 0);
      if (depth > 0) {
        const kids = node.children.slice(0, limit).map((c) => this.view(c, depth - 1, limit));
        let restSize = node.other ? node.other.size : 0;
        let restCount = node.other ? node.other.count : 0;
        for (const c of node.children.slice(limit)) {
          restSize += c.size;
          restCount += c.count;
        }
        if (restSize > 0 || restCount > 0) {
          kids.push({
            id: `${node.id}::other`,
            name: `(${restCount.toLocaleString()} smaller items)`,
            isDir: false,
            synthetic: true,
            size: restSize,
            count: restCount,
          });
          kids.sort((a, b) => b.size - a.size);
        }
        v.children = kids;
      }
    }
    return v;
  }
}
