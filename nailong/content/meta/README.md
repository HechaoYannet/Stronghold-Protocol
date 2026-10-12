# content/meta/ — 休整期（prep）侧的注册

一个文件默认导出一个函数 `(registry) => void`，在服务器启动时用 `server/match/effectsMeta.js`
的 `getDefaultRegistry()` 调用一次。registry 提供的便捷方法：

```
registry.bond(bondId, handler)      registry.item(itemKey, handler)
registry.garrison(effectKey, h)     registry.choice(effectId, handler)
registry.band(bandId, handler)      registry.effect(id, handler)
registry.global(name, handler)
```

具体 handler 签名见 `docs/META.md` §2。**只有服务器**加载本目录（休整期是服务器权威的）。
