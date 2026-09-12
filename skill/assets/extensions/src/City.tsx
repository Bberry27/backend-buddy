import React, { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Html, OrbitControls } from '@react-three/drei';
import { Box, ChevronDown, ChevronUp, Focus, Map as MapIcon, RotateCcw, RotateCw, ZoomIn, ZoomOut } from 'lucide-react';
import * as THREE from 'three';
import type { SchemaGraph, LiveConnection } from './types';
import { CITY_HEIGHT_BASES, CITY_LABEL_DENSITIES, cityHeightAdvice, cityLabelled, cityTableLabel, layoutCity, placeCityLabels, type CityBuilding, type CityHeightBasis, type CityLabelDensity, type CityLayout, type CityLabelPlacement } from './city-layout';
import { CITY_LIGHT_COLORS, ROAD_COLORS, SEMANTIC_COLORS } from './palettes';
import { useTheme } from './theme';
import './City.css';

interface CityProps { graph: SchemaGraph; onSelectTable: (id: string) => void; live?: LiveConnection }
interface BoundaryProps { children: React.ReactNode; onFailure: () => void }
class CityBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onFailure(); }
  render() { return this.state.failed ? null : this.props.children; }
}

interface CameraRequests { zoomRequest: number; orbitRequest: number; tiltRequest: number; panRequest: { x: number; y: number } }

function CameraRig({ layout, reset, zoomRequest, orbitRequest, tiltRequest, panRequest, onFailure }:
  CameraRequests & { layout: CityLayout; reset: number; onFailure: () => void }) {
  const { camera, size, gl, invalidate } = useThree();
  const controls = useRef<React.ComponentRef<typeof OrbitControls>>(null);
  const lastZoom = useRef(zoomRequest);
  const lastOrbit = useRef(orbitRequest);
  const lastTilt = useRef(tiltRequest);
  const lastPan = useRef(panRequest);
  useLayoutEffect(() => {
    const difference = zoomRequest - lastZoom.current;
    lastZoom.current = zoomRequest;
    if (!difference || !controls.current) return;
    const target = controls.current.target;
    const offset = camera.position.clone().sub(target);
    const distance = Math.max(controls.current.minDistance, Math.min(controls.current.maxDistance, offset.length() * 0.7 ** difference));
    camera.position.copy(target).add(offset.setLength(distance));
    controls.current.update(); invalidate();
  }, [camera, invalidate, zoomRequest]);
  useLayoutEffect(() => {
    // Turning and tilting move the camera around the same target OrbitControls orbits, so a button
    // press and a right-drag are the same gesture and cannot disagree about where the city is.
    const turn = orbitRequest - lastOrbit.current; lastOrbit.current = orbitRequest;
    const tilt = tiltRequest - lastTilt.current; lastTilt.current = tiltRequest;
    if ((!turn && !tilt) || !controls.current) return;
    const target = controls.current.target;
    const spherical = new THREE.Spherical().setFromVector3(camera.position.clone().sub(target));
    spherical.theta += turn * Math.PI / 12;
    // Clamp against the control's own ceiling so no press puts the camera under the ground plane.
    spherical.phi = Math.max(0.08, Math.min(controls.current.maxPolarAngle, spherical.phi + tilt * Math.PI / 24));
    camera.position.copy(target).add(new THREE.Vector3().setFromSpherical(spherical));
    controls.current.update(); invalidate();
  }, [camera, invalidate, orbitRequest, tiltRequest]);
  useLayoutEffect(() => {
    const dx = panRequest.x - lastPan.current.x, dy = panRequest.y - lastPan.current.y;
    lastPan.current = panRequest;
    if ((!dx && !dy) || !controls.current) return;
    const target = controls.current.target;
    // One step is a fifth of the frustum height at the target, so a keyboard pan covers the same
    // share of the screen whether the camera is fitted to the city or pushed in on one building.
    const fov = THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov);
    const step = camera.position.distanceTo(target) * Math.tan(fov / 2) * 0.2;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0).multiplyScalar(dx * step);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1).multiplyScalar(-dy * step);
    const move = right.add(up);
    camera.position.add(move); target.add(move);
    controls.current.update(); invalidate();
  }, [camera, invalidate, panRequest]);
  useLayoutEffect(() => {
    const perspective = camera as THREE.PerspectiveCamera;
    const center = new THREE.Vector3(layout.width / 2, layout.maxHeight / 2, layout.depth / 2);
    const radius = Math.hypot(layout.width, layout.depth, layout.maxHeight) / 2 + 2;
    const fov = THREE.MathUtils.degToRad(perspective.fov);
    const verticalTangent = Math.tan(fov / 2);
    const horizontalTangent = verticalTangent * size.width / Math.max(1, size.height);
    const direction = new THREE.Vector3(0.8, 1.1, 1).normalize();
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), direction).normalize();
    const up = new THREE.Vector3().crossVectors(direction, right);
    let distance = 1;
    // Fit all corners against both camera axes, including portrait viewports.
    for (const x of [-2, layout.width + 2]) for (const y of [-0.2, layout.maxHeight + 0.2])
      for (const z of [-2, layout.depth + 2]) {
        const offset = new THREE.Vector3(x, y, z).sub(center);
        distance = Math.max(distance, offset.dot(direction) + Math.max(
          Math.abs(offset.dot(right)) / horizontalTangent,
          Math.abs(offset.dot(up)) / verticalTangent));
      }
    distance *= 1.12;
    perspective.position.copy(center).addScaledVector(direction, distance);
    perspective.near = Math.max(0.05, distance / 10000);
    perspective.far = distance * 12;
    perspective.updateProjectionMatrix();
    perspective.lookAt(center);
    if (controls.current) {
      controls.current.target.copy(center);
      controls.current.minDistance = Math.max(2, radius * 0.1);
      controls.current.maxDistance = distance * 3;
      controls.current.update();
    }
    invalidate();
  }, [camera, invalidate, layout, reset, size.width, size.height]);
  useEffect(() => {
    const canvas = gl.domElement;
    const lost = (event: Event) => { event.preventDefault(); onFailure(); };
    canvas.addEventListener('webglcontextlost', lost);
    return () => canvas.removeEventListener('webglcontextlost', lost);
  }, [gl, onFailure]);
  return <OrbitControls ref={controls} domElement={gl.domElement.parentElement || gl.domElement}
    makeDefault enableDamping={false} enablePan screenSpacePanning
    mouseButtons={{ LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }}
    touches={{ ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE }}
    maxPolarAngle={Math.PI / 2 - 0.04} />;
}

function LabelGroups({ labels, onSelect, onHover }: { labels: CityLabelPlacement[]; onSelect: (id: string) => void; onHover: (building: CityBuilding | null) => void }) {
  return <>{labels.map(label => <g key={label.building.id} className="schema-city-name"
    data-table-id={label.building.id} data-member-count={label.members.length}
    role="button" tabIndex={0} aria-label={`Inspect ${label.members.map(building => building.table.name || building.id).join(', ')}`}
    onPointerEnter={() => onHover(label.building)} onPointerLeave={() => onHover(null)}
    onFocus={() => onHover(label.building)} onBlur={() => onHover(null)}
    onClick={event => { event.stopPropagation(); onSelect(label.building.id); }}
    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(label.building.id); } }}>
    <title>{label.members.map(building => cityTableLabel(building.table)).join('\n')}</title>
    <line x1={label.x} y1={label.y} x2={Math.max(label.left, Math.min(label.left + label.width, label.x))}
      y2={Math.max(label.top, Math.min(label.top + label.height, label.y))} stroke={label.building.color} />
    <rect x={label.left} y={label.top} width={label.width} height={label.height} rx="3"
      className={label.priority ? 'schema-city-name-priority' : undefined} />
    <text x={label.left + 6} y={label.top + 13}>
      {label.lines.map((line, index) => <tspan key={index} x={label.left + 6} dy={index ? 14 : 0}>{line}</tspan>)}
    </text>
    {label.building.rowCount === null && <text x={label.left + label.width - 28} y={label.top + 13}
      className="schema-city-unprofiled-mark">?</text>}
    {label.members.length > 1 && <text x={label.left + label.width - 5} y={label.top + 13} textAnchor="end" className="schema-city-name-count">+{label.members.length - 1}</text>}
  </g>)}</>;
}

function BuildingNames({ layout, priorityId, labelled, onSelect, onHover }: { layout: CityLayout; priorityId: string | null; labelled: ReadonlySet<string>; onSelect: (id: string) => void; onHover: (building: CityBuilding | null) => void }) {
  const { camera, size, invalidate, gl } = useThree();
  const portal = useMemo(() => ({ current: gl.domElement.parentElement! }), [gl]);
  const [labels, setLabels] = useState<CityLabelPlacement[]>([]);
  const lastProjection = useRef('');
  useLayoutEffect(() => { lastProjection.current = ''; invalidate(); }, [layout, priorityId, labelled, invalidate]);
  useFrame(() => {
    camera.updateMatrixWorld();
    const signature = `${camera.matrixWorld.elements.join(',')}|${camera.projectionMatrix.elements.join(',')}|${size.width},${size.height}`;
    if (signature === lastProjection.current) return;
    lastProjection.current = signature;
    const anchors = layout.buildings.flatMap(building => {
      if (!labelled.has(building.id)) return [];
      const roof = new THREE.Vector3(building.x, building.height + 0.1, building.z).project(camera);
      if (roof.z < -1 || roof.z > 1) return [];
      const edge = new THREE.Vector3(building.x + building.width / 2, building.height + 0.1, building.z).project(camera);
      return [{ building, x: (roof.x + 1) * size.width / 2, y: (1 - roof.y) * size.height / 2,
        projectedWidth: Math.hypot((roof.x - edge.x) * size.width, (roof.y - edge.y) * size.height), priority: priorityId === building.id }];
    });
    setLabels(placeCityLabels(anchors, size.width, size.height));
  });
  return <Html portal={portal} fullscreen calculatePosition={(_, __, viewport) => [viewport.width / 2, viewport.height / 2]}
    zIndexRange={[2, 1]} style={{ pointerEvents: 'none' }}>
    <svg className="schema-city-names" width={size.width} height={size.height} aria-label="Persistent table names">
      <LabelGroups labels={labels} onSelect={onSelect} onHover={onHover} />
    </svg>
  </Html>;
}

/**
 * A box outline around one building.
 *
 * The city is a single InstancedMesh, so a selected instance cannot be styled on its own; this is
 * a separate object sized to it. `depthTest` is off so the outline stays visible when the building
 * is behind a taller neighbour, which is exactly when a user has lost track of what they picked,
 * and a translucent face tint carries the selection at a distance where a one-pixel line cannot.
 */
function BuildingOutline({ building, color, strong }: {
  building: CityBuilding; color: string; strong: boolean;
}) {
  const edges = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), []);
  useEffect(() => () => edges.dispose(), [edges]);
  // Slightly proud of the building so the outline does not fight its own faces for the same pixels.
  const scale: [number, number, number] = [building.width * 1.03, building.height * 1.03 + 0.05,
    building.depth * 1.03];
  const position: [number, number, number] = [building.x, building.height / 2 + 0.08, building.z];
  return <group position={position} scale={scale} renderOrder={10}>
    <lineSegments>
      <primitive object={edges} attach="geometry" />
      <lineBasicMaterial color={color} depthTest={false} transparent opacity={strong ? 1 : 0.6} />
    </lineSegments>
    <mesh>
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial color={color} transparent opacity={strong ? 0.22 : 0.1}
        depthWrite={false} />
    </mesh>
  </group>;
}

function Buildings({ layout, onHover, onSelect }: {
  layout: CityLayout; onHover: (building: CityBuilding | null) => void; onSelect: (id: string) => void;
}) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    if (!mesh.current) return;
    const transform = new THREE.Object3D();
    layout.buildings.forEach((building, index) => {
      transform.position.set(building.x, building.height / 2 + 0.08, building.z);
      transform.scale.set(building.width, building.height, building.depth);
      transform.updateMatrix();
      mesh.current!.setMatrixAt(index, transform.matrix);
      mesh.current!.setColorAt(index, new THREE.Color(building.color));
    });
    mesh.current.instanceMatrix.needsUpdate = true;
    if (mesh.current.instanceColor) mesh.current.instanceColor.needsUpdate = true;
    mesh.current.computeBoundingSphere();
  }, [layout]);
  const hit = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    if (event.instanceId !== undefined) onHover(layout.buildings[event.instanceId]);
  };
  return <instancedMesh ref={mesh} args={[undefined, undefined, layout.buildings.length]}
    onPointerOver={hit} onPointerMove={hit} onPointerOut={() => onHover(null)}
    onClick={event => {
      event.stopPropagation();
      if (event.delta <= 4 && event.instanceId !== undefined) onSelect(layout.buildings[event.instanceId].id);
    }}>
    <boxGeometry args={[1, 1, 1]} /><meshStandardMaterial roughness={0.78} metalness={0.04} />
  </instancedMesh>;
}

function Roads({ layout }: { layout: CityLayout }) {
  // three.js needs a resolved colour: an instanced mesh cannot read a custom property.
  const roads = ROAD_COLORS[useTheme()];
  const mesh = useRef<THREE.InstancedMesh>(null);
  const segments = useMemo(() => layout.roads.flatMap(road => road.points.slice(1).map((to, i) => ({
    from: road.points[i], to, road,
  }))), [layout]);
  useLayoutEffect(() => {
    if (!mesh.current) return;
    const transform = new THREE.Object3D();
    segments.forEach(({ from, to, road }, index) => {
      transform.position.set((from[0] + to[0]) / 2, 0.06, (from[1] + to[1]) / 2);
      transform.scale.set(Math.abs(to[0] - from[0]) || road.width, 0.04, Math.abs(to[1] - from[1]) || road.width);
      transform.updateMatrix();
      mesh.current!.setMatrixAt(index, transform.matrix);
      mesh.current!.setColorAt(index, new THREE.Color(road.crossDistrict ? roads.cross : road.inferred ? roads.inferred : roads.declared));
    });
    mesh.current.instanceMatrix.needsUpdate = true;
    if (mesh.current.instanceColor) mesh.current.instanceColor.needsUpdate = true;
    mesh.current.computeBoundingSphere();
  }, [segments, roads]);
  if (!segments.length) return null;
  return <instancedMesh ref={mesh} args={[undefined, undefined, segments.length]} raycast={() => {}}>
    <boxGeometry args={[1, 1, 1]} /><meshBasicMaterial />
  </instancedMesh>;
}

function FlatCity({ layout, onHover, onSelect, priorityId, labelled, reset, zoomRequest }: {
  layout: CityLayout; onHover: (building: CityBuilding | null) => void; onSelect: (id: string) => void;
  priorityId: string | null; labelled: ReadonlySet<string>; reset: number; zoomRequest: number;
}) {
  const roads = ROAD_COLORS[useTheme()];
  const svg = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 600, height: 400 });
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const lastZoom = useRef(zoomRequest);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  useLayoutEffect(() => {
    const element = svg.current!;
    const measure = () => { const box = element.getBoundingClientRect(); setSize({ width: box.width, height: box.height }); };
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { setView({ zoom: 1, x: 0, y: 0 }); }, [layout, reset]);
  useEffect(() => {
    const delta = zoomRequest - lastZoom.current; lastZoom.current = zoomRequest;
    if (delta) setView(previous => { const zoom = Math.max(0.5, Math.min(32, previous.zoom * (1 / 0.7) ** delta));
      return { zoom, x: previous.x * zoom / previous.zoom, y: previous.y * zoom / previous.zoom }; });
  }, [zoomRequest]);
  useEffect(() => {
    const element = svg.current!;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = element.getBoundingClientRect(), px = event.clientX - box.left - box.width / 2, py = event.clientY - box.top - box.height / 2;
      setView(previous => { const zoom = Math.max(0.5, Math.min(32, previous.zoom * Math.exp(-event.deltaY * 0.002)));
        const ratio = zoom / previous.zoom; return { zoom, x: px - (px - previous.x) * ratio, y: py - (py - previous.y) * ratio }; });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);
  const scale = Math.min(size.width / (layout.width + 4), size.height / (layout.depth + 4)) * view.zoom;
  const project = (building: CityBuilding) => ({ x: size.width / 2 + view.x + (building.x - layout.width / 2) * scale,
    y: size.height / 2 + view.y + (building.z - layout.depth / 2) * scale });
  const labels = placeCityLabels(layout.buildings.filter(building => labelled.has(building.id))
    .map(building => ({ building, ...project(building),
      projectedWidth: building.width * scale, priority: priorityId === building.id })), size.width, size.height);
  return <svg ref={svg} className="schema-city-flat" viewBox={`0 0 ${size.width} ${size.height}`}
    role="group" aria-label="Schema City flat map" onPointerDownCapture={event => {
      if (event.pointerType !== 'touch' && event.button !== 0) return;
      drag.current = { x: event.clientX, y: event.clientY, moved: false };
    }} onPointerMove={event => {
      if (!drag.current || (!event.buttons && event.pointerType !== 'touch')) return;
      const dx = event.clientX - drag.current.x, dy = event.clientY - drag.current.y;
      if (!drag.current.moved && Math.hypot(dx, dy) < 4) return;
      drag.current = { x: event.clientX, y: event.clientY, moved: true };
      svg.current?.setPointerCapture(event.pointerId);
      setView(previous => ({ ...previous, x: previous.x + dx, y: previous.y + dy }));
    }} onClickCapture={event => { if (drag.current?.moved) { event.preventDefault(); event.stopPropagation(); } drag.current = null; }}
    onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
    <g transform={`translate(${size.width / 2 + view.x},${size.height / 2 + view.y}) scale(${scale}) translate(${-layout.width / 2},${-layout.depth / 2})`}>
    {layout.districts.map(d => <g key={d.id}>
      <rect x={d.x} y={d.z} width={d.width} height={d.depth} fill={d.color} fillOpacity="0.1" stroke={d.color} strokeOpacity="0.55" strokeWidth="0.15" />
    </g>)}
    <g fill="none" strokeLinejoin="round" aria-hidden="true">{layout.roads.map(road =>
      <path key={road.id} d={road.points.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ')}
        stroke={road.crossDistrict ? roads.cross : road.inferred ? roads.inferred : roads.declared}
        strokeWidth={road.width} strokeDasharray={road.inferred ? '0.5 0.4' : undefined} />)}</g>
    {layout.buildings.map(building => <g key={building.id} role="button" tabIndex={0}
      className="schema-city-target" aria-label={`${cityTableLabel(building.table)} · ${building.domain}`}
      onFocus={() => {
        onHover(building);
        const point = project(building);
        if (point.x < 20 || point.y < 20 || point.x > size.width - 20 || point.y > size.height - 20)
          setView(previous => ({ ...previous, x: -(building.x - layout.width / 2) * scale, y: -(building.z - layout.depth / 2) * scale }));
      }} onBlur={() => onHover(null)}
      onPointerEnter={() => onHover(building)} onPointerLeave={() => onHover(null)}
      onClick={() => onSelect(building.id)} onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(building.id); }
      }}>
      <title>{cityTableLabel(building.table)}</title>
      <rect x={building.x - building.width / 2} y={building.z - building.depth / 2}
        width={building.width} height={building.depth}
        fill={building.color} strokeWidth="0.18" strokeDasharray={building.rowCount === null ? '0.35 0.2' : undefined} />
    </g>)}
    </g>
    <g className="schema-city-names" aria-label="Persistent table names"><LabelGroups labels={labels} onSelect={onSelect} onHover={onHover} /></g>
  </svg>;
}

export default function City({ graph, onSelectTable }: CityProps) {
  // Scene lighting is a material input, so it comes from the palette rather than a CSS variable.
  const theme = useTheme();
  const cityLight = CITY_LIGHT_COLORS[theme];
  // three.js materials take a colour, not a custom property, which is what palettes.ts exists for.
  const citySelection = SEMANTIC_COLORS[theme].selection;
  const [basis, setBasis] = useState<CityHeightBasis>('rows');
  const [density, setDensity] = useState<CityLabelDensity>('prominent');
  const layout = useMemo(() => layoutCity(graph, basis), [graph, basis]);
  const [mode, setMode] = useState<'3d' | 'flat'>('3d');
  const [failed, setFailed] = useState(false);
  const [webglReady, setWebglReady] = useState(false);
  const [reset, setReset] = useState(0);
  const [zoomRequest, setZoomRequest] = useState(0);
  const [orbitRequest, setOrbitRequest] = useState(0);
  const [tiltRequest, setTiltRequest] = useState(0);
  const [panRequest, setPanRequest] = useState({ x: 0, y: 0 });
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<CityBuilding | null>(null);
  const scene = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = scene.current!;
    let gesture: { x: number; y: number; moved: boolean } | null = null;
    const down = (event: PointerEvent) => { gesture = { x: event.clientX, y: event.clientY, moved: false }; };
    const move = (event: PointerEvent) => {
      if (gesture && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 4) gesture.moved = true;
    };
    // Native capture covers both the R3F root and the separate Html label root.
    const click = (event: MouseEvent) => {
      if (event.detail !== 0 && gesture?.moved) { event.preventDefault(); event.stopImmediatePropagation(); }
      gesture = null;
    };
    element.addEventListener('pointerdown', down, true);
    element.addEventListener('pointermove', move, true);
    element.addEventListener('click', click, true);
    return () => {
      element.removeEventListener('pointerdown', down, true);
      element.removeEventListener('pointermove', move, true);
      element.removeEventListener('click', click, true);
    };
  }, []);
  const selectTable = useCallback((id: string) => { setSelected(id); onSelectTable(id); }, [onSelectTable]);
  const onCameraKey = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    // Buildings and their labels are buttons inside this element. Only drive the camera when the
    // scene itself holds focus, so Enter and the arrows still belong to whatever the user tabbed to.
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
    const turn = event.shiftKey;
    const step = (setter: React.Dispatch<React.SetStateAction<number>>, delta: number) => setter(value => value + delta);
    switch (event.key) {
      case 'ArrowLeft': turn ? step(setOrbitRequest, -1) : setPanRequest(p => ({ ...p, x: p.x - 1 })); break;
      case 'ArrowRight': turn ? step(setOrbitRequest, 1) : setPanRequest(p => ({ ...p, x: p.x + 1 })); break;
      case 'ArrowUp': turn ? step(setTiltRequest, -1) : setPanRequest(p => ({ ...p, y: p.y - 1 })); break;
      case 'ArrowDown': turn ? step(setTiltRequest, 1) : setPanRequest(p => ({ ...p, y: p.y + 1 })); break;
      case '+': case '=': step(setZoomRequest, 1); break;
      case '-': case '_': step(setZoomRequest, -1); break;
      case '0': setReset(value => value + 1); setHovered(null); break;
      default: return;
    }
    event.preventDefault();
  }, []);
  const onFailure = useCallback(() => { setFailed(true); setMode('flat'); setHovered(null); }, []);
  useEffect(() => {
    // R3F initializes its renderer asynchronously, outside React's error boundary.
    // Probe once so unavailable WebGL never leaves the Canvas stuck blank.
    try {
      const probe = document.createElement('canvas').getContext('webgl2', { failIfMajorPerformanceCaveat: false });
      if (!probe) { onFailure(); return; }
      probe.getExtension('WEBGL_lose_context')?.loseContext();
      setWebglReady(true);
    } catch { onFailure(); }
  }, [onFailure]);
  useEffect(() => { setHovered(null); setSelected(null); }, [layout]);
  const flat = mode === 'flat' || failed;
  const unprofiled = layout.buildings.filter(building => building.rowCount === null).length;
  const basisInfo = CITY_HEIGHT_BASES.find(option => option.id === layout.basis) || CITY_HEIGHT_BASES[0];
  const densityInfo = CITY_LABEL_DENSITIES.find(option => option.id === density) || CITY_LABEL_DENSITIES[0];
  // Whatever the pointer or the selection is on always keeps its name, so hiding the rest costs
  // no information: the answer is a hover away.
  const keep = useMemo(() => new Set([selected, hovered?.id].filter((id): id is string => !!id)),
    [selected, hovered]);
  const labelled = useMemo(() => cityLabelled(layout.buildings, density, keep),
    [layout, density, keep]);
  const selectedBuilding = useMemo(() => layout.buildings.find(building => building.id === selected) || null,
    [layout, selected]);
  // Said where the flatness is, because the legend key alone did not carry it.
  const advice = cityHeightAdvice(layout);
  return <section className="schema-city" aria-label="Schema City">
    <div className="schema-city-toolbar">
      <div className="schema-city-summary"><strong>Schema City</strong><span>{layout.buildings.length} tables · {unprofiled} unprofiled</span></div>
      <label className="schema-city-basis">Height
        <select value={basis} onChange={event => setBasis(event.target.value as CityHeightBasis)}
          title={basisInfo.title}>
          {CITY_HEIGHT_BASES.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      </label>
      <label className="schema-city-basis">Labels
        <select value={density} onChange={event => setDensity(event.target.value as CityLabelDensity)}
          title={densityInfo.title}>
          {CITY_LABEL_DENSITIES.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      </label>
      <div className="schema-city-controls" role="group" aria-label="City view">
        <button type="button" title="3D city" aria-label="3D city" aria-pressed={!flat} disabled={failed}
          onClick={() => { setMode('3d'); setHovered(null); }}><Box size={17} /></button>
        <button type="button" title="Flat map" aria-label="Flat map" aria-pressed={flat}
          onClick={() => { setMode('flat'); setHovered(null); }}><MapIcon size={17} /></button>
        <button type="button" title="Turn left" aria-label="Turn left" disabled={flat}
          onClick={() => setOrbitRequest(value => value - 1)}><RotateCcw size={17} /></button>
        <button type="button" title="Turn right" aria-label="Turn right" disabled={flat}
          onClick={() => setOrbitRequest(value => value + 1)}><RotateCw size={17} /></button>
        <button type="button" title="Tilt up" aria-label="Tilt up" disabled={flat}
          onClick={() => setTiltRequest(value => value - 1)}><ChevronUp size={17} /></button>
        <button type="button" title="Tilt down" aria-label="Tilt down" disabled={flat}
          onClick={() => setTiltRequest(value => value + 1)}><ChevronDown size={17} /></button>
        <button type="button" title="Zoom in" aria-label="Zoom in" onClick={() => setZoomRequest(value => value + 1)}><ZoomIn size={17} /></button>
        <button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => setZoomRequest(value => value - 1)}><ZoomOut size={17} /></button>
        <button type="button" title="Fit city" aria-label="Fit city" onClick={() => { setReset(value => value + 1); setHovered(null); }}><Focus size={17} /></button>
      </div>
    </div>
    <div ref={scene} className={`schema-city-scene${hovered ? ' schema-city-hovering' : ''}`}
      onContextMenu={event => event.preventDefault()} tabIndex={0}
      aria-label="Schema City camera. Arrow keys pan, shift with the arrow keys turns and tilts, plus and minus zoom, 0 fits the city."
      onKeyDown={onCameraKey}>
      {!layout.buildings.length ? <div className="schema-city-empty">No tables in this schema.</div> : flat ?
        <FlatCity layout={layout} onHover={setHovered} onSelect={selectTable} priorityId={selected}
          labelled={labelled} reset={reset} zoomRequest={zoomRequest} /> :
        !webglReady ? <div className="schema-city-empty" role="status">Starting city...</div> : <CityBoundary onFailure={onFailure}>
          <Canvas frameloop="demand" dpr={[1, 1.5]} camera={{ fov: 42 }}
            gl={{ antialias: true, alpha: true, powerPreference: 'default', failIfMajorPerformanceCaveat: false }}
            aria-label="Interactive 3D schema city">
            <ambientLight intensity={1.4} /><directionalLight position={[30, 70, 20]} intensity={2.2} />
            <hemisphereLight args={[cityLight.sky, cityLight.ground, 0.8]} />
            <CameraRig layout={layout} reset={reset} zoomRequest={zoomRequest} orbitRequest={orbitRequest}
              tiltRequest={tiltRequest} panRequest={panRequest} onFailure={onFailure} />
            {layout.districts.map(d => <mesh key={d.id} position={[d.x + d.width / 2, -0.08, d.z + d.depth / 2]}>
              <boxGeometry args={[d.width, 0.16, d.depth]} />
              <meshStandardMaterial color={d.color} transparent opacity={0.22} roughness={1} depthWrite={false} />
            </mesh>)}
            <Roads layout={layout} /><Buildings layout={layout} onHover={setHovered} onSelect={selectTable} />
            {hovered && hovered.id !== selected &&
              <BuildingOutline building={hovered} color={citySelection} strong={false} />}
            {selectedBuilding && <BuildingOutline building={selectedBuilding} color={citySelection} strong />}
            <BuildingNames layout={layout} priorityId={selected} labelled={labelled}
              onSelect={selectTable} onHover={setHovered} />
          </Canvas>
        </CityBoundary>}
      {advice && <p className="schema-city-advice" role="status">{advice}</p>}
      {hovered && <div className="schema-city-tooltip" role="status">
        <strong>{hovered.table.name || hovered.id}</strong><span>{hovered.domain}</span>
        <span>{hovered.rowCount === null ? 'Unprofiled · row count unknown' : `${hovered.rowCount.toLocaleString()} rows`} · {hovered.table.allColumns.length} columns</span>
      </div>}
    </div>
    <div className="schema-city-legend" aria-label="City legend">
      {failed && <span className="schema-city-failure" role="status">WebGL unavailable · Flat map active</span>}
      <span title={basisInfo.title}>{basisInfo.legend}</span>
      {layout.basis === 'rows' && <span><b className="schema-city-unprofiled-mark">?</b> Unprofiled: baseline height</span>}
      {!flat && <span className="schema-city-hint">Drag to pan · Right-drag to turn · Scroll to zoom</span>}
      <span title={densityInfo.title}>Labels: {densityInfo.label.toLowerCase()}</span>
      <span title="Nearby names are grouped when their labels would overlap. The full list is in each label's tooltip.">+N nearby tables</span>
      {layout.districts.map(d => <span key={d.id} title={d.id}><i style={{ background: d.color }} />{d.id}</span>)}
      <span><i className="schema-city-road-key" />Cross-domain FK</span>
      <span title="Road width uses the child/parent row-count ratio when both counts are known. It is a volume proxy, not measured relationship cardinality.">Road width: row ratio</span>
    </div>
  </section>;
}
