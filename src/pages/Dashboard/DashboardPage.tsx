import { useState, useRef, useEffect } from 'react';
import MainLayout from '@/components/Layout/MainLayout';
import Header from '@/components/Layout/Header';
import InventoryStats from './modules/InventoryStats';
import VehicleSchedule from './modules/VehicleSchedule';
import TrafficMonitor from './modules/TrafficMonitor';
import Warehouse3D from './modules/Warehouse3D';
import ChinaMap3D from './modules/ChinaMap3D';
import type { ChinaMap3DHandle } from './modules/ChinaMap3D';
import RoadMap3D from './modules/RoadMap3D';

// 定义视图类型
type ViewMode = 'warehouse' | 'chinaMap' | 'roadMap';

function DashboardPage() {
    const [view, setView] = useState<ViewMode>('warehouse');
    const mapRef = useRef<ChinaMap3DHandle>(null);
    const roadMapRef = useRef<any>(null);

    // WebSocket 连接（暂不处理消息，仅保持连接）
    useEffect(() => {
        const wsUrl = import.meta.env.VITE_WS_URL || 'ws://localhost:8080/ws/dashboard';
        const ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log('WebSocket 已连接');
        };
        ws.onerror = (error) => {
            console.error('WebSocket 连接错误', error);
        };
        ws.onmessage = (event) => {
            // 后端已暂停推送，这里暂时不处理
            console.log('收到消息:', event.data);
        };
        ws.onclose = () => {
            console.log('WebSocket 已断开');
        };

        return () => {
            ws.close();
        };
    }, []);

    // 测试按钮处理函数
    const handleRiseCity = (city: string) => {
        mapRef.current?.riseCity(city);
    };

    const handleFallCity = (city: string) => {
        mapRef.current?.fallCity(city);
    };

    const handleFlyLine = (from: string, to: string) => {
        mapRef.current?.addFlyLine(
            `${from}-${to}-${Date.now()}`,
            from === '北京' ? [116.4074, 39.9042] : [113.121416, 23.021548],
            to === '上海' ? [121.4737, 31.2304] : [113.2644, 23.1291]
        );
    };

    const handleShowRoad = async () => {
        try {
            // 北京 → 广州
            const res = await fetch(
                'http://localhost:8080/api/road/path?fromLng=116.4074&fromLat=39.9042&toLng=113.2644&toLat=23.1291'
            );
            const data = await res.json();
            roadMapRef.current?.setRoadPath(data.coordinates);
        } catch (error) {
            console.error('获取道路数据失败', error);
        }
    };

    // 根据当前视图渲染中心面板
    const renderCenterPanel = () => {
        switch (view) {
            case 'warehouse':
                return <Warehouse3D />;
            case 'chinaMap':
                return <ChinaMap3D ref={mapRef} />;
            case 'roadMap':
                return <RoadMap3D ref={roadMapRef} />;
            default:
                return null;
        }
    };

    // 视图切换按钮组
    const viewButtons = (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 flex gap-2">
            <button
                onClick={() => setView('warehouse')}
                className={`px-4 py-2 rounded-full text-xs backdrop-blur-md border transition-all shadow-lg pointer-events-auto ${
                    view === 'warehouse'
                        ? 'bg-cyan-500/20 border-cyan-400/50 text-cyan-300'
                        : 'bg-white/10 border-white/10 text-gray-400 hover:bg-white/20'
                }`}
            >
                仓库视图
            </button>
            <button
                onClick={() => setView('chinaMap')}
                className={`px-4 py-2 rounded-full text-xs backdrop-blur-md border transition-all shadow-lg pointer-events-auto ${
                    view === 'chinaMap'
                        ? 'bg-cyan-500/20 border-cyan-400/50 text-cyan-300'
                        : 'bg-white/10 border-white/10 text-gray-400 hover:bg-white/20'
                }`}
            >
                数字孪生地图
            </button>
            <button
                onClick={() => setView('roadMap')}
                className={`px-4 py-2 rounded-full text-xs backdrop-blur-md border transition-all shadow-lg pointer-events-auto ${
                    view === 'roadMap'
                        ? 'bg-cyan-500/20 border-cyan-400/50 text-cyan-300'
                        : 'bg-white/10 border-white/10 text-gray-400 hover:bg-white/20'
                }`}
            >
                道路级地图
            </button>
        </div>
    );

    // 测试按钮区域（仅在中国地图模式下显示相关测试按钮）
    const testButtons = view === 'chinaMap' && (
        <>
            <button
                onClick={() => handleRiseCity('上海')}
                className="absolute bottom-20 left-1/2 -translate-x-1/2 z-40 px-4 py-2 bg-white/10 backdrop-blur-md border border-cyan-400/30 rounded-full text-cyan-300 text-xs hover:bg-white/20 transition-all shadow-lg pointer-events-auto"
            >
                凸起上海
            </button>
            <button
                onClick={() => handleFallCity('上海')}
                className="absolute bottom-36 left-1/2 -translate-x-1/2 z-40 px-4 py-2 bg-white/10 backdrop-blur-md border border-cyan-400/30 rounded-full text-cyan-300 text-xs hover:bg-white/20 transition-all shadow-lg pointer-events-auto"
            >
                降下上海
            </button>
            <button
                onClick={() => handleFlyLine('佛山', '上海')}
                className="absolute bottom-52 left-1/2 -translate-x-1/2 z-40 px-4 py-2 bg-white/10 backdrop-blur-md border border-cyan-400/30 rounded-full text-cyan-300 text-xs hover:bg-white/20 transition-all shadow-lg pointer-events-auto"
            >
                飞线：佛山 → 上海
            </button>
            <button
                onClick={() => handleFlyLine('北京', '深圳')}
                className="absolute bottom-68 left-1/2 -translate-x-1/2 z-40 px-4 py-2 bg-white/10 backdrop-blur-md border border-cyan-400/30 rounded-full text-cyan-300 text-xs hover:bg-white/20 transition-all shadow-lg pointer-events-auto"
            >
                飞线：北京 → 深圳
            </button>
        </>
    );

    const roadTestButton = view === 'roadMap' && (
        <button
            onClick={handleShowRoad}
            className="absolute bottom-20 left-1/2 -translate-x-1/2 z-40 px-4 py-2 bg-white/10 backdrop-blur-md border border-cyan-400/30 rounded-full text-cyan-300 text-xs hover:bg-white/20 transition-all shadow-lg pointer-events-auto"
        >
            显示佛山→广州道路
        </button>
    );

    return (
        <MainLayout
            header={<Header />}
            leftPanel={<InventoryStats />}
            centerPanel={
                <div className="relative w-full h-full">
                    {renderCenterPanel()}
                    {viewButtons}
                    {testButtons}
                    {roadTestButton}
                </div>
            }
            rightPanel={
                <>
                    <VehicleSchedule routeOrders={[]} />
                    <TrafficMonitor />
                </>
            }
        />
    );
}

export default DashboardPage;