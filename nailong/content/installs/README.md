# content/installs/ — 每场战斗的附加安装器

一个文件默认导出一个函数 `(battle) => void`，或 `{ install(battle) }`。
它在 `installContent` 的末尾被调用（上游 `opts.extraContent` 通道），用来做**全局**改动：
新地形装置、全局光环、额外的战斗事件监听等。每个安装器都在 try/catch 里执行，抛错只会记日志。

写法和限制同 `content/kits/`（确定性、无 Node 内置、无时钟、无随机）。
