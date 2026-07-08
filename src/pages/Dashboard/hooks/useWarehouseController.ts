import { useCallback, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { ChinaMap3DHandle } from '../modules/ChinaMap3D';
import type { WarehouseFocusState } from '../modules/DashboardSidePanels';
import type { WarehouseFocusPanel, WarehouseFocusStyle } from './useDashboardRealtime';
import { fetchWarehouseFocus, pushWarehouseSnapshot } from '../services/warehouseApi';
import { waitFrame } from '../utils';

type WarehouseTourState = {
    mode: 'overview' | 'focus';
    cityName?: string;
    displayData?: Record<string, any>;
};

type WarehouseSnapshotPrepareHandlers = {
    isCurrentPrepareRun: () => boolean;
    onDataReady: () => void;
    onPrepareFailed: () => void;
};

type UseWarehouseControllerOptions = {
    mapRef: RefObject<ChinaMap3DHandle | null>;
};


function stableRecordKey(data: Record<string, any>) {
    return Object.keys(data)
        .sort()
        .map((key) => `${key}:${JSON.stringify(data[key])}`)
        .join('|');
}

type UseWarehouseControllerResult = {
    warehouseFocus: WarehouseFocusState | null;
    clearWarehouseFocus: () => void;
    handleCityRaise: (cityName: string) => void;
    handleCityFall: (cityName: string) => void;
    handleWarehouseUpdate: (cityName: string, action: string, displayData: Record<string, any>) => void;
    handleWarehouseTourStateChange: (state: WarehouseTourState) => void;
    handleCameraControl: (cityNames: string[], mode: string) => void;
    handleWarehouseFocus: (cityName: string, panels: WarehouseFocusPanel[], style?: WarehouseFocusStyle) => void;
    requestWarehouseSnapshot: (handlers: WarehouseSnapshotPrepareHandlers) => Promise<void>;
};

export function useWarehouseController({
    mapRef,
}: UseWarehouseControllerOptions): UseWarehouseControllerResult {
    const [warehouseFocus, setWarehouseFocus] = useState<WarehouseFocusState | null>(null);
    const warehouseDisplayDataRef = useRef<Map<string, Record<string, any>>>(new Map());
    const warehouseFocusKeyRef = useRef('');

    const clearWarehouseFocus = useCallback(() => {
        warehouseFocusKeyRef.current = '';
        setWarehouseFocus(null);
    }, []);

    const handleCityRaise = useCallback((cityName: string) => {
        mapRef.current?.riseCity(cityName);
    }, [mapRef]);

    const handleCityFall = useCallback((cityName: string) => {
        mapRef.current?.fallCity(cityName);
    }, [mapRef]);

    const handleWarehouseUpdate = useCallback((cityName: string, action: string, displayData: Record<string, any>) => {
        if (action !== 'fall') {
            console.log('🏗️ 处理仓库更新:', cityName, action, displayData);
            warehouseDisplayDataRef.current.set(cityName, displayData ?? {});
            mapRef.current?.riseCity(cityName);
            mapRef.current?.updateCityData(cityName, displayData);
        } else {
            warehouseDisplayDataRef.current.delete(cityName);
            mapRef.current?.fallCity(cityName);
            mapRef.current?.updateCityData(cityName, null);
        }
    }, [mapRef]);

    const handleWarehouseTourStateChange = useCallback((state: WarehouseTourState) => {
        if (state.mode !== 'focus' || !state.cityName) {
            if (warehouseFocusKeyRef.current !== '') {
                warehouseFocusKeyRef.current = '';
                setWarehouseFocus(null);
            }
            return;
        }

        const displayData = state.displayData ?? warehouseDisplayDataRef.current.get(state.cityName) ?? {};
        const nextKey = `${state.cityName}:${stableRecordKey(displayData)}`;
        if (warehouseFocusKeyRef.current === nextKey) {
            return;
        }

        warehouseFocusKeyRef.current = nextKey;
        setWarehouseFocus({
            cityName: state.cityName,
            displayData,
        });
    }, []);

    const handleCameraControl = useCallback((cityNames: string[], mode: string) => {
        // 仓库地图进入时使用前端本地巡航流程；后端 camera_control 先保留接入点，避免打断巡航。
        void cityNames;
        void mode;
    }, []);

    const handleWarehouseFocus = useCallback((cityName: string, panels: WarehouseFocusPanel[], style?: WarehouseFocusStyle) => {
        mapRef.current?.showCityPanels(cityName, panels, style);
    }, [mapRef]);

    const waitForChinaMapReady = useCallback(async () => {
        const startedAt = performance.now();
        while (!mapRef.current?.isReady()) {
            if (performance.now() - startedAt > 2500) return false;
            await waitFrame();
        }
        await waitFrame();
        return true;
    }, [mapRef]);

    const requestWarehouseSnapshot = useCallback(async ({
        isCurrentPrepareRun,
        onDataReady,
        onPrepareFailed,
    }: WarehouseSnapshotPrepareHandlers) => {
        try {
            // 1. 推送仓库快照，让所有城市升起
            const messages = await pushWarehouseSnapshot();
            messages.forEach((message) => {
                handleWarehouseUpdate(message.cityName, message.action, message.displayData);
            });

            const foshanName = '佛山市';
            const uniqueCities = Array.from(new Set([
                foshanName,
                ...messages.map((message) => message.cityName),
            ]));

            uniqueCities.forEach((city) => {
                fetchWarehouseFocus(city)
                    .then((focusMessage) => {
                        const targetCity = focusMessage.cityName || city;
                        const panels = focusMessage.panels ?? [];
                        mapRef.current?.cacheCityPanels(targetCity, panels, focusMessage.style);
                    })
                    .catch(err => console.warn(`${city} 面板预加载失败`, err));
            });

            // 到这里说明 ChinaMap3D 已经挂载、仓库快照已经进入地图；再等 Three mesh 就绪后释放旧视图。
            await waitForChinaMapReady();
            if (!isCurrentPrepareRun()) return;

            // 先在隐藏状态下启动巡游，避开 Three 首帧/巡游起步阶段可能出现的黑底。
            window.requestAnimationFrame(() => {
                mapRef.current?.startWarehouseTour();
            });
            onDataReady();
        } catch (error) {
            console.warn('Warehouse snapshot request failed', error);
            if (isCurrentPrepareRun()) {
                onPrepareFailed();
            }
        }
    }, [handleWarehouseUpdate, mapRef, waitForChinaMapReady]);

    return {
        warehouseFocus,
        clearWarehouseFocus,
        handleCityRaise,
        handleCityFall,
        handleWarehouseUpdate,
        handleWarehouseTourStateChange,
        handleCameraControl,
        handleWarehouseFocus,
        requestWarehouseSnapshot,
    };
}
