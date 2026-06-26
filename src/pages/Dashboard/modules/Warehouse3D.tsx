import { Canvas } from '@react-three/fiber';
import { OrbitControls, Grid } from '@react-three/drei';
import { useMemo } from 'react';
import * as THREE from 'three';

// 货位数据（模拟）
const shelves = [
    { id: 1, position: [-4, 0.5, 3], status: 'occupied' },
    { id: 2, position: [-2, 0.5, 3], status: 'idle' },
    { id: 3, position: [0, 0.5, 3], status: 'pending' },
    { id: 4, position: [2, 0.5, 3], status: 'occupied' },
    { id: 5, position: [4, 0.5, 3], status: 'idle' },
    { id: 6, position: [-4, 0.5, -1], status: 'idle' },
    { id: 7, position: [-2, 0.5, -1], status: 'occupied' },
    { id: 8, position: [0, 0.5, -1], status: 'pending' },
    { id: 9, position: [2, 0.5, -1], status: 'idle' },
    { id: 10, position: [4, 0.5, -1], status: 'occupied' },
] as const;

const statusColorMap = {
    idle: '#22c55e',
    occupied: '#ef4444',
    pending: '#f59e0b',
};

// 单个货位方块
function ShelfSlot({
                       position,
                       status,
                   }: {
    position: [number, number, number];
    status: keyof typeof statusColorMap;
}) {
    const color = statusColorMap[status];
    return (
        <mesh position={position}>
            <boxGeometry args={[1.2, 0.8, 1.2]} />
            <meshStandardMaterial
                color={color}
                emissive={color}
                emissiveIntensity={0.4}
            />
        </mesh>
    );
}

// 场景内容
function WarehouseScene() {
    const shelfElements = useMemo(
        () =>
            shelves.map((s) => (
                <ShelfSlot key={s.id} position={[...s.position]} status={s.status} />
            )),
        []
    );

    return (
        <>
            {/* 灯光 */}
            <ambientLight intensity={0.4} />
            <directionalLight position={[8, 12, 8]} intensity={0.8} castShadow />
            <pointLight position={[0, 4, 0]} intensity={0.5} color="#22d3ee" />

            {/* 地面网格 */}
            <Grid
                args={[30, 30]}
                position={[0, -0.01, 0]}
                cellSize={1}
                cellThickness={0.5}
                cellColor="#1e3a5f"
                sectionSize={5}
                sectionThickness={1.5}
                sectionColor="#0ea5e9"
                fadeDistance={50}
                infiniteGrid
            />

            {/* 货架底座（一条长台） */}
            <mesh position={[0, -0.2, 1]} receiveShadow>
                <boxGeometry args={[11, 0.2, 5]} />
                <meshStandardMaterial color="#1e293b" />
            </mesh>

            {/* 货位方块 */}
            {shelfElements}

            {/* 相机控制 */}
            <OrbitControls
                enableDamping
                dampingFactor={0.1}
                maxPolarAngle={Math.PI / 2.2}
                target={[0, 0.5, 1]}
            />
        </>
    );
}

function Warehouse3D() {
    return (
        <div className="w-full h-full">
            <Canvas
                camera={{ position: [10, 8, 12], fov: 45 }}
                shadows
                gl={{ antialias: true }}
                // 手动设置场景背景色（深蓝黑），替代 Environment
                onCreated={({ scene }) => {
                    scene.background = new THREE.Color('#0a0e17');
                    scene.fog = new THREE.Fog('#0a0e17', 15, 40);
                }}
            >
                <WarehouseScene />
            </Canvas>
        </div>
    );
}

export default Warehouse3D;
