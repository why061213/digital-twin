---
name: dashboard-panels
description: Dashboard panel design, data visualization styling, animation orchestration, and UI layout patterns for the digital twin platform. Use when designing dashboard panels, KPI cards, chart styling, CSS animations, layout components, or any visual/interaction design for the dashboard.
---

# Dashboard Panel & Animation Design

Design patterns and best practices for the digital twin dashboard platform.

## Tech Stack

- **React 18+** with TypeScript
- **ECharts** for chart visualizations
- **CSS Modules** / Inline styles for panel layouts
- **Three.js / R3F** for 3D map scenes
- **WebSocket** for real-time data push

## Panel Design Patterns

### Glass-morphism Panel

```css
.dashboard-panel {
  background: rgba(15, 23, 42, 0.85);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(56, 189, 248, 0.15);
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3);
}
```

### KPI Card (Digital Flop)

```tsx
function KpiCard({ label, value, unit, trend, icon }: KpiCardProps) {
  return (
    <div className="kpi-card">
      <div className="kpi-icon">{icon}</div>
      <div className="kpi-body">
        <span className="kpi-label">{label}</span>
        <span className="kpi-value">
          <DigitalFlop value={value} />
          <small>{unit}</small>
        </span>
        {trend && <TrendBadge direction={trend} />}
      </div>
    </div>
  )
}
```

### Panel Layout Grid

```css
.dashboard-grid {
  display: grid;
  grid-template-columns: 280px 1fr 280px;
  grid-template-rows: auto 1fr auto;
  height: 100vh;
  gap: 12px;
  padding: 12px;
}

/* 3D map takes center */
.map-container {
  grid-column: 2;
  grid-row: 1 / -1;
}

/* Side panels */
.side-panel-left {
  grid-column: 1;
  grid-row: 1 / -1;
}

.side-panel-right {
  grid-column: 3;
  grid-row: 1 / -1;
}
```

## ECharts Styling (Dark Theme)

```ts
const DARK_CHART_THEME = {
  backgroundColor: 'transparent',
  textStyle: { color: '#94a3b8' },
  grid: {
    left: 50, right: 20, top: 30, bottom: 30,
    borderColor: 'rgba(56, 189, 248, 0.1)',
  },
  xAxis: {
    axisLine: { lineStyle: { color: '#334155' } },
    axisLabel: { color: '#64748b', fontSize: 11 },
    splitLine: { show: false },
  },
  yAxis: {
    axisLine: { show: false },
    axisLabel: { color: '#64748b', fontSize: 11 },
    splitLine: { lineStyle: { color: 'rgba(51, 65, 85, 0.5)' } },
  },
  series: [
    {
      type: 'line',
      smooth: true,
      symbol: 'none',
      lineStyle: { width: 2 },
      areaStyle: {
        color: {
          type: 'linear',
          x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: 'rgba(56, 189, 248, 0.3)' },
            { offset: 1, color: 'rgba(56, 189, 248, 0)' },
          ],
        },
      },
    },
  ],
}
```

## Color Palette

```ts
const BRAND_COLORS = {
  // Primary
  primary: '#38bdf8',     // Cyan
  secondary: '#a78bfa',   // Purple
  accent: '#f59e0b',      // Amber

  // Status
  success: '#22c55e',
  warning: '#f59e0b',
  danger: '#ef4444',
  info: '#38bdf8',

  // Background tiers
  bgDeep: '#0f172a',      // Deepest
  bgPanel: '#1e293b',     // Panel bg
  bgCard: '#334155',      // Card bg
  bgHover: '#475569',     // Hover state

  // Text
  textPrimary: '#f1f5f9',
  textSecondary: '#94a3b8',
  textMuted: '#64748b',

  // Borders
  border: 'rgba(56, 189, 248, 0.15)',
  borderActive: 'rgba(56, 189, 248, 0.4)',
}
```

## Animation Design

### CSS Transition Presets

```css
/* Smooth panel entrance */
.panel-enter {
  animation: fadeSlideIn 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}
@keyframes fadeSlideIn {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* Pulse glow (for active indicators) */
.pulse-glow {
  animation: pulseGlow 2s ease-in-out infinite;
}
@keyframes pulseGlow {
  0%, 100% { box-shadow: 0 0 4px rgba(56, 189, 248, 0.3); }
  50%      { box-shadow: 0 0 16px rgba(56, 189, 248, 0.6); }
}

/* Counter roll-up */
.counter-roll {
  transition: all 0.6s cubic-bezier(0.16, 1, 0.3, 1);
}
```

### Animation Orchestration

```ts
// Sequential stagger animation for panels
function useStaggerAnimation(count: number, delay = 100) {
  return Array.from({ length: count }, (_, i) => ({
    style: {
      animationDelay: `${i * delay}ms`,
      animationFillMode: 'both' as const,
    },
    className: 'panel-enter',
  }))
}

// Route highlight sequencing
type RouteAnimation = {
  id: string
  duration: number
  delay: number
  easing: string
}
```

### 3D Transition Flow

```
Scene boot
  → Province focus (zoom + highlight)
    → Route group highlight (fly lines glow)
      → Candidate path pulse
        → Edge traverse animation
          → Order batch show
            → Return to province focus
```

## Responsive Breakpoints

```css
/* 1920x1080 (standard dashboard) */
@media (min-width: 1920px) { ... }

/* 1366x768 (laptop) */
@media (max-width: 1366px) { ... }

/* Full HD wall */
@media (min-width: 3840px) { ... }
```

## Common Patterns

### Data Counter with Trend

```tsx
function DataCounter({ value, prevValue, label }: Props) {
  const diff = value - prevValue
  const pct = prevValue ? ((diff / prevValue) * 100).toFixed(1) : 0
  return (
    <div className="data-counter">
      <span className="value">{formatNumber(value)}</span>
      <span className={`trend ${diff >= 0 ? 'up' : 'down'}`}>
        {diff >= 0 ? '↑' : '↓'} {Math.abs(Number(pct))}%
      </span>
      <span className="label">{label}</span>
    </div>
  )
}
```

### View Mode Transitions

```ts
type ViewMode = 'chinaMap' | 'roadMap' | 'townRoadMap' | 'warehouse'

const VIEW_TRANSITION_CONFIG: Record<ViewMode, {
  camera: [number, number, number]
  target: [number, number, number]
  duration: number
}> = {
  chinaMap:    { camera: [0, 0, 18], target: [0, 0, 0], duration: 1500 },
  roadMap:     { camera: [0, -5, 10], target: [0, 0, 0], duration: 1200 },
  townRoadMap: { camera: [0, -3, 6],  target: [0, 0, 0], duration: 1000 },
  warehouse:   { camera: [3, 2, 5],    target: [0, 0, 1], duration: 800 },
}
```

## Font & Typography

```css
.dashboard {
  font-family: 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif;
  -webkit-font-smoothing: antialiased;
}

.kpi-value {
  font-size: 28px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.5px;
}

.panel-title {
  font-size: 14px;
  font-weight: 600;
  color: #f1f5f9;
  letter-spacing: 0.5px;
}
```

## Icons (using simple SVG or Unicode)

Prefer lightweight inline SVGs over icon libraries to reduce bundle size.
For simple indicators, use Unicode symbols: ● ○ ◆ ◇ ▲ ▼ ▶ ⏸ ■ □
