import MainLayout from '@/components/Layout/MainLayout';
import Header from '@/components/Layout/Header';
import InventoryStats from './modules/InventoryStats';
import VehicleSchedule from './modules/VehicleSchedule';
import TrafficMonitor from './modules/TrafficMonitor';
import Warehouse3D from './modules/Warehouse3D';

function DashboardPage() {
    return (
        <MainLayout
            header={<Header />}
            leftPanel={<InventoryStats />}
            centerPanel={<Warehouse3D />}
            rightPanel={
                <>
                    <VehicleSchedule />
                    <TrafficMonitor />
                </>
            }
        />
    );
}

export default DashboardPage;