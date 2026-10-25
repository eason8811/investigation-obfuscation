import {createObject} from './env-completion.js'

const initialStorage = {
    "__cuid": "16c4f5b3-619c-4dad-b691-fb8712c1c250",
    "volume": "1",
    "rweb.recentUserIds": "AJDbOkpFjxo"
};

// 使用 Map 保存存储数据
const storageData = new Map(
    Object.entries(initialStorage)
);

const LocalStorage = createObject(
    [...storageData.keys()],
    {
        ...initialStorage,

        getItem(key) {
            key = String(key);

            return storageData.has(key)
                ? storageData.get(key)
                : null;
        },

        setItem(key, value) {
            key = String(key);
            value = String(value);

            storageData.set(key, value);

            // 同步到模拟对象，支持直接属性读取
            LocalStorage[key] = value;
        },

        removeItem(key) {
            key = String(key);

            storageData.delete(key);

            delete LocalStorage[key];
        },

        clear() {
            for (const key of storageData.keys()) {
                delete LocalStorage[key];
            }

            storageData.clear();
        },

        key(index) {
            return [...storageData.keys()][Number(index) >>> 0]
                ?? null;
        }
    },
    {
        label: "LocalStorage",
        logReads: true,
        logWrites: true,
        logMissing: true,
        logEnumerations: true
    }
);

// length 需要实时计算
Object.defineProperty(LocalStorage, "length", {
    get() {
        return storageData.size;
    },
    enumerable: false,
    configurable: true
});

export {LocalStorage};