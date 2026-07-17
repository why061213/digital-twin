import { useCallback, useEffect, useRef, useState } from 'react';
import { MAP_VIEW_RELEASE_DELAY_MS } from '../constants';
import type { ViewMode } from '../types';

type UseDashboardViewTransitionParams = {
    onBeforeViewChange?: () => void;
};

export function useDashboardViewTransition({
    onBeforeViewChange,
}: UseDashboardViewTransitionParams = {}) {
    const [view, setView] = useState<ViewMode>('chinaMap');
    const [chinaMapSession, setChinaMapSession] = useState(0);
    const [isPreparingChinaMap, setIsPreparingChinaMap] = useState(false);
    const [isRevealingChinaMap, setIsRevealingChinaMap] = useState(false);
    const [isChinaMapVisualReady, setIsChinaMapVisualReady] = useState(false);
    const [isChinaMapDataReady, setIsChinaMapDataReady] = useState(false);
    const [roadMapSession, setRoadMapSession] = useState(0);
    const [isPreparingRoadMap, setIsPreparingRoadMap] = useState(false);
    const [isRevealingRoadMap, setIsRevealingRoadMap] = useState(false);
    const [isRoadMapVisualReady, setIsRoadMapVisualReady] = useState(false);
    const [isRoadMapDataReady, setIsRoadMapDataReady] = useState(false);

    const chinaMapPrepareRunRef = useRef(0);
    const chinaMapRevealTimerRef = useRef<number | null>(null);
    const roadMapPrepareRunRef = useRef(0);
    const roadMapRevealTimerRef = useRef<number | null>(null);
    const skipNextRoadMapRefreshRef = useRef(false);

    const cancelChinaMapTransition = useCallback(() => {
        if (chinaMapRevealTimerRef.current !== null) {
            window.clearTimeout(chinaMapRevealTimerRef.current);
            chinaMapRevealTimerRef.current = null;
        }
        chinaMapPrepareRunRef.current += 1;
        setIsPreparingChinaMap(false);
        setIsRevealingChinaMap(false);
        setIsChinaMapVisualReady(false);
        setIsChinaMapDataReady(false);
    }, []);

    const cancelRoadMapTransition = useCallback(() => {
        if (roadMapRevealTimerRef.current !== null) {
            window.clearTimeout(roadMapRevealTimerRef.current);
            roadMapRevealTimerRef.current = null;
        }
        roadMapPrepareRunRef.current += 1;
        skipNextRoadMapRefreshRef.current = false;
        setIsPreparingRoadMap(false);
        setIsRevealingRoadMap(false);
        setIsRoadMapVisualReady(false);
        setIsRoadMapDataReady(false);
    }, []);

    const requestViewChange = useCallback((nextView: ViewMode) => {
        onBeforeViewChange?.();

        if (nextView === 'chinaMap') {
            if (view === 'chinaMap' || isPreparingChinaMap || isRevealingChinaMap) return;
            cancelRoadMapTransition();
            chinaMapPrepareRunRef.current += 1;
            setIsPreparingChinaMap(true);
            setIsRevealingChinaMap(false);
            setIsChinaMapVisualReady(false);
            setIsChinaMapDataReady(false);
            setChinaMapSession((session) => session + 1);
            return;
        }

        if (nextView === 'roadMap') {
            if (view === 'roadMap' || isPreparingRoadMap || isRevealingRoadMap) return;
            cancelChinaMapTransition();
            roadMapPrepareRunRef.current += 1;
            skipNextRoadMapRefreshRef.current = false;
            setIsPreparingRoadMap(true);
            setIsRevealingRoadMap(false);
            setIsRoadMapVisualReady(false);
            setIsRoadMapDataReady(false);
            setRoadMapSession((session) => session + 1);
            return;
        }

        cancelChinaMapTransition();
        cancelRoadMapTransition();
        setView(nextView);
    }, [
        cancelChinaMapTransition,
        cancelRoadMapTransition,
        isPreparingChinaMap,
        isPreparingRoadMap,
        isRevealingChinaMap,
        isRevealingRoadMap,
        onBeforeViewChange,
        view,
    ]);

    const handleChinaMapVisualReady = useCallback(() => {
        setIsChinaMapVisualReady(true);
    }, []);

    const handleRoadMapVisualReady = useCallback(() => {
        setIsRoadMapVisualReady(true);
    }, []);

    const markChinaMapDataReady = useCallback(() => {
        setIsChinaMapDataReady(true);
    }, []);

    const markRoadMapDataReady = useCallback(() => {
        skipNextRoadMapRefreshRef.current = true;
        setIsRoadMapDataReady(true);
    }, []);

    const failChinaMapPrepare = useCallback(() => {
        setIsPreparingChinaMap(false);
        setIsRevealingChinaMap(false);
        setIsChinaMapDataReady(false);
    }, []);

    const failRoadMapPrepare = useCallback(() => {
        setIsPreparingRoadMap(false);
        setIsRevealingRoadMap(false);
        setIsRoadMapDataReady(false);
    }, []);

    useEffect(() => {
        if (!isPreparingChinaMap || !isChinaMapVisualReady || !isChinaMapDataReady || isRevealingChinaMap) return;
        const prepareRunId = chinaMapPrepareRunRef.current;

        setIsRevealingChinaMap(true);
        chinaMapRevealTimerRef.current = window.setTimeout(() => {
            if (chinaMapPrepareRunRef.current !== prepareRunId) return;
            setView('chinaMap');
            setIsPreparingChinaMap(false);
            setIsRevealingChinaMap(false);
            setIsChinaMapDataReady(false);
            chinaMapRevealTimerRef.current = null;
        }, MAP_VIEW_RELEASE_DELAY_MS);
    }, [isChinaMapDataReady, isChinaMapVisualReady, isPreparingChinaMap, isRevealingChinaMap]);

    useEffect(() => {
        if (!isPreparingRoadMap || !isRoadMapVisualReady || !isRoadMapDataReady || isRevealingRoadMap) return;
        const prepareRunId = roadMapPrepareRunRef.current;

        setIsRevealingRoadMap(true);
        roadMapRevealTimerRef.current = window.setTimeout(() => {
            if (roadMapPrepareRunRef.current !== prepareRunId) return;
            setView('roadMap');
            setIsPreparingRoadMap(false);
            setIsRevealingRoadMap(false);
            setIsRoadMapDataReady(false);
            roadMapRevealTimerRef.current = null;
        }, MAP_VIEW_RELEASE_DELAY_MS);
    }, [isPreparingRoadMap, isRevealingRoadMap, isRoadMapDataReady, isRoadMapVisualReady]);

    useEffect(() => {
        return () => {
            if (chinaMapRevealTimerRef.current !== null) {
                window.clearTimeout(chinaMapRevealTimerRef.current);
                chinaMapRevealTimerRef.current = null;
            }
            if (roadMapRevealTimerRef.current !== null) {
                window.clearTimeout(roadMapRevealTimerRef.current);
                roadMapRevealTimerRef.current = null;
            }
        };
    }, []);

    return {
        view,
        requestViewChange,
        chinaMapSession,
        isPreparingChinaMap,
        isRevealingChinaMap,
        isChinaMapVisualReady,
        isChinaMapDataReady,
        roadMapSession,
        isPreparingRoadMap,
        isRevealingRoadMap,
        isRoadMapVisualReady,
        isRoadMapDataReady,
        chinaMapPrepareRunRef,
        roadMapPrepareRunRef,
        skipNextRoadMapRefreshRef,
        handleChinaMapVisualReady,
        handleRoadMapVisualReady,
        markChinaMapDataReady,
        markRoadMapDataReady,
        failChinaMapPrepare,
        failRoadMapPrepare,
    };
}
