// src/pages/Dashboard/hooks/useWebSocket.ts
import { useEffect } from 'react';
import wsClient from '@/services/wsClient';
import { useDashboardStore } from '@/store/useDashboardStore';
import { useInventoryStore } from '@/store/useInventoryStore';
import { useAlertStore } from '@/store/useAlertStore';

export const useWebSocket = (topics: any[]) => {
    const onVehicleEvent = useDashboardStore((s) => s.onVehicleEvent);
    const onWarehouseEvent = useInventoryStore((s) => s.onWarehouseEvent);
    const onAlertEvent = useAlertStore((s) => s.onAlertEvent);

    useEffect(() => {
        wsClient.connect(topics, {
            onVehicleEvent,
            onWarehouseEvent,
            onAlertEvent,
        });

        return () => {
            wsClient.disconnect();
        };
    }, []);
};