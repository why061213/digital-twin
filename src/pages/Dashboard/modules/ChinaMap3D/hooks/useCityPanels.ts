import { useCallback, useEffect } from 'react';
import * as THREE from 'three';
import * as echarts from 'echarts';
import { LABEL_CONFIG } from '@/config/labelLayout';
import {
    projectToScreen,
    leaderLineHtml,
    layoutPanelPlacements,
    attachSideFromCard,
    labelAnchorScale,
} from '../labelUtils';
import { normalizeCityName, octagonStartOffset } from '../utils';
import { useChinaMapRefs } from './useChinaMapRefs';
import type { PanelData, PanelStyle, LabelLayout } from '../types';

export function useCityPanels(
    refs: ReturnType<typeof useChinaMapRefs>,
    findCityKey: (cityName: string) => string | undefined,
    applyLabelVisibility: () => void,
) {
    const showCityPanels = useCallback(
        (cityName: string, panels: PanelData[], style?: PanelStyle) => {
            console.log('🎯 showCityPanels 进入', cityName);
            const matchedKey = findCityKey(cityName);
            if (!matchedKey) {
                refs.pendingCityPanelsRef.current.set(cityName, panels);
                refs.pendingCityPanelsRef.current.set(normalizeCityName(cityName), panels);
                if (style) {
                    refs.pendingCityPanelStylesRef.current.set(cityName, style);
                    refs.pendingCityPanelStylesRef.current.set(normalizeCityName(cityName), style);
                }
                console.warn('⏳ 城市 mesh 尚未就绪，暂存面板:', cityName);
                return;
            }
            refs.cityPanelDataRef.current.set(matchedKey, panels);
            if (style) {
                refs.cityPanelStyleRef.current.set(matchedKey, style);
            }
            const group = refs.meshMapRef.current[matchedKey];
            if (!group) {
                refs.pendingCityPanelsRef.current.set(cityName, panels);
                refs.pendingCityPanelsRef.current.set(matchedKey, panels);
                if (style) {
                    refs.pendingCityPanelStylesRef.current.set(cityName, style);
                    refs.pendingCityPanelStylesRef.current.set(matchedKey, style);
                }
                console.warn('❌ group 未找到，matchedKey:', matchedKey);
                return;
            }

            // 移除旧面板
            const oldPanel = refs.cityPanelMapRef.current.get(matchedKey);
            if (oldPanel) {
                refs.cityPanelChartsRef.current.get(matchedKey)?.forEach((chart) => chart.dispose());
                refs.cityPanelChartsRef.current.delete(matchedKey);
                oldPanel.remove();
                refs.cityPanelMapRef.current.delete(matchedKey);
            }

            const layout = (group.userData.labelLayout as LabelLayout | undefined) ?? {
                x: 96,
                y: -58,
                align: 'left' as const,
                startOffset: octagonStartOffset(0, labelAnchorScale(refs.cameraRef.current)),
            };
            const panelStyle = style ?? refs.cityPanelStyleRef.current.get(matchedKey) ?? {};
            const panelMinWidth = LABEL_CONFIG.panels.minWidth;
            const panelMinHeight = LABEL_CONFIG.panels.minHeight;
            const panelWidth = Math.max(panelMinWidth, panelStyle.width ?? LABEL_CONFIG.panels.width);
            const panelMaxHeight = panelStyle.maxHeight ?? LABEL_CONFIG.panels.maxHeight;
            const panelPadding = panelStyle.padding ?? LABEL_CONFIG.panels.padding;
            const titleFontSize = panelStyle.titleFontSize ?? LABEL_CONFIG.panels.titleFontSize;
            const bodyFontSize = panelStyle.bodyFontSize ?? LABEL_CONFIG.panels.bodyFontSize;
            const chartTextFontSize = panelStyle.chartTextFontSize ?? 10;
            const anchor = group.userData.labelAnchor as THREE.Vector3 | undefined;
            const camera = refs.cameraRef.current;
            const containerEl = refs.containerRef.current;
            if (!anchor || !camera || !containerEl) {
                refs.pendingCityPanelsRef.current.set(cityName, panels);
                refs.pendingCityPanelsRef.current.set(matchedKey, panels);
                if (style) {
                    refs.pendingCityPanelStylesRef.current.set(cityName, style);
                    refs.pendingCityPanelStylesRef.current.set(matchedKey, style);
                }
                console.warn('❌ 缺少 anchor/camera/containerEl', { anchor: !!anchor, camera: !!camera, container: !!containerEl });
                return;
            }
            const anchorScreen = projectToScreen(anchor, camera, containerEl);

            const panelDiv = document.createElement('div');
            panelDiv.style.position = 'absolute';
            panelDiv.style.left = '0';
            panelDiv.style.top = '0';
            panelDiv.style.width = '100%';
            panelDiv.style.height = '100%';
            panelDiv.style.zIndex = '90';
            panelDiv.style.pointerEvents = 'none';
            panelDiv.style.display = 'none';
            panelDiv.style.opacity = '0';
            panelDiv.style.transition = 'opacity 240ms ease';
            panelDiv.dataset.cityPanel = matchedKey;

            const charts: echarts.ECharts[] = [];
            const titleBlockHeight =
                Math.round(titleFontSize * 1.35) +
                Math.max(5, Math.round(titleFontSize * 0.55)) +
                Math.max(4, Math.round(titleFontSize * 0.42));

            const responsiveChartOption = (
                panel: PanelData,
                chartWidth: number,
                chartHeight: number,
            ) => {
                const baseOption = panel.option ?? {};
                const series = Array.isArray(baseOption.series) ? baseOption.series : [];
                const isCircularChart = panel.chartType === 'pie' || panel.chartType === 'ring';
                const shortSide = Math.max(80, Math.min(chartWidth, chartHeight));
                const labelFontSize = Math.max(9, Math.min(13, chartTextFontSize));
                const circularLabelWidth = Math.max(34, Math.floor((chartWidth - shortSide * 0.62) / 2));

                const nextSeries = series.map((item: any) => {
                    if (item?.type !== 'pie') {
                        return {
                            ...item,
                            symbolSize: panel.chartType === 'line' ? Math.max(4, Math.round(shortSide * 0.045)) : item?.symbolSize,
                            barWidth: panel.chartType === 'bar' ? `${Math.max(24, Math.min(48, Math.round(chartWidth * 0.12)))}%` : item?.barWidth,
                        };
                    }

                    return {
                        ...item,
                        center: item.center ?? ['50%', chartHeight < 145 ? '50%' : '52%'],
                        radius: panel.chartType === 'ring'
                            ? [
                                `${Math.max(30, Math.min(44, Math.round(shortSide * 0.2)))}%`,
                                `${Math.max(50, Math.min(66, Math.round(shortSide * 0.34)))}%`,
                            ]
                            : `${Math.max(44, Math.min(58, Math.round(shortSide * 0.32)))}%`,
                        avoidLabelOverlap: true,
                        minShowLabelAngle: chartWidth < 260 ? 10 : 5,
                        label: {
                            show: true,
                            color: '#e2e8f0',
                            fontSize: labelFontSize,
                            width: circularLabelWidth,
                            overflow: 'truncate',
                            ellipsis: '…',
                            ...(item.label ?? {}),
                        },
                        labelLine: {
                            show: true,
                            length: Math.max(8, Math.round(shortSide * 0.08)),
                            length2: Math.max(8, Math.round(chartWidth * 0.06)),
                            smooth: 0.25,
                            ...(item.labelLine ?? {}),
                        },
                    };
                });

                return {
                    ...baseOption,
                    textStyle: {
                        color: '#cbd5e1',
                        fontSize: chartTextFontSize,
                        ...(baseOption.textStyle ?? {}),
                    },
                    color: baseOption.color ?? ['#22d3ee', '#fbbf24', '#38bdf8', '#34d399', '#a78bfa'],
                    tooltip: {
                        trigger: 'item',
                        backgroundColor: 'rgba(2,6,23,0.92)',
                        borderColor: 'rgba(103,232,249,0.28)',
                        textStyle: { color: '#e2e8f0' },
                        ...(baseOption.tooltip ?? {}),
                    },
                    grid: !isCircularChart
                        ? {
                            left: Math.max(28, Math.round(chartWidth * 0.13)),
                            right: Math.max(10, Math.round(chartWidth * 0.05)),
                            top: Math.max(12, Math.round(chartHeight * 0.12)),
                            bottom: Math.max(20, Math.round(chartHeight * 0.18)),
                            containLabel: true,
                            ...(baseOption.grid ?? {}),
                        }
                        : baseOption.grid,
                    legend: isCircularChart
                        ? {
                            show: false,
                            ...(baseOption.legend ?? {}),
                            textStyle: {
                                color: '#cbd5e1',
                                fontSize: labelFontSize,
                                ...(baseOption.legend?.textStyle ?? {}),
                            },
                        }
                        : baseOption.legend,
                    series: nextSeries,
                };
            };

            const renderTable = (section: HTMLDivElement, panel: PanelData) => {
                const table = document.createElement('table');
                table.style.width = '100%';
                table.style.color = '#e2e8f0';
                table.style.fontSize = `${bodyFontSize}px`;
                table.style.borderCollapse = 'collapse';

                const rows = panel.rows ?? [];
                const columns = panel.columns?.length
                    ? panel.columns
                    : Object.keys(rows[0] ?? {}).map((key) => ({ key, label: key }));

                rows.forEach((row) => {
                    const tr = document.createElement('tr');
                    columns.forEach((column, index) => {
                        const cell = document.createElement('td');
                        cell.textContent = String(row[column.key] ?? '--');
                        cell.style.color = index === 0 ? '#94a3b8' : '#e2e8f0';
                        cell.style.padding = `${Math.max(2, Math.round(bodyFontSize * 0.28))}px 0`;
                        cell.style.textAlign = index === 0 ? 'left' : 'right';
                        cell.style.fontWeight = index === 0 ? '400' : '600';
                        cell.style.whiteSpace = 'nowrap';
                        tr.appendChild(cell);
                    });
                    table.appendChild(tr);
                });
                section.appendChild(table);
            };

            const renderChart = (section: HTMLDivElement, panel: PanelData, chartHeight: number, chartWidth: number) => {
                const chartDiv = document.createElement('div');
                chartDiv.style.width = '100%';
                chartDiv.style.height = `${chartHeight}px`;
                chartDiv.style.minHeight = `${chartHeight}px`;
                section.appendChild(chartDiv);

                window.setTimeout(() => {
                    if (!chartDiv.isConnected) return;
                    const chart = echarts.init(chartDiv, undefined, { renderer: 'canvas' });
                    chart.setOption(responsiveChartOption(panel, chartWidth, chartHeight));
                    charts.push(chart);
                    refs.cityPanelChartsRef.current.set(matchedKey, charts);
                    chart.resize({ width: chartWidth, height: chartHeight });
                }, 0);
            };

            const panelSizes = panels.map((panel) => {
                const rowCount = Math.max(1, panel.rows?.length ?? 3);
                const tableContentHeight = rowCount * Math.round(bodyFontSize * 1.95);
                // 表格高度不能只按配置硬裁，否则标题 + 多行数据会被 overflow:hidden 切掉。
                const tableMinHeight = panelPadding * 2 + titleBlockHeight + tableContentHeight;
                const chartNaturalHeight = Math.max(
                    panel.height ?? 110,
                    Math.round(panelWidth * (panel.chartType === 'pie' || panel.chartType === 'ring' ? 0.58 : 0.48)),
                );
                const desiredHeight = panel.chartType === 'table'
                    ? Math.max(panel.height ?? 96, tableMinHeight)
                    : panelPadding * 2 + titleBlockHeight + chartNaturalHeight;

                return {
                    width: panelWidth,
                    height: Math.max(panelMinHeight, Math.min(panelMaxHeight, desiredHeight)),
                };
            });
            const panelPlacements = layoutPanelPlacements(
                anchorScreen,
                panelSizes,
                {
                    width: containerEl?.clientWidth || 1920,
                    height: containerEl?.clientHeight || 1080,
                },
                1,
                labelAnchorScale(camera),
            );

            const viewWidth = containerEl?.clientWidth || 1920;
            const viewHeight = containerEl?.clientHeight || 1080;

            panels.forEach((panel, index) => {
                const cardHeight = panelSizes[index].height;
                const placement = panelPlacements[index] ?? {
                    x: layout.x,
                    y: layout.y + (index + 1) * (cardHeight + 12),
                    align: layout.align,
                    startOffset: [0, 0],
                    attachSide: attachSideFromCard(layout.x, layout.y, panelWidth, cardHeight, layout.align, [0, 0]),
                    direction: new THREE.Vector2(layout.x || 1, layout.y || 0).normalize(),
                };
                const cardX = anchorScreen.x + placement.x;
                const cardY = anchorScreen.y + placement.y;

                // 限制在屏幕内
                const maxX = Math.max(0, viewWidth - panelWidth);
                const maxY = Math.max(0, viewHeight - cardHeight);
                const clampedX = Math.max(0, Math.min(maxX, cardX));
                const clampedY = Math.max(0, Math.min(maxY, cardY));

                if (LABEL_CONFIG.panels.showLeaderLines) {
                    panelDiv.insertAdjacentHTML(
                        'beforeend',
                        leaderLineHtml(
                            clampedX,
                            clampedY,
                            cardHeight,
                            placement.align,
                            8,
                            index === 0 ? 0.48 : 0.34,
                            [anchorScreen.x, anchorScreen.y],
                            placement.attachSide,
                            panelWidth,
                            placement.direction,
                        ),
                    );
                }

                const section = document.createElement('div');
                section.style.position = 'absolute';
                section.style.left = `${clampedX}px`;
                section.style.top = `${clampedY}px`;
                section.style.transform = placement.align === 'right' ? 'translateX(-100%)' : 'none';
                section.style.width = `${panelWidth}px`;
                section.style.minWidth = `${panelMinWidth}px`;
                section.style.minHeight = `${panelMinHeight}px`;
                section.style.maxHeight = `${cardHeight}px`;
                section.style.boxSizing = 'border-box';
                section.style.padding = `${panelPadding}px`;
                section.style.overflow = 'hidden';
                section.style.pointerEvents = 'auto';
                section.style.zIndex = `${12 + index}`;
                section.style.border = LABEL_CONFIG.panels.border;
                section.style.borderRadius = `${LABEL_CONFIG.panels.borderRadius}px`;
                section.style.background = 'linear-gradient(180deg, rgba(15,23,42,0.95), rgba(8,13,24,0.86))';
                section.style.boxShadow = '0 12px 28px rgba(8,47,73,0.38), inset 0 1px 0 rgba(255,255,255,0.07)';
                section.style.backdropFilter = 'blur(8px)';
                section.style.whiteSpace = 'normal';

                // 标题
                const title = document.createElement('div');
                title.textContent = panel.title;
                title.style.color = '#cffafe';
                title.style.fontSize = `${titleFontSize}px`;
                title.style.fontWeight = '700';
                title.style.lineHeight = `${Math.round(titleFontSize * 1.35)}px`;
                title.style.marginBottom = `${Math.max(5, Math.round(titleFontSize * 0.55))}px`;
                title.style.paddingBottom = `${Math.max(4, Math.round(titleFontSize * 0.42))}px`;
                title.style.borderBottom = '1px solid rgba(103,232,249,0.18)';
                title.style.textShadow = '0 1px 10px rgba(8,47,73,0.9)';
                section.appendChild(title);

                if (panel.chartType === 'table') {
                    renderTable(section, panel);
                } else {
                    const chartHeight = Math.max(
                        80,
                        cardHeight - panelPadding * 2 - titleBlockHeight,
                    );
                    renderChart(section, panel, chartHeight, panelWidth - panelPadding * 2);
                }
                panelDiv.appendChild(section);
            });

            containerEl.appendChild(panelDiv);
            refs.cityPanelMapRef.current.set(matchedKey, panelDiv);
            console.log('✅ 面板已添加，当前面板 keys:', Array.from(refs.cityPanelMapRef.current.keys()));

            applyLabelVisibility();
            window.setTimeout(() => {
                refs.cityPanelChartsRef.current.get(matchedKey)?.forEach((chart) => chart.resize());
            }, 0);
        },
        [refs, findCityKey, applyLabelVisibility],
    );

    const cacheCityPanels = useCallback((cityName: string, panels: PanelData[], style?: PanelStyle) => {
        const matchedKey = findCityKey(cityName);
        if (matchedKey) {
            refs.cityPanelDataRef.current.set(matchedKey, panels);
            if (style) refs.cityPanelStyleRef.current.set(matchedKey, style);
            refs.pendingCityPanelsRef.current.delete(matchedKey);
            refs.pendingCityPanelsRef.current.delete(normalizeCityName(matchedKey));
            refs.pendingCityPanelStylesRef.current.delete(matchedKey);
            refs.pendingCityPanelStylesRef.current.delete(normalizeCityName(matchedKey));
            const visibility = refs.labelVisibilityRef.current;
            if (visibility.mode === 'focus' && visibility.focusedKey === matchedKey) {
                window.setTimeout(() => showCityPanels(matchedKey, panels, style), 0);
            }
        } else {
            refs.pendingCityPanelsRef.current.set(cityName, panels);
            refs.pendingCityPanelsRef.current.set(normalizeCityName(cityName), panels);
            if (style) {
                refs.pendingCityPanelStylesRef.current.set(cityName, style);
                refs.pendingCityPanelStylesRef.current.set(normalizeCityName(cityName), style);
            }
        }
    }, [refs, findCityKey, showCityPanels]);

    const showCachedCityPanels = useCallback((cityName: string) => {
        const matchedKey = findCityKey(cityName);
        if (!matchedKey) return false;

        const panels =
            refs.cityPanelDataRef.current.get(matchedKey) ??
            refs.pendingCityPanelsRef.current.get(matchedKey) ??
            refs.pendingCityPanelsRef.current.get(normalizeCityName(matchedKey)) ??
            refs.pendingCityPanelsRef.current.get(cityName) ??
            refs.pendingCityPanelsRef.current.get(normalizeCityName(cityName));
        if (!panels) return false;

        const style =
            refs.cityPanelStyleRef.current.get(matchedKey) ??
            refs.pendingCityPanelStylesRef.current.get(matchedKey) ??
            refs.pendingCityPanelStylesRef.current.get(normalizeCityName(matchedKey)) ??
            refs.pendingCityPanelStylesRef.current.get(cityName) ??
            refs.pendingCityPanelStylesRef.current.get(normalizeCityName(cityName));
        showCityPanels(matchedKey, panels, style);
        return true;
    }, [refs, findCityKey, showCityPanels]);

    const clearCityPanels = useCallback(
        (cityName: string) => {
            const matchedKey = findCityKey(cityName);
            if (!matchedKey) return;
            refs.cityPanelDataRef.current.delete(matchedKey);
            refs.cityPanelStyleRef.current.delete(matchedKey);
            const panel = refs.cityPanelMapRef.current.get(matchedKey);
            if (panel) {
                refs.cityPanelChartsRef.current.get(matchedKey)?.forEach((chart) => chart.dispose());
                refs.cityPanelChartsRef.current.delete(matchedKey);
                panel.remove();
                refs.cityPanelMapRef.current.delete(matchedKey);
            }
        },
        [refs, findCityKey],
    );

    useEffect(() => {
        refs.showCityPanelsRef.current = showCityPanels;
    }, [refs.showCityPanelsRef, showCityPanels]);

    return { showCityPanels, clearCityPanels, cacheCityPanels, showCachedCityPanels };
}
