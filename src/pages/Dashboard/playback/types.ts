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
