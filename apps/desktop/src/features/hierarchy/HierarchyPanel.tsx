import { flattenTree, type SceneNode } from '@forge/engineering-core';
import {
  Axis3d,
  Box,
  ChevronDown,
  ChevronRight,
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
  Circle,
  Boxes,
} from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useEditor } from '@/app/store';
import { cn } from '@/lib/utils';

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

/** Scene tree: select, expand/collapse, rename, show/hide, lock, group/ungroup, delete. */
export function HierarchyPanel() {
  const scene = useEditor((s) => s.project.scene);
  const selection = useEditor((s) => s.selection);
  const collapsed = useEditor((s) => s.collapsed);
  const { select, run, toggleCollapsed } = useEditor((s) => s);
  const [renaming, setRenaming] = useState<string | null>(null);
  const selectedId = selection[0];
  const selected = selectedId ? scene.nodes[selectedId] : undefined;

  const rows = flattenTree(scene).filter(({ id }) => {
    // Hide rows whose ancestor is collapsed.
    let p = scene.nodes[id]?.parentId ?? null;
    while (p) {
      if (collapsed[p]) return false;
      p = scene.nodes[p]?.parentId ?? null;
    }
    return true;
  });

  return (
    <section aria-label="Scene hierarchy" className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">Hierarchy</h2>
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
      <ul role="tree" className="min-h-0 flex-1 overflow-auto py-1 text-sm">
        {rows.map(({ id, depth }) => {
          const n = scene.nodes[id]!;
          const isRoot = n.kind === 'root';
          const isSelected = selection.includes(id);
          return (
            <li
              key={id}
              role="treeitem"
              aria-selected={isSelected}
              aria-expanded={n.childIds.length ? !collapsed[id] : undefined}
              data-testid={`tree-row-${id}`}
              className={cn(
                'group flex h-7 cursor-default items-center gap-1 pr-1 select-none',
                isSelected ? 'bg-primary/20' : 'hover:bg-secondary/60',
                !n.visible && 'opacity-50',
              )}
              style={{ paddingLeft: 6 + depth * 14 }}
              onClick={() => select(id)}
              onDoubleClick={() => !isRoot && setRenaming(id)}
            >
              <button
                type="button"
                aria-label={collapsed[id] ? 'Expand' : 'Collapse'}
                className={cn('size-4 shrink-0 text-muted-foreground', !n.childIds.length && 'invisible')}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleCollapsed(id);
                }}
              >
                {collapsed[id] ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
              </button>
              <NodeIcon node={n} />
              {renaming === id ? (
                <input
                  autoFocus
                  aria-label="Rename"
                  defaultValue={n.name}
                  className="h-6 min-w-0 flex-1 rounded border border-ring bg-background px-1 text-sm"
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    const name = e.target.value.trim();
                    if (name && name !== n.name)
                      run('scene.node.rename', { nodeId: id, name }, { label: 'Rename' });
                    setRenaming(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') {
                      (e.target as HTMLInputElement).value = n.name;
                      setRenaming(null);
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
                    onClick={() =>
                      run(
                        'scene.node.visibility',
                        { nodeId: id, visible: !n.visible },
                        { label: n.visible ? 'Hide' : 'Show' },
                      )
                    }
                  >
                    {n.visible ? <Eye /> : <EyeOff />}
                  </RowButton>
                  <RowButton
                    label={n.locked ? `Unlock ${n.name}` : `Lock ${n.name}`}
                    active={n.locked}
                    onClick={() =>
                      run(
                        'scene.node.lock',
                        { nodeId: id, locked: !n.locked },
                        { label: n.locked ? 'Unlock' : 'Lock' },
                      )
                    }
                  >
                    {n.locked ? <Lock /> : <LockOpen />}
                  </RowButton>
                  <RowButton
                    label={`Delete ${n.name}`}
                    onClick={() => run('scene.node.delete', { nodeId: id }, { label: 'Delete' })}
                  >
                    <Trash2 />
                  </RowButton>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function RowButton({
  label,
  onClick,
  children,
  active,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
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
