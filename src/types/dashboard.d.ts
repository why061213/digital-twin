export interface ShelfData {
    id: string;
    position: [number, number, number];
    status: 'idle' | 'occupied' | 'pending';
}
export interface dashBoardSummary {
    total: number;
    in: number;
    out: number;
}