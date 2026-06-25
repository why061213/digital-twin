import { useState, useRef } from 'react';
import MainLayout from '@/components/Layout/MainLayout';
import Header from '@/components/Layout/Header';
import InventoryStats from './modules/InventoryStats';
import VehicleSchedule from './modules/VehicleSchedule';
import TrafficMonitor from './modules/TrafficMonitor';
import Warehouse3D from './modules/Warehouse3D';
import ChinaMap3D from './modules/ChinaMap3D';

function DashboardPage() {
    const [view, setView] = useState<'warehouse' | 'earth'>('warehouse');
    const mapRef = useRef<any>(null);

    return (
        <MainLayout
            header={<Header />}
            leftPanel={<InventoryStats />}
            centerPanel={
                <div className="relative w-full h-full">
                    {/* 仓库场景 */}
                    <div
                        className={`absolute inset-0 transition-opacity duration-700 ease-in-out ${
                            view === 'warehouse' ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'
                        }`}
                    >
                        <Warehouse3D/>
                    </div>

                    {/* 地图场景 */}
                    <div
                        className={`absolute inset-0 transition-opacity duration-700 ease-in-out ${
                            view === 'earth' ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'
                        }`}
                    >
                        <ChinaMap3D ref={mapRef}/>
                    </div>

                    {/* 切换按钮 */}
                    <button
                        onClick={() => setView((v) => (v === 'warehouse' ? 'earth' : 'warehouse'))}
                        className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 px-4 py-2 bg-white/10 backdrop-blur-md border border-cyan-400/30 rounded-full text-cyan-300 text-xs hover:bg-white/20 transition-all shadow-lg pointer-events-auto"
                    >
                        {view === 'warehouse' ? '切换地图视图' : '切换仓库视图'}
                    </button>

                    {/* 测试连线按钮 */}
                    <button
                        onClick={() => {
                            setView('earth');
                            setTimeout(() => {
                                mapRef.current?.flyToCity('上海');
                            }, 500);
                        }}
                        className="absolute bottom-20 left-1/2 -translate-x-1/2 z-40 px-4 py-2 bg-white/10 backdrop-blur-md border border-cyan-400/30 rounded-full text-cyan-300 text-xs"
                    >
                        演示：佛山 → 上海
                    </button>
                    <button
                        onClick={() => {
                            setView('earth');
                            setTimeout(() => {
                                mapRef.current?.flyToCity('北京');
                            }, 500);
                        }}
                        className="absolute bottom-40 left-1/2 -translate-x-1/2 z-40 px-4 py-2 bg-white/10 backdrop-blur-md border border-cyan-400/30 rounded-full text-cyan-300 text-xs"
                    >
                        演示：佛山 → 北京
                    </button>
                </div>
            }
            rightPanel={
                <>
                    <VehicleSchedule/>
                    <TrafficMonitor/>
                </>
            }
        />
    );
}

export default DashboardPage;