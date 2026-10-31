import { useMemo, useRef, useState, useLayoutEffect } from 'react';
import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy';
import { fmtBytes } from './api.js';

// Stable hue per top-level child so nested tiles share their parent's colour.
const HUES = [212, 28, 158, 268, 352, 48, 190, 120, 305, 8];

export default function Treemap({ node, onOpen, onSelect, onPreview, selected, thumbFor = () => null }) {
  const ref = useRef(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const tiles = useMemo(() => {
    if (!node || !box.w || !box.h || !node.size) return [];
    const root = hierarchy(node, (d) => d.children)
      .sum((d) => (d.children && d.children.length ? 0 : Math.max(d.size, 0)))
      .sort((a, b) => b.value - a.value);
    treemap().tile(treemapSquarify).size([box.w, box.h]).paddingInner(2).paddingTop((d) => (d.depth === 1 && d.x1 - d.x0 > 60 && d.y1 - d.y0 > 40 ? 18 : 2)).round(true)(root);
    const top = root.children || [];
    const hueOf = new Map(top.map((c, i) => [c, HUES[i % HUES.length]]));
    let thumbsLeft = 120; // biggest tiles first (already sorted) — cap work per view
    return root.descendants().slice(1).filter((d) => d.x1 - d.x0 >= 2 && d.y1 - d.y0 >= 2).map((d) => {
      let t = d; while (t.depth > 1) t = t.parent;
      const leaf = !d.children;
      const thumb = leaf && thumbsLeft > 0 && d.x1 - d.x0 >= 40 && d.y1 - d.y0 >= 32 ? thumbFor(d.data) : null;
      if (thumb) thumbsLeft--;
      return { d, hue: hueOf.get(t), thumb };
    });
  }, [node, box, thumbFor]);

  return (
    <div className="treemap" ref={ref} onMouseLeave={() => setHover(null)}>
      {tiles.map(({ d, hue, thumb }) => {
        const w = d.x1 - d.x0, h = d.y1 - d.y0;
        const item = d.data;
        const isGroup = d.children && d.depth === 1;
        const light = 30 + d.depth * 10 + (item.isDir ? 0 : 6);
        return (
          <div
            key={item.id}
            className={`tile ${isGroup ? 'group' : ''} ${item.synthetic || item.meta?.hidden ? 'synthetic' : ''} ${selected.has(item.id) ? 'sel' : ''}`}
            style={{ left: d.x0, top: d.y0, width: w, height: h, background: item.synthetic || item.meta?.hidden ? undefined : `hsl(${hue} 55% ${light}%)`, zIndex: d.depth }}
            onMouseEnter={() => setHover({ item, x: d.x0, y: d.y0 })}
            onClick={(e) => {
              e.stopPropagation();
              if (item.synthetic || (item.meta?.hidden && !item.isDir)) return;
              if (item.isDir && !e.shiftKey && !e.metaKey) onOpen(item.id);
              else onSelect(item, e.shiftKey || e.metaKey);
            }}
            onDoubleClick={(e) => { e.stopPropagation(); if (!item.isDir && !item.synthetic) onPreview(item); }}
            onContextMenu={(e) => { e.preventDefault(); if (!item.synthetic) onSelect(item, true); }}
          >
            {thumb && <img className="tile-thumb" src={thumb} alt="" loading="lazy" draggable={false} onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
            {w > 54 && h > 16 && (
              <span className="tile-label">
                {item.name}
                {w > 110 && <em> {fmtBytes(item.size)}</em>}
              </span>
            )}
          </div>
        );
      })}
      {!tiles.length && <div className="empty">Empty folder</div>}
      {hover && (
        <div className="tip">
          <b>{hover.item.name}</b> · {fmtBytes(hover.item.size)}
          {hover.item.isDir ? ` · ${hover.item.count.toLocaleString()} files` : ''}
          <div className="tip-hint">{hover.item.isDir ? 'click: open · ⌘/shift-click or right-click: select' : 'double-click: preview · click: select'}</div>
        </div>
      )}
    </div>
  );
}
