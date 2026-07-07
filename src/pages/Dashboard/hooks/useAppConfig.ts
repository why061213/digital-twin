import { useState, useEffect, useRef } from 'react';
import { API_BASE_URL } from '../constants';

export interface AppConfig {
    roadGroupSize: number;
    roadGroupDisplayBaseMs: number;
    roadGroupDisplayAddMs: number;
    defaultGroupStrategy: string;

    autoCarouselRoadGroupCycles: number;
    autoCarouselChinaMapLoops: number;
    autoCarouselChinaMapDurationMs: number;
    autoCarouselEnabled: boolean;
}

const DEFAULT_CONFIG: AppConfig = {
    roadGroupSize: 12,
    roadGroupDisplayBaseMs: 8000,
    roadGroupDisplayAddMs: 200,
    defaultGroupStrategy: 'business-priority',

    autoCarouselRoadGroupCycles: 2,
    autoCarouselChinaMapLoops: 1,
    autoCarouselChinaMapDurationMs: 30000,
    autoCarouselEnabled: true,
};

function configSignature(config: AppConfig) {
    return JSON.stringify({
        roadGroupSize: config.roadGroupSize,
        roadGroupDisplayBaseMs: config.roadGroupDisplayBaseMs,
        roadGroupDisplayAddMs: config.roadGroupDisplayAddMs,
        defaultGroupStrategy: config.defaultGroupStrategy,
        autoCarouselRoadGroupCycles: config.autoCarouselRoadGroupCycles,
        autoCarouselChinaMapLoops: config.autoCarouselChinaMapLoops,
        autoCarouselChinaMapDurationMs: config.autoCarouselChinaMapDurationMs,
        autoCarouselEnabled: config.autoCarouselEnabled,
    });
}

export function useAppConfig() {
    const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
    const [loading, setLoading] = useState(true);
    const signatureRef = useRef(configSignature(DEFAULT_CONFIG));

    useEffect(() => {
        let disposed = false;

        const loadConfig = async () => {
            try {
                const res = await fetch(`${API_BASE_URL}/config`);
                if (!res.ok) throw new Error(`读取配置失败: ${res.status}`);

                const data = await res.json();

                const nextConfig: AppConfig = {
                    ...DEFAULT_CONFIG,
                    ...data,
                };

                const nextSignature = configSignature(nextConfig);

                if (!disposed && nextSignature !== signatureRef.current) {
                    signatureRef.current = nextSignature;
                    setConfig(nextConfig);
                }
            } catch (err) {
                console.warn('读取后端配置失败，使用默认值', err);
            } finally {
                if (!disposed) {
                    setLoading(false);
                }
            }
        };

        void loadConfig();

        const timer = window.setInterval(() => {
            void loadConfig();
        }, 5000);

        return () => {
            disposed = true;
            window.clearInterval(timer);
        };
    }, []);

    return { config, loading };
}