import { getDefinition } from '@forge/components';
import type { SceneNode } from '@forge/engineering-core';
import { Save } from 'lucide-react';
import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { useEditor } from '@/app/store';

/** Group / assembly membership (component families and counts) and "save as reusable assembly". */
export function GroupInspector({ node }: { node: SceneNode }) {
  const scene = useEditor((s) => s.project.scene);
  const saveAssembly = useEditor((s) => s.saveAssembly);
  const members = useMemo(() => {
    const counts = new Map<string, number>();
    let other = 0;
    const walk = (id: string) => {
      for (const c of scene.nodes[id]?.childIds ?? []) {
        const n = scene.nodes[c]!;
        if (n.kind === 'component-instance' && n.component) {
          const name = getDefinition(n.definitionId)?.name ?? n.component.snapshot.name;
          counts.set(name, (counts.get(name) ?? 0) + 1);
        } else if (n.kind !== 'group' && n.kind !== 'assembly') other += 1;
        walk(c);
      }
    };
    walk(node.id);
    return { list: [...counts].sort((a, b) => b[1] - a[1]), other };
  }, [scene, node.id]);
  const total = members.list.reduce((n, [, c]) => n + c, 0);
  return (
    <section aria-label="Group members" className="space-y-1 text-xs">
      <p className="font-semibold">
        Members: {total} component{total === 1 ? '' : 's'}
        {members.other ? ` + ${members.other} other` : ''}
      </p>
      <ul data-testid="group-members" className="max-h-40 overflow-auto">
        {members.list.map(([name, n]) => (
          <li key={name}>
            {n} × {name}
          </li>
        ))}
      </ul>
      <Button size="sm" variant="secondary" data-testid="save-assembly" onClick={() => saveAssembly(node.id)}>
        <Save /> Save as reusable assembly
      </Button>
    </section>
  );
}
