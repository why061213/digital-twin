export type RouteGroupSnapshot = {
    groupId: string;
    index?: number;
};

export type RouteGroupNode = {
    groupId: string;
    next: RouteGroupNode | null;
};

export type RouteGroupRing = {
    nodes: Map<string, RouteGroupNode>;
    head: RouteGroupNode | null;
    tail: RouteGroupNode | null;
    current: RouteGroupNode | null;
};

export type PlaybackPhase =
    | 'idle'
    | 'syncing'
    | 'preparing-scene'
    | 'loading-group'
    | 'showing'
    | 'transitioning'
    | 'paused'
    | 'error';

export type RouteGroupPlaybackState<TGroup extends RouteGroupSnapshot, TRoute> = {
    phase: PlaybackPhase;
    snapshotVersion: string | null;
    groups: readonly TGroup[];
    activeGroupId: string | null;
    activeRoutes: readonly TRoute[];
    transitionGeneration: number;
    isSceneReady: boolean;
    isFading: boolean;
    error: string | null;
};

export type RouteGroupPlaybackEvent<TGroup extends RouteGroupSnapshot, TRoute> =
    | { type: 'ENTER_RM2' }
    | { type: 'LEAVE_RM2' }
    | { type: 'SCENE_READY' }
    | { type: 'SCENE_UNREADY' }
    | {
        type: 'SNAPSHOT_RECEIVED';
        snapshotVersion: string;
        groups: readonly TGroup[];
        preferredGroupId?: string | null;
    }
    | { type: 'GROUP_LOAD_STARTED'; groupId: string; generation: number }
    | { type: 'GROUP_RENDERED'; groupId: string; routes: readonly TRoute[]; generation: number }
    | { type: 'GROUP_TIMEOUT'; generation: number }
    | { type: 'GROUP_COMPLETED'; generation: number }
    | { type: 'TRANSITION_FINISHED'; nextGroupId: string; generation: number }
    | { type: 'MANUAL_GROUP_SELECTED'; groupId: string }
    | { type: 'ERROR'; message: string; generation?: number }
    | { type: 'RETRY' };
