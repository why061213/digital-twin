/* Hallmark · pre-emit critique: P4 H5 E4 S5 R5 V4 */
import * as THREE from 'three';

type VehicleSceneInfo = {
    plate?: string;
    status?: string;
    speedKmh?: number | null;
    stateStr?: string;
};

type VehicleWithSceneLabel = {
    lineId: string;
    bar: THREE.Mesh;
    info: VehicleSceneInfo;
    sceneLabel?: THREE.Sprite;
    sceneLabelSignature?: string;
};

const ABNORMAL_STATE_PATTERN = /报警|异常|故障|离线|失联|断电|超速|偏航|越界|危险|事故/;
const STOPPED_STATE_PATTERN = /停车|停驶|静止|熄火|驻车/;

function classifyState(info: VehicleSceneInfo) {
    const state = `${info.stateStr ?? ''} ${info.status ?? ''}`.trim();
    if (ABNORMAL_STATE_PATTERN.test(state)) return { kind: 'abnormal', label: '异常', color: '#fb7185' } as const;
    if (STOPPED_STATE_PATTERN.test(state)) return { kind: 'stopped', label: '停车', color: '#fbbf24' } as const;
    return { kind: 'running', label: '运输中', color: '' } as const;
}

function fitText(context: CanvasRenderingContext2D, value: string, maxWidth: number) {
    if (context.measureText(value).width <= maxWidth) return value;
    let result = value;
    while (result.length > 1 && context.measureText(`${result}...`).width > maxWidth) {
        result = result.slice(0, -1);
    }
    return `${result}...`;
}

function createLabelTexture(info: VehicleSceneInfo, accentColor: number) {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 136;
    const context = canvas.getContext('2d');
    if (!context) return null;

    const state = classifyState(info);
    const accent = state.color || `#${new THREE.Color(accentColor).getHexString()}`;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = 'rgba(2, 8, 20, 0.86)';
    context.beginPath();
    context.roundRect(8, 8, 624, 120, 12);
    context.fill();
    context.strokeStyle = `${accent}aa`;
    context.lineWidth = state.kind === 'running' ? 2 : 5;
    context.stroke();

    context.fillStyle = accent;
    context.fillRect(8, 8, 8, 120);
    context.font = '600 32px "Microsoft YaHei", sans-serif';
    context.fillText(fitText(context, info.plate || '--', 250), 34, 52);

    context.font = '600 23px "Microsoft YaHei", sans-serif';
    const stateText = state.kind === 'running' ? state.label : state.label;
    context.fillStyle = accent;
    context.textAlign = 'right';
    context.fillText(stateText, 608, 50);

    context.textAlign = 'left';
    context.font = '400 21px "Microsoft YaHei", sans-serif';
    context.fillStyle = state.kind === 'running' ? '#94a3b8' : accent;
    const detailText = state.kind === 'running'
        ? '当前速度'
        : fitText(context, info.stateStr || info.status || '请关注车辆状态', 430);
    context.fillText(detailText, 34, 98);

    const speed = Number(info.speedKmh);
    context.textAlign = 'right';
    context.fillStyle = '#94a3b8';
    context.fillText(Number.isFinite(speed) ? `${Math.round(speed)} km/h` : '-- km/h', 608, 98);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
}

export function updateVehicleSceneLabel(
    vehicle: VehicleWithSceneLabel,
    mode: 'rm1' | 'rm2',
    accentColor: number,
    visible: boolean,
) {
    if (!visible) {
        if (vehicle.sceneLabel) vehicle.sceneLabel.visible = false;
        return;
    }

    const signature = JSON.stringify([
        vehicle.info.plate,
        vehicle.info.status,
        vehicle.info.speedKmh,
        vehicle.info.stateStr,
        accentColor,
    ]);
    if (!vehicle.sceneLabel) {
        const material = new THREE.SpriteMaterial({
            transparent: true,
            depthTest: false,
            depthWrite: false,
        });
        const sprite = new THREE.Sprite(material);
        const baseScale = mode === 'rm2' ? [8.8, 1.87] : [4.6, 0.98];
        const referenceDistance = mode === 'rm2' ? 115 : 180;
        sprite.scale.set(baseScale[0], baseScale[1], 1);
        sprite.position.set(0, mode === 'rm2' ? 5.2 : 2.55, 0);
        sprite.renderOrder = 96;
        const worldPosition = new THREE.Vector3();
        sprite.onBeforeRender = (_renderer, _scene, camera) => {
            const distance = camera.position.distanceTo(sprite.getWorldPosition(worldPosition));
            const distanceScale = THREE.MathUtils.clamp(distance / referenceDistance, 0.72, 2.1);
            sprite.scale.set(baseScale[0] * distanceScale, baseScale[1] * distanceScale, 1);
        };
        vehicle.bar.add(sprite);
        vehicle.sceneLabel = sprite;
    }

    if (vehicle.sceneLabelSignature !== signature) {
        const texture = createLabelTexture(vehicle.info, accentColor);
        if (texture) {
            const material = vehicle.sceneLabel.material as THREE.SpriteMaterial;
            material.map?.dispose();
            material.map = texture;
            material.needsUpdate = true;
            vehicle.sceneLabelSignature = signature;
        }
    }
    vehicle.sceneLabel.visible = true;
}
