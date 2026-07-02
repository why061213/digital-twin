import * as THREE from 'three';
export type PanelData = {
    id: string;
    title: string;
    chartType: 'table' | 'bar' | 'line' | 'pie' | 'ring';
    height?: number;
    columns?: Array<{ key: string; label: string }>;
    rows?: Array<Record<string, any>>;
    option?: any;
};
export type PanelStyle = {
    width?: number;
    maxHeight?: number;
    padding?: number;
    titleFontSize?: number;
    bodyFontSize?: number;
    chartTextFontSize?: number;
    placement?: string;
    theme?: string;
};
export type ChinaMap3DHandle = {
    riseCity: (cityName: string) => void;
    fallCity: (cityName: string) => void;
    flyToCity: (cityName: string) => void;
    addFlyLine: (lineId: string, fromCoords: [number, number], toCoords: [number, number]) => void;
    removeFlyLine: (lineId: string) => void;
    updateCityData: (cityName: string, data: Record<string, any> | null) => void;
    focusOnCities: (cityNames: string[], mode: CameraFocusMode) => void;
    isReady: () => boolean;
    startWarehouseTour: () => void;
    showCityPanels: (cityName: string, panels: PanelData[], style?: PanelStyle) => void;
    cacheCityPanels: (cityName: string, panels: PanelData[], style?: PanelStyle) => void;
    showCachedCityPanels: (cityName: string) => boolean;
    clearCityPanels: (cityName: string) => void;
};
export type CameraFocusMode = 'overview' | 'focus';
export type CameraPose = { position: THREE.Vector3; target: THREE.Vector3 };
export type PendingCameraControl = { cityNames: string[]; mode: CameraFocusMode };
export type LabelVisibilityMode = { mode: 'all' | 'focus'; focusedKey?: string };
export type LabelLayout = { x: number; y: number; align: 'left' | 'right'; startOffset: [number, number] };
export type MarkedWarehouse = { name: string; group: THREE.Group; anchor: THREE.Vector3; screen: THREE.Vector2; data: Record<string, any> };
export type ScreenRect = { left: number; top: number; right: number; bottom: number };
export type PanelAttachSide =
    | 'left'
    | 'right'
    | 'top'
    | 'bottom'
    | 'left-top'
    | 'left-bottom'
    | 'right-top'
    | 'right-bottom';
export type PanelPlacement = { x: number; y: number; align: 'left' | 'right'; startOffset: [number, number]; attachSide: PanelAttachSide; direction: THREE.Vector2 };
