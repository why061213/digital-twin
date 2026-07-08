import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RefObject } from 'react';
import type { ViewMode } from '../types';
import type { TownRoadMap3DHandle, TownRoadRenderCommand, TownTransportTask } from '../modules/TownRoadMap3D';
import { mockTownProvinceRenderCommand } from '../mock/townRenderCommand';

type UseTownRoadControllerParams = {
    view: ViewMode;
    townRoadMapRef: RefObject<TownRoadMap3DHandle | null>;
};

function commandOrders(command: TownRoadRenderCommand): TownTransportTask[] {
    return command.orders?.length ? command.orders : (command.tasks ?? []);
}

function commandRenderProvinces(command: TownRoadRenderCommand): string[] {
    return command.renderProvinces?.length ? command.renderProvinces : (command.renderAdcodes ?? []);
}

export function useTownRoadController({ view, townRoadMapRef }: UseTownRoadControllerParams) {
    const [townCommand, setTownCommand] = useState<TownRoadRenderCommand>(mockTownProvinceRenderCommand);

    const townTasks = useMemo<TownTransportTask[]>(() => commandOrders(townCommand), [townCommand]);

    useEffect(() => {
        if (view !== 'townRoadMap') return;
        townRoadMapRef.current?.setRenderCommand(townCommand);
    }, [townCommand, townRoadMapRef, view]);

    const handleTownRoadRenderCommand = useCallback((command: TownRoadRenderCommand) => {
        const orders = command.orders ?? command.tasks ?? [];
        const renderProvinces = command.renderProvinces ?? command.renderAdcodes ?? [];

        setTownCommand({
            ...command,
            type: 'town_road_render',
            renderLevel: command.renderLevel ?? 'province-district',
            renderProvinces,
            orders,
            // 保留旧字段，避免当前版本其他组件还读 tasks/renderAdcodes 时空掉。
            renderAdcodes: command.renderAdcodes ?? renderProvinces,
            tasks: command.tasks ?? orders,
            issuedAt: command.issuedAt ?? new Date().toISOString(),
        });
    }, []);

    const townSummary = useMemo(() => {
        const activeTasks = townTasks.filter((task) => !task.deleted && task.status !== '已取消');
        const destinationNames = new Set(activeTasks.map((task) => task.to.name));
        const sourceNames = new Set(activeTasks.map((task) => task.from.name));
        const transporting = activeTasks.filter((task) => task.status.includes('运输')).length;
        const loading = activeTasks.filter((task) => task.status.includes('装载')).length;
        const finished = activeTasks.filter((task) => task.status.includes('完成')).length;
        const provinces = commandRenderProvinces(townCommand);

        return {
            title: townCommand.title ?? activeTasks[0]?.groupName ?? '区镇短途配送',
            description: townCommand.description ?? '后端命令指定省份和订单批次',
            renderCount: provinces.length,
            renderLevel: townCommand.renderLevel ?? 'province-district',
            taskCount: activeTasks.length,
            sourceCount: sourceNames.size,
            destinationCount: destinationNames.size,
            transporting,
            loading,
            finished,
        };
    }, [townCommand, townTasks]);

    const reloadMockTownCommand = useCallback(() => {
        setTownCommand({
            ...mockTownProvinceRenderCommand,
            commandId: `mock-province-orders-${Date.now()}`,
            issuedAt: new Date().toISOString(),
        });
    }, []);

    return {
        townCommand,
        townTasks,
        townSummary,
        handleTownRoadRenderCommand,
        reloadMockTownCommand,
    };
}
