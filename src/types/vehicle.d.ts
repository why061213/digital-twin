export interface ShelfData {
    id: string;
    position: [number, number, number];
    status: 'idle' | 'occupied' | 'pending';
}
export interface vehicleSummary {
    total: number;
    in: number;
    out: number;
}