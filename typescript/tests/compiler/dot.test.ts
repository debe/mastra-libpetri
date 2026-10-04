import { describe, expect, it } from 'vitest';
import { edgeStyle, nodeStyle, sanitize } from 'libpetri/export';
import { PetriNet, Transition, one, outPlace, place, type Place } from 'libpetri';
import { compile, toDot } from '../../src/compiler/index.js';
import type { CompiledWorkflow, EntryDescription, StepDescription, WorkflowDescription } from '../../src/compiler/types.js';

/**
 * `toDot` — the compiled net as Graphviz DOT, clustered by entry ([EXP-012]..[EXP-016]).
 *
 * The assertions are structural, not a golden file: libpetri owns the styling, and a golden file
 * would pin its palette rather than our net. What is pinned is what this repo adds or relies on —
 * every place and transition of the compiled net drawn exactly once, every arc of every kind drawn
 * once and no extra one, each node in its entry's cluster, clusters nested as paths nest, terminals
 * drawn as terminals, and the same output for the same workflow.
 */

const step = (id: string): StepDescription => ({ kind: 'step', id });
const fan = (id: string, arms: readonly StepDescription[]): EntryDescription => ({ kind: 'parallel', id, arms });
const each = (id: string, body: StepDescription, concurrency: number): EntryDescription => ({ kind: 'foreach', id, body, concurrency });
const wf = (...entries: EntryDescription[]): WorkflowDescription => ({ id: 'w', entries });

const SHAPES: readonly (readonly [string, WorkflowDescription])[] = [
  ['chain', wf(step('a'), step('b'), step('c'))],
  ['parallel', wf(step('a'), fan('fan', [step('b'), step('c')]), step('d'))],
  ['foreach', wf(step('pre'), each('items', step('body'), 2))],
];

// ------------------------------------------------------------------
//  A small DOT reader: enough of the grammar libpetri's renderer emits.
// ------------------------------------------------------------------

interface DotNode {
  readonly id: string;
  readonly attrs: string;
  /** The enclosing `subgraph` ids, outermost first; empty at the top level. */
  readonly clusters: readonly string[];
}
interface DotEdge {
  readonly from: string;
  readonly to: string;
  readonly attrs: string;
  readonly clusters: readonly string[];
}
interface Dot {
  readonly nodes: readonly DotNode[];
  readonly edges: readonly DotEdge[];
  readonly clusterLabels: ReadonlyMap<string, string>;
  /** Every `subgraph` id in the order the text opens them (pre-order). */
  readonly clusterOrder: readonly string[];
}

function parseDot(text: string): Dot {
  const nodes: DotNode[] = [];
  const edges: DotEdge[] = [];
  const clusterLabels = new Map<string, string>();
  const clusterOrder: string[] = [];
  const stack: string[] = [];
  let depth = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    let m: RegExpExecArray | null;
    if ((m = /^digraph \S+ \{$/.exec(line))) {
      depth++;
    } else if ((m = /^subgraph (\S+) \{$/.exec(line))) {
      stack.push(m[1]!);
      clusterOrder.push(m[1]!);
    } else if (line === '}') {
      if (stack.length > 0) stack.pop();
      else depth--;
    } else if ((m = /^label=(".*")\;$/.exec(line)) && stack.length > 0) {
      clusterLabels.set(stack[stack.length - 1]!, JSON.parse(m[1]!) as string);
    } else if ((m = /^(\S+) -> (\S+) \[(.*)\];$/.exec(line))) {
      edges.push({ from: m[1]!, to: m[2]!, attrs: m[3]!, clusters: [...stack] });
    } else if ((m = /^(\S+) \[(.*)\];$/.exec(line)) && !['node', 'edge', 'graph'].includes(m[1]!)) {
      nodes.push({ id: m[1]!, attrs: m[2]!, clusters: [...stack] });
    }
  }
  expect(depth).toBe(0);
  expect(stack).toEqual([]);
  return { nodes, edges, clusterLabels, clusterOrder };
}

/** One attribute's value, unquoted; undefined when absent. */
function attr(attrs: string, key: string): string | undefined {
  const m = new RegExp(`(?:^|, )${key}=("(?:[^"\\\\]|\\\\.)*"|[^,]*)`).exec(attrs);
  if (m === null) return undefined;
  const v = m[1]!;
  return v.startsWith('"') ? (JSON.parse(v) as string) : v;
}

const pid = (p: Place<unknown>): string => `p_${sanitize(p.name)}`;
const tid = (t: Transition): string => `t_${sanitize(t.name)}`;

/** Which arc kind libpetri drew an edge as, read back from its style alone. */
function kindOf(edge: DotEdge): 'inhibitor' | 'read' | 'reset' | 'reset-output' | 'input' | 'output' {
  const label = attr(edge.attrs, 'label');
  if (attr(edge.attrs, 'arrowhead') === edgeStyle('inhibitor').arrowhead && attr(edge.attrs, 'color') === edgeStyle('inhibitor').color) {
    return 'inhibitor';
  }
  if (label === 'read') return 'read';
  if (label === 'reset') return 'reset';
  if (label === 'reset+out') return 'reset-output';
  return edge.from.startsWith('p_') ? 'input' : 'output';
}

/** The places an output edge out of `from` lands in, following junctions. */
function reachedThroughJunctions(dot: Dot, from: string): Set<string> {
  const out = new Set<string>();
  const queue = [from];
  while (queue.length > 0) {
    const at = queue.shift()!;
    for (const e of dot.edges) {
      if (e.from !== at) continue;
      const kind = kindOf(e);
      if (kind !== 'output' && kind !== 'reset-output') continue;
      if (e.to.startsWith('j_')) queue.push(e.to);
      else out.add(e.to);
    }
  }
  return out;
}

/** The longest shared prefix of two cluster stacks. */
function sharedClusters(a: readonly string[], b: readonly string[]): string[] {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return a.slice(0, n);
}

/** `cluster_entry_1_10` -> `[1, 10]`. */
const pathOfCluster = (id: string): number[] => id.replace(/^cluster_entry_/, '').split('_').map(Number);

const clusterOf = (path: readonly number[]): string => `cluster_entry_${path.join('_')}`;

/** Every enclosing cluster of a node at `path`, outermost first. */
const clustersFor = (path: readonly number[]): string[] => path.map((_, i) => clusterOf(path.slice(0, i + 1)));

// ------------------------------------------------------------------

describe.each(SHAPES)('toDot: %s', (_label, description) => {
  const compiled: CompiledWorkflow = compile(description);
  const text = toDot(compiled);
  const dot = parseDot(text);
  const places = [...compiled.net.places] as Place<unknown>[];
  const transitions = [...compiled.net.transitions];

  it('draws every place and every transition exactly once, and nothing else but junctions', () => {
    const count = new Map<string, number>();
    for (const n of dot.nodes) count.set(n.id, (count.get(n.id) ?? 0) + 1);

    for (const p of places) {
      expect(count.get(pid(p)), p.name).toBe(1);
      expect(attr(dot.nodes.find((n) => n.id === pid(p))!.attrs, 'xlabel')).toBe(p.name);
    }
    for (const t of transitions) {
      expect(count.get(tid(t)), t.name).toBe(1);
      expect(attr(dot.nodes.find((n) => n.id === tid(t))!.attrs, 'label')!.startsWith(t.name)).toBe(true);
    }
    const others = dot.nodes.filter((n) => !n.id.startsWith('j_')).length;
    expect(others).toBe(places.length + transitions.length);
    for (const n of dot.nodes.filter((n) => n.id.startsWith('j_'))) expect(count.get(n.id)).toBe(1);
  });

  it('draws every inhibitor, read, reset and input arc exactly once, and no arc the net lacks', () => {
    const expected = { input: 0, inhibitor: 0, read: 0, reset: 0 };
    for (const t of transitions) {
      const outs = new Set([...t.outputPlaces()].map((p) => pid(p)));
      const edgesTo = (kind: string, from: string): number =>
        dot.edges.filter((e) => e.from === from && e.to === tid(t) && kindOf(e) === kind).length;
      for (const spec of t.inputSpecs) {
        expect(edgesTo('input', pid(spec.place)), `${t.name} <- ${spec.place.name}`).toBe(1);
        expected.input++;
      }
      for (const a of t.inhibitors) {
        expect(edgesTo('inhibitor', pid(a.place)), `${t.name} -o ${a.place.name}`).toBe(1);
        expected.inhibitor++;
      }
      for (const a of t.reads) {
        expect(edgesTo('read', pid(a.place)), `${t.name} reads ${a.place.name}`).toBe(1);
        expected.read++;
      }
      for (const a of t.resets) {
        // A reset on a place the transition also outputs to is drawn once, as reset+out ([EXP-014]).
        const kind = outs.has(pid(a.place)) ? 'reset-output' : 'reset';
        const drawn = dot.edges.filter((e) => e.from === tid(t) && e.to === pid(a.place) && kindOf(e) === kind);
        expect(drawn.length, `${t.name} resets ${a.place.name}`).toBe(1);
        expected.reset++;
      }
      // Every output place is reached through the junctions, and only those.
      expect([...reachedThroughJunctions(dot, tid(t))].sort(), t.name).toEqual([...outs].sort());
    }
    const drawn = { input: 0, inhibitor: 0, read: 0, reset: 0 };
    for (const e of dot.edges) {
      const kind = kindOf(e);
      if (kind === 'reset-output') drawn.reset++;
      else if (kind !== 'output') drawn[kind]++;
    }
    expect(drawn).toEqual(expected);
  });

  it("puts each transition in its entry's cluster, nested as its path nests", () => {
    for (const t of transitions) {
      const node = dot.nodes.find((n) => n.id === tid(t))!;
      const entry = compiled.netMap.transitionToEntry.get(t.name);
      expect(node.clusters, t.name).toEqual(entry === undefined ? [] : clustersFor(entry.path));
    }
    for (const [name, entry] of compiled.netMap.placeToEntry) {
      const node = dot.nodes.find((n) => n.id === `p_${sanitize(name)}`)!;
      expect(node.clusters, name).toEqual(clustersFor(entry.path));
    }
    // A top-level entry's cluster is labelled with its id and path.
    for (const [key, entry] of compiled.netMap.pathToEntry) {
      expect(dot.clusterLabels.get(clusterOf([Number(key)]))).toBe(`${entry.entryId} [${key}]`);
    }
  });

  it('draws the terminals as terminals and the cancel signal as an environment place, at the top level', () => {
    const terminal = nodeStyle('terminal');
    for (const p of Object.values(compiled.terminals) as Place<unknown>[]) {
      const node = dot.nodes.find((n) => n.id === pid(p))!;
      expect(node.clusters).toEqual([]);
      expect([attr(node.attrs, 'shape'), attr(node.attrs, 'fillcolor')], p.name).toEqual([terminal.shape, terminal.fill]);
    }
    // Not vacuous: an ordinary place is drawn differently.
    expect(nodeStyle('place').shape).not.toBe(terminal.shape);
    const cancel = dot.nodes.find((n) => n.id === pid(compiled.cancel))!;
    expect(cancel.clusters).toEqual([]);
    expect(attr(cancel.attrs, 'fillcolor')).toBe(nodeStyle('environment').fill);
  });

  it('puts every edge in the deepest cluster holding both its ends', () => {
    const at = new Map(dot.nodes.map((n) => [n.id, n.clusters] as const));
    for (const e of dot.edges) {
      expect(e.clusters, `${e.from} -> ${e.to}`).toEqual(sharedClusters(at.get(e.from)!, at.get(e.to)!));
    }
    // Not vacuous: some edge sits inside a cluster, and some edge crosses from a deeper cluster.
    expect(dot.edges.some((e) => e.clusters.length > 0)).toBe(true);
    expect(dot.edges.some((e) => at.get(e.from)!.length > e.clusters.length)).toBe(true);
  });

  it('draws each junction in the cluster of the transition whose output spec drew it', () => {
    const at = new Map(dot.nodes.map((n) => [n.id, n.clusters] as const));
    const junctions = dot.nodes.filter((n) => n.id.startsWith('j_'));
    for (const j of junctions) {
      const into = dot.edges.filter((e) => e.to === j.id);
      expect(into.length, j.id).toBe(1);
      expect(j.clusters, j.id).toEqual(at.get(into[0]!.from));
    }
    expect(junctions.some((j) => j.clusters.length > 0)).toBe(true);
  });

  it('orders sibling clusters by path', () => {
    const order = dot.clusterOrder.map(pathOfCluster);
    const byPath = (a: number[], b: number[]): number => {
      for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
      return a.length - b.length;
    };
    expect(order).toEqual([...order].sort(byPath));
    expect(new Set(order.filter((p) => p.length === 1).map(String)).size).toBeGreaterThan(1);
  });

  it('is deterministic: the same workflow compiled twice renders byte-identical DOT', () => {
    expect(toDot(compile(description))).toBe(text);
    expect(toDot(compiled)).toBe(text);
  });

  it('orders nodes by id and edges by endpoints inside every cluster, so the order is not construction order', () => {
    const sorted = (xs: readonly string[]): string[] => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const groups = new Map<string, { nodes: string[]; edges: string[] }>();
    const group = (clusters: readonly string[]) => {
      const key = clusters.join('/');
      let g = groups.get(key);
      if (g === undefined) groups.set(key, (g = { nodes: [], edges: [] }));
      return g;
    };
    for (const n of dot.nodes) group(n.clusters).nodes.push(n.id);
    for (const e of dot.edges) group(e.clusters).edges.push(`${e.from}\u0000${e.to}`);
    expect(groups.size).toBeGreaterThan(1);
    for (const [key, g] of groups) {
      expect(g.nodes, key).toEqual(sorted(g.nodes));
      expect(g.edges, key).toEqual(sorted(g.edges));
    }
  });
});

describe('toDot: across the shapes', () => {
  it('exercises every arc kind the assertions above check, so none of them passes on an empty set', () => {
    const totals = { inhibitor: 0, read: 0, reset: 0 };
    for (const [, description] of SHAPES) {
      for (const t of compile(description).net.transitions) {
        totals.inhibitor += t.inhibitors.length;
        totals.read += t.reads.length;
        totals.reset += t.resets.length;
      }
    }
    expect(totals.inhibitor).toBeGreaterThan(0);
    expect(totals.read).toBeGreaterThan(0);
    expect(totals.reset).toBeGreaterThan(0);
  });

  it("nests a .parallel() arm's cluster inside its block's, labelled with the arm's step id", () => {
    const dot = parseDot(toDot(compile(SHAPES[1]![1])));
    const arm = dot.nodes.find((n) => n.id === 't_t_1_0_b_run')!;
    expect(arm.clusters).toEqual(['cluster_entry_1', 'cluster_entry_1_0']);
    expect(dot.clusterLabels.get('cluster_entry_1')).toBe('fan [1]');
    expect(dot.clusterLabels.get('cluster_entry_1_0')).toBe('b [1.0]');
    // A gadget-internal place no NetMap entry names is clustered by its `s.<path>.` segment.
    const join = dot.nodes.find((n) => n.id === 'p_s_1_fan_arrived')!;
    expect(join.clusters).toEqual(['cluster_entry_1']);
  });

  it('refuses a net whose names collide once sanitized to DOT ids, rather than merging two places', () => {
    // Arm `b` at [1, 0] owns `s.1-0.b.in`; a block with id `0_b` at [1] owns `s.1.0_b.in`. Both
    // sanitize to `s_1_0_b_in`, which would draw one node for two places.
    const compiled = compile(wf(step('a'), fan('0_b', [step('b')])));
    const names = [...compiled.net.places].map((p: Place<unknown>) => p.name);
    expect(names).toEqual(expect.arrayContaining(['s.1-0.b.in', 's.1.0_b.in']));
    expect(() => toDot(compiled)).toThrow(/both render as DOT id 's_1_0_b_in'/);
  });

  it('opens the clusters in path order: an arm after its block, the arms in order, before the next block', () => {
    expect(parseDot(toDot(compile(SHAPES[1]![1]))).clusterOrder).toEqual([
      'cluster_entry_0', 'cluster_entry_1', 'cluster_entry_1_0', 'cluster_entry_1_1', 'cluster_entry_2',
    ]);
  });

  it("places an arc inside one arm in that arm's cluster, and an arc between entries in their common ancestor", () => {
    const dot = parseDot(toDot(compile(SHAPES[1]![1])));
    const edge = (from: string, to: string): DotEdge => {
      const found = dot.edges.filter((e) => e.from === from && e.to === to);
      expect(found.length, `${from} -> ${to}`).toBe(1);
      return found[0]!;
    };
    // Inside arm `b` [1.0]: its input place into its run transition.
    expect(edge('p_s_1_0_b_in', 't_t_1_0_b_run').clusters).toEqual(['cluster_entry_1', 'cluster_entry_1_0']);
    // From arm `b` [1.0] to its block's join [1]: the block's cluster, not the arm's.
    const fromArm = dot.edges.filter((e) => e.from.startsWith('t_t_1_0_b_') || e.from.startsWith('j_t_1_0_b_'))
      .filter((e) => dot.nodes.find((n) => n.id === e.to)!.clusters.length === 1);
    expect(fromArm.length).toBeGreaterThan(0);
    for (const e of fromArm) expect(e.clusters, `${e.from} -> ${e.to}`).toEqual(['cluster_entry_1']);
    // From entry [0] into the block [1]: the top level.
    const crossing = dot.edges.filter((e) => e.from.startsWith('t_t_0_') || e.from.startsWith('j_t_0_'))
      .filter((e) => dot.nodes.find((n) => n.id === e.to)!.clusters[0] === 'cluster_entry_1');
    expect(crossing.length).toBeGreaterThan(0);
    for (const e of crossing) expect(e.clusters, `${e.from} -> ${e.to}`).toEqual([]);
  });

  it("clusters a leaf's own retry place by its multi-segment `s.<path>.` name when the NetMap does not name it", () => {
    const compiled = compile(wf(step('a'), fan('fan', [{ kind: 'step', id: 'b', retries: 1 }, step('c')])));
    expect(compiled.netMap.placeToEntry.has('s.1-0.b.retry-1')).toBe(false);
    expect([...compiled.net.places].map((p: Place<unknown>) => p.name)).toContain('s.1-0.b.retry-1');
    const node = parseDot(toDot(compiled)).nodes.find((n) => n.id === 'p_s_1_0_b_retry_1')!;
    expect(node.clusters).toEqual(['cluster_entry_1', 'cluster_entry_1_0']);
  });

  it('keeps every workflow-wide `wf.*` place at the top level: terminals, cancel, permits, slots, quotas', () => {
    const quota = { id: 'api', kind: 'limit', n: 1 } as const;
    const compiled = compile(
      wf({ kind: 'step', id: 'a', quotas: [quota] }, { kind: 'parallel', id: 'fan', arms: [step('b'), step('c'), step('d')], concurrency: 2 }),
      { concurrency: 2 },
    );
    const wide = ([...compiled.net.places] as Place<unknown>[]).map((p) => p.name).filter((n) => n.startsWith('wf.'));
    expect(wide).toEqual(expect.arrayContaining(['wf.permits', 'wf.slots.1', 'wf.quota.api', 'wf.cancel.request']));
    const dot = parseDot(toDot(compiled));
    for (const name of wide) expect(dot.nodes.find((n) => n.id === `p_${sanitize(name)}`)!.clusters, name).toEqual([]);
  });

  it('refuses a net whose transition names collide once sanitized, even when its places do not', () => {
    const p = place<null>('p');
    const q = place<null>('q');
    const t = (name: string): Transition => Transition.builder(name).inputs(one(p)).outputs(outPlace(q)).action(async () => {}).build();
    const net = PetriNet.builder('collide').places(p, q).transitions(t('t.x'), t('t_x')).build();
    expect(() => toDot({ net } as unknown as CompiledWorkflow)).toThrow(/transition 't\.x' and 't_x' both render as DOT id 't_x'/);
  });

  it('honours the layout direction', () => {
    expect(toDot(compile(SHAPES[0]![1]), { direction: 'LR' })).toMatch(/^\s*rankdir=LR;$/m);
  });
});
