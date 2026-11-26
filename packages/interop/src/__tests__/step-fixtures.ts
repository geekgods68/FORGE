/**
 * Test fixture generator: ISO 10303-21 (STEP AP214) files describing axis-aligned boxes as
 * exact B-reps (planar faces, straight edges), in a chosen length unit. Each box is its own
 * PRODUCT with a MANIFOLD_SOLID_BREP; several boxes form an assembly through
 * NEXT_ASSEMBLY_USAGE_OCCURRENCE with explicit placements, so hierarchy, units and placement
 * can be verified against known values.
 */
export interface StepBox {
  name: string;
  size: [number, number, number]; // in file units
  /** Placement of the part in the assembly (file units). */
  at: [number, number, number];
}

export function stepAssembly(
  boxes: StepBox[],
  unit: 'mm' | 'm' | 'inch' = 'mm',
  assemblyName = 'ASM',
): string {
  let id = 0;
  const L: string[] = [];
  const e = (s: string) => {
    id++;
    L.push(`#${id}=${s};`);
    return `#${id}`;
  };
  const pt = (x: number, y: number, z: number) =>
    e(`CARTESIAN_POINT('',(${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)}))`);
  const dir = (x: number, y: number, z: number) =>
    e(`DIRECTION('',(${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)}))`);
  const ax2 = (o: [number, number, number], z: [number, number, number], x: [number, number, number]) =>
    e(`AXIS2_PLACEMENT_3D('',${pt(...o)},${dir(...z)},${dir(...x)})`);

  // Units and representation context.
  const lenUnit =
    unit === 'm'
      ? e(`(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT($,.METRE.))`)
      : unit === 'mm'
        ? e(`(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))`)
        : (() => {
            const mm = e(`(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))`);
            const mw = e(`LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),${mm})`);
            const dims = e(`DIMENSIONAL_EXPONENTS(1.,0.,0.,0.,0.,0.,0.)`);
            return e(`(CONVERSION_BASED_UNIT('INCH',${mw})LENGTH_UNIT()NAMED_UNIT(${dims}))`);
          })();
  const angUnit = e(`(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))`);
  const solUnit = e(`(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())`);
  const unc = e(
    `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),${lenUnit},'distance_accuracy_value','confusion accuracy')`,
  );
  const ctx = e(
    `(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${unc}))GLOBAL_UNIT_ASSIGNED_CONTEXT((${lenUnit},${angUnit},${solUnit}))REPRESENTATION_CONTEXT('Context3D','3D'))`,
  );
  const appCtx = e(`APPLICATION_CONTEXT('automotive design')`);
  e(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${appCtx})`);
  const pCtx = e(`PRODUCT_CONTEXT('',${appCtx},'mechanical')`);
  const pdCtx = e(`PRODUCT_DEFINITION_CONTEXT('part definition',${appCtx},'design')`);

  const product = (name: string) => {
    const p = e(`PRODUCT('${name}','${name}','',(${pCtx}))`);
    const f = e(`PRODUCT_DEFINITION_FORMATION('','',${p})`);
    const pd = e(`PRODUCT_DEFINITION('design','',${f},${pdCtx})`);
    const pds = e(`PRODUCT_DEFINITION_SHAPE('','',${pd})`);
    return { pd, pds };
  };

  const boxBrep = (s: [number, number, number]) => {
    const [a, b, c] = s;
    const V = [
      [0, 0, 0],
      [a, 0, 0],
      [a, b, 0],
      [0, b, 0],
      [0, 0, c],
      [a, 0, c],
      [a, b, c],
      [0, b, c],
    ].map((p) => e(`VERTEX_POINT('',${pt(p[0]!, p[1]!, p[2]!)})`));
    const P = [
      [0, 0, 0],
      [a, 0, 0],
      [a, b, 0],
      [0, b, 0],
      [0, 0, c],
      [a, 0, c],
      [a, b, c],
      [0, b, c],
    ];
    const edges = new Map<string, string>();
    const edge = (i: number, j: number) => {
      const k = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (!edges.has(k)) {
        const [lo, hi] = i < j ? [i, j] : [j, i];
        const d = [0, 1, 2].map((t) => P[hi]![t]! - P[lo]![t]!);
        const len = Math.hypot(d[0]!, d[1]!, d[2]!);
        const vec = e(`VECTOR('',${dir(d[0]! / len, d[1]! / len, d[2]! / len)},${len.toFixed(6)})`);
        const line = e(`LINE('',${pt(P[lo]![0]!, P[lo]![1]!, P[lo]![2]!)},${vec})`);
        edges.set(k, e(`EDGE_CURVE('',${V[lo]},${V[hi]},${line},.T.)`));
      }
      return { ec: edges.get(k)!, same: i < j };
    };
    // Faces: vertex loops counter-clockwise seen from outside, with outward normals.
    const faces: [number[], [number, number, number], [number, number, number]][] = [
      [
        [0, 3, 2, 1],
        [0, 0, -1],
        [1, 0, 0],
      ],
      [
        [4, 5, 6, 7],
        [0, 0, 1],
        [1, 0, 0],
      ],
      [
        [0, 1, 5, 4],
        [0, -1, 0],
        [1, 0, 0],
      ],
      [
        [1, 2, 6, 5],
        [1, 0, 0],
        [0, 1, 0],
      ],
      [
        [2, 3, 7, 6],
        [0, 1, 0],
        [-1, 0, 0],
      ],
      [
        [3, 0, 4, 7],
        [-1, 0, 0],
        [0, -1, 0],
      ],
    ];
    const fs = faces.map(([loop, n, x]) => {
      const oes = loop.map((v, k) => {
        const w = loop[(k + 1) % loop.length]!;
        const { ec, same } = edge(v, w);
        return e(`ORIENTED_EDGE('',*,*,${ec},${same ? '.T.' : '.F.'})`);
      });
      const el = e(`EDGE_LOOP('',(${oes.join(',')}))`);
      const fb = e(`FACE_OUTER_BOUND('',${el},.T.)`);
      const o = P[loop[0]!]! as [number, number, number];
      const plane = e(`PLANE('',${ax2(o, n, x)})`);
      return e(`ADVANCED_FACE('',(${fb}),${plane},.T.)`);
    });
    const shell = e(`CLOSED_SHELL('',(${fs.join(',')}))`);
    return e(`MANIFOLD_SOLID_BREP('',${shell})`);
  };

  const origin = ax2([0, 0, 0], [0, 0, 1], [1, 0, 0]);
  const asm = product(assemblyName);
  const asmRep = e(`SHAPE_REPRESENTATION('${assemblyName}',(${origin}),${ctx})`);
  e(`SHAPE_DEFINITION_REPRESENTATION(${asm.pds},${asmRep})`);
  boxes.forEach((bx, i) => {
    const part = product(bx.name);
    const partOrigin = ax2([0, 0, 0], [0, 0, 1], [1, 0, 0]);
    const brep = boxBrep(bx.size);
    const rep = e(`ADVANCED_BREP_SHAPE_REPRESENTATION('${bx.name}',(${partOrigin},${brep}),${ctx})`);
    e(`SHAPE_DEFINITION_REPRESENTATION(${part.pds},${rep})`);
    const nauo = e(
      `NEXT_ASSEMBLY_USAGE_OCCURRENCE('${i + 1}','${bx.name}:${i + 1}','',${asm.pd},${part.pd},$)`,
    );
    const placement = ax2(bx.at, [0, 0, 1], [1, 0, 0]);
    const idt = e(`ITEM_DEFINED_TRANSFORMATION('','',${partOrigin},${placement})`);
    const rr = e(
      `(REPRESENTATION_RELATIONSHIP('','',${rep},${asmRep})REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(${idt})SHAPE_REPRESENTATION_RELATIONSHIP())`,
    );
    const pdsN = e(`PRODUCT_DEFINITION_SHAPE('','',${nauo})`);
    e(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(${rr},${pdsN})`);
  });
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('FORGE test fixture'),'2;1');",
    `FILE_NAME('${assemblyName}.step','2026-11-26T00:00:00',('FORGE'),('FORGE'),'FORGE fixture generator','FORGE','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    'ENDSEC;',
    'DATA;',
    ...L,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}
