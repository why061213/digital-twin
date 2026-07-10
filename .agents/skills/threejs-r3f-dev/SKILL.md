---
name: threejs-r3f-dev
description: Three.js and React Three Fiber development guide for 3D data visualization, map rendering, animation orchestration, and performance optimization. Use when working with Three.js, @react-three/fiber, @react-three/drei, 3D scenes, shaders, camera controls, or any 3D rendering issues in this project.
---

# Three.js / R3F Development Skill

Best practices and reference for Three.js + React Three Fiber development in this monorepo.

## Project Tech Stack

- **Three.js** (v0.160+) via `@react-three/fiber` (R3F) and `@react-three/drei`
- **TypeScript** throughout
- **d3-geo** for map projections
- **ECharts** for 2D charts (KPI cards, bar/pie)
- **Vite** bundler

## Core Patterns

### R3F Component Structure

```tsx
import { Canvas } from '@react-three/fiber'
import { OrbitControls, MapControls } from '@react-three/drei'

function Scene() {
  return (
    <Canvas camera={{ position: [0, 0, 5], fov: 45 }}>
      <ambientLight intensity={0.5} />
      <SceneContent />
    </Canvas>
  )
}
```

### Map Projection (d3-geo → Three.js)

```ts
import { geoMercator } from 'd3-geo'

export const projection = geoMercator()
  .center([104, 35])
  .scale(100)
  .translate([0, 0])

// Convert geo coords to 3D positions
export function to3D(lng: number, lat: number): [number, number] {
  const [x, y] = projection([lng, lat])!
  return [x, -y] // Flip Y for Three.js
}
```

### Extruded GeoJSON Regions

```tsx
function ProvinceMesh({ geoJson, color }: { geoJson: any; color: string }) {
  const shape = useMemo(() => {
    const s = new THREE.Shape()
    const ring = geoJson.coordinates[0]
    ring.forEach(([lng, lat], i) => {
      const [x, y] = to3D(lng, lat)
      if (i === 0) s.moveTo(-x, -y)
      else s.lineTo(-x, -y)
    })
    return s
  }, [geoJson])

  return (
    <mesh rotation={[Math.PI / 2, 0, 0]}>
      <extrudeGeometry args={[shape, { depth: 0.5, bevelEnabled: false }]} />
      <meshStandardMaterial color={color} side={THREE.DoubleSide} />
    </mesh>
  )
}
```

### Fly Lines / Curved Paths

```tsx
function FlyLine({ from, to, color }: { from: [number, number]; to: [number, number]; color: string }) {
  const points = useMemo(() => {
    const [fx, fy] = to3D(from[0], from[1])
    const [tx, ty] = to3D(to[0], to[1])
    const mid = new THREE.Vector3((fx + tx) / 2, (fy + ty) / 2, 2) // Arc height
    const curve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(fx, fy, 0),
      mid,
      new THREE.Vector3(tx, ty, 0)
    )
    return curve.getPoints(50)
  }, [from, to])

  return (
    <line>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[new Float32Array(points.flatMap(p => [p.x, p.y, p.z])), 3]} />
      </bufferGeometry>
      <lineBasicMaterial color={color} />
    </line>
  )
}
```

### CSS2D Labels

```tsx
import { Html } from '@react-three/drei'

function CityLabel({ name, position }: { name: string; position: [number, number, number] }) {
  return (
    <Html position={position} center style={{ pointerEvents: 'none' }}>
      <div style={{ color: '#fff', fontSize: 12, textShadow: '0 0 4px #000' }}>
        {name}
      </div>
    </Html>
  )
}
```

## Performance Checklist

- [ ] Use `useMemo` for geometries, shapes, and materials
- [ ] Use `instancedMesh` for repeated objects (>50 instances)
- [ ] Limit draw calls: merge same-material meshes
- [ ] Set `frustumCulled = true` on off-screen objects
- [ ] Use `renderer.setPixelRatio(Math.min(devicePixelRatio, 2))`
- [ ] Dispose geometries/materials on unmount with `useEffect` cleanup
- [ ] Avoid `new THREE.Vector3()` in render loops — reuse objects
- [ ] For animations: use `useFrame` with `clock.getDelta()` not `Date.now()`

## Animation Orchestration

When building multi-stage animations:

```tsx
type AnimationStage = {
  id: string
  kind: 'focus' | 'highlight' | 'fly' | 'transition'
  duration: number // ms
  onStart: () => void
  onComplete: () => void
}

function useAnimationQueue(stages: AnimationStage[]) {
  const [current, setCurrent] = useState(0)

  useEffect(() => {
    if (current >= stages.length) return
    const stage = stages[current]
    stage.onStart()
    const timer = setTimeout(() => {
      stage.onComplete()
      setCurrent(prev => prev + 1)
    }, stage.duration)
    return () => clearTimeout(timer)
  }, [current])

  return { currentStage: stages[current], advance: () => setCurrent(p => p + 1) }
}
```

## Camera Controls

```tsx
// For map-like pan/zoom (top-down)
<MapControls
  enableRotate={false}
  maxPolarAngle={Math.PI / 3}
  minDistance={5}
  maxDistance={50}
/>

// For free orbit
<OrbitControls
  enableDamping
  dampingFactor={0.1}
  minDistance={3}
  maxDistance={30}
  maxPolarAngle={Math.PI / 2}
/>
```

## Common Issues

| Problem | Solution |
|---------|----------|
| GeoJSON coordinates flipped | Use `[x, -y]` in projection |
| Mesh not visible | Check rotation: `rotation.x = Math.PI / 2` for top-down |
| Memory leak | `geometry.dispose()` + `material.dispose()` in cleanup |
| Z-fighting | Adjust `polygonOffset` or `depthTest` |
| Slow with many objects | Use `InstancedMesh` or merge geometries |
| CSS2D labels disappear | They're DOM elements, check `pointerEvents` and z-index |

## Color Palette for 3D Maps

```ts
const MAP_COLORS = {
  province: '#1e293b',      // Dark blue-gray
  city: '#334155',          // Medium gray
  district: '#475569',       // Light gray
  highlight: '#38bdf8',      // Cyan
  selected: '#f59e0b',       // Amber
  route: '#a78bfa',          // Purple
  edge: '#22d3ee',           // Teal
  background: '#0f172a',     // Very dark blue
}
```

## Dependencies Versions (this project)

```json
{
  "three": "^0.160",
  "@react-three/fiber": "^8.x",
  "@react-three/drei": "^9.x",
  "d3-geo": "^3.x",
  "echarts": "^5.x"
}
```
