export type CircularQueuePatch<T> = Partial<T> | ((item: T) => T | Partial<T> | null | undefined);

export type CircularQueueUpdateOptions = {
    /**
     * 默认不修改 locked 节点。播放中的动画节点可以 locked，避免后端新数据把当前动画改掉。
     */
    skipLocked?: boolean;
};

type QueueNode<T extends { id: string; locked?: boolean }> = {
    item: T;
    previous: QueueNode<T>;
    next: QueueNode<T>;
};

export type CircularQueueSnapshot<T extends { id: string; locked?: boolean }> = {
    size: number;
    headId: string | null;
    tailId: string | null;
    currentId: string | null;
    items: T[];
};

function applyPatch<T extends { id: string; locked?: boolean }>(item: T, patch: CircularQueuePatch<T>): T | null {
    if (typeof patch === 'function') {
        const result = patch(item);
        if (!result) return null;
        if ('id' in result && Object.keys(result).length > 1) {
            return result as T;
        }
        return { ...item, ...(result as Partial<T>) };
    }

    return { ...item, ...patch };
}

/**
 * 循环双向链表队列。
 *
 * 适合动画编排：
 * - current 指向当前播放节点；
 * - head/tail 保留队列边界语义；
 * - next/previous 永远闭环，播放可以无缝循环；
 * - 未播放节点可以增删改，locked 节点默认不被覆盖。
 */
export class CircularAnimationQueue<T extends { id: string; locked?: boolean }> {
    private nodes = new Map<string, QueueNode<T>>();
    private headNode: QueueNode<T> | null = null;
    private tailNode: QueueNode<T> | null = null;
    private currentNode: QueueNode<T> | null = null;

    get size() {
        return this.nodes.size;
    }

    get head() {
        return this.headNode?.item ?? null;
    }

    get tail() {
        return this.tailNode?.item ?? null;
    }

    get current() {
        return this.currentNode?.item ?? null;
    }

    has(id: string) {
        return this.nodes.has(id);
    }

    get(id: string) {
        return this.nodes.get(id)?.item ?? null;
    }

    find(predicate: (item: T, index: number) => boolean) {
        return this.toArray().find(predicate) ?? null;
    }

    findAll(predicate: (item: T, index: number) => boolean) {
        return this.toArray().filter(predicate);
    }

    clear() {
        this.nodes.clear();
        this.headNode = null;
        this.tailNode = null;
        this.currentNode = null;
    }

    append(item: T) {
        this.assertNewId(item.id);
        const node = this.createDetachedNode(item);

        if (!this.headNode || !this.tailNode) {
            this.attachFirstNode(node);
            return item;
        }

        node.previous = this.tailNode;
        node.next = this.headNode;
        this.tailNode.next = node;
        this.headNode.previous = node;
        this.tailNode = node;
        this.nodes.set(item.id, node);
        return item;
    }

    prepend(item: T) {
        this.assertNewId(item.id);
        const node = this.createDetachedNode(item);

        if (!this.headNode || !this.tailNode) {
            this.attachFirstNode(node);
            return item;
        }

        node.previous = this.tailNode;
        node.next = this.headNode;
        this.tailNode.next = node;
        this.headNode.previous = node;
        this.headNode = node;
        this.nodes.set(item.id, node);
        return item;
    }

    insertAfter(anchorId: string, item: T) {
        this.assertNewId(item.id);
        const anchor = this.nodes.get(anchorId);
        if (!anchor) return false;

        const node = this.createDetachedNode(item);
        const next = anchor.next;
        node.previous = anchor;
        node.next = next;
        anchor.next = node;
        next.previous = node;
        if (this.tailNode === anchor) this.tailNode = node;
        this.nodes.set(item.id, node);
        return true;
    }

    insertBefore(anchorId: string, item: T) {
        this.assertNewId(item.id);
        const anchor = this.nodes.get(anchorId);
        if (!anchor) return false;

        const node = this.createDetachedNode(item);
        const previous = anchor.previous;
        node.previous = previous;
        node.next = anchor;
        previous.next = node;
        anchor.previous = node;
        if (this.headNode === anchor) this.headNode = node;
        this.nodes.set(item.id, node);
        return true;
    }

    remove(id: string) {
        const node = this.nodes.get(id);
        if (!node) return null;

        if (this.nodes.size === 1) {
            const item = node.item;
            this.clear();
            return item;
        }

        node.previous.next = node.next;
        node.next.previous = node.previous;
        if (this.headNode === node) this.headNode = node.next;
        if (this.tailNode === node) this.tailNode = node.previous;
        if (this.currentNode === node) this.currentNode = node.next;
        this.nodes.delete(id);
        return node.item;
    }

    update(id: string, patch: CircularQueuePatch<T>, options: CircularQueueUpdateOptions = {}) {
        const node = this.nodes.get(id);
        if (!node) return null;
        const skipLocked = options.skipLocked ?? true;
        if (skipLocked && node.item.locked) return node.item;

        const nextItem = applyPatch(node.item, patch);
        if (!nextItem) return null;

        if (nextItem.id !== id) {
            if (this.nodes.has(nextItem.id)) {
                throw new Error(`Duplicate queue node id after update: ${nextItem.id}`);
            }
            this.nodes.delete(id);
            this.nodes.set(nextItem.id, node);
        }

        node.item = nextItem;
        return nextItem;
    }

    upsertAppend(item: T, options: CircularQueueUpdateOptions = {}) {
        if (this.has(item.id)) {
            return this.update(item.id, item, options);
        }
        return this.append(item);
    }

    moveNext() {
        if (!this.currentNode) return null;
        this.currentNode = this.currentNode.next;
        return this.currentNode.item;
    }

    movePrevious() {
        if (!this.currentNode) return null;
        this.currentNode = this.currentNode.previous;
        return this.currentNode.item;
    }

    setCurrent(id: string) {
        const node = this.nodes.get(id);
        if (!node) return false;
        this.currentNode = node;
        return true;
    }

    /**
     * 替换整条链，但尽量保留当前播放节点：
     * - 如果旧 currentId 在新队列里还存在，则 current 仍指向它；
     * - 否则 current 指向新 head。
     */
    replaceAll(items: T[], options: { keepCurrent?: boolean } = {}) {
        const previousCurrentId = options.keepCurrent ? this.currentNode?.item.id ?? null : null;
        this.clear();
        items.forEach((item) => this.append(item));
        if (previousCurrentId && this.nodes.has(previousCurrentId)) {
            this.setCurrent(previousCurrentId);
        }
    }

    /**
     * 按新列表同步队列：已有节点走 update，新节点 append，消失节点 remove。
     * 默认不会覆盖 locked 节点，适合后端增量更新时保住当前播放动画。
     */
    sync(items: T[], options: CircularQueueUpdateOptions & { removeMissing?: boolean } = {}) {
        const removeMissing = options.removeMissing ?? true;
        const nextIds = new Set(items.map((item) => item.id));

        items.forEach((item) => {
            this.upsertAppend(item, options);
        });

        if (removeMissing) {
            Array.from(this.nodes.keys()).forEach((id) => {
                if (!nextIds.has(id)) this.remove(id);
            });
        }
    }

    toArray(startAtCurrent = false) {
        const result: T[] = [];
        const start = startAtCurrent ? this.currentNode : this.headNode;
        if (!start) return result;

        let node = start;
        do {
            result.push(node.item);
            node = node.next;
        } while (node !== start);

        return result;
    }

    toSnapshot(startAtCurrent = false): CircularQueueSnapshot<T> {
        return {
            size: this.size,
            headId: this.headNode?.item.id ?? null,
            tailId: this.tailNode?.item.id ?? null,
            currentId: this.currentNode?.item.id ?? null,
            items: this.toArray(startAtCurrent),
        };
    }

    private assertNewId(id: string) {
        if (!id) throw new Error('Queue node id is required');
        if (this.nodes.has(id)) throw new Error(`Duplicate queue node id: ${id}`);
    }

    private createDetachedNode(item: T): QueueNode<T> {
        const node = {} as QueueNode<T>;
        node.item = item;
        node.previous = node;
        node.next = node;
        return node;
    }

    private attachFirstNode(node: QueueNode<T>) {
        node.previous = node;
        node.next = node;
        this.headNode = node;
        this.tailNode = node;
        this.currentNode = node;
        this.nodes.set(node.item.id, node);
    }
}
