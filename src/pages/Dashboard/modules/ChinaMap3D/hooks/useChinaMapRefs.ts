import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import * as echarts from 'echarts';
import { CameraPose, PendingCameraControl, LabelVisibilityMode, PanelData, PanelStyle } from '../types';

export function useChinaMapRefs() {
    const containerRef = useRef<HTMLDivElement>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const controlsRef = useRef<OrbitControls | null>(null);
    const mapGroupRef = useRef<THREE.Group | null>(null);
    const meshMapRef = useRef<Record<string, THREE.Group>>({});
    const cityStatusRef = useRef<Map<string, number>>(new Map());
    const cityAnimFramesRef = useRef<Map<string, number>>(new Map());
    const flyAnimFramesRef = useRef<Map<string, number>>(new Map());
    const flyTimeoutsRef = useRef<Map<string, number>>(new Map());
    const flyRemovalTimeoutsRef = useRef<Map<string, number>>(new Map());
    const flyLinesRef = useRef<Map<string, THREE.Group>>(new Map());
    const flyStartTimesRef = useRef<Map<string, number>>(new Map());
    const pendingFlyRemovalRef = useRef<Set<string>>(new Set());
    const activeRouteCoordsRef = useRef<Map<string, [[number, number], [number, number]]>>(new Map());
    const renderFrameRef = useRef<number>(0);
    const lastLabelRefreshRef = useRef(0);
    const lastCameraStateRef = useRef('');
    // 初始加载阶段地图和相机还没稳定，先按“移动中”处理，避免标签/面板第一帧全量闪现。
    const isCameraMovingRef = useRef(true);
    const labelRevealTimeoutRef = useRef<number | null>(null);
    const cameraMoveFrameRef = useRef<number>(0);
    const cameraFocusTimeoutRef = useRef<number | null>(null);
    const pendingRaisedCitiesRef = useRef<Set<string>>(new Set(['佛山']));
    const initialCameraPoseRef = useRef<CameraPose | null>(null);
    const firstCameraControlRef = useRef(true);
    const pendingCameraControlRef = useRef<PendingCameraControl | null>(null);
    const lastCameraControlRef = useRef<{ key: string; time: number }>({ key: '', time: 0 });
    const labelVisibilityRef = useRef<LabelVisibilityMode>({ mode: 'all' });
    const warehouseTourTimeoutRef = useRef<number | null>(null);
    const warehouseTourRunRef = useRef(0);
    const cityPanelMapRef = useRef<Map<string, HTMLDivElement>>(new Map());
    const cityPanelDataRef = useRef<Map<string, PanelData[]>>(new Map());
    const cityPanelStyleRef = useRef<Map<string, PanelStyle>>(new Map());
    const cityPanelChartsRef = useRef<Map<string, echarts.ECharts[]>>(new Map());
    const pendingCityPanelsRef = useRef<Map<string, PanelData[]>>(new Map());
    const pendingCityPanelStylesRef = useRef<Map<string, PanelStyle>>(new Map());
    const showCityPanelsRef = useRef<(cityName: string, panels: PanelData[], style?: PanelStyle) => void>(() => {});
    const labelRendererRef = useRef<CSS2DRenderer | null>(null);
    const cityLabelMapRef = useRef<Map<string, CSS2DObject>>(new Map());
    const pendingCityDataRef = useRef<Map<string, Record<string, any> | null>>(new Map());
    const tooltipRef = useRef<HTMLDivElement | null>(null);
    const mouseRef = useRef(new THREE.Vector2());
    const raycasterRef = useRef(new THREE.Raycaster());
    const hoveredCityRef = useRef<THREE.Group | null>(null);

    return useMemo(() => ({
        containerRef, sceneRef, rendererRef, cameraRef, controlsRef, mapGroupRef,
        meshMapRef, cityStatusRef, cityAnimFramesRef, flyAnimFramesRef, flyTimeoutsRef,
        flyRemovalTimeoutsRef, flyLinesRef, flyStartTimesRef, pendingFlyRemovalRef,
        activeRouteCoordsRef, renderFrameRef, lastLabelRefreshRef, lastCameraStateRef,
        isCameraMovingRef, labelRevealTimeoutRef, cameraMoveFrameRef, cameraFocusTimeoutRef,
        pendingRaisedCitiesRef, initialCameraPoseRef, firstCameraControlRef,
        pendingCameraControlRef, lastCameraControlRef, labelVisibilityRef,
        warehouseTourTimeoutRef, warehouseTourRunRef, cityPanelMapRef, cityPanelDataRef,
        cityPanelStyleRef, cityPanelChartsRef, pendingCityPanelsRef,
        pendingCityPanelStylesRef, showCityPanelsRef,
        labelRendererRef, cityLabelMapRef, pendingCityDataRef,
        tooltipRef, mouseRef, raycasterRef, hoveredCityRef,
    }), []);
}
