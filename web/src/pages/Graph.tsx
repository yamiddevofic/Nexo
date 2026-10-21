import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Link, useLocation, useSearch as useQueryString } from 'wouter'
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum,
} from 'd3-force'
import { select } from 'd3-selection'
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom'
import * as Popover from '@radix-ui/react-popover'
import { ArrowUpRight, Locate, Maximize, Minus, Plus, Search, SlidersHorizontal, X } from 'lucide-react'
import type { GraphEdge, GraphNode, NoteType, RelationType } from '../../../shared/schema'
import { NOTE_TYPES, RELATION_TYPES } from '../../../shared/vocab'
import { RELATION_LABELS, TYPE_LABELS } from '../../../shared/labels'
import { EpistemicTag, Loading, RelationLabel, TypeIcon } from '../components/ui'
import { useGraph, useHotkey } from '../hooks'

type SimNode = GraphNode & SimulationNodeDatum & { r: number }
type SimLink = {
  source: string | SimNode
  target: string | SimNode
  kind: 'edge' | 'source' | 'item'
  edge?: GraphEdge
}
type Placed = { source: SimNode; target: SimNode; kind: SimLink['kind']; edge?: GraphEdge }

const nodeRadius = (degree: number) => 6 + Math.sqrt(degree) * 3

export function Graph() {
  const { data, isLoading } = useGraph()
  const params = new URLSearchParams(useQueryString())
  const [, navigate] = useLocation()

  const [relations, setRelations] = useState<Set<RelationType>>(() => new Set(RELATION_TYPES))
  const [types, setTypes] = useState<Set<NoteType>>(() => new Set(NOTE_TYPES))
  const [showRefs, setShowRefs] = useState(false)
  const [depth, setDepth] = useState<1 | 2>(2)
  const focus = params.get('foco')
  const [hovered, setHovered] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(focus)
  const [tooltip, setTooltip] = useState<{ x: number; y: number; edge: GraphEdge; from: string; to: string } | null>(null)
  const [transform, setTransform] = useState<ZoomTransform>(zoomIdentity)
  const [, setTick] = useState(0)

  const svgRef = useRef<SVGSVGElement>(null)
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown>>(null)
  const simRef = useRef<Simulation<SimNode, undefined>>(null)
  const positions = useRef(new Map<string, { x: number; y: number }>())
  const drag = useRef<{ node: SimNode; x: number; y: number; moved: boolean } | null>(null)

  const setFocus = useCallback(
    (id: string | null) => navigate(id ? `/grafo?foco=${encodeURIComponent(id)}` : '/grafo', { replace: true }),
    [navigate],
  )

  // ── Qué se ve: filtros y vecindario ─────────────────────────
  const visible = useMemo(() => {
    if (!data) return { nodes: [] as SimNode[], links: [] as SimLink[] }
    let nodes = data.nodes.filter((n) => types.has(n.type))
    let ids = new Set(nodes.map((n) => n.id))
    let links: SimLink[] = [
      ...data.edges
        .filter((e) => relations.has(e.type) && ids.has(e.from) && ids.has(e.to))
        .map((e) => ({ source: e.from, target: e.to, kind: 'edge' as const, edge: e })),
      ...(showRefs
        ? data.refs.filter((r) => ids.has(r.from) && ids.has(r.to)).map((r) => ({ source: r.from, target: r.to, kind: r.kind }))
        : []),
    ]
    if (focus && ids.has(focus)) {
      const near = new Set([focus])
      for (let d = 0; d < depth; d++) {
        for (const l of links) {
          const [s, t] = [l.source as string, l.target as string]
          if (near.has(s) || near.has(t)) {
            near.add(s)
            near.add(t)
          }
        }
      }
      nodes = nodes.filter((n) => near.has(n.id))
      ids = near
      links = links.filter((l) => near.has(l.source as string) && near.has(l.target as string))
    }
    const simNodes: SimNode[] = nodes.map((n) => ({ ...n, r: nodeRadius(n.degree), ...positions.current.get(n.id) }))
    return { nodes: simNodes, links }
  }, [data, types, relations, showRefs, focus, depth])

  const neighbors = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const l of visible.links) {
      const [s, t] = [id(l.source), id(l.target)]
      if (!map.has(s)) map.set(s, new Set())
      if (!map.has(t)) map.set(t, new Set())
      map.get(s)!.add(t)
      map.get(t)!.add(s)
    }
    return map
  }, [visible])

  // ── Zoom y encuadre ─────────────────────────────────────────
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const z = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.15, 4])
      .filter((e: Event) => !(e.target as Element).closest?.('.g-node') && !(e as MouseEvent).button)
      .on('zoom', (e) => setTransform(e.transform))
    select(svg).call(z).on('dblclick.zoom', null)
    zoomRef.current = z
    return () => {
      select(svg).on('.zoom', null)
    }
  }, [isLoading])

  const fit = useCallback((nodes: SimNode[], attempt = 0) => {
    const svg = svgRef.current
    const z = zoomRef.current
    if (!svg || !z || nodes.length === 0) return
    const { width, height } = svg.getBoundingClientRect()
    // Si el lienzo aún no tiene tamaño (pestaña oculta, maquetación en curso), se reintenta.
    if (!width || !height) {
      if (attempt < 20) setTimeout(() => fit(nodes, attempt + 1), 100)
      return
    }
    const xs = nodes.map((n) => n.x ?? 0)
    const ys = nodes.map((n) => n.y ?? 0)
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    const pad = 120
    const k = Math.min(1.4, width / (x1 - x0 + pad * 2), height / (y1 - y0 + pad * 2))
    const t = zoomIdentity
      .translate(width / 2, height / 2)
      .scale(k)
      .translate(-(x0 + x1) / 2, -(y0 + y1) / 2)
    select(svg).call(z.transform, t)
  }, [])

  // ── Simulación de fuerzas ───────────────────────────────────
  useEffect(() => {
    const { nodes, links } = visible
    const fresh = nodes.filter((n) => n.x === undefined).length > nodes.length / 2
    const sim = forceSimulation<SimNode>(nodes)
      .force(
        'link',
        forceLink<SimNode, SimLink>(links.map((l) => ({ ...l })))
          .id((d) => d.id)
          .distance((l) => (l.kind === 'edge' ? 130 : 90))
          .strength((l) => (l.kind === 'edge' ? 0.5 : 0.12)),
      )
      .force('charge', forceManyBody<SimNode>().strength(-420))
      .force('collide', forceCollide<SimNode>((d) => d.r + 22))
      .force('x', forceX<SimNode>(0).strength(0.05))
      .force('y', forceY<SimNode>(0).strength(0.05))
      .stop()

    // Se calcula la disposición de golpe para que el grafo aparezca ya ordenado.
    // En un vecindario, la nota enfocada se fija en el centro mientras se ordena el resto.
    const anchor = focus ? nodes.find((n) => n.id === focus) : undefined
    if (anchor) [anchor.fx, anchor.fy] = [0, 0]
    // Con muchos nodos cada iteración cuesta más: se limita el trabajo total para no congelar la pantalla.
    const budget = Math.max(40, Math.round(60000 / Math.max(nodes.length, 1)))
    sim.alpha(fresh ? 1 : 0.7)
    sim.tick(Math.min(fresh ? 300 : 200, budget))
    if (anchor) [anchor.fx, anchor.fy] = [null, null]
    sim.alphaTarget(0)
    save(nodes)
    sim.on('tick', () => {
      save(nodes)
      setTick((t) => t + 1)
    })
    simRef.current = sim
    setTick((t) => t + 1)
    requestAnimationFrame(() => fit(nodes))
    return () => {
      sim.stop()
    }

    function save(ns: SimNode[]) {
      for (const n of ns) positions.current.set(n.id, { x: n.x!, y: n.y! })
    }
  }, [visible, fit]) // `focus` ya forma parte de `visible`

  // Si el lienzo pasa de no tener tamaño a tenerlo (panel que se muestra), se vuelve a encuadrar.
  const nodesRef = useRef(visible.nodes)
  nodesRef.current = visible.nodes
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    let empty = svg.getBoundingClientRect().width === 0
    const observer = new ResizeObserver(([entry]) => {
      const nowEmpty = entry.contentRect.width === 0 || entry.contentRect.height === 0
      if (empty && !nowEmpty) fit(nodesRef.current)
      empty = nowEmpty
    })
    observer.observe(svg)
    return () => observer.disconnect()
  }, [isLoading, fit])

  // Si la nota enfocada desaparece por los filtros, se deselecciona.
  useEffect(() => {
    if (data && selected && !visible.nodes.some((n) => n.id === selected)) setSelected(null)
  }, [data, visible, selected])

  useHotkey('escape', useCallback(() => setSelected(null), []))
  useHotkey('f', useCallback(() => fit(visible.nodes), [fit, visible]))

  // ── Arrastrar nodos ─────────────────────────────────────────
  const toGraph = (e: ReactPointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect()
    return transform.invert([e.clientX - rect.left, e.clientY - rect.top])
  }
  const onNodeDown = (e: ReactPointerEvent, node: SimNode) => {
    e.stopPropagation()
    try {
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    } catch {
      // Sin captura el arrastre sigue funcionando mientras el puntero esté sobre el nodo.
    }
    drag.current = { node, x: e.clientX, y: e.clientY, moved: false }
  }
  const onNodeMove = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d) return
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return
    if (!d.moved) {
      d.moved = true
      simRef.current?.alphaTarget(0.25).restart()
    }
    const [x, y] = toGraph(e)
    d.node.fx = x
    d.node.fy = y
  }
  const onNodeUp = () => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.moved) {
      simRef.current?.alphaTarget(0)
      d.node.fx = null
      d.node.fy = null
    } else {
      setSelected((s) => (s === d.node.id ? null : d.node.id))
    }
  }

  const centerOn = (nodeId: string) => {
    const n = visible.nodes.find((x) => x.id === nodeId)
    const svg = svgRef.current
    if (!n || !svg || !zoomRef.current) return
    select(svg).call(zoomRef.current.translateTo, n.x ?? 0, n.y ?? 0)
    setSelected(nodeId)
  }

  if (isLoading) return <Loading />
  if (!data) return null

  const byId = new Map(visible.nodes.map((n) => [n.id, n]))
  const placed: Placed[] = visible.links.flatMap((l) => {
    const source = byId.get(id(l.source))
    const target = byId.get(id(l.target))
    return source && target ? [{ source, target, kind: l.kind, edge: l.edge }] : []
  })
  const bends = bendsFor(placed)
  const labelsAbove = labelSides(placed)
  // En un vecindario, la nota enfocada ya está en el centro: no hace falta atenuar el resto.
  const active = hovered ?? (selected !== focus ? selected : null)
  const lit = active ? new Set([active, ...(neighbors.get(active) ?? [])]) : null
  const isDim = ({ source: s, target: t }: Placed) => !!lit && !(s.id === active || t.id === active)
  const showAllLabels = visible.nodes.length <= 40 || transform.k >= 1.2
  const focusNode = focus ? data.nodes.find((n) => n.id === focus) : undefined
  const selectedNode = selected ? data.nodes.find((n) => n.id === selected) : undefined

  return (
    <div className="graph-page">
      <svg ref={svgRef} className="graph" onClick={(e) => e.target === e.currentTarget && setSelected(null)}>
        <g transform={transform.toString()}>
          <g>
            {placed.map((p, i) => {
              const { source: s, target: t, kind, edge } = p
              const geo = geometry(s, t, bends[i], kind === 'edge')
              const dim = isDim(p)
              const key = `${s.id}>${t.id}:${edge?.type ?? kind}`
              if (!edge) return <path key={key} d={geo.d} className={`g-ref ${dim ? 'dim' : ''}`} />
              return (
                <g key={key} className={`g-edge r-${edge.type} ${dim ? 'dim' : ''}`}>
                  <path d={geo.d} className="g-line" />
                  <path
                    d={geo.d}
                    className="g-hit"
                    onPointerEnter={(e) => setTooltip({ x: e.clientX, y: e.clientY, edge, from: s.title, to: t.title })}
                    onPointerMove={(e) => setTooltip((tt) => tt && { ...tt, x: e.clientX, y: e.clientY })}
                    onPointerLeave={() => setTooltip(null)}
                  />
                </g>
              )
            })}
          </g>
          <g>
            {visible.nodes.map((n) => {
              const dim = lit && !lit.has(n.id)
              const strong = n.id === active || n.id === focus
              const label = !dim && (showAllLabels || n.degree >= 3 || lit?.has(n.id) || strong)
              return (
                <g
                  key={n.id}
                  className={`g-node n-${n.type} ${dim ? 'dim' : ''} ${strong ? 'active' : ''}`}
                  transform={`translate(${n.x ?? 0},${n.y ?? 0})`}
                  onPointerDown={(e) => onNodeDown(e, n)}
                  onPointerMove={onNodeMove}
                  onPointerUp={onNodeUp}
                  onPointerEnter={() => setHovered(n.id)}
                  onPointerLeave={() => setHovered(null)}
                  onDoubleClick={() => navigate(`/n/${n.id}`)}
                  role="button"
                  aria-label={n.title}
                >
                  <circle r={n.r + 5} className="g-halo" />
                  <circle r={n.r} />
                  {label && (
                    <text y={labelsAbove.has(n.id) ? -(n.r + 8) : n.r + 15} textAnchor="middle">
                      {truncate(n.title, 34)}
                    </text>
                  )}
                </g>
              )
            })}
          </g>
          {/* Las puntas van encima de nodos y etiquetas para que el sentido siempre se vea. */}
          <g className="g-arrows">
            {placed.map((p, i) => {
              if (!p.edge) return null
              const geo = geometry(p.source, p.target, bends[i], true)
              return (
                <polygon
                  key={`${p.source.id}>${p.target.id}:${p.edge.type}`}
                  points={geo.arrow}
                  className={`g-arrow r-${p.edge.type} ${isDim(p) ? 'dim' : ''}`}
                />
              )
            })}
          </g>
        </g>
      </svg>

      <div className="graph-toolbar">
        <GraphSearch nodes={data.nodes} onPick={(n) => (visible.nodes.some((v) => v.id === n.id) ? centerOn(n.id) : setFocus(n.id))} />
        <Popover.Root>
          <Popover.Trigger asChild>
            <button type="button" className="graph-btn" aria-label="Filtros">
              <SlidersHorizontal size={15} />
              <span>Filtros</span>
              {(relations.size < RELATION_TYPES.length || types.size < NOTE_TYPES.length || showRefs) && <span className="graph-dot" />}
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content className="popover graph-filters" align="start" sideOffset={8}>
              <p className="eyebrow">Relaciones</p>
              {RELATION_TYPES.map((r) => (
                <Toggle key={r} on={relations.has(r)} onChange={() => setRelations(toggle(relations, r))}>
                  <RelationLabel type={r} direction="out" />
                </Toggle>
              ))}
              <p className="eyebrow">Tipos</p>
              {NOTE_TYPES.map((t) => (
                <Toggle key={t} on={types.has(t)} onChange={() => setTypes(toggle(types, t))}>
                  <span className="filter-type">
                    <span className={`type-dot n-${t}`} /> {TYPE_LABELS[t].many}
                  </span>
                </Toggle>
              ))}
              <p className="eyebrow">Otros vínculos</p>
              <Toggle on={showRefs} onChange={() => setShowRefs(!showRefs)}>
                <span className="filter-type">Fuentes citadas y notas reunidas</span>
              </Toggle>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        {focusNode && (
          <span className="focus-chip">
            <Locate size={14} />
            <span className="focus-title">Vecindario de {focusNode.title}</span>
            <span className="segmented mini">
              {([1, 2] as const).map((d) => (
                <button key={d} type="button" className={depth === d ? 'selected' : ''} onClick={() => setDepth(d)} title={d === 1 ? 'Solo conexiones directas' : 'Hasta dos pasos de distancia'}>
                  {d}
                </button>
              ))}
            </span>
            <button type="button" className="icon-btn" onClick={() => setFocus(null)} aria-label="Ver todo el grafo" title="Ver todo">
              <X size={14} />
            </button>
          </span>
        )}
      </div>

      {selectedNode && (
        <NodeCard
          node={selectedNode}
          edges={data.edges.filter((e) => e.from === selectedNode.id || e.to === selectedNode.id)}
          titles={new Map(data.nodes.map((n) => [n.id, n.title]))}
          onClose={() => setSelected(null)}
          onFocus={() => setFocus(selectedNode.id)}
          onPick={centerOn}
          focused={focus === selectedNode.id}
        />
      )}

      <div className="graph-legend" aria-hidden>
        <span className="legend-line solid" /> relación
        <span className="legend-line dashed" /> analogía
        {showRefs && (
          <>
            <span className="legend-line dotted" /> fuente o nota reunida
          </>
        )}
        <span className="legend-sep" />
        {visible.nodes.length} nodos · {placed.filter((p) => p.edge).length} conexiones
      </div>

      <div className="graph-zoom">
        <button type="button" className="graph-btn icon" onClick={() => zoomRef.current && select(svgRef.current!).call(zoomRef.current.scaleBy, 1.3)} aria-label="Acercar">
          <Plus size={16} />
        </button>
        <button type="button" className="graph-btn icon" onClick={() => zoomRef.current && select(svgRef.current!).call(zoomRef.current.scaleBy, 1 / 1.3)} aria-label="Alejar">
          <Minus size={16} />
        </button>
        <button type="button" className="graph-btn icon" onClick={() => fit(visible.nodes)} aria-label="Encuadrar (F)" title="Encuadrar (F)">
          <Maximize size={15} />
        </button>
      </div>

      {tooltip && (
        <div className="graph-tooltip" style={{ left: tooltip.x + 14, top: tooltip.y + 14 }}>
          <p className="tt-sentence">
            {tooltip.from} <strong className={`r-${tooltip.edge.type}`}>{RELATION_LABELS[tooltip.edge.type].out.toLowerCase()}</strong> {tooltip.to}
          </p>
          <p className="tt-why">{tooltip.edge.why}</p>
          {tooltip.edge.origin === 'ia' && <p className="tt-limit">Propuesta por la IA y aceptada por ti</p>}
          {tooltip.edge.assumption && (
            <p className="tt-limit">
              <span>Supone</span> {tooltip.edge.assumption}
            </p>
          )}
          {tooltip.edge.limit && (
            <p className="tt-limit">
              <span>Límite</span> {tooltip.edge.limit}
            </p>
          )}
        </div>
      )}

      {data.nodes.length === 0 && (
        <div className="graph-empty">
          <p className="empty-title">El grafo está vacío</p>
          <p className="muted">Crea notas y conéctalas para verlas aquí.</p>
        </div>
      )}
    </div>
  )
}

function NodeCard({
  node,
  edges,
  titles,
  onClose,
  onFocus,
  onPick,
  focused,
}: {
  node: GraphNode
  edges: GraphEdge[]
  titles: Map<string, string>
  onClose: () => void
  onFocus: () => void
  onPick: (id: string) => void
  focused: boolean
}) {
  return (
    <aside className="node-card" aria-label={node.title}>
      <div className="node-card-head">
        <span className="node-card-type">
          <TypeIcon type={node.type} size={14} /> {TYPE_LABELS[node.type].one}
        </span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar">
          <X size={16} />
        </button>
      </div>
      <h2 className="node-card-title">{node.title}</h2>
      {(node.byline || node.excerpt) && <p className="node-card-excerpt">{node.byline ?? node.excerpt}</p>}
      <EpistemicTag value={node.epistemic} />
      <div className="node-card-actions">
        <Link href={`/n/${node.id}`} className="btn btn-primary btn-sm">
          Abrir <ArrowUpRight size={14} />
        </Link>
        {!focused && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onFocus}>
            <Locate size={14} /> Ver vecindario
          </button>
        )}
      </div>
      {edges.length > 0 && (
        <ul className="node-card-edges">
          {edges.map((e) => {
            const out = e.from === node.id
            const other = out ? e.to : e.from
            return (
              <li key={`${e.from}>${e.to}:${e.type}`}>
                <RelationLabel type={e.type} direction={out ? 'out' : 'in'} />
                <button type="button" className="node-card-link" onClick={() => onPick(other)}>
                  {titles.get(other) ?? other}
                </button>
                <p className="node-card-why">{e.why}</p>
              </li>
            )
          })}
        </ul>
      )}
    </aside>
  )
}

function GraphSearch({ nodes, onPick }: { nodes: GraphNode[]; onPick: (n: GraphNode) => void }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const n = normalize(q)
  const results = n ? nodes.filter((x) => normalize(x.title).includes(n)).slice(0, 7) : []
  const pick = (node: GraphNode) => {
    onPick(node)
    setQ('')
    setOpen(false)
  }
  return (
    <div className="graph-search">
      <Search size={15} />
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setOpen(true)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && results[0]) pick(results[0])
          if (e.key === 'Escape') setQ('')
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Buscar en el grafo…"
        aria-label="Buscar en el grafo"
      />
      {open && results.length > 0 && (
        <ul className="graph-search-results">
          {results.map((r) => (
            <li key={r.id}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(r)}>
                <TypeIcon type={r.type} size={14} /> {r.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Toggle({ on, onChange, children }: { on: boolean; onChange: () => void; children: React.ReactNode }) {
  return (
    <label className="toggle-row">
      <input type="checkbox" checked={on} onChange={onChange} />
      {children}
    </label>
  )
}

function toggle<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

const ARROW_LENGTH = 12
const ARROW_WIDTH = 9

/**
 * Trazo de una arista: empieza en el borde del círculo de origen y termina en una punta
 * de flecha que toca el borde del círculo de destino. `bend` curva la línea cuando hay
 * varias conexiones entre el mismo par de notas, para que no se tapen entre sí.
 */
function geometry(s: SimNode, t: SimNode, bend: number, arrow: boolean) {
  const [sx, sy, tx, ty] = [s.x ?? 0, s.y ?? 0, t.x ?? 0, t.y ?? 0]
  const [ux, uy] = unit(tx - sx, ty - sy)
  // Punto de control: el centro del segmento desplazado en perpendicular.
  const cx = (sx + tx) / 2 - uy * bend
  const cy = (sy + ty) / 2 + ux * bend
  const [ax, ay] = unit(cx - sx, cy - sy)
  const [bx, by] = unit(tx - cx, ty - cy)
  const start = [sx + ax * (s.r + 2), sy + ay * (s.r + 2)]
  const tip = [tx - bx * (t.r + 2), ty - by * (t.r + 2)]
  const end = arrow ? [tip[0] - bx * (ARROW_LENGTH - 1), tip[1] - by * (ARROW_LENGTH - 1)] : tip
  const base = [tip[0] - bx * ARROW_LENGTH, tip[1] - by * ARROW_LENGTH]
  const [px, py] = [-by * (ARROW_WIDTH / 2), bx * (ARROW_WIDTH / 2)]
  return {
    d: bend ? `M${start[0]},${start[1]} Q${cx},${cy} ${end[0]},${end[1]}` : `M${start[0]},${start[1]} L${end[0]},${end[1]}`,
    arrow: `${tip[0]},${tip[1]} ${base[0] + px},${base[1] + py} ${base[0] - px},${base[1] - py}`,
  }
}

/** Curvatura de cada arista: 0 si es la única entre dos notas; repartida a ambos lados si hay varias. */
function bendsFor(placed: Placed[]): number[] {
  const groups = new Map<string, number[]>()
  placed.forEach((p, i) => {
    const key = [p.source.id, p.target.id].sort().join('|')
    groups.set(key, [...(groups.get(key) ?? []), i])
  })
  const bends = placed.map(() => 0)
  for (const indexes of groups.values()) {
    if (indexes.length < 2) continue
    indexes.forEach((i, k) => {
      const offset = (k - (indexes.length - 1) / 2) * 28
      // La perpendicular cambia de lado con el sentido; se normaliza respecto a un sentido canónico.
      const canonical = placed[i].source.id < placed[i].target.id
      bends[i] = canonical ? offset : -offset
    })
  }
  return bends
}

/** Nodos cuya etiqueta va arriba: la mayoría de sus aristas llegan desde abajo y la taparían. */
function labelSides(placed: Placed[]): Set<string> {
  const pull = new Map<string, { below: number; total: number }>()
  const add = (from: SimNode, to: SimNode) => {
    const p = pull.get(from.id) ?? { below: 0, total: 0 }
    p.total++
    if (unit((to.x ?? 0) - (from.x ?? 0), (to.y ?? 0) - (from.y ?? 0))[1] > 0.35) p.below++
    pull.set(from.id, p)
  }
  for (const { source, target } of placed) {
    add(source, target)
    add(target, source)
  }
  return new Set([...pull].filter(([, p]) => p.below > p.total / 2).map(([id]) => id))
}

function unit(dx: number, dy: number): [number, number] {
  const d = Math.hypot(dx, dy) || 1
  return [dx / d, dy / d]
}

const id = (end: string | SimNode) => (typeof end === 'string' ? end : end.id)

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
