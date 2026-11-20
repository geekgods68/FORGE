import type { SceneGraph, SceneNode } from '@forge/engineering-core';
import {
  Axis3d,
  Box,
  Boxes,
  ChevronDown,
  ChevronRight,
  Circle,
  Cone,
  Cylinder,
  Eye,
  EyeOff,
  Folder,
  Group,
  Layers,
  Lock,
  LockOpen,
  Square,
  Torus,
  Trash2,
  Ungroup,
} from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { useEditor } from '@/app/store';
import { cn } from '@/lib/utils';

/** Fixed row height (px) — virtualization relies on it. */
const ROW_HEIGHT = 28;
const OVERSCAN = 8;

function NodeIcon({ node }: { node: SceneNode }) {
  const cls = 'size-3.5 shrink-0 text-muted-foreground';
  switch (node.kind) {
    case 'root':
      return <Layers className={cls} />;
    case 'group':
    case 'assembly':
      return <Folder className={cls} />;
    case 'reference':
      return <Axis3d className={cls} />;
    case 'component-instance':
      return <Boxes className={cls} />;
    case 'primitive': {
      const Icon = { box: Box, sphere: Circle, cylinder: Cylinder, cone: Cone, plane: Square, torus: Torus }[
        node.geometry.shape
      ];
      return <Icon className={cls} />;
    }
  }
}

/** Visible rows in display order, skipping descendants of collapsed nodes. O(N), iterative. */
function visibleRows(scene: SceneGraph, collapsed: Record<string, boolean>) {
  const out: { id: string; depth: number }[] = [];
  const stack: [string, number][] = [[scene.rootId, 0]];
  while (stack.length) {
    const [id, depth] = stack.pop()!;
    out.push({ id, depth });
    const n = scene.nodes[id];
    if (!n || collapsed[id]) continue;
    for (let i = n.childIds.length - 1; i >= 0; i--) stack.push([n.childIds[i]!, depth + 1]);
  }
  return out;
}

/**
 * Scene tree: select, expand/collapse, rename, show/hide, lock, group/ungroup, delete.
 * Virtualized: only rows in (or near) the viewport are mounted, so a 5,000-node scene
 * costs the same to render as a 50-node one.
 */
export function HierarchyPanel() {
  const scene = useEditor((s) => s.project.scene);
  const selectedId = useEditor((s) => s.selection[0]);
  const collapsed = useEditor((s) => s.collapsed);
  const select = useEditor((s) => s.select);
  const run = useEditor((s) => s.run);
  const toggleCollapsed = useEditor((s) => s.toggleCollapsed);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const scroller = useRef<HTMLUListElement>(null);
  const selected = selectedId ? scene.nodes[selectedId] : undefined;

  const rows = useMemo(() => visibleRows(scene, collapsed), [scene, collapsed]);
  const indexOf = useMemo(() => new Map(rows.map((r, i) => [r.id, i])), [rows]);

  // Track the scroller's height (jsdom has no ResizeObserver: keep the default).
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight || 600));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the selected row in view (e.g. after selecting in the 3D viewport).
  useEffect(() => {
    const el = scroller.current;
    const i = selectedId ? indexOf.get(selectedId) : undefined;
    if (!el || i === undefined) return;
    const top = i * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight)
      el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
  }, [selectedId, indexOf]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
  const windowRows = rows.slice(first, last);

  return (
    <section aria-label="Scene hierarchy" className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          Hierarchy <span className="font-normal normal-case">({rows.length - 1})</span>
        </h2>
        <div className="flex gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            title="Group selected (into a new group)"
            aria-label="Group selected"
            disabled={!selected || selected.kind === 'root'}
            onClick={() => {
              const r = run('scene.node.group', { nodeIds: [selectedId!] }, { label: 'Group' });
              if (r.ok) select(r.affectedIds[0]!);
            }}
          >
            <Group />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            title="Ungroup selected group"
            aria-label="Ungroup"
            disabled={!selected || (selected.kind !== 'group' && selected.kind !== 'assembly')}
            onClick={() => run('scene.node.ungroup', { groupId: selectedId! }, { label: 'Ungroup' })}
          >
            <Ungroup />
          </Button>
        </div>
      </header>
      <ul
        ref={scroller}
        role="tree"
        data-testid="hierarchy-scroll"
        className="relative min-h-0 flex-1 overflow-auto text-sm"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <li aria-hidden style={{ height: first * ROW_HEIGHT }} />
        {windowRows.map(({ id, depth }) => (
          <Row
            key={id}
            node={scene.nodes[id]!}
            depth={depth}
            selected={id === selectedId}
            collapsed={!!collapsed[id]}
            renaming={renaming === id}
            onSelect={select}
            onToggle={toggleCollapsed}
            onStartRename={setRenaming}
            onFinishRename={(name) => {
              const n = scene.nodes[id];
              if (n && name && name !== n.name)
                run('scene.node.rename', { nodeId: id, name }, { label: 'Rename' });
              setRenaming(null);
            }}
            onVisibility={(v) =>
              run('scene.node.visibility', { nodeId: id, visible: v }, { label: v ? 'Show' : 'Hide' })
            }
            onLock={(l) =>
              run('scene.node.lock', { nodeId: id, locked: l }, { label: l ? 'Lock' : 'Unlock' })
            }
            onDelete={() => run('scene.node.delete', { nodeId: id }, { label: 'Delete' })}
          />
        ))}
        <li aria-hidden style={{ height: (rows.length - last) * ROW_HEIGHT }} />
      </ul>
    </section>
  );
}

const Row = memo(function Row({
  node: n,
  depth,
  selected,
  collapsed,
  renaming,
  onSelect,
  onToggle,
  onStartRename,
  onFinishRename,
  onVisibility,
  onLock,
  onDelete,
}: {
  node: SceneNode;
  depth: number;
  selected: boolean;
  collapsed: boolean;
  renaming: boolean;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onStartRename: (id: string) => void;
  onFinishRename: (name: string) => void;
  onVisibility: (visible: boolean) => void;
  onLock: (locked: boolean) => void;
  onDelete: () => void;
}) {
  const isRoot = n.kind === 'root';
  return (
    <li
      role="treeitem"
      aria-selected={selected}
      aria-expanded={n.childIds.length ? !collapsed : undefined}
      data-testid={`tree-row-${n.id}`}
      className={cn(
        'group flex cursor-default items-center gap-1 pr-1 select-none',
        selected ? 'bg-primary/20' : 'hover:bg-secondary/60',
        !n.visible && 'opacity-50',
      )}
      style={{ height: ROW_HEIGHT, paddingLeft: 6 + depth * 14 }}
      onClick={() => onSelect(n.id)}
      onDoubleClick={() => !isRoot && onStartRename(n.id)}
    >
      <button
        type="button"
        aria-label={collapsed ? 'Expand' : 'Collapse'}
        className={cn('size-4 shrink-0 text-muted-foreground', !n.childIds.length && 'invisible')}
        onClick={(e) => {
          e.stopPropagation();
          onToggle(n.id);
        }}
      >
        {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
      </button>
      <NodeIcon node={n} />
      {renaming ? (
        <input
          autoFocus
          aria-label="Rename"
          defaultValue={n.name}
          className="h-6 min-w-0 flex-1 rounded border border-ring bg-background px-1 text-sm"
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => onFinishRename(e.target.value.trim())}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              (e.target as HTMLInputElement).value = n.name;
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      ) : (
        <span className="min-w-0 flex-1 truncate" title={n.name}>
          {n.name}
        </span>
      )}
      {!isRoot && (
        <span className="flex shrink-0 items-center">
          <RowButton
            label={n.visible ? `Hide ${n.name}` : `Show ${n.name}`}
            onClick={() => onVisibility(!n.visible)}
          >
            {n.visible ? <Eye /> : <EyeOff />}
          </RowButton>
          <RowButton
            label={n.locked ? `Unlock ${n.name}` : `Lock ${n.name}`}
            active={n.locked}
            onClick={() => onLock(!n.locked)}
          >
            {n.locked ? <Lock /> : <LockOpen />}
          </RowButton>
          <RowButton label={`Delete ${n.name}`} onClick={onDelete}>
            <Trash2 />
          </RowButton>
        </span>
      )}
    </li>
  );
});

function RowButton({
  label,
  onClick,
  children,
  active,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={cn(
        'grid size-6 place-items-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground [&_svg]:size-3.5',
        active
          ? 'text-primary'
          : 'opacity-0 group-hover:opacity-100 group-aria-selected:opacity-100 focus:opacity-100',
      )}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}
