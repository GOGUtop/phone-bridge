# Anima 小手机桥

一部虚构小手机共用一个 OpenAI 兼容 API，并把会影响剧情的关键事件同步到 Anima Memory System。

这是首个可运行版本，重点验证三件事：手机内直接对话、完整手机数据持久化、后续正文能读取手机约定和事件。

## 当前功能

- 苹果风格单屏桌面，支持桌面和手机端。
- 微信私聊、微信群：在手机里发送消息，由统一手机 API 返回角色回复。
- 朋友圈：发布动态并写入剧情事件。
- 微信支付、支付宝、银行卡：转账、私聊红包、群红包、工资到账和流水。
- 饿了么、美团外卖：餐品下单、余额扣除、订单状态同步。
- 大众点评：地点与评价记录。
- 网易云音乐：播放状态与剧情同步。
- 每个聊天存档单独保存手机数据。
- Anima 桥：把近期手机事件、未完成约定、未读、余额和当前订单写入最新 AI 楼层的 `anima_data.手机`。

所有支付、银行、订单和商家均为角色扮演世界中的模拟数据，不连接真实商业服务。

## GitHub 安装

### 1. 安装前端扩展

仓库发布到 GitHub 后，在 SillyTavern 的扩展管理器中选择“安装扩展”，粘贴本仓库 Git URL。

也可以在 SillyTavern 目录执行：

```sh
git clone <你的仓库 Git URL> public/scripts/extensions/third-party/anima-phone-bridge
```

### 2. 安装服务端插件

进入扩展目录后执行：

```sh
sh install-server.sh /home/www/SillyTavern2
```

确认 SillyTavern 的 `config.yaml` 中：

```yaml
enableServerPlugins: true
```

然后完整重启 SillyTavern。API Key 保存在 `data/default-user/anima-phone-bridge/config.json`，不会下发到浏览器。

### 3. 配置手机 API

打开右下角手机按钮，进入“设置”，填写一套 OpenAI 兼容 API：

- API 地址，例如 `https://api.openai.com/v1`
- API Key
- 模型名称

保存后点击“测试连接”。微信私聊和微信群共用这一套 API。

## Anima 适配

1. 保持 Anima 的“状态变量”和“世界书注入”开启。
2. 将 [`presets/anima-status-addon.txt`](presets/anima-status-addon.txt) 追加到 Anima 的状态更新提示词，让状态模型保护 `手机` 根字段并在正文兑现后更新约定。
3. 将 [`presets/main-preset-addon.txt`](presets/main-preset-addon.txt) 加入当前酒馆预设的系统提示，让主模型自然使用手机事件。
4. 如果 Anima 已经注入完整状态，不要再重复添加 `{{ANIMA_BASE_STATUS::手机}}`。

桥接需要酒馆助手提供 `TavernHelper` 变量接口。没有 AI 楼层时，手机可以使用，但会等第一条 AI 正文出现后再同步 Anima。

## 更新

通过 SillyTavern 扩展管理器更新前端后，再执行一次：

```sh
sh install-server.sh /home/www/SillyTavern2
```

命令行维护也可以执行：

```sh
sh update.sh /home/www/SillyTavern2
```

## 数据边界

- 完整手机历史存放在 SillyTavern 扩展设置中，按角色卡与聊天标识隔离。
- Anima 只接收最近 12 条关键事件、未完成约定、未读、余额摘要和当前订单，避免上下文无限增长。
- 手机 Agent 每次只读取当前会话最近 18 条消息和有限角色/世界资料。
- 非会话成员不会因手机事件自动获得知情权。

## 开发

```sh
npm test
npm run check
```

项目不依赖前端构建步骤，仓库根目录可直接由 SillyTavern 扩展管理器加载。
