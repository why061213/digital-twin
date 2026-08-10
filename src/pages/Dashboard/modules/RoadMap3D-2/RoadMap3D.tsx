import {forwardRef, useCallback, useEffect, useImperativeHandle} from 'react';
import type { RoadMap3DHandle } from './types';
import { useRoadMapRefs } from './hooks/useRoadMapRefs';
import { useRoadControls } from './hooks/useRoadControls';
import { useRoadSelection } from './hooks/useRoadSelection';
import { useRoadMapScene } from './hooks/useRoadMapScene';

type RoadMap3DProps = {
    onVisualReady?: () => void;
};

const RoadMap3D = forwardRef<RoadMap3DHandle, RoadMap3DProps>(({ onVisualReady }, ref) => {
    const refs = useRoadMapRefs();
    const controls = useRoadControls(refs);
    const selection = useRoadSelection(refs);

    const mapScene = useRoadMapScene(refs, controls, selection, onVisualReady);

    const clearRoads = useCallback(() => {
        controls.clearRoads();
        selection.clearSelection();
    }, [controls.clearRoads, selection.clearSelection]);

    useImperativeHandle(ref, () => ({
        setRoadPath: controls.setRoadPath,
        addRoadPath: controls.addRoadPath,
        removeRoadPath: controls.removeRoadPath,
        clearRoads,
        setRoadsOpacity: controls.setRoadsOpacity,
        preloadProvinceRegion: mapScene.preloadProvinceRegion,
        setProvinceRegion: mapScene.setProvinceRegion,
        clearProvinceRegion: mapScene.clearProvinceRegion,
        preloadDirectionRegions: mapScene.preloadDirectionRegions,
        setDirectionRegions: mapScene.setDirectionRegions,
        clearDirectionRegions: mapScene.clearDirectionRegions,
        updateTruckPosition: controls.updateTruckPosition,
        setHighlightedVehicle: controls.setHighlightedVehicle,
        refreshAllPositions: controls.refreshAllPositions,
    }), [
        controls.setRoadPath,
        controls.addRoadPath,
        controls.removeRoadPath,
        clearRoads,
        controls.setRoadsOpacity,
        mapScene.preloadProvinceRegion,
        mapScene.setProvinceRegion,
        mapScene.clearProvinceRegion,
        mapScene.preloadDirectionRegions,
        mapScene.setDirectionRegions,
        mapScene.clearDirectionRegions,
        controls.updateTruckPosition,
        controls.setHighlightedVehicle,
        controls.refreshAllPositions,
    ]);

    useEffect(() => {
        console.log('RoadMap3D mounted');

        return () => {
            console.log('RoadMap3D unmounted');
        };
    }, []);

    return (
        <div ref={refs.containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
            <div className="pointer-events-none absolute left-3 top-3 z-40 flex flex-wrap gap-2 rounded-md border border-white/10 bg-slate-950/85 px-3 py-2 text-[11px] text-slate-200 backdrop-blur-md">
                <span><i className="mr-1.5 inline-block h-2 w-5 rounded bg-cyan-400" />普通路线</span>
                <span><i className="mr-1.5 inline-block h-2 w-5 rounded bg-amber-500" />分支路线</span>
                <span><i className="mr-1.5 inline-block h-2 w-5 rounded bg-purple-500" />重叠路线</span>
                <span><i className="mr-1.5 inline-block h-2 w-5 rounded bg-rose-500" />分支且重叠</span>
                <span><i className="mr-1.5 inline-block h-2 w-5 rounded bg-slate-500" />计划基线</span>
            </div>
            {selection.hoverInfo && (
                <div
                    className="pointer-events-none absolute z-50 w-64 -translate-x-1/2 -translate-y-full rounded-md border border-cyan-300/35 bg-slate-950/92 px-3 py-2.5 text-xs text-slate-100 shadow-2xl shadow-cyan-950/40 backdrop-blur-md"
                    style={{
                        left: Math.min(Math.max(132, selection.hoverInfo.x), Math.max(132, (refs.containerRef.current?.clientWidth ?? 264) - 132)),
                        top: Math.min(Math.max(116, selection.hoverInfo.y - 18), Math.max(116, (refs.containerRef.current?.clientHeight ?? 180) - 12)),
                    }}
                >
                    <div className="mb-2 flex items-start justify-between gap-3 border-b border-white/10 pb-2">
                        <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-cyan-100">{selection.hoverInfo.title}</div>
                            <div className="mt-0.5 truncate text-[11px] text-slate-400" title={selection.hoverInfo.subtitle}>
                                {selection.hoverInfo.subtitle}
                            </div>
                        </div>
                        <span className="shrink-0 rounded border border-emerald-300/25 bg-emerald-400/10 px-1.5 py-0.5 text-[10px] text-emerald-200">
                            {selection.hoverInfo.status}
                        </span>
                    </div>
                    <div className="space-y-1.5">
                        {selection.hoverInfo.rows.map(([label, value]) => (
                            <div key={label} className="grid grid-cols-[4.5rem_1fr] gap-2">
                                <span className="text-slate-400">{label}</span>
                                <span className="truncate text-right text-slate-100" title={value}>
                                    {value}
                                </span>
                            </div>
                        ))}
                    </div>
                    <div className="absolute left-1/2 top-full h-4 w-px -translate-x-1/2 bg-cyan-300/45" />
                    <div className="absolute left-1/2 top-[calc(100%+1rem)] h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-cyan-200 shadow-[0_0_12px_rgba(125,211,252,0.8)]" />
                </div>
            )}
        </div>
    );
});

export default RoadMap3D;
export type { RoadMap3DHandle };
