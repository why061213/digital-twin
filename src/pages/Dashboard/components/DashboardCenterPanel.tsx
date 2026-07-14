import type { RefObject } from 'react';
import Warehouse3D from '../modules/Warehouse3D';
import ChinaMap3D from '../modules/ChinaMap3D';
import type { ChinaMap3DHandle } from '../modules/ChinaMap3D';
import RoadMap3D1 from '../modules/RoadMap3D-1';
import type { RoadMap3DHandle as RoadMap3D1Handle } from '../modules/RoadMap3D-1';
import RoadMap3D2 from '../modules/RoadMap3D-2';
import type { RoadMap3DHandle as RoadMap3D2Handle } from '../modules/RoadMap3D-2';
import type { ViewMode } from '../types';

type DashboardCenterPanelProps = {
    view: ViewMode;
    mapRef: RefObject<ChinaMap3DHandle | null>;
    roadMapRef: RefObject<RoadMap3D1Handle | null>;
    roadMap2Ref: RefObject<RoadMap3D2Handle | null>;
    onChinaMapVisualReady: () => void;
    onRoadMapVisualReady: () => void;
    onRoadMap2VisualReady: () => void;
    onWarehouseTourStateChange: (state: {
        mode: 'overview' | 'focus';
        cityName?: string;
        displayData?: Record<string, any>;
    }) => void;
};

export function DashboardCenterPanel({
    view,
    mapRef,
    roadMapRef,
    roadMap2Ref,
    onChinaMapVisualReady,
    onRoadMapVisualReady,
    onRoadMap2VisualReady,
    onWarehouseTourStateChange,
}: DashboardCenterPanelProps) {
    // 只挂载当前活动场景：卸载会触发各自的 Three.js cleanup，避免 RAF/Timer/WebGL 累积。
    if (view === 'warehouse') {
        return <div className="absolute inset-0"><Warehouse3D /></div>;
    }
    if (view === 'chinaMap') {
        return (
            <div className="absolute inset-0">
                <ChinaMap3D
                    ref={mapRef}
                    onVisualReady={onChinaMapVisualReady}
                    onTourStateChange={onWarehouseTourStateChange}
                />
            </div>
        );
    }
    if (view === 'roadMap2') {
        return <div className="absolute inset-0"><RoadMap3D2 ref={roadMap2Ref} onVisualReady={onRoadMap2VisualReady} /></div>;
    }
    return <div className="absolute inset-0"><RoadMap3D1 ref={roadMapRef} onVisualReady={onRoadMapVisualReady} /></div>;
}
