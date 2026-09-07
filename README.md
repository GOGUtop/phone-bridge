# Anima 小手机桥

面向 SillyTavern 的虚构 iPhone 风格小手机，并与 Anima Memory System 双向同步。完整手机记录保存在扩展中，影响剧情的摘要写入 `anima_data.手机`；独立的幕后七条写入 `anima_data.幕后状态`。

## 功能

- 微信私聊、微信群和朋友圈，可直接与世界中的 NPC 互动。
- 微信支付、支付宝、银行卡、私聊红包、群红包和工资到账。
- 饿了么、美团外卖、大众点评和网易云音乐。
- 发送 API 专门处理手机互动；实时更新 API 在每层正文完成后校准手机和幕后状态。
- 实时更新 API 故障时自动改用发送 API，冷却后自动检测并切回。
- 订单按剧情时间和正文事实推进，不按现实时间倒计时。
- 从当前角色绑定的世界书及正文校准结果中导入具名 NPC 联系人。
- 可拖动、自动贴边且记忆位置的手机悬浮按钮。
- 独立的幕后状态条，可自由拖动并记住位置；展开后显示时间地点、现场人物、衣着、约定、秘密、镜头外 NPC 和世界事件。
- 默认自动适配新角色卡：等待 Anima 建立默认提示词后，仅追加一次桥接规则，不覆盖卡内原规则。
- 每个聊天存档独立保存；重复校准不会重复发消息、记账或推进订单。

所有支付、银行、订单和商家均为角色扮演世界中的模拟数据，不连接真实商业服务。

## GitHub 安装

在 SillyTavern 扩展管理器中选择“安装扩展”，粘贴：

```text
https://github.com/GOGUtop/phone-bridge
```

也可在 SillyTavern 目录执行：

```sh
git clone https://github.com/GOGUtop/phone-bridge public/scripts/extensions/third-party/anima-phone-bridge
```

## 安装服务端插件

进入扩展目录后执行：

```sh
sh install-server.sh /home/www/SillyTavern2
```

确认 SillyTavern 的 `config.yaml` 已开启：

```yaml
enableServerPlugins: true
```

然后完整重启 SillyTavern。API Key 只保存在 `data/default-user/anima-phone-bridge/config.json`，不会由设置接口回传到浏览器。

## 双 API 设置

打开小手机的“设置”：

1. “发送 API”填写 API 地址、API Key 和模型，用于微信、群聊、朋友圈及应用互动。
2. “实时更新 API”用于正文完成后的状态校准。整组留空时会共用发送 API。
3. 两组 API 均可单独拉取模型和测试连接。
4. 更新 API 失败后，会在设定的恢复间隔内使用发送 API；间隔结束后的下一次正文校准会自动尝试恢复。

接口需兼容 OpenAI Chat Completions 与 `/models`。部分中转站不开放模型列表时，可直接手动填写模型名称。

这里的“实时更新”指正文生成完成、切换聊天或打开手机后的事件驱动校准，不是每秒轮询。它因此以剧情时间为准，也避免无意义消耗 API。

## Anima 适配

1. 保持 Anima 的状态变量和世界书注入开启。
2. 将 `presets/anima-status-addon.txt` 追加到 Anima 的状态更新提示词。
3. 将 `presets/main-preset-addon.txt` 加入酒馆正文预设的系统提示。
4. Anima 已注入完整状态时，不要再重复添加状态宏。

`v0.3.1` 起不再需要为每张新角色卡手动导入状态提示词。“设置 → 自动适配新角色卡”默认开启；也可点击“立即适配”检查当前卡。角色卡中已有的提示词会完整保留，插件只维护标题为“📱Anima 小手机桥｜状态维护补充规则”的单独条目。

桥接依赖酒馆助手提供 `TavernHelper` 变量接口。尚无 AI 正文楼层时，手机仍可使用，但会等待首条正文出现后再写入 Anima。

## 数据与记忆边界

- 扩展本地保存完整手机消息、朋友圈、交易、订单和联系人。
- Anima 只保存近期关键事件、约定、未读、余额摘要、当前订单与幕后七条，避免上下文无限增长。
- 手机 Agent 每次只读取当前会话近期消息和有限的角色/世界资料。
- 联系人、群聊与秘密都遵守知情边界，NPC 不会因数据存在就自动知道未参与的事情。

## 更新

通过扩展管理器更新前端后，需要再次安装服务端插件并完整重启：

```sh
sh update.sh /home/www/SillyTavern2
```

## 开发验证

```sh
npm test
npm run check
```
