import { logger } from "@/utils/logger";

/**
 * 通用 TTL 缓存 + invoke 包装：把"先查缓存 → 命中即返回 → 未命中 invoke →
 * 命中后写回缓存 → 失败打日志并返回 null"这一长串样板折叠成一个工厂。
 *
 * 用法见 databaseCache.ts。复用了 aboutMatch.ts 已有的 in-flight 合并思路，
 * 同一 key 多个并发请求只触发一次 invoke，命中后所有等待者都拿到同一 Promise。
 */
export interface TtlCache<K, V> {
    get(key: K): V | null;
    set(key: K, value: V): void;
    delete(key: K): void;
    clear(): void;
    size(): number;
}

export interface CreateTtlCacheOptions<K, V> {
    ttlMs: number;
    invoke: (key: K) => Promise<V | null>;
    /** 仅返回非 null 时才写入缓存。默认 true。 */
    cacheOnTruthy?: boolean;
    op: string;
    /** 错误 / 命中日志的扩展字段。 */
    context?: (key: K) => Record<string, unknown>;
}

const isFresh = <V>(
    entry: { value: V; fetchedAt: number } | undefined,
    ttl: number,
): boolean =>
    entry !== undefined && Date.now() - entry.fetchedAt < ttl;

export const createTtlCache = <K, V>({
    ttlMs,
    invoke,
    cacheOnTruthy = true,
    op,
    context,
}: CreateTtlCacheOptions<K, V>): TtlCache<K, V> & {
    fetch: (key: K) => Promise<V | null>;
    clear: () => void;
} => {
    const store = new Map<K, { value: V; fetchedAt: number }>();
    const inFlight = new Map<K, Promise<V | null>>();
    const keyGeneration = new Map<K, number>();
    let clearGeneration = 0;

    const generationOf = (key: K) => ({
        clear: clearGeneration,
        key: keyGeneration.get(key) ?? 0,
    });

    const sameGeneration = (
        left: { clear: number; key: number },
        right: { clear: number; key: number },
    ) => left.clear === right.clear && left.key === right.key;

    const invalidateKey = (key: K) => {
        if (!inFlight.has(key)) {
            keyGeneration.delete(key);
            return;
        }
        keyGeneration.set(key, (keyGeneration.get(key) ?? 0) + 1);
        inFlight.delete(key);
    };

    const fetch = async (key: K): Promise<V | null> => {
        const cached = store.get(key);
        if (isFresh(cached, ttlMs)) {
            logger.debug({
                tag: "db.cache",
                message: "TTL 命中，跳过 invoke",
                context: { op, ...(context?.(key) ?? {}) },
            });
            return cached!.value;
        }
        const startedAt = Date.now();
        const existing = inFlight.get(key);
        if (existing) return existing;
        // 记录查询开始时的代际；写入或清空缓存后，旧查询只能返回给原调用者，
        // 不能再把旧值写回缓存。
        const startedGeneration = generationOf(key);
        const promise = (async () => {
            try {
                const value = await invoke(key);
                if (
                    value !== null &&
                    (cacheOnTruthy || value !== undefined) &&
                    sameGeneration(startedGeneration, generationOf(key))
                ) {
                    store.set(key, { value, fetchedAt: Date.now() });
                    logger.debug({
                        tag: "db.cache",
                        message: "TTL 缓存已写入",
                        context: {
                            op,
                            duration_ms: Date.now() - startedAt,
                            ...(context?.(key) ?? {}),
                        },
                    });
                }
                return value;
            } catch (error) {
                logger.warn({
                    tag: "db.cache",
                    message: "TTL 缓存 invoke 失败",
                    context: {
                        op,
                        duration_ms: Date.now() - startedAt,
                        error: String(error).slice(0, 500),
                        ...(context?.(key) ?? {}),
                    },
                });
                return null;
            }
        })().finally(() => {
            if (inFlight.get(key) === promise) {
                inFlight.delete(key);
                keyGeneration.delete(key);
            } else if (!inFlight.has(key)) {
                // 该请求可能在完成前被 delete/set 失效；此时没有新请求
                // 接管这个 key，可以回收它留下的代际标记。
                keyGeneration.delete(key);
            }
        });
        inFlight.set(key, promise);
        return promise;
    };

    return {
        fetch,
        get: (key) => store.get(key)?.value ?? null,
        set: (key, value) => {
            // 外部 set（例如跨维度回填 summoner cache）应覆盖并发旧查询，
            // 不能让旧 Promise 完成后再次覆盖这个新值。
            invalidateKey(key);
            store.set(key, { value, fetchedAt: Date.now() });
        },
        delete: (key) => {
            invalidateKey(key);
            store.delete(key);
        },
        clear: () => {
            clearGeneration += 1;
            inFlight.clear();
            keyGeneration.clear();
            store.clear();
        },
        size: () => store.size,
    };
};
