import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
    createRing,
    getNext,
    setCurrent,
    syncRing,
} from './routeGroupRing';
import {
    createRouteGroupPlaybackState,
    dispatchPlaybackEvent as reducePlaybackEvent,
} from './routeGroupPlaybackState';
import type {
    RouteGroupPlaybackEvent,
    RouteGroupPlaybackState,
    RouteGroupSnapshot,
} from './types';

const DEFAULT_TRANSITION_DURATION_MS = 500;

export type RouteGroupSnapshotResponse<TGroup extends RouteGroupSnapshot> = {
    snapshotVersion: string;
    groups: readonly TGroup[];
};

export type RouteGroupPlaybackControllerOptions<TGroup extends RouteGroupSnapshot, TRoute> = {
    scope: string;
    sceneReady: boolean;
    fetchGroups: (signal?: AbortSignal) => Promise<RouteGroupSnapshotResponse<TGroup>>;
    fetchGroupRoutes: (groupId: string, signal?: AbortSignal) => Promise<readonly TRoute[]>;
    prepareSceneForGroup: (group: TGroup) => void | Promise<void>;
    replaceRenderedGroup: (group: TGroup, routes: readonly TRoute[]) => void | Promise<void>;
    clearRenderedGroup: () => void | Promise<void>;
    isRouteComplete: (route: TRoute) => boolean;
    getDisplayDuration: (group: TGroup, routes: readonly TRoute[]) => number;
    transitionDurationMs?: number;
};

export type RouteGroupPlaybackController<TGroup extends RouteGroupSnapshot, TRoute> = {
    groups: readonly TGroup[];
    activeGroupId: string | null;
    activeRoutes: readonly TRoute[];
    phase: RouteGroupPlaybackState<TGroup, TRoute>['phase'];
    isFading: boolean;
    refreshSnapshot: () => Promise<void>;
    selectGroup: (groupId: string) => void;
    markRouteFinished: (route: TRoute) => void;
    pause: () => void;
    resume: () => Promise<void>;
};

export function useRouteGroupPlaybackController<TGroup extends RouteGroupSnapshot, TRoute>(
    options: RouteGroupPlaybackControllerOptions<TGroup, TRoute>,
): RouteGroupPlaybackController<TGroup, TRoute> {
    const {
        sceneReady,
        fetchGroups,
        fetchGroupRoutes,
        prepareSceneForGroup,
        replaceRenderedGroup,
        clearRenderedGroup,
        isRouteComplete,
        getDisplayDuration,
        transitionDurationMs = DEFAULT_TRANSITION_DURATION_MS,
    } = options;
    const [state, reactDispatch] = useReducer(
        reducePlaybackEvent<TGroup, TRoute>,
        sceneReady,
        createRouteGroupPlaybackState<TGroup, TRoute>,
    );
    const stateRef = useRef(state);
    const ringRef = useRef(createRing());
    const snapshotAbortRef = useRef<AbortController | null>(null);
    const routesAbortRef = useRef<AbortController | null>(null);
    const completedRoutesRef = useRef<Set<TRoute>>(new Set());

    const dispatchPlaybackEvent = useCallback((event: RouteGroupPlaybackEvent<TGroup, TRoute>) => {
        stateRef.current = reducePlaybackEvent(stateRef.current, event);
        reactDispatch(event);
    }, []);

    const isCurrentLoad = useCallback((groupId: string, generation: number) => {
        const current = stateRef.current;
        return current.phase === 'loading-group'
            && current.activeGroupId === groupId
            && current.transitionGeneration === generation;
    }, []);

    const refreshSnapshot = useCallback(async () => {
        if (stateRef.current.phase === 'paused') return;

        snapshotAbortRef.current?.abort();
        const request = new AbortController();
        snapshotAbortRef.current = request;
        try {
            const snapshot = await fetchGroups(request.signal);
            if (request.signal.aborted) return;

            syncRing(ringRef.current, snapshot.groups);
            dispatchPlaybackEvent({
                type: 'SNAPSHOT_RECEIVED',
                snapshotVersion: snapshot.snapshotVersion,
                groups: snapshot.groups,
                preferredGroupId: ringRef.current.current?.groupId ?? null,
            });
        } catch (error) {
            if ((error as DOMException).name === 'AbortError') return;
            dispatchPlaybackEvent({
                type: 'ERROR',
                message: error instanceof Error ? error.message : 'Route group snapshot failed',
                generation: stateRef.current.transitionGeneration,
            });
        }
    }, [dispatchPlaybackEvent, fetchGroups]);

    const selectGroup = useCallback((groupId: string) => {
        if (!setCurrent(ringRef.current, groupId)) return;
        completedRoutesRef.current.clear();
        dispatchPlaybackEvent({ type: 'MANUAL_GROUP_SELECTED', groupId });
    }, [dispatchPlaybackEvent]);

    const markRouteFinished = useCallback((route: TRoute) => {
        const current = stateRef.current;
        if (current.phase !== 'showing' || !current.activeRoutes.includes(route)) return;

        completedRoutesRef.current.add(route);
        const allCompleted = current.activeRoutes.length > 0
            && current.activeRoutes.every((item) => isRouteComplete(item) || completedRoutesRef.current.has(item));
        if (allCompleted) {
            dispatchPlaybackEvent({ type: 'GROUP_COMPLETED', generation: current.transitionGeneration });
        }
    }, [dispatchPlaybackEvent, isRouteComplete]);

    const pause = useCallback(() => {
        snapshotAbortRef.current?.abort();
        routesAbortRef.current?.abort();
        completedRoutesRef.current.clear();
        void clearRenderedGroup();
        dispatchPlaybackEvent({ type: 'LEAVE_RM2' });
    }, [clearRenderedGroup, dispatchPlaybackEvent]);

    const resume = useCallback(async () => {
        dispatchPlaybackEvent({ type: 'ENTER_RM2' });
        await refreshSnapshot();
    }, [dispatchPlaybackEvent, refreshSnapshot]);

    useEffect(() => {
        if (!sceneReady && (stateRef.current.phase === 'idle' || stateRef.current.phase === 'paused')) return;
        dispatchPlaybackEvent({ type: sceneReady ? 'SCENE_READY' : 'SCENE_UNREADY' });
    }, [dispatchPlaybackEvent, sceneReady]);

    useEffect(() => {
        if (state.phase !== 'loading-group' || !state.isSceneReady || !state.activeGroupId) return;
        const group = state.groups.find((item) => item.groupId === state.activeGroupId);
        if (!group) {
            void refreshSnapshot();
            return;
        }

        routesAbortRef.current?.abort();
        const request = new AbortController();
        routesAbortRef.current = request;
        const generation = state.transitionGeneration;
        const groupId = group.groupId;
        dispatchPlaybackEvent({ type: 'GROUP_LOAD_STARTED', groupId, generation });

        void (async () => {
            try {
                await prepareSceneForGroup(group);
                if (request.signal.aborted || !isCurrentLoad(groupId, generation)) return;
                const routes = await fetchGroupRoutes(groupId, request.signal);
                if (request.signal.aborted || !isCurrentLoad(groupId, generation)) return;
                await replaceRenderedGroup(group, routes);
                if (request.signal.aborted || !isCurrentLoad(groupId, generation)) return;

                completedRoutesRef.current.clear();
                dispatchPlaybackEvent({ type: 'GROUP_RENDERED', groupId, routes, generation });
            } catch (error) {
                if ((error as DOMException).name === 'AbortError') return;
                dispatchPlaybackEvent({
                    type: 'ERROR',
                    message: error instanceof Error ? error.message : 'Route group load failed',
                    generation,
                });
            }
        })();

        return () => request.abort();
    }, [dispatchPlaybackEvent, fetchGroupRoutes, isCurrentLoad, prepareSceneForGroup, refreshSnapshot, replaceRenderedGroup, state.activeGroupId, state.groups, state.isSceneReady, state.phase, state.transitionGeneration]);

    useEffect(() => {
        if (state.phase !== 'showing' || !state.activeGroupId) return;
        const group = state.groups.find((item) => item.groupId === state.activeGroupId);
        if (!group) return;
        const duration = Math.max(0, getDisplayDuration(group, state.activeRoutes));
        const generation = state.transitionGeneration;
        const timer = window.setTimeout(() => {
            dispatchPlaybackEvent({ type: 'GROUP_TIMEOUT', generation });
        }, duration);
        return () => window.clearTimeout(timer);
    }, [dispatchPlaybackEvent, getDisplayDuration, state.activeGroupId, state.activeRoutes, state.groups, state.phase, state.transitionGeneration]);

    useEffect(() => {
        if (state.phase !== 'transitioning') return;
        const generation = state.transitionGeneration;
        const timer = window.setTimeout(() => {
            const nextGroupId = getNext(ringRef.current)?.groupId;
            if (nextGroupId) {
                dispatchPlaybackEvent({ type: 'TRANSITION_FINISHED', nextGroupId, generation });
            } else {
                void refreshSnapshot();
            }
        }, Math.max(0, transitionDurationMs));
        return () => window.clearTimeout(timer);
    }, [dispatchPlaybackEvent, refreshSnapshot, state.phase, state.transitionGeneration, transitionDurationMs]);

    useEffect(() => () => {
        snapshotAbortRef.current?.abort();
        routesAbortRef.current?.abort();
    }, []);

    return {
        groups: state.groups,
        activeGroupId: state.activeGroupId,
        activeRoutes: state.activeRoutes,
        phase: state.phase,
        isFading: state.isFading,
        refreshSnapshot,
        selectGroup,
        markRouteFinished,
        pause,
        resume,
    };
}
