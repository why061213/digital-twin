import { useRef } from 'react';
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
    const renderFrameRef = useRef<number>(0);
    const raycasterRef = useRef(new THREE.Raycaster());
    const pointerRef = useRef(new THREE.Vector2());
    const selectedRoadIdRef = useRef<string | null>(null);

    return {
        containerRef,
        sceneRef,
        cameraRef,
        rendererRef,
        controlsRef,
        roadsMapRef,
        renderFrameRef,
        raycasterRef,
        pointerRef,
        selectedRoadIdRef,
    };
}