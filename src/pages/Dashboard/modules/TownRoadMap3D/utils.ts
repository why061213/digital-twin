export function parseAdcodeList(list: Array<{ adcode: number }>) {
    return list.map(item => item.adcode);
}