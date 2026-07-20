import * as THREE from 'three';

export type VehicleAlarmSeverity = 'none' | 'warning' | 'critical';

type VehicleAlertInfo = {
    alarmStr?: string;
    alarmSeverity?: VehicleAlarmSeverity | string;
    stateStr?: string;
    online?: boolean;
};

type VehicleWithAlertRipple = {
    bar: THREE.Mesh;
    info: VehicleAlertInfo;
    alertRipple?: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
    alertSeverity?: VehicleAlarmSeverity;
};

const CRITICAL_PATTERN = /无效定位|离线|失联|故障|异常|紧急报警|碰撞报警|前向碰撞|行人碰撞|侧翻|危险预警|防劫|双手脱把|未检测到驾驶员|驾驶员异常/;
const WARNING_PATTERN = /停车超时|超速|疲劳|偏离|车距过近|预警|报警/;

export function resolveVehicleAlarmSeverity(info: VehicleAlertInfo): VehicleAlarmSeverity {
    if (info.alarmStr?.trim()) return 'critical';
    const description = info.stateStr?.trim() ?? '';
    if (CRITICAL_PATTERN.test(description)) return 'critical';
    if (info.online === false) return 'critical';
    if (WARNING_PATTERN.test(description)) return 'warning';
    if (description) return 'none';
    if (info.alarmSeverity === 'critical') return 'critical';
    if (info.alarmSeverity === 'warning') return 'warning';
    return 'none';
}

function createRippleMaterial(severity: Exclude<VehicleAlarmSeverity, 'none'>) {
    const critical = severity === 'critical';
    return new THREE.ShaderMaterial({
        uniforms: {
            uTime: { value: 0 },
            uPeriod: { value: critical ? 3 : 5 },
            uColor: { value: new THREE.Color(critical ? 0xff1744 : 0xff5a36) },
            uIntensity: { value: critical ? 1 : 0.76 },
        },
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform float uTime;
            uniform float uPeriod;
            uniform float uIntensity;
            uniform vec3 uColor;
            varying vec2 vUv;

            float ripple(float distanceFromCenter, float phase) {
                float radius = phase * 0.48;
                float width = mix(0.018, 0.008, phase);
                float ring = 1.0 - smoothstep(width, width * 2.2, abs(distanceFromCenter - radius));
                return ring * pow(1.0 - phase, 1.45);
            }

            void main() {
                vec2 centered = vUv - 0.5;
                float distanceFromCenter = length(centered);
                float phase = fract(uTime / uPeriod);
                float previousPhase = fract(phase + 0.46);
                float alpha = ripple(distanceFromCenter, phase);
                alpha += ripple(distanceFromCenter, previousPhase) * 0.42;
                alpha *= uIntensity;
                if (alpha < 0.012) discard;
                gl_FragColor = vec4(uColor, alpha);
            }
        `,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
    });
}

function createRipple(severity: Exclude<VehicleAlarmSeverity, 'none'>) {
    const material = createRippleMaterial(severity);
    const ripple = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    ripple.rotation.x = -Math.PI / 2;
    ripple.position.y = -0.12;
    ripple.renderOrder = 42;
    const worldPosition = new THREE.Vector3();
    ripple.onBeforeRender = (renderer, _scene, camera) => {
        material.uniforms.uTime.value = performance.now() / 1_000;
        const distance = camera.position.distanceTo(ripple.getWorldPosition(worldPosition));
        const perspectiveCamera = camera as THREE.PerspectiveCamera;
        const verticalFov = THREE.MathUtils.degToRad(perspectiveCamera.fov || 50);
        const visibleWorldHeight = 2 * distance * Math.tan(verticalFov / 2);
        const aspect = renderer.domElement.clientWidth / Math.max(1, renderer.domElement.clientHeight);
        const diameter = visibleWorldHeight * Math.min(0.52, 0.44 * Math.max(1, aspect));
        ripple.scale.setScalar(Math.max(8, diameter * 0.5));
    };
    return ripple;
}

export function syncVehicleAlertRipple(vehicle: VehicleWithAlertRipple) {
    const severity = resolveVehicleAlarmSeverity(vehicle.info);
    if (severity === 'none') {
        if (vehicle.alertRipple) vehicle.alertRipple.visible = false;
        vehicle.alertSeverity = 'none';
        return;
    }

    if (!vehicle.alertRipple || vehicle.alertSeverity !== severity) {
        if (vehicle.alertRipple) {
            vehicle.bar.remove(vehicle.alertRipple);
            vehicle.alertRipple.geometry.dispose();
            vehicle.alertRipple.material.dispose();
        }
        vehicle.alertRipple = createRipple(severity);
        vehicle.bar.add(vehicle.alertRipple);
    }
    vehicle.alertSeverity = severity;
    vehicle.alertRipple.visible = true;
}
