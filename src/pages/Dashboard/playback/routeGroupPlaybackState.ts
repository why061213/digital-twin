import type {
    RouteGroupPlaybackEvent,
    RouteGroupPlaybackState,
    RouteGroupSnapshot,
} from './types';

export function createRouteGroupPlaybackState<TGroup extends RouteGroupSnapshot, TRoute>(
    isSceneReady = false,
): RouteGroupPlaybackState<TGroup, TRoute> {
    return {
        phase: 'idle',
        snapshotVersion: null,
        groups: [],
        activeGroupId: null,
        activeRoutes: [],
        transitionGeneration: 0,
        isSceneReady,
        isFading: false,
        error: null,
    };
}

export function dispatchPlaybackEvent<TGroup extends RouteGroupSnapshot, TRoute>(
    state: RouteGroupPlaybackState<TGroup, TRoute>,
    event: RouteGroupPlaybackEvent<TGroup, TRoute>,
): RouteGroupPlaybackState<TGroup, TRoute> {
    switch (event.type) {
        case 'ENTER_RM2':
            return {
                ...state,
                phase: 'syncing',
                activeRoutes: [],
                transitionGeneration: state.transitionGeneration + 1,
                isFading: false,
                error: null,
            };

        case 'LEAVE_RM2':
            return {
                ...state,
                phase: 'paused',
                activeRoutes: [],
                transitionGeneration: state.transitionGeneration + 1,
                isFading: false,
                error: null,
            };

        case 'SCENE_READY':
            if (state.phase === 'preparing-scene' && state.activeGroupId) {
                return { ...state, isSceneReady: true, phase: 'loading-group' };
            }
            return { ...state, isSceneReady: true };

        case 'SCENE_UNREADY':
            return {
                ...state,
                isSceneReady: false,
                phase: state.phase === 'paused' ? 'paused' : 'preparing-scene',
                transitionGeneration: state.transitionGeneration + 1,
            };

        case 'SNAPSHOT_RECEIVED': {
            const activeGroupId = selectGroupId(state, event.groups, event.preferredGroupId);
            const generation = state.transitionGeneration + 1;
            if (!activeGroupId) {
                return {
                    ...state,
                    phase: 'syncing',
                    snapshotVersion: event.snapshotVersion,
                    groups: event.groups,
                    activeGroupId: null,
                    activeRoutes: [],
                    isFading: false,
                    error: null,
                };
            }
            return {
                ...state,
                phase: state.isSceneReady ? 'loading-group' : 'preparing-scene',
                snapshotVersion: event.snapshotVersion,
                groups: event.groups,
                activeGroupId,
                activeRoutes: [],
                transitionGeneration: generation,
                isFading: false,
                error: null,
            };
        }

        case 'GROUP_LOAD_STARTED':
            if (state.phase !== 'loading-group' || !isActiveGeneration(state, event.groupId, event.generation)) return state;
            return { ...state, phase: 'loading-group', error: null };

        case 'GROUP_RENDERED':
            if (state.phase !== 'loading-group' || !isActiveGeneration(state, event.groupId, event.generation)) return state;
            return { ...state, phase: 'showing', activeRoutes: event.routes, isFading: false, error: null };

        case 'GROUP_TIMEOUT':
        case 'GROUP_COMPLETED':
            if (state.phase !== 'showing' || event.generation !== state.transitionGeneration) return state;
            return {
                ...state,
                phase: 'transitioning',
                transitionGeneration: state.transitionGeneration + 1,
                isFading: true,
            };

        case 'TRANSITION_FINISHED':
            if (state.phase !== 'transitioning' || event.generation !== state.transitionGeneration) return state;
            if (!hasGroup(state.groups, event.nextGroupId)) {
                return { ...state, phase: 'syncing', activeGroupId: null, activeRoutes: [], isFading: false };
            }
            return {
                ...state,
                phase: state.isSceneReady ? 'loading-group' : 'preparing-scene',
                activeGroupId: event.nextGroupId,
                activeRoutes: [],
                isFading: false,
            };

        case 'MANUAL_GROUP_SELECTED':
            if (!hasGroup(state.groups, event.groupId)) return state;
            return {
                ...state,
                phase: state.isSceneReady ? 'loading-group' : 'preparing-scene',
                activeGroupId: event.groupId,
                activeRoutes: [],
                transitionGeneration: state.transitionGeneration + 1,
                isFading: false,
                error: null,
            };

        case 'ERROR':
            if (event.generation !== undefined && event.generation !== state.transitionGeneration) return state;
            return { ...state, phase: 'error', isFading: false, error: event.message };

        case 'RETRY':
            return {
                ...state,
                phase: 'syncing',
                transitionGeneration: state.transitionGeneration + 1,
                isFading: false,
                error: null,
            };
    }
}

function selectGroupId<TGroup extends RouteGroupSnapshot, TRoute>(
    state: RouteGroupPlaybackState<TGroup, TRoute>,
    groups: readonly TGroup[],
    preferredGroupId?: string | null,
): string | null {
    if (preferredGroupId && hasGroup(groups, preferredGroupId)) return preferredGroupId;
    if (state.activeGroupId && hasGroup(groups, state.activeGroupId)) return state.activeGroupId;
    return groups[0]?.groupId ?? null;
}

function hasGroup(groups: readonly RouteGroupSnapshot[], groupId: string): boolean {
    return groups.some((group) => group.groupId === groupId);
}

function isActiveGeneration<TGroup extends RouteGroupSnapshot, TRoute>(
    state: RouteGroupPlaybackState<TGroup, TRoute>,
    groupId: string,
    generation: number,
): boolean {
    return state.activeGroupId === groupId && state.transitionGeneration === generation;
}
