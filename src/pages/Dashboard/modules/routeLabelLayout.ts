import * as THREE from 'three';

export type RouteLabelLayoutInput = {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    priority: number;
};

type RouteLabelPlacement = {
    x: number;
    y: number;
};

type ScreenRect = {
    left: number;
    right: number;
    top: number;
    bottom: number;
};

type RouteLabelMeta = {
    anchor: THREE.Vector3;
    baseScale: [number, number];
    referenceDistance: number;
    priority: number;
    pinRightGap: number;
};

const ROUTE_LABEL_META = 'routeLabelLayout';
const VIEWPORT_MARGIN = 10;
const COLLISION_GAP = 7;

function rectAt(label: RouteLabelLayoutInput, x: number, y: number): ScreenRect {
    return {
        left: x - label.width / 2 - COLLISION_GAP,
        right: x + label.width / 2 + COLLISION_GAP,
        top: y - label.height / 2 - COLLISION_GAP,
        bottom: y + label.height / 2 + COLLISION_GAP,
    };
}

function overlapArea(left: ScreenRect, right: ScreenRect) {
    const width = Math.min(left.right, right.right) - Math.max(left.left, right.left);
    const height = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
    return width > 0 && height > 0 ? width * height : 0;
}

function clampCenter(value: number, size: number, viewportSize: number) {
    const half = Math.min(size / 2 + COLLISION_GAP, Math.max(0, viewportSize / 2 - VIEWPORT_MARGIN));
    return THREE.MathUtils.clamp(value, VIEWPORT_MARGIN + half, viewportSize - VIEWPORT_MARGIN - half);
}

function candidatesFor(label: RouteLabelLayoutInput, count: number) {
    const verticalStep = Math.max(38, label.height + COLLISION_GAP * 2);
    const horizontalStep = Math.min(220, Math.max(110, label.width * 0.54));
    const candidates: RouteLabelPlacement[] = [{ x: label.x, y: label.y }];
    const rings = Math.max(2, Math.min(8, count));
    for (let ring = 1; ring <= rings; ring += 1) {
        candidates.push(
            { x: label.x, y: label.y - verticalStep * ring },
            { x: label.x, y: label.y + verticalStep * ring },
        );
    }
    for (const direction of [-1, 1]) {
        for (let ring = 0; ring <= Math.min(4, rings); ring += 1) {
            const vertical = verticalStep * ring;
            candidates.push(
                { x: label.x + horizontalStep * direction, y: label.y - vertical },
                ...(ring > 0 ? [{ x: label.x + horizontalStep * direction, y: label.y + vertical }] : []),
            );
        }
    }
    return candidates;
}

export function arrangeRouteLabelRects(
    labels: RouteLabelLayoutInput[],
    viewport: { width: number; height: number },
) {
    const placements = new Map<string, RouteLabelPlacement>();
    const occupied: ScreenRect[] = [];
    [...labels]
        .sort((left, right) => left.priority - right.priority || left.y - right.y || left.x - right.x)
        .forEach((label) => {
            let best: { placement: RouteLabelPlacement; rect: ScreenRect; score: number } | null = null;
            for (const candidate of candidatesFor(label, labels.length)) {
                const placement = {
                    x: clampCenter(candidate.x, label.width, viewport.width),
                    y: clampCenter(candidate.y, label.height, viewport.height),
                };
                const rect = rectAt(label, placement.x, placement.y);
                const collision = occupied.reduce((sum, other) => sum + overlapArea(rect, other), 0);
                const displacement = Math.hypot(placement.x - label.x, placement.y - label.y);
                const score = collision * 1_000 + displacement;
                if (!best || score < best.score) best = { placement, rect, score };
            }
            if (!best) return;
            placements.set(label.id, best.placement);
            occupied.push(best.rect);
        });
    return placements;
}

export function registerRouteLabel(
    sprite: THREE.Sprite,
    config: {
        anchor?: THREE.Vector3;
        baseScale: [number, number];
        referenceDistance: number;
        priority: number;
        pinRightGap?: number;
    },
) {
    sprite.userData[ROUTE_LABEL_META] = {
        anchor: config.anchor?.clone() ?? sprite.position.clone(),
        baseScale: config.baseScale,
        referenceDistance: config.referenceDistance,
        priority: config.priority,
        pinRightGap: config.pinRightGap ?? 0,
    } satisfies RouteLabelMeta;
}

function routeLabelMeta(object: THREE.Object3D): RouteLabelMeta | null {
    return object instanceof THREE.Sprite
        ? object.userData[ROUTE_LABEL_META] as RouteLabelMeta | undefined ?? null
        : null;
}

function isVisibleInTree(object: THREE.Object3D) {
    let current: THREE.Object3D | null = object;
    while (current) {
        if (!current.visible) return false;
        current = current.parent;
    }
    return true;
}

export function updateRouteLabelLayout(
    roots: Iterable<THREE.Object3D>,
    camera: THREE.PerspectiveCamera,
    viewport: { width: number; height: number },
) {
    if (viewport.width <= 0 || viewport.height <= 0) return;
    camera.updateMatrixWorld();
    const entries: Array<{
        id: string;
        sprite: THREE.Sprite;
        meta: RouteLabelMeta;
        anchorWorld: THREE.Vector3;
        input: RouteLabelLayoutInput;
    }> = [];
    let sequence = 0;
    for (const root of roots) {
        root.traverse((object) => {
            const meta = routeLabelMeta(object);
            if (!meta || !(object instanceof THREE.Sprite) || !object.parent || !isVisibleInTree(object)) return;
            const anchorWorld = object.parent.localToWorld(meta.anchor.clone());
            const distance = camera.position.distanceTo(anchorWorld);
            const distanceScale = THREE.MathUtils.clamp(distance / meta.referenceDistance, 0.88, 2.25);
            object.scale.set(meta.baseScale[0] * distanceScale, meta.baseScale[1] * distanceScale, 1);

            const center = anchorWorld.clone().project(camera);
            if (center.z < -1 || center.z > 1 || Math.abs(center.x) > 1.1 || Math.abs(center.y) > 1.1) return;
            const cameraRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
            const cameraUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
            const rightEdge = anchorWorld.clone().addScaledVector(cameraRight, object.scale.x / 2).project(camera);
            const topEdge = anchorWorld.clone().addScaledVector(cameraUp, object.scale.y / 2).project(camera);
            const id = `route-label-${sequence++}`;
            entries.push({
                id,
                sprite: object,
                meta,
                anchorWorld,
                input: {
                    id,
                    x: (center.x + 1) * viewport.width / 2
                        + Math.max(24, Math.abs(rightEdge.x - center.x) * viewport.width) / 2
                        + meta.pinRightGap,
                    y: (1 - center.y) * viewport.height / 2,
                    width: Math.max(24, Math.abs(rightEdge.x - center.x) * viewport.width),
                    height: Math.max(18, Math.abs(topEdge.y - center.y) * viewport.height),
                    priority: meta.priority,
                },
            });
        });
    }

    const placements = arrangeRouteLabelRects(entries.map((entry) => entry.input), viewport);
    entries.forEach(({ id, sprite, meta, anchorWorld }) => {
        const placement = placements.get(id);
        if (!placement || !sprite.parent) return;
        const projectedAnchor = anchorWorld.clone().project(camera);
        const targetWorld = new THREE.Vector3(
            placement.x / viewport.width * 2 - 1,
            1 - placement.y / viewport.height * 2,
            projectedAnchor.z,
        ).unproject(camera);
        sprite.position.copy(sprite.parent.worldToLocal(targetWorld));
        // The anchor is immutable; every frame starts from it so labels do not drift.
        sprite.userData[ROUTE_LABEL_META] = meta;
    });
}
