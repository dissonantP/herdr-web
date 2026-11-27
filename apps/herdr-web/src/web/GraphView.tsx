import "@xyflow/react/dist/style.css";
import { Background, ReactFlow, ReactFlowProvider, useNodesState, useReactFlow, useStore, type Node, type NodeProps } from "@xyflow/react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { Tree } from "../shared/model.ts";
import { spaceAndBelow } from "../shared/tree-walk.ts";
import { act, addMenu, SettingsButton, groupItems, paneItems, spaceItems } from "./admin.tsx";
import { buildGraph, type GraphNode, type SpaceStatus } from "./graph-layout.ts";
import { setGraphPrefs, useGraphPrefs } from "./graph-view.ts";
import { ViewSwitch } from "./ViewSwitch.tsx";
import { useLongPress } from "./longpress.ts";
import { openMenu } from "./overlay.tsx";
import { navigate, type Route } from "./router.ts";
import { allGroups, findSpace, groupOfSpace, parentOfSpace } from "./tree-utils.ts";
import { StatusDot } from "./StatusDot.tsx";

// The node-graph drawing of the space hierarchy (F39): groups as labelled bordered boxes around their
// spaces (nested to any depth), a space with child spaces in a subtler box around its subtree, packed
// compactly (see graph-layout.ts), with pan and zoom (touch included). Dragging a space onto a space
// or into its box nests it there, into a group box puts it in that group; tapping a space opens it. The list and this view switch with the List | Graph control.

interface NodeData extends Record<string, unknown> {
  readonly node: GraphNode;
}

function Dot({ status }: { readonly status: SpaceStatus }) {
  return status === "none" ? null : <StatusDot state={status} />;
}

const GraphCtx = createContext<{ readonly tree: Tree; readonly route: Route } | null>(null);

/** A node's actions menu: the same items as its row in the list. */
function nodeMenu(n: GraphNode, tree: Tree, route: Route): void {
  if (n.kind === "group") {
    const group = allGroups(tree).find(({ group: g }) => g.id === n.groupId)?.group;
    if (group !== undefined) openMenu(`Group ${group.name}`, groupItems(tree, group, route));
    return;
  }
  const space = findSpace(tree, n.spaceId);
  if (space === null) return;
  if (n.kind === "space") {
    openMenu(`Space ${space.name}`, spaceItems(tree, space, route));
    return;
  }
  const pane = space.tabs.flatMap((t) => t.panes).find((p) => p.id === n.paneId);
  if (pane !== undefined) openMenu(`Pane ${pane.name}`, paneItems(pane));
}

function GraphNodeView({ data, selected }: NodeProps<Node<NodeData>>) {
  const n = data.node;
  const ctx = useContext(GraphCtx);
  const press = useLongPress(() => {
    if (ctx !== null) nodeMenu(n, ctx.tree, ctx.route);
  });
  if (n.kind === "box") return <div className="gbox gbox-subtree" data-testid="graph-subtree" data-id={n.spaceId} />;
  if (n.kind === "group") {
    // The box itself lets touches through to what is inside it and to the canvas; only its label is a target.
    return (
      <div className="gbox gbox-group" data-testid="graph-node" data-kind="group" data-id={n.groupId}>
        <div className="gbox-label" style={{ height: n.labelH - 2 }} {...press}>
          {n.name}
        </div>
      </div>
    );
  }
  const id = n.kind === "space" ? n.id : n.paneId;
  return (
    <div className={`gnode gnode-${n.kind}${selected ? " selected" : ""}`} data-testid="graph-node" data-kind={n.kind} data-id={id} data-status={n.status} data-space={n.spaceId} {...press}>
      <div className="gnode-title">
        <Dot status={n.status} />
        <span className="gnode-name">{n.name}</span>
      </div>
      <div className="gnode-status">{n.detail}</div>
    </div>
  );
}

// Framing never shrinks the graph below this (text stays readable on a phone); pan to see the rest.
const FIT_MIN_ZOOM = 0.5;

const nodeTypes = { graph: GraphNodeView };

function toFlow(n: GraphNode): Node<NodeData> {
  return {
    id: n.id,
    type: "graph",
    position: { x: n.x, y: n.y },
    width: n.w,
    height: n.h,
    data: { node: n },
    draggable: n.kind === "space",
    selectable: false,
    zIndex: n.kind === "group" || n.kind === "box" ? n.depth : 1000,
    className: n.kind === "group" || n.kind === "box" ? "gcontainer" : undefined,
  };
}

function Canvas({ tree, route }: { readonly tree: Tree; readonly route: Route }) {
  const { sessions } = useGraphPrefs();
  // Packed for the pane's shape: a tall drawing for a phone held upright, a wide one otherwise.
  const aspect = useStore((s) => (s.height > 0 && s.width < 0.9 * s.height ? 0.55 : 1.8));
  const model = useMemo(() => buildGraph(tree, sessions, aspect), [tree, sessions, aspect]);
  // The model only changes when something drawn does, so a status ping elsewhere doesn't snap a node mid-drag.
  const signature = JSON.stringify(model);
  const stable = useMemo(() => model, [signature]); // eslint-disable-line react-hooks/exhaustive-deps
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<NodeData>>(stable.nodes.map(toFlow));
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const flow = useReactFlow();
  useEffect(() => setNodes(stable.nodes.map(toFlow)), [stable, setNodes]);
  // Frame the whole graph again when nodes come or go or move under another parent, not on a status change.
  const shape = stable.nodes.map((n) => `${n.id}>${n.parent ?? ""}`).join();
  useEffect(() => {
    const t = setTimeout(() => void flow.fitView({ padding: 0.1, minZoom: FIT_MIN_ZOOM, maxZoom: 1 }), 50);
    return () => clearTimeout(t);
  }, [shape, flow]);
  useEffect(() => {
    if (note === null) return;
    const t = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(t);
  }, [note]);

  /**
   * The space or group node the dragged one overlaps most (never itself, never a session). Overlap,
   * not the centre point: a finger drag lags behind the pointer, and nodes are small when zoomed out.
   */
  const targetUnder = (dragged: Node): string | null => {
    const kindOf = (o: Node) => (o.data as NodeData).node;
    const size = (n: Node) => ({ w: n.measured?.width ?? n.width ?? 0, h: n.measured?.height ?? n.height ?? 0 });
    const d = size(dragged);
    let best: string | null = null;
    let bestArea = 0;
    for (const o of flow.getNodes()) {
      if (o.id === dragged.id || kindOf(o).kind !== "space") continue;
      const s = size(o);
      const w = Math.min(dragged.position.x + d.w, o.position.x + s.w) - Math.max(dragged.position.x, o.position.x);
      const h = Math.min(dragged.position.y + d.h, o.position.y + s.h) - Math.max(dragged.position.y, o.position.y);
      // A graze doesn't count: over a third of the dragged node must overlap (a box label next to a node is a drop on the box).
      if (w > 0 && h > 0 && w * h >= 0.35 * d.w * d.h && w * h > bestArea) {
        best = o.id;
        bestArea = w * h;
      }
    }
    if (best !== null) return best;
    // Not on another node: the innermost box (a group's, or a space's subtree) its centre is in; failing
    // that (a finger drag lags behind the pointer) the box it overlaps most, if over a quarter of it is inside.
    const cx = dragged.position.x + d.w / 2;
    const cy = dragged.position.y + d.h / 2;
    let smallest = Infinity;
    let lap = 0;
    let near: string | null = null;
    for (const o of flow.getNodes()) {
      const info = kindOf(o);
      if ((info.kind !== "group" && info.kind !== "box") || (info.kind === "box" && info.spaceId === dragged.id)) continue;
      const s = size(o);
      if (cx >= o.position.x && cx <= o.position.x + s.w && cy >= o.position.y && cy <= o.position.y + s.h && s.w * s.h < smallest) {
        best = o.id;
        smallest = s.w * s.h;
      }
      const w = Math.min(dragged.position.x + d.w, o.position.x + s.w) - Math.max(dragged.position.x, o.position.x);
      const h = Math.min(dragged.position.y + d.h, o.position.y + s.h) - Math.max(dragged.position.y, o.position.y);
      if (w > 0 && h > 0 && w * h >= 0.25 * d.w * d.h && w * h > lap) {
        near = o.id;
        lap = w * h;
      }
    }
    return best ?? near;
  };

  const drop = async (id: string, target: GraphNode) => {
    const moved = findSpace(tree, id);
    if (moved === null) return;
    if (target.kind === "group") {
      if (parentOfSpace(tree, id) === null && groupOfSpace(tree, id)?.id === target.groupId) return;
      // A nested space comes to the top level first: only top-level spaces belong to a group.
      const nested = parentOfSpace(tree, id) !== null;
      if (nested) {
        const up = await act({ type: "space.reparent", id, parentId: null });
        if (!up.ok) {
          setNote(up.error);
          return;
        }
      }
      const result = await act({ type: "space.move", id, groupId: target.groupId });
      if (!result.ok) setNote(nested ? `Moved out of its parent, but not into the group: ${result.error}` : result.error);
      return;
    }
    const targetId = target.spaceId; // a space node, or the box around one
    if (findSpace(tree, targetId) === null || parentOfSpace(tree, id)?.id === targetId) return;
    if (spaceAndBelow(moved).some((s) => s.id === targetId)) {
      setNote("Can't move a space inside itself or something under it.");
      return;
    }
    const result = await act({ type: "space.reparent", id, parentId: targetId });
    if (!result.ok) setNote(result.error);
  };

  const selected = route.space;
  return (
    <>
      <ReactFlow
        nodes={nodes.map((n) => ({ ...n, className: [n.className, n.id === dropTarget ? "gdrop" : ""].filter((c) => c !== "").join(" ") || undefined, selected: (n.data as NodeData).node.spaceId === selected && (n.data as NodeData).node.kind === "space" }))}
        edges={[]}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        colorMode="dark"
        fitView
        fitViewOptions={{ padding: 0.1, minZoom: FIT_MIN_ZOOM, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={2}
        nodesConnectable={false}
        elementsSelectable={false}
        nodeDragThreshold={6}
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, n) => {
          const g = (n.data as NodeData).node;
          if (g.kind === "group") return;
          navigate({ space: g.spaceId, tab: g.tabId, pane: g.paneId });
        }}
        onNodeDrag={(_, n) => setDropTarget(targetUnder(n))}
        onNodeDragStop={(_, n) => {
          const target = targetUnder(n);
          setDropTarget(null);
          setNodes(stable.nodes.map(toFlow)); // snap back; the tree event redraws it under its new parent
          const hit = target === null ? undefined : stable.nodes.find((o) => o.id === target);
          if (hit !== undefined) void drop(n.id, hit);
        }}
      >
        <Background gap={24} />
      </ReactFlow>
      {note !== null && (
        <div className="graph-note" role="alert" data-testid="graph-note">
          {note}
        </div>
      )}
    </>
  );
}

export interface GraphViewProps {
  readonly tree: Tree;
  readonly route: Route;
}

export function GraphView({ tree, route }: GraphViewProps) {
  const { sessions } = useGraphPrefs();
  return (
    <div className="graph" data-testid="graph-view">
      <div className="graph-bar">
        <ViewSwitch mode="graph" />
        <label className="graph-toggle">
          <input type="checkbox" checked={sessions} data-testid="graph-sessions" onChange={(e) => setGraphPrefs({ sessions: e.target.checked })} />
          Sessions
        </label>
        <span className="graph-spacer" />
        <button type="button" className="add" aria-label="New space or group" data-testid="add-node" onClick={() => addMenu(tree)}>
          +
        </button>
        <SettingsButton />
      </div>
      <div className="graph-canvas">
        <GraphCtx.Provider value={{ tree, route }}>
          <ReactFlowProvider>
            <Canvas tree={tree} route={route} />
          </ReactFlowProvider>
        </GraphCtx.Provider>
      </div>
    </div>
  );
}
