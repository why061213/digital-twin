import { useCallback, useRef, useState } from 'react';
import MainLayout from '@/components/Layout/MainLayout';
import Header from '@/components/Layout/Header';
import InventoryStats from './modules/InventoryStats';
import VehicleSchedule from './modules/VehicleSchedule';
import TrafficMonitor from './modules/TrafficMonitor';
import Warehouse3D from './modules/Warehouse3D';
import ChinaMap3D from './modules/ChinaMap3D';
import type { ChinaMap3DHandle } from './modules/ChinaMap3D';
import { type RouteOrder, useDashboardRealtime } from './hooks/useDashboardRealtime';

function DashboardPage() {
    const [view, setView] = useState<'warehouse' | 'earth'>('warehouse');
    const [routeOrders, setRouteOrders] = useState<RouteOrder[]>([]);
    const mapRef = useRef<ChinaMap3DHandle | null>(null);

    const riseCity = useCallback((cityName: string) => {
        setView('earth');
        window.setTimeout(() => {
            mapRef.current?.riseCity(cityName);
        }, 500);
    }, []);

    const fallCity = useCallback((cityName: string) => {
        mapRef.current?.fallCity(cityName);
    }, []);

    const upsertRouteOrder = useCallback((order: RouteOrder) => {
        setRouteOrders((orders) => {
            const exists = orders.some((item) => item.lineId === order.lineId);
            if (exists) {
                return orders.map((item) => (item.lineId === order.lineId ? order : item));
            }
            return [...orders, order].slice(-8);
        });
        mapRef.current?.addFlyLine(order.lineId, order.fromCoords, order.toCoords);
    }, []);

    const removeRouteFlyLine = useCallback((lineId: string) => {
        mapRef.current?.removeFlyLine(lineId);
    }, []);

    useDashboardRealtime({
        onCityRaise: riseCity,
        onCityFall: fallCity,
        onRouteRaise: upsertRouteOrder,
        onRouteFall: removeRouteFlyLine,
    });

    return (
        <MainLayout
            header={<Header />}
            leftPanel={<InventoryStats />}
            centerPanel={
                <div className="relative w-full h-full">
                    <div
                        className={`absolute inset-0 transition-opacity duration-700 ease-in-out ${
                            view === 'warehouse' ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'
                        }`}
                    >
                        <Warehouse3D />
                    </div>

                    <div
                        className={`absolute inset-0 transition-opacity duration-700 ease-in-out ${
                            view === 'earth' ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'
                        }`}
                    >
                        <ChinaMap3D ref={mapRef} />
                    </div>

                    <button
                        onClick={() => setView((current) => (current === 'warehouse' ? 'earth' : 'warehouse'))}
                        className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 px-4 py-2 bg-slate-950/45 backdrop-blur-md border border-cyan-300/35 rounded-full text-cyan-200 text-xs hover:bg-cyan-400/10 hover:border-cyan-200/60 transition-all shadow-[0_0_22px_rgba(34,211,238,0.18)] pointer-events-auto"
                    >
                        {view === 'warehouse' ? '\u5207\u6362\u5730\u56fe\u89c6\u56fe' : '\u5207\u6362\u4ed3\u5e93\u89c6\u56fe'}
                    </button>
                </div>
            }
            rightPanel={
                <>
                    <VehicleSchedule routeOrders={routeOrders} />
                    <TrafficMonitor />
                </>
            }
        />
    );
}

export default DashboardPage;
