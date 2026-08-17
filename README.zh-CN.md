# DeepSeek Harness 优化配置

[English](README.md)

这是一个可复用、可公开分享的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web Profile。它会先在 Node.js 工具层完整读取并解析大型 HTML，只把与当前任务有关的证据送入模型；当模型输出达到上限时，也会自动压缩上下文并续写。

这是独立的社区项目，不是 DeepSeek 官方发行版。仓库不包含 API Key、历史对话、记忆数据库、浏览器资料、个人自动化、本地模型或模型权重。下载者必须配置自己的模型和凭据。

## macOS App

使用 macOS 13 或更高版本的 Apple Silicon 用户，可以直接从 [GitHub Releases](https://github.com/wendymyyht-ctrl/deepseek-harness-optimized/releases) 下载 ZIP 或 DMG。App 已内置经过校验的 Node.js 运行时，并在原生窗口中打开 Harness，不需要另行安装 Node.js。

当前社区构建采用 ad-hoc 签名，尚未经过 Apple 公证。如果首次双击被 macOS 阻止，请按住 Control 点击 App，然后选择**打开**。凭据和对话只会写入 `~/Library/Application Support/DeepSeek Harness Optimized`。

## 主要优化

### HTML 不再直接“生吃”

处理本地 `.html` / `.htm` 文件时，Agent 会先调用程序化工具：

1. 用 Node.js 完整解析原文件；
2. 对标题、可见文本、属性、脚本、样式和内嵌 JSON 建立紧凑索引；
3. 根据任务搜索、提取或比较相关区块；
4. 只将有用且有长度上限的证据送入模型推理。

它并没有取消全量读取能力。DOM/CSS/JavaScript 排错会自动选择聚焦源码；当用户明确要求“完整读取原始 HTML”时，则允许受保护的完整读取或分页读取。HTML 内容始终按不可信数据处理，不会被当成指令。

对于大型页面，这通常会明显减少 Prompt 构建和模型推理时间，因为脚本、样式、重复标签和无关记录不会反复塞进上下文。实际加速幅度取决于页面结构和模型服务。

### 达到输出上限后自动压缩并继续

当提供方以 `max-tokens` 结束回答时，插件会要求 Harness 压缩可压缩的上下文，然后自动排队继续完成原任务。普通停止不会触发；如果当前没有可安全压缩的内容，也不会强行续写。

### 模型可以在线切换

Harness 可以配置 DeepSeek、其他目录提供方，以及自定义 OpenAI 兼容接口。保存模型更改后，下一次请求立即生效，不需要重启服务器。已经发送过请求的旧会话会保留自己日志中的模型路由；如果要完全干净地切换，建议选择模型后新建会话。

## 环境要求

- Node.js 22 系列需不低于 `22.19`，或使用 Node.js 24+
- npm、pnpm，或其他支持 npm workspace 的包管理器
- 自己的模型 API Key，或可访问的本地 OpenAI 兼容端点

## 快速开始

```bash
git clone https://github.com/wendymyyht-ctrl/deepseek-harness-optimized.git
cd deepseek-harness-optimized
npm install
npm start
```

打开 Harness 输出的地址，通常是 `http://127.0.0.1:3080`。进入**设置 → 模型**：

- 填入你自己的 DeepSeek API Key；或
- 添加一个内置目录提供方；或
- 添加自定义提供方，填写小写 Provider ID、基础 URL、API 协议、凭据和模型 ID。

凭据保存在运行目录中，默认是 `~/.dsh-optimized/.credentials.yaml`，不在 Git 仓库内。Web UI 不会把密钥明文读回，也不会把它打包进本仓库。

如需查看 Web 启动参数：

```bash
npm start -- --help
```

## 运行数据隔离

启动器会创建独立运行目录 `~/.dsh-optimized`，并把仓库内的 Profile 链接进去。如需自定义：

```bash
DSH_HOME=/path/to/runtime DSH_PROFILE=my-profile npm start
```

如果目标 Profile 已经是普通目录，或链接到了别处，安装脚本会拒绝覆盖。

高级用户可以参考 `settings.example.yaml`，把配置写入 `$DSH_HOME/settings.yaml`，并通过环境变量提供密钥。日常使用建议直接通过**设置 → 模型**完成。

## 修改后验证

```bash
npm run verify
```

测试覆盖自动路由、HTML 索引、受限源码读取、版本比较、索引缓存和自动续写。安全检查会拦截常见密钥格式、私人运行数据文件、模型权重和个人 macOS 路径。

## 有意排除的内容

个人记忆、历史对话、账号集成、浏览器状态、自动化任务、API 凭据、本地模型路由器、启动服务、GGUF/SafeTensors 权重和机器专属路径都不会公开。用户仍可在**设置 → 模型**中，把本地 DeepSeek 或 Qwen 服务添加成自定义 OpenAI 兼容提供方。

## 许可证

MIT，详见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。DeepSeek Harness 是上游依赖，并继续遵循它自己的 MIT 许可证。
