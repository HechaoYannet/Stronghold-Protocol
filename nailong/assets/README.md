# assets/ — 资源覆盖镜像（奶龙美术 / 音频 / 字体）

把文件按 **public/assets/ 下的相对路径** 放进来，就会被优先于上游素材提供：

    nailong/assets/audio/bgm/act1.mp3   →   /assets/audio/bgm/act1.mp3
    nailong/assets/spine/char_199_yak/… →   /assets/spine/char_199_yak/…

规则：`nailong build` 扫描本目录生成映射表；只在文件确实存在时覆盖，缺失的路径照常由上游
`public/assets/` 提供。`data/assets.json`（素材清单）本身也可以用数据补丁改写。

注意：`public/assets/` 被 .gitignore 忽略（版权素材不入库）。本目录**会**入库，
所以只放你自己拥有版权的素材。
