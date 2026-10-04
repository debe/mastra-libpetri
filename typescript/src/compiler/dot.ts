import {
  DEFAULT_DOT_CONFIG,
  mapToGraph,
  nodeStyle,
  renderDot,
  sanitize,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type RankDir,
  type Subgraph,
} from 'libpetri/export';
import type { PetriNet, Place } from 'libpetri';
import type { EntryPath } from './names.js';
import type { CompiledWorkflow } from './types.js';

/** How {@link toDot} lays the graph out. Everything else is libpetri's own style ([EXP-012]). */
export interface DotOptions {
  /** Graphviz `rankdir`; libpetri's default when omitted. */
  readonly direction?: RankDir;
}

/**
 * Renders a compiled workflow's net as Graphviz DOT, grouped by the workflow entry each node
 * belongs to.
 *
 * **libpetri draws the net; this file only groups it.** Places, transitions, every arc kind —
 * input, output, inhibitor, read, reset and reset+output — and the XOR/AND junctions of an output
 * spec come from libpetri's own mapper and renderer ([EXP-012], [EXP-013], [EXP-014]), so the
 * picture is the net the executor runs and the verifier proves, never a re-derivation of it. What
 * libpetri cannot know is which Mastra entry a node belongs to: the compiled net is flat, so it
 * carries no subnet membership ([MOD-026]) and no instance prefix ([MOD-040]) to cluster by. The
 * {@link NetMap} does, and this adds one `cluster_entry_<path>` per entry path, nested as the
 * paths nest ([EXP-016]) — a `.parallel()` arm's cluster sits inside its block's.
 *
 * - A transition belongs to the entry `netMap.transitionToEntry` names; one it does not name (the
 *   settle transitions, the cancel arrival, a quota refill) stays at the top level.
 * - A place belongs to the entry `netMap.placeToEntry` names, or else to the entry its `s.<path>.`
 *   name segment names (`names.ts`): every place a gadget mints starts there, and a leaf's own
 *   retry and timeout places (`s.1-0.b.retry-1`) are named nowhere else. A `wf.*` place —
 *   terminals, the cancel signal and request, the permits, slot and quota pools — matches neither,
 *   so it stays at the top level, as the barrier counts it ([ADR 0010]); the compiler never maps
 *   one to an entry.
 * - A junction belongs with the transition whose output spec drew it.
 * - An edge sits in the deepest cluster holding both its ends, as libpetri places one.
 *
 * The terminals are drawn as terminals and the cancel signal as an environment place, whether or
 * not the net declares them so ([EXEC-042], [ENV-010]): at runtime the kernel registers the signal.
 *
 * **Deterministic.** Nodes are ordered by id and edges by `(from, to, kind, label)` in every
 * cluster, clusters by path; nothing depends on iteration order beyond the junction indices
 * libpetri itself numbers per transition ([EXP-013]).
 *
 * @throws when two distinct place names, or two transition names, sanitize to the same DOT id.
 *   libpetri's ids replace every non-`[A-Za-z0-9_]` character by `_`, so `s.1-2.x.in` and
 *   `s.1.2_x.in` would collide and the picture would silently merge two places. A refusal names
 *   both rather than drawing a net that is not the one compiled.
 */
export function toDot(compiled: CompiledWorkflow, options: DotOptions = {}): string {
  assertInjectiveIds(compiled.net);
  const graph = mapToGraph(compiled.net, {
    ...DEFAULT_DOT_CONFIG,
    direction: options.direction ?? DEFAULT_DOT_CONFIG.direction,
    environmentPlaces: new Set([compiled.cancel.name]),
    clusterSource: 'none',
  });
  return renderDot(clustered(graph, compiled));
}

/** Refuses a net whose place or transition names do not map one-to-one onto DOT ids. */
function assertInjectiveIds(net: PetriNet): void {
  const check = (kind: string, names: Iterable<string>): void => {
    const seen = new Map<string, string>();
    for (const name of names) {
      const id = sanitize(name);
      const other = seen.get(id);
      if (other !== undefined && other !== name) {
        throw new Error(`toDot: ${kind} '${other}' and '${name}' both render as DOT id '${id}'`);
      }
      seen.set(id, name);
    }
  };
  check('place', [...net.places].map((p: Place<unknown>) => p.name));
  check('transition', [...net.transitions].map((t) => t.name));
}

/** A path as a map key: `[1, 0]` -> `1.0`. */
const keyOf = (path: EntryPath): string => path.join('.');

/** `s.<path>.…` -> the path, for a place minted by the name vocabulary; otherwise undefined. */
function pathOfName(name: string): EntryPath | undefined {
  const match = /^s\.(\d+(?:-\d+)*)\./.exec(name);
  return match === null ? undefined : match[1]!.split('-').map(Number);
}

interface Cluster {
  readonly path: EntryPath;
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
  readonly children: Map<string, Cluster>;
}

function clustered(graph: Graph, compiled: CompiledWorkflow): Graph {
  const { netMap } = compiled;
  const terminalNames = new Set(Object.values(compiled.terminals).map((p: Place<unknown>) => p.name));

  // Labels: the top-level id from `pathToEntry`, a nested one from the first node mapped there.
  const labels = new Map<string, string>();
  for (const [key, entry] of netMap.pathToEntry) labels.set(key, entry.entryId);
  for (const entry of [...netMap.transitionToEntry.values(), ...netMap.placeToEntry.values()]) {
    if (!labels.has(keyOf(entry.path))) labels.set(keyOf(entry.path), entry.id);
  }

  // Which path every place and transition node belongs to.
  const nodePath = new Map<string, EntryPath>();
  for (const node of graph.nodes) {
    if (node.id.startsWith('t_')) {
      const entry = netMap.transitionToEntry.get(node.semanticId);
      if (entry !== undefined) nodePath.set(node.id, entry.path);
    } else if (node.id.startsWith('p_')) {
      const path = netMap.placeToEntry.get(node.semanticId)?.path ?? pathOfName(node.semanticId);
      if (path !== undefined) nodePath.set(node.id, path);
    }
  }
  // A junction follows the transition (or enclosing junction) that draws an edge into it. libpetri
  // emits the edge into a junction before any edge out of it, so one pass in order resolves nesting.
  for (const edge of graph.edges) {
    if (edge.to.startsWith('j_') && !nodePath.has(edge.to)) {
      const owner = nodePath.get(edge.from);
      if (owner !== undefined) nodePath.set(edge.to, owner);
    }
  }

  const root: Cluster = { path: [], nodes: [], edges: [], children: new Map() };
  const clusterAt = (path: EntryPath): Cluster => {
    let at = root;
    for (let depth = 1; depth <= path.length; depth++) {
      const prefix = path.slice(0, depth);
      const key = keyOf(prefix);
      let child = at.children.get(key);
      if (child === undefined) {
        child = { path: prefix, nodes: [], edges: [], children: new Map() };
        at.children.set(key, child);
      }
      at = child;
    }
    return at;
  };

  for (const node of graph.nodes) {
    const styled = terminalNames.has(node.semanticId) ? asTerminal(node) : node;
    clusterAt(nodePath.get(node.id) ?? []).nodes.push(styled);
  }
  for (const edge of graph.edges) {
    clusterAt(commonPrefix(nodePath.get(edge.from), nodePath.get(edge.to))).edges.push(edge);
  }
  // `clusterSource: 'none'` leaves libpetri's own subgraph list empty; anything there would be
  // a node this grouping never saw, so it is refused rather than dropped.
  if (graph.subgraphs.length > 0) throw new Error('toDot: libpetri returned clusters for a net mapped without any');

  const subgraphOf = (cluster: Cluster): Subgraph => {
    const key = keyOf(cluster.path);
    const id = labels.get(key);
    return {
      id: `entry_${cluster.path.join('_')}`,
      label: id === undefined ? `[${key}]` : `${id} [${key}]`,
      nodes: sortNodes(cluster.nodes),
      edges: sortEdges(cluster.edges),
      subgraphs: sortClusters(cluster.children).map(subgraphOf),
    };
  };

  return {
    ...graph,
    nodes: sortNodes(root.nodes),
    edges: sortEdges(root.edges),
    subgraphs: sortClusters(root.children).map(subgraphOf),
  };
}

/** The longest shared prefix of two paths; empty when either end is at the top level. */
function commonPrefix(a: EntryPath | undefined, b: EntryPath | undefined): EntryPath {
  if (a === undefined || b === undefined) return [];
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return a.slice(0, n);
}

/** A place drawn in libpetri's terminal style ([EXEC-042]), keeping its id and label. */
function asTerminal(node: GraphNode): GraphNode {
  const style = nodeStyle('terminal');
  const { style: _dropped, ...rest } = node;
  return {
    ...rest,
    shape: style.shape,
    fill: style.fill,
    stroke: style.stroke,
    penwidth: style.penwidth,
    ...(style.style === undefined ? {} : { style: style.style }),
    ...(style.width === undefined ? {} : { width: style.width }),
  };
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function sortNodes(nodes: readonly GraphNode[]): GraphNode[] {
  return [...nodes].sort((a, b) => compare(a.id, b.id));
}

function sortEdges(edges: readonly GraphEdge[]): GraphEdge[] {
  const key = (e: GraphEdge): string => `${e.from}\u0000${e.to}\u0000${e.arcType}\u0000${e.label ?? ''}`;
  return [...edges].sort((a, b) => compare(key(a), key(b)));
}

function sortClusters(children: ReadonlyMap<string, Cluster>): Cluster[] {
  const byPath = (a: Cluster, b: Cluster): number => {
    for (let i = 0; i < Math.min(a.path.length, b.path.length); i++) {
      const d = a.path[i]! - b.path[i]!;
      if (d !== 0) return d;
    }
    return a.path.length - b.path.length;
  };
  return [...children.values()].sort(byPath);
}
