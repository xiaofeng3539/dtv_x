# 第三方源码与许可

本项目原有源码来自 [cookie-kangd/dtv_x](https://github.com/cookie-kangd/dtv_x)，原 MIT 许可和版权声明保留在 `LICENSE`。

2026-10-05 的直播取流和搜索链接改动，参考并移植了 [dart_simple_live](https://github.com/xiaofeng3539/dart_simple_live) 的实现。参考项目采用 GNU GPL 第 3 版，许可全文保留在 `LICENSES/GPL-3.0.txt`，相应来源也标注在源码中。

涉及的参考文件：

- `simple_live_core/lib/src/bilibili_site.dart`
- `simple_live_core/lib/src/douyu_site.dart`
- `simple_live_core/lib/src/huya_site.dart`
- `simple_live_core/lib/src/douyin_site.dart`
- `simple_live_app/lib/modules/search/search_room_url.dart`

本次移植产生的派生实现按 GPL-3.0 提供；分发包含这些实现的修改版本时，应保留相关许可和版权声明，并提供对应源码。本修改版本包含 GPL-3.0 实现，不能将原项目的 MIT 声明理解为对新增派生实现的重新许可。
