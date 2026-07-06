import { useRef, useMemo } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { RoadState } from '../types';

export function useRoadMapRefs() {
    const containerRef = useRef<HTMLDivElement>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const controlsRef = useRef<OrbitControls | null>(null);
    const roadsMapRef = useRef<Map<string, RoadState>>(new Map());
    const lineTrackMapRef = useRef<Map<string, string>>(new Map());
    const manualMarkersRef = useRef<Map<string, THREE.Group>>(new Map());
    const renderFrameRef = useRef<number>(0);
    const raycasterRef = useRef(new THREE.Raycaster());
    const pointerRef = useRef(new THREE.Vector2());
    const selectedRoadIdRef = useRef<string | null>(null);
    const cameraMoveFrameRef = useRef<number>(0);
    const cameraFocusTimeoutRef = useRef<number | null>(null);

    return useMemo(() => ({
        containerRef,
        sceneRef,
        cameraRef,
        rendererRef,
        controlsRef,
        roadsMapRef,
        lineTrackMapRef,
        manualMarkersRef,
        renderFrameRef,
        raycasterRef,
        pointerRef,
        selectedRoadIdRef,
        cameraMoveFrameRef,
        cameraFocusTimeoutRef,
    }), []);
}
