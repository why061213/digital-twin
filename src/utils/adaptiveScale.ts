// src/utils/adaptiveScale.ts
export const setupAdaptiveScale = (
    container: HTMLElement,
    designWidth = 1920,
    designHeight = 1080
) => {
    const setScale = () => {
        const windowWidth = window.innerWidth;
        const windowHeight = window.innerHeight;
        const scaleX = windowWidth / designWidth;
        const scaleY = windowHeight / designHeight;
        const scale = Math.min(scaleX, scaleY);

        container.style.transform = `scale(${scale})`;
        container.style.transformOrigin = 'left top';
        container.style.width = `${designWidth}px`;
        container.style.height = `${designHeight}px`;
    };

    setScale();
    window.addEventListener('resize', setScale);
    return () => window.removeEventListener('resize', setScale);
};