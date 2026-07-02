import * as THREE from 'three';
import { LABEL_CONFIG } from '@/config/labelLayout';
import type { LabelLayout, ScreenRect, PanelAttachSide, PanelPlacement } from './types';

export const OCTAGON_ORDER = [0, 2, 4, 6, 1, 3, 5, 7];
export const LABEL_ANCHOR_RADIUS = 38;
export const LABEL_ANCHOR_CENTER_Y = -28;

export function projectToScreen(point: THREE.Vector3, camera: THREE.Camera, container: HTMLDivElement) {
    const projected = point.clone().project(camera);
    return new THREE.Vector2(
        (projected.x * 0.5 + 0.5) * container.clientWidth,
        (-projected.y * 0.5 + 0.5) * container.clientHeight
    );
}

export function equalCircleOverlapRatio(distance: number, radius: number) {
    if (distance >= radius * 2) return 0;
    if (distance <= 0) return 1;
    const clamped = Math.min(Math.max(distance, 0), radius * 2);
    const area = 2 * radius * radius * Math.acos(clamped / (2 * radius))
        - 0.5 * clamped * Math.sqrt(Math.max(0, 4 * radius * radius - clamped * clamped));
    return area / (Math.PI * radius * radius);
}

export function rectFromCenter(center: THREE.Vector2, size: { width: number; height: number }): ScreenRect {
    return {
        left: center.x - size.width / 2,
        top: center.y - size.height / 2,
        right: center.x + size.width / 2,
        bottom: center.y + size.height / 2,
    };
}

export function clampRectToViewport(rect: ScreenRect, viewport: { width: number; height: number }, margin: number) {
    const dx = Math.max(margin - rect.left, 0) - Math.max(rect.right - (viewport.width - margin), 0);
    const dy = Math.max(margin - rect.top, 0) - Math.max(rect.bottom - (viewport.height - margin), 0);
    return {
        left: rect.left + dx,
        top: rect.top + dy,
        right: rect.right + dx,
        bottom: rect.bottom + dy,
    };
}

export function panelPlacementFromRect(
    anchorScreen: THREE.Vector2,
    rect: ScreenRect,
    preferredAlign: 'left' | 'right',
    startOffset: [number, number] = [0, 0],
    attachSide: PanelAttachSide = 'left'
): PanelPlacement {
    const centerX = (rect.left + rect.right) / 2;
    const align = Math.abs(centerX - anchorScreen.x) < 24 ? preferredAlign : centerX < anchorScreen.x ? 'right' : 'left';
    return {
        x: align === 'right' ? rect.right - anchorScreen.x : rect.left - anchorScreen.x,
        y: rect.top - anchorScreen.y,
        align,
        startOffset,
        attachSide,
        direction: new THREE.Vector2(1, 0),
    };
}

export function attachSideFromDirection(direction: THREE.Vector2): PanelAttachSide {
    if (Math.abs(direction.y) > Math.abs(direction.x)) {
        return direction.y > 0 ? 'top' : 'bottom';
    }
    return direction.x > 0 ? 'left' : 'right';
}

export function attachSideFromCard(
    x: number,
    y: number,
    width: number,
    height: number,
    align: 'left' | 'right',
    startOffset: [number, number]
) {
    const cardLeft = align === 'right' ? x - width : x;
    const cardCenter = new THREE.Vector2(cardLeft + width / 2, y + height / 2);
    const start = new THREE.Vector2(startOffset[0], startOffset[1]);
    const direction = cardCenter.sub(start);
    if (direction.lengthSq() < 0.001) {
        direction.set(1, 0);
    }
    return attachSideFromDirection(direction);
}

export function layoutPanelPlacements(
    anchorScreen: THREE.Vector2,
    panelSizes: Array<{ width: number; height: number }>,
    viewport: { width: number; height: number },
    orderOffset = 0,
    anchorScale = 1
): PanelPlacement[] {
    void orderOffset;
    void anchorScale;
    const placements: PanelPlacement[] = [];
    // 九宫格固定位置（右、上、左、下、右上、左上、左下、右下）
    const slots: Array<{
        col: number;
        row: number;
        attach: 'left' | 'right' | 'top' | 'bottom';
        align: 'left' | 'right';
        direction: THREE.Vector2;
    }> = [
        { col: 2, row: 1, attach: 'left', align: 'left', direction: new THREE.Vector2(1, 0) },      // 右
        { col: 1, row: 0, attach: 'bottom', align: 'left', direction: new THREE.Vector2(0, -1) },   // 上：连面板下边中点
        { col: 0, row: 1, attach: 'right', align: 'right', direction: new THREE.Vector2(-1, 0) },   // 左
        { col: 1, row: 2, attach: 'top', align: 'left', direction: new THREE.Vector2(0, 1) },       // 下：连面板上边中点
        { col: 2, row: 0, attach: 'left', align: 'left', direction: new THREE.Vector2(1, -1).normalize() },   // 右上
        { col: 0, row: 0, attach: 'right', align: 'right', direction: new THREE.Vector2(-1, -1).normalize() }, // 左上
        { col: 0, row: 2, attach: 'right', align: 'right', direction: new THREE.Vector2(-1, 1).normalize() },  // 左下
        { col: 2, row: 2, attach: 'left', align: 'left', direction: new THREE.Vector2(1, 1).normalize() },     // 右下
    ];

    const cellWidth = viewport.width / 3;
    const cellHeight = viewport.height / 3;
    const margin = 24;

    panelSizes.forEach((size, index) => {
        const slot = slots[index % slots.length];
        // 计算该九宫格单元格的中心点（屏幕绝对坐标）
        const cellCenterX = cellWidth * (slot.col + 0.5);
        const cellCenterY = cellHeight * (slot.row + 0.5);
        // 面板左上角坐标（居中于单元格）
        let left = cellCenterX - size.width / 2;
        let top = cellCenterY - size.height / 2;

        // 每个格子的微调（基于视口百分比，可根据需要调整）
        switch (index) {
            case 0: // 右
                left -= viewport.width * 0.125;
                break;
            case 1: // 上
                top += viewport.height * 0.05;
                break;
            case 2: // 左
                left += viewport.width * 0.275;
                break;
            case 3: // 下
                top -= viewport.height * 0.05;
                break;
            case 4: // 右上
                left -= viewport.width * 0.125;
                top += viewport.height * 0.05;
                break;
            case 5: // 左上
                left += viewport.width * 0.275;
                top += viewport.height * 0.05;
                break;
            case 6: // 左下
                left += viewport.width * 0.275;
                top -= viewport.height * 0.05;
                break;
            case 7: // 右下
                left -= viewport.width * 0.125;
                top -= viewport.height * 0.05;
                break;
            default:
                break;
        }

        // 限制在视口内（四周留边距）
        left = Math.max(margin, Math.min(viewport.width - size.width - margin, left));
        top = Math.max(margin, Math.min(viewport.height - size.height - margin, top));

        // 相对于城市锚点的偏移（用于引导线）
        const offsetX = left - anchorScreen.x;
        const offsetY = top - anchorScreen.y;

        placements.push({
            x: offsetX,
            y: offsetY,
            align: slot.align,
            startOffset: [0, 0],
            attachSide: slot.attach,
            direction: slot.direction.clone(),
        });
    });

    return placements;
}

export function leaderLineHtml(
    cardX: number,
    cardY: number,
    cardHeight: number,
    align: 'left' | 'right',
    endInset = 8,
    opacity = 0.58,
    startOffset: [number, number] = [0, 0],
    attachSide: PanelAttachSide = align === 'right' ? 'right' : 'left',
    cardWidth = LABEL_CONFIG.cardWidth,
    simpleDirection?: THREE.Vector2
) {
    const [startX, startY] = startOffset;
    const cardLeft = align === 'right' ? cardX - cardWidth : cardX;
    const cardRight = cardLeft + cardWidth;
    const cardTop = cardY;
    const cardBottom = cardTop + cardHeight;
    let lineEndX: number;
    let lineEndY: number;

    if (attachSide === 'right') {
        lineEndX = cardRight + endInset;
        lineEndY = cardTop + (simpleDirection ? cardHeight * 0.5 : Math.min(cardHeight * 0.5, 32));
    } else if (attachSide === 'right-top') {
        lineEndX = cardRight + endInset;
        lineEndY = cardTop - endInset;
    } else if (attachSide === 'right-bottom') {
        lineEndX = cardRight + endInset;
        lineEndY = cardBottom + endInset;
    } else if (attachSide === 'top') {
        lineEndX = cardLeft + cardWidth * 0.5;
        lineEndY = cardTop - endInset;
    } else if (attachSide === 'bottom') {
        lineEndX = cardLeft + cardWidth * 0.5;
        lineEndY = cardBottom + endInset;
    } else if (attachSide === 'left-top') {
        lineEndX = cardLeft - endInset;
        lineEndY = cardTop - endInset;
    } else if (attachSide === 'left-bottom') {
        lineEndX = cardLeft - endInset;
        lineEndY = cardBottom + endInset;
    } else {
        lineEndX = cardLeft - endInset;
        lineEndY = cardTop + (simpleDirection ? cardHeight * 0.5 : Math.min(cardHeight * 0.5, 32));
    }

    const deltaX = lineEndX - startX;
    const deltaY = lineEndY - startY;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);
    let pathPoints: Array<[number, number]>;

    if (simpleDirection && Math.abs(simpleDirection.x) > 0.01 && Math.abs(simpleDirection.y) > 0.01) {
        const horizontalFirst = Math.abs(simpleDirection.x) >= Math.abs(simpleDirection.y);
        pathPoints = horizontalFirst
            ? [[startX, startY], [lineEndX, startY], [lineEndX, lineEndY]]
            : [[startX, startY], [startX, lineEndY], [lineEndX, lineEndY]];
    } else if (simpleDirection || absX < 18 || absY < 18) {
        pathPoints = [[startX, startY], [lineEndX, lineEndY]];
    } else if (attachSide === 'top' || attachSide === 'bottom') {
        const elbowY = startY + deltaY * 0.52;
        pathPoints = [[startX, startY], [startX, elbowY], [lineEndX, elbowY], [lineEndX, lineEndY]];
    } else {
        const elbowX = startX + deltaX * 0.52;
        pathPoints = [[startX, startY], [elbowX, startY], [elbowX, lineEndY], [lineEndX, lineEndY]];
    }

    const minX = Math.min(...pathPoints.map(([x]) => x)) - 8;
    const minY = Math.min(...pathPoints.map(([, y]) => y)) - 8;
    const maxX = Math.max(...pathPoints.map(([x]) => x)) + 8;
    const maxY = Math.max(...pathPoints.map(([, y]) => y)) + 8;
    const points = pathPoints.map(([x, y]) => `${x - minX},${y - minY}`).join(' ');
    const endDot = pathPoints[pathPoints.length - 1];

    return `
        <svg style="position:absolute;left:${minX}px;top:${minY}px;width:${maxX - minX}px;height:${maxY - minY}px;overflow:visible;pointer-events:none;z-index:1">
            <polyline points="${points}" fill="none" stroke="rgba(103,232,249,${opacity})" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"></polyline>
        </svg>
        <span style="position:absolute;left:${startX - 3}px;top:${startY - 3}px;width:6px;height:6px;border-radius:999px;background:rgba(103,232,249,0.82);box-shadow:0 0 10px rgba(103,232,249,0.7);z-index:2"></span>
        <span style="position:absolute;left:${endDot[0] - 3}px;top:${endDot[1] - 3}px;width:6px;height:6px;border-radius:999px;background:rgba(103,232,249,0.92);box-shadow:0 0 10px rgba(103,232,249,0.76);z-index:2"></span>
    `;
}

export function warehouseLabelHtml(cityName: string, data: Record<string, any>, layout: LabelLayout) {
    const label = data.label || cityName;
    const cardTransform = layout.align === 'right' ? 'translateX(-100%)' : 'none';
    const attachSide = attachSideFromCard(
        layout.x,
        layout.y,
        LABEL_CONFIG.cardWidth,
        LABEL_CONFIG.cardHeight,
        layout.align,
        layout.startOffset
    );
    return `
        ${leaderLineHtml(layout.x, layout.y, LABEL_CONFIG.cardHeight, layout.align, 8, 0.58, layout.startOffset, attachSide, LABEL_CONFIG.cardWidth)}
        <span style="
            position:absolute;
            left:${layout.x}px;
            top:${layout.y}px;
            transform:${cardTransform};
            display:block;
            z-index:2;
            min-width:112px;
            border:1px solid rgba(103,232,249,0.32);
            border-radius:7px;
            background:linear-gradient(180deg, rgba(15,23,42,0.94), rgba(8,13,24,0.82));
            box-shadow:0 14px 34px rgba(8,47,73,0.46), inset 0 1px 0 rgba(255,255,255,0.08);
            padding:7px 10px 8px;
            text-shadow:0 1px 10px rgba(8,47,73,0.9);
            white-space:nowrap;
        ">
            <span style="display:block;color:#cffafe;font-size:12px;font-weight:700;line-height:16px">${label}</span>
            <span style="display:block;color:#94a3b8;font-size:10px;line-height:13px">库存 ${data.inventory ?? '--'} 吨</span>
        </span>
    `;
}

export function labelAnchorScale(camera: THREE.PerspectiveCamera | null) {
    if (!camera) return 1;
    return THREE.MathUtils.clamp(68 / Math.max(camera.position.y, 1), 0.38, 1.02);
}
