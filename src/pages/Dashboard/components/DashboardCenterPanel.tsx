import type { RefObject } from 'react';
import Warehouse3D from '../modules/Warehouse3D';
import ChinaMap3D from '../modules/ChinaMap3D';
import type { ChinaMap3DHandle } from '../modules/ChinaMap3D';
import RoadMap3D from '../modules/RoadMap3D';
import type { RoadMap3DHandle } from '../modules/RoadMap3D';
import TownRoadMap3D from '../modules/TownRoadMap3D';
import type { TownRoadMap3DHandle } from '../modules/TownRoadMap3D';
import type { ViewMode } from '../types';
import { MAP_VIEW_TRANSITION_MS, ROAD_GROUP_TRANSITION_MS } from '../constants';

type DashboardCenterPanelProps = {
    view: ViewMode;
    isPreparingChinaMap: boolean;
    isRevealingChinaMap: boolean;
    isPreparingRoadMap: boolean;
    isRevealingRoadMap: boolean;
    isRoadGroupFading: boolean;
    chinaMapSession: number;
    roadMapSession: number;
    mapRef: RefObject<ChinaMap3DHandle | null>;
    roadMapRef: RefObject<RoadMap3DHandle | null>;
    townRoadMapRef?: RefObject<TownRoadMap3DHandle | null>;
    onChinaMapVisualReady: () => void;
    onRoadMapVisualReady: () => void;
    onTownRoadMapVisualReady?: () => void;
    onWarehouseTourStateChange: (state: {
        mode: 'overview' | 'focus';
        cityName?: string;
        displayData?: Record<string, any>;
    }) => void;
};

export function DashboardCenterPanel({
    view,
    isPreparingChinaMap,
    isRevealingChinaMap,
    isPreparingRoadMap,
    isRevealingRoadMap,
    isRoadGroupFading,
    chinaMapSession,
    roadMapSession,
    mapRef,
    roadMapRef,
    townRoadMapRef,
    onChinaMapVisualReady,
    onRoadMapVisualReady,
    onTownRoadMapVisualReady,
    onWarehouseTourStateChange,
}: DashboardCenterPanelProps) {
    const showChinaMapLayer = view === 'chinaMap' || isPreparingChinaMap || isRevealingChinaMap;
    const isChinaMapLeaving = view === 'chinaMap' && isRevealingRoadMap;
    const isChinaMapVisible = (view === 'chinaMap' && !isChinaMapLeaving) || isRevealingChinaMap;

    const showRoadMapLayer = view === 'roadMap' || isPreparingRoadMap || isRevealingRoadMap;
    const isRoadMapLeaving = view === 'roadMap' && isRevealingChinaMap;
    const isRoadGroupTransition = view === 'roadMap' && !isPreparingRoadMap && !isRevealingRoadMap;
    const isRoadMapVisible = ((view === 'roadMap' && !isRoadMapLeaving) || isRevealingRoadMap) && !isRoadGroupFading;
    const roadMapTransitionMs = isRoadGroupTransition ? ROAD_GROUP_TRANSITION_MS : MAP_VIEW_TRANSITION_MS;

    return (
        <>
            {view === 'warehouse' && (
                <div className="absolute inset-0">
                    <Warehouse3D key="warehouse" />
                </div>
            )}

            {view === 'townRoadMap' && townRoadMapRef && (
                <div className="absolute inset-0 z-10">
                    <TownRoadMap3D ref={townRoadMapRef} onVisualReady={onTownRoadMapVisualReady} />
                </div>
            )}

            {showRoadMapLayer && (
                <div
                    className={`absolute inset-0 transition-opacity ${
                        isRoadMapVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
                    } ${isPreparingRoadMap || isRevealingRoadMap ? 'z-20' : 'z-10'}`}
                    style={{
                        transitionDuration: `${roadMapTransitionMs}ms`,
                        transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
                    }}
                >
                    <RoadMap3D
                        key={`roadMap-${roadMapSession}`}
                        ref={roadMapRef}
                        onVisualReady={onRoadMapVisualReady}
                    />
                </div>
            )}

            {showChinaMapLayer && (
                <div
                    className={`absolute inset-0 transition-opacity ${
                        isChinaMapVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
                    } ${isPreparingChinaMap || isRevealingChinaMap ? 'z-20' : 'z-10'}`}
                    style={{
                        transitionDuration: `${MAP_VIEW_TRANSITION_MS}ms`,
                        transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
                    }}
                >
                    <ChinaMap3D
                        key={`chinaMap-${chinaMapSession}`}
                        ref={mapRef}
                        onVisualReady={onChinaMapVisualReady}
                        onTourStateChange={onWarehouseTourStateChange}
                    />
                </div>
            )}
        </>
    );
}
