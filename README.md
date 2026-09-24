# dsh-peak-gate —— DSH 请求闸门（高峰避让 + 网络故障挂起）

把「会让对话中断的两种等待」都变成**挂起**：一种是高峰时段（省钱），一种是网络不好（不丢会话）。

## 能力一：高峰避让

工作日（周一~周五）北京时间 **09:00–12:00 / 14:00–18:00** 是 DeepSeek API 高峰时段（原价），
其余时间（含凌晨、午间空档、晚上、周末全天）为低谷时段（官方 5 折）。

本插件在 `llm/stream` 瀑布（每次流式模型调用的必经之路）上做**请求闸门**：
高峰期间把匹配的模型请求**挂起不发**，低谷起点自动放行、原样继续。

## 能力二：网络故障挂起（2026-09-23 新增）

网络不好/断网时，DSH 在重试耗尽后会把整轮标记为失败（前端显示
`本轮运行失败 DeepSeek API request to https://api.deepseek.com failed`），对话就此中断。

本插件在 `agent/request-error` 瀑布（每一次「模型请求失败后该不该重试」的决策点）上接管：
命中网络类失败时**不把失败交回上层**，而是把这次请求挂起等待，等到

- 自动重试间隔到点，或
- 用户点徽章上的「**立即重试**」（=`POST /dsh-peak-gate/wake`），或
- 用户中止回合（AbortSignal）

之后返回 `{ kind: 'retry' }`，让**同一轮对话原地重试**。取消挂起后若网络仍不通，会再次进入挂起
（同一回合内次数递增，等待间隔按 15s → 30s → 60s 退避）。

不会接管的情况（照常按原生失败流程处理，避免"无限挂起"）：

| 失败码 | 含义 |
| --- | --- |
| `QUOTA` | 额度不足 |
| `INVALID_CREDENTIAL` / `AUTH` | 密钥无效 |
| `CONTEXT_WINDOW_EXCEEDED` | 上下文超限 |
| `INVALID_REQUEST` / `CLIENT` | 请求本身有问题 |
| `ABORTED` | 用户主动中止 |

默认接管：`TRANSPORT`（连接失败，即你看到的这条）、`TIMEOUT`、`SERVER`、`RATE_LIMIT`、`EMPTY_RESPONSE`。
失败码未知（第三方 provider）时，只有报文带网络特征（`fetch failed` / `ECONNRESET` / `连接失败` 等）才接管。

## 能力三：按请求放行 / 忽略本次（针对个别对话）

徽章在**有挂起时**会多出一个「**挂起列表 N**」按钮，点开是一份挂起清单，每条都标明身份：

```
挂起中的请求（2）
放行本轮=这个对话这一轮不再被拦（回合结束恢复）；忽略 10 分钟=限时免拦，你还在用就自动续期
[高峰] 帮我改一下插件，让断网也不中断        [放行本轮] [忽略 10 分钟]
       deepseek-v4.1-flash · a1b2c3d4 · 12:00 自动放行
[网络] 帮我改一下插件，让断网也不中断        [重试] [忽略 10 分钟]
       deepseek-v4.1-flash · a1b2c3d4 · TRANSPORT · 第 1 次 · 00:14后自动重试
                                        [全部放行]
已免拦 · 不再挂起（1）
[忽略] 帮我改一下插件，让断网也不中断            [恢复]
       免拦剩余 09:32 · a1b2c3d4 · 在用会自动续期
```

| 动作 | 含义 |
| --- | --- |
| **放行本轮**（高峰） | 放行这一次，并让**该对话在本轮内不再被挂起**——同一轮里可能有很多步模型调用，点一次就够；**回合结束自动恢复拦截**（回到省钱状态） |
| **重试**（网络） | 只立刻重连**这一次**；仍不通则继续挂起 |
| **忽略 N 分钟** | 放行这一次，并让**该对话限时免拦**——高峰不挂起、网络失败也不再接管。**期间只要你还在这个对话里发请求就自动续期**，停手 N 分钟（默认 10 分钟，`bypassMs` 可配）才恢复拦截 |
| **恢复** | 撤销该对话的免拦，重新交给闸门管 |

> **为什么是"滑动续期"**：高峰窗口一次 3 小时（09:00–12:00），若免拦是固定死期，用户每 10 分钟
> 就要被重新挂一次、必须重点（2026-09-24 用户实测报障）。改成"你在用就一直免拦、停手才恢复"
> 之后，点一次就够，且停止使用后立刻回到省钱状态。

- 每行动作只作用于**那一条/那一个对话**，其他对话继续挂着，互不影响；
- 身份标签取自**该请求所属对话的最后一条真人消息**（开头 24 字）；生成会话标题、
  压缩上下文这类内部调用会直接标注出来，不会和你的对话混淆；
- **注意**：挂起清单里可能同时有**别的对话 / 后台任务会话**的请求（它们也会被闸门拦），
  这些不需要你处理——它们会在低谷自动放行。只想让自己在用的对话顺畅，点它的「放行本轮」即可；
- 徽章主按钮的含义：有网络挂起 →「立即重试」；只有高峰挂起 → 「全部放行」；都没有 → 启停总开关；
- 免拦过期自动失效；`state.json` 的 `bypass[]` 可以看到每条免拦的类型（`mode`：`turn`=放行本轮 /
  `ignore`=忽略）和剩余时间。
- 命令行等价写法：

```bash
# 放行本轮某一个（id 从 state.json 的 parks[].id 取）
curl -X POST http://127.0.0.1:3080/dsh-peak-gate/release \
  -H 'Content-Type: application/json' -d '{"id":"pk-xxxxxxxx-1"}'
# 只放行某一类
curl -X POST http://127.0.0.1:3080/dsh-peak-gate/release \
  -H 'Content-Type: application/json' -d '{"kind":"peak"}'     # 或 {"kind":"network"}
# 放行全部
curl -X POST http://127.0.0.1:3080/dsh-peak-gate/release -d '{}'
# 忽略 N 分钟（放行它 + 该对话限时免拦）
curl -X POST http://127.0.0.1:3080/dsh-peak-gate/release \
  -H 'Content-Type: application/json' -d '{"id":"pk-xxxxxxxx-1","action":"bypass"}'
# 撤销免拦（不传 sessionId 则全部撤销；本轮与忽略两类一起清）
curl -X POST http://127.0.0.1:3080/dsh-peak-gate/release \
  -H 'Content-Type: application/json' -d '{"undo":"bypass","sessionId":"a1b2c3d4"}'
```

## 特性

- **零费用**：高峰挂起期间请求尚未发出，不产生任何 API 计费；
- **零丢回合**：会话状态零改动，挂起结束后同一请求继续，历史/工具结果不受影响；
- **不阻塞**：用户中止（AbortSignal）、插件停用/更新或总开关关闭时，挂起请求立即放行；
- **无人值守**：网络挂起会自动重试，高峰挂起由低谷起点自动放行；
- **安全阀**：只接管"网络类"失败；`maxAttempts` 可限制同一回合最多挂起几次（默认不限）；
- **Web 徽章**：页面角落显示当前时段、放行倒计时、挂起计数；有挂起时出现「挂起列表 N」，
  可针对个别对话放行（见下）；网络挂起时显示「网络中断 · 已挂起 N 个请求 · 第 N 次 · mm:ss 后自动重试」；
- **可配置**：匹配的 provider/model、高峰窗口、网络挂起参数均可热更新（≤15s 生效）。

## 安装

```bash
# 热装配（免重启）：
#   1. 把本目录放到任意位置（如 ~/plugins/dsh-peak-gate）
#   2. 在 DSH 会话里调用 dev_install_package(dir=本目录绝对路径)
# 重启后由 profile 的 bundles 列表自动装配。
```

## 配置

配置文件：`~/.dsh/dsh-peak-gate.json`（不存在时用默认值；改 UI 开关即写入）：

```json
{
  "enabled": true,
  "match": { "providers": ["deepseek-official"], "models": [] },
  "windows": [[9, 12], [14, 18]],
  "weekendsValley": true,
  "ui": { "position": "bottom-left" },
  "bypassMs": 600000,
  "netPark": {
    "enabled": true,
    "codes": ["TRANSPORT", "TIMEOUT", "SERVER", "RATE_LIMIT", "EMPTY_RESPONSE"],
    "match": { "providers": [], "models": [] },
    "autoRetryMs": 15000,
    "maxAutoRetryMs": 60000,
    "maxAttempts": 0
  }
}
```

| 字段 | 含义 |
| --- | --- |
| `enabled` | 总开关（false = 高峰避让与网络挂起都停用） |
| `match.providers` | 高峰要拦截的 provider 路由键（**默认精确相等**；空数组 = 全部） |
| `match.models` | 高峰要拦截的模型名（**默认精确相等**；空数组 = 全部） |
| `windows` | 高峰窗口（北京时间，`[start, end)`），可自定义 |
| `weekendsValley` | 周末全天按谷价 → 不拦截（官方 2026-08-23 起政策） |
| `ui.position` | 徽章位置：`bottom-left` / `bottom-right` / `top-left` / `top-right` |
| `bypassMs` | 「忽略 N 分钟」的免拦时长（毫秒，默认 600000 = 10 分钟；范围 1s–24h；**滑动续期**） |
| `turnBypassMs` | 「放行本轮」的兜底时长（毫秒，默认 300000 = 5 分钟；回合正常结束时立即清除） |
| `netPark.enabled` | 网络故障挂起开关（只关它，高峰避让照旧） |
| `netPark.codes` | 要接管的失败码白名单（见上表；不在白名单的已知码一律不接管） |
| `netPark.match` | 网络挂起作用范围；**空数组 = 所有 provider**（断网不分 provider） |
| `netPark.autoRetryMs` | 首次自动重试间隔（默认 15s，下限 1s） |
| `netPark.maxAutoRetryMs` | 退避上限（默认 60s，上限 1h） |
| `netPark.maxAttempts` | 同一 turn+step 最多挂起几次；`0` = 不限（默认） |

热更新（免重启）：

```bash
# 只关网络挂起，保留高峰避让
curl -X PUT http://127.0.0.1:3080/dsh-peak-gate/config.json \
  -H 'Content-Type: application/json' -d '{"netPark":{"enabled":false}}'
# 立刻结束当前网络挂起、马上重连
curl -X POST http://127.0.0.1:3080/dsh-peak-gate/wake
```

## 调试与自检

- `GET /dsh-peak-gate/state.json` —— 当前状态：时段、放行时刻、挂起计数、最近经过闸门的请求
  （`lastSeen`，用来核对 `match` 规则是否命中真实 provider 键）、最近一次高峰挂起详情；
  以及 `network` 段（网络挂起：`parks` 累计次数、`parkedNow`、`parked[]` 正在挂起的请求与
  下次重试时刻、`lastPark` 最近一次详情）和 `probe` 段（派发链路自检）；
- `PUT /dsh-peak-gate/config.json` —— 热更新配置；
- `POST /dsh-peak-gate/release` —— 放行 / 忽略挂起：`{"id":"pk-…"}` 放行指定一条；
  `{"kind":"peak"|"network"}` 放行某一类；`{}` 放行全部；`{"id":"…","action":"bypass"}` 忽略本次；
  `{"undo":"bypass","sessionId":"…"}` 撤销免拦；
- `POST /dsh-peak-gate/wake` —— 取消网络挂起 / 立即重试连接（等价于 `release` 的 `kind=network`）；
- 挂起时宿主日志输出 `[dsh-peak-gate] ...` 行（含失败码、第几次、多少秒后重试）。

`state.json` 里的 `parks[]` 就是徽章清单的数据源，每条含：
`id` / `kind`（peak｜network）/ `label`（哪个对话或哪类内部调用）/ `provider` / `model` /
`sessionId` / `startedAt` / `releaseAt`（高峰：自动放行时刻）/ `nextRetryAt`（网络：下次重试）/ `code`。

**自检**：若怀疑网络挂起没生效，先看 `state.json.probe.agentEvents` 是否在涨——
涨了说明 `agent/status` / `tools/result` 这类 agent 作用域事件确实能到达插件（派发链路正常），
那问题就在 `netPark.codes` / `netPark.match` 配置；一直是 0 才是派发链路的问题。

## 测试

```bash
DSH_HOME=$(mktemp -d) node test/peak.test.mjs      # 纯逻辑：峰谷判定/匹配/配置清洗/失败判定/退避（54 项）
DSH_HOME=$(mktemp -d) node test/netpark.test.mjs   # 行为：挂起→retry、/wake 立即重试、中止、开关与上限（14 项）
DSH_HOME=$(mktemp -d) node test/release.test.mjs   # 行为：身份标签、放行本轮、忽略免拦滑动续期与撤销（20 项）
```

## 注意

- 挂起适用于**所有**匹配的模型调用，包括会话标题生成、压缩（compaction）、
  子代理等内部调用——它们同样会延迟放行/重试（这正是"不中断"的目的）；
- 网络挂起期间该轮对话保持"进行中"状态（页面显示运行中 + 徽章提示）；要放弃就点停止按钮，
  挂起会立即退出并按原生失败收尾；
- 重试会重新发送完整请求：连接层失败不产生计费；若失败发生在已经开始出字之后，
  重试的那次会重新计费（与 DSH 内置重试行为一致）；
- 时段按北京时间（UTC+8）计算，无夏令时。
