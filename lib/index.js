// ============================================================================
// dsh-peak-gate —— DSH 请求闸门（高峰避让 + 网络故障挂起 + 按请求放行）
// ============================================================================
//
// 一、高峰避让（原有能力）
// DeepSeek API 官方峰谷政策（2026-08-23 起）：
//   - 工作日（周一~周五）北京时间 09:00–12:00 与 14:00–18:00 为高峰时段（原价）
//   - 其余时间（00:00–09:00、12:00–14:00、18:00–24:00）为低谷时段（5 折）
//   - 周末（周六/周日）全天按低谷价计费，不再区分峰谷
// 拦截 `llm/stream` 瀑布（每次流式模型调用的必经之路）：高峰期间把匹配的
// 请求"挂起不发"，低谷起点自动放行、原样继续。
//
// 二、网络故障挂起（2026-09-23 新增）
// 断网/网络抖动时，DSH 会在重试耗尽后把整轮标记为失败（前端显示
// "本轮运行失败 DeepSeek API request to https://api.deepseek.com failed"），
// 对话就此中断。本插件在 `agent/request-error` 瀑布（每一次"模型请求失败后
// 该不该重试"的决策点）上接管：命中网络类失败时，**不把失败交回上层**，
// 而是把该次请求挂起等待——网络恢复/自动重试间隔到点/用户点「立即重试」时
// 返回 { kind: 'retry' }，让同一轮对话原地重试，会话不中断。
//
// 三、用户可主动取消挂起
// 徽章出现「立即重试」按钮（=`POST /dsh-peak-gate/wake`）：点击即立刻结束
// 等待并重试连接；若网络仍不通，会再次进入挂起（每次挂起计一次，退避递增）。
//
// 三、用户可主动取消挂起 / 按请求放行（2026-09-23 追加）
// 徽章在有挂起时出现「挂起列表 N」：每条挂起都带身份（取自该请求所属对话的最后一条
// 真人消息；生成标题/压缩上下文等内部调用单独标注），可针对个别对话单独放行——
// `POST /dsh-peak-gate/release` body: {} 全部 / {"kind":"peak"|"network"} 某一类 /
// {"id":"pk-…"} 单独一条。网络挂起放行 = 立刻重试；高峰挂起放行 = 不等了直接发。
//
// 特性：
//   - 会话状态零改动：高峰挂起期间请求尚未发出，不产生任何 API 费用；
//   - 不丢回合：挂起结束后同一请求原样继续，历史与工具结果都在；
//   - 用户中止：请求携带的 AbortSignal 触发时立即放行/退出，不阻塞；
//   - 插件停用/更新：所有挂起立即放行，闸门随插件移除；
//   - 配置热更新：改配置后 ≤15s 内生效（等待循环每 15s 复查一次）；
//   - 安全阀：非网络类失败（鉴权/额度/上下文超限等）**不接管**，仍走原生失败流程。
//
// 配置文件：~/.dsh/dsh-peak-gate.json（不存在时用内置默认值）
//   {
//     "enabled": true,                       // 总开关
//     "match": { "providers": ["deepseek"], "models": [] },  // 空数组=匹配全部
//     "windows": [[9, 12], [14, 18]],        // 工作日高峰（北京时间 [start,end)）
//     "weekendsValley": true,                // 周末全天谷价 → 不拦截
//     "ui": { "position": "bottom-left" },   // 徽章位置
//     "netPark": {                           // 网络故障挂起
//       "enabled": true,
//       "codes": ["TRANSPORT", "TIMEOUT", "SERVER", "RATE_LIMIT", "EMPTY_RESPONSE"],
//       "match": { "providers": [], "models": [] },          // 空数组=所有 provider
//       "autoRetryMs": 15000,                // 首次自动重试间隔
//       "maxAutoRetryMs": 60000,             // 退避上限
//       "maxAttempts": 0                     // 同一回合最多挂起次数，0=不限
//     }
//   }
//
// UI：Web 页面角落小徽章（/dsh-peak-gate/widget.js，经 tapIndex 注入），
//     显示当前时段、放行倒计时、挂起计数、网络挂起与「立即重试」，可一键启停。
// ============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-peak-gate'
export const inject = ['webServer']

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONFIG_PATH = path.join(DSH_HOME, 'dsh-peak-gate.json')
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  enabled: true,
  // ⚠️ v0.4.2 修复（事故 L-2026-09-24-02）：旧默认值是 ['deepseek']，
  // 而当时的匹配语义是"子串包含" ⇒ deepseek-web（网页版免费通道）也被当成
  // 按量计费的官方通道一起挂起，表现成"高峰期 DSH 突然不出字"，极难排查。
  // 现在两层一起收口：① 默认值收窄为精确的官方 provider 键；
  // ② 匹配语义改为**默认精确相等**（要前缀/子串必须显式写通配符，见 compileMatcher）。
  match: { providers: ['deepseek-official'], models: [] },
  windows: [[9, 12], [14, 18]],
  weekendsValley: true,
  ui: { position: 'bottom-left' },
  // 「忽略本次」的有效期：该对话在此期间不再被挂起（高峰不拦、网络失败也不接管）。
  // **期间只要该对话还在发请求就自动续期**，静默超过该时长才恢复拦截——
  // 否则高峰窗口有 3 小时，用户每 10 分钟就要重点一次（2026-09-24 用户实测报障）。
  bypassMs: 600_000,
  // 「放行本轮」的有效期：点一次放行后，该对话在本轮对话内不再被挂起；
  // 回合结束（agent/turn-stopping）立即清除，另有该时长兜底（防事件丢失）。
  turnBypassMs: 300_000,
  // 网络故障挂起：命中即"不失败"，原地等待并重试（详见文件头）。
  netPark: {
    enabled: true,
    codes: ['TRANSPORT', 'TIMEOUT', 'SERVER', 'RATE_LIMIT', 'EMPTY_RESPONSE'],
    match: { providers: [], models: [] },
    autoRetryMs: 15000,
    maxAutoRetryMs: 60000,
    maxAttempts: 0,
  },
}

/**
 * DSH 已定义的失败码（LlmError code）。出现在这里、但不在用户 `codes` 白名单里的，
 * 一律不接管——避免把鉴权/额度/上下文超限这类"重试也没用"的错误挂起来。
 */
const KNOWN_FAILURE_CODES = new Set([
  'TRANSPORT',
  'TIMEOUT',
  'SERVER',
  'RATE_LIMIT',
  'EMPTY_RESPONSE',
  'QUOTA',
  'INVALID_CREDENTIAL',
  'AUTH',
  'CONTEXT_WINDOW_EXCEEDED',
  'INVALID_REQUEST',
  'CLIENT',
  'ABORTED',
])

/**
 * 失败码未知（第三方 provider / 新错误类型）时的兜底：只按报文里的网络特征判定。
 */
const NETWORK_MESSAGE_PATTERNS = [
  /fetch failed/i,
  /\b(ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EADDRNOTAVAIL|EPIPE)\b/i,
  /socket hang up/i,
  /network (?:error|is unreachable|is down)/i,
  /(?:连接|网络)(?:失败|中断|异常|不可达|超时)/,
  /requests? to .* failed/i,
]

function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

function strList(value, fallback, upper) {
  if (!Array.isArray(value)) return fallback
  const out = value
    .filter((v) => typeof v === 'string' && v.trim().length > 0)
    .map((v) => (upper ? v.trim().toUpperCase() : v.trim().toLowerCase()))
  return out
}

function sanitizeNetPark(raw, base) {
  const d = base && typeof base === 'object' ? base : DEFAULT_CONFIG.netPark
  const src = raw && typeof raw === 'object' ? raw : {}
  const autoRetryMs = clampInt(src.autoRetryMs, d.autoRetryMs, 1000, 3_600_000)
  const maxAutoRetryMs = Math.max(
    autoRetryMs,
    clampInt(src.maxAutoRetryMs, d.maxAutoRetryMs, 1000, 3_600_000),
  )
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : d.enabled,
    codes: strList(src.codes, d.codes, true),
    match: {
      providers: strList(src.match && src.match.providers, d.match.providers, false),
      models: strList(src.match && src.match.models, d.match.models, false),
    },
    autoRetryMs,
    maxAutoRetryMs,
    maxAttempts: clampInt(src.maxAttempts, d.maxAttempts, 0, 100_000),
  }
}

function sanitizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  let windows = DEFAULT_CONFIG.windows
  if (Array.isArray(src.windows)) {
    const cleaned = src.windows
      .filter((w) => Array.isArray(w) && w.length === 2 && w.every((n) => Number.isFinite(n)))
      .map((w) => [Math.max(0, Math.min(24, Math.floor(w[0]))), Math.max(0, Math.min(24, Math.floor(w[1])))])
      .filter((w) => w[0] < w[1])
    if (cleaned.length) windows = cleaned
  }
  const providers = Array.isArray(src.match && src.match.providers)
    ? src.match.providers.filter((p) => typeof p === 'string').map((p) => p.toLowerCase())
    : DEFAULT_CONFIG.match.providers
  const models = Array.isArray(src.match && src.match.models)
    ? src.match.models.filter((m) => typeof m === 'string').map((m) => m.toLowerCase())
    : DEFAULT_CONFIG.match.models
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : DEFAULT_CONFIG.enabled,
    match: { providers, models },
    windows,
    weekendsValley: typeof src.weekendsValley === 'boolean' ? src.weekendsValley : DEFAULT_CONFIG.weekendsValley,
    ui: { position: (src.ui && src.ui.position) || DEFAULT_CONFIG.ui.position },
    bypassMs: clampInt(src.bypassMs, DEFAULT_CONFIG.bypassMs, 1_000, 86_400_000),
    turnBypassMs: clampInt(src.turnBypassMs, DEFAULT_CONFIG.turnBypassMs, 1_000, 86_400_000),
    netPark: sanitizeNetPark(src.netPark, DEFAULT_CONFIG.netPark),
  }
}

/** 局部热更新：把 patch 深合并进当前配置后再清洗（netPark/match/ui 均为一层嵌套）。 */
function mergeConfig(current, patch) {
  const p = patch && typeof patch === 'object' ? patch : {}
  const netPatch = p.netPark && typeof p.netPark === 'object' ? p.netPark : {}
  return sanitizeConfig({
    ...current,
    ...p,
    match: { ...current.match, ...(p.match && typeof p.match === 'object' ? p.match : {}) },
    ui: { ...current.ui, ...(p.ui && typeof p.ui === 'object' ? p.ui : {}) },
    netPark: {
      ...current.netPark,
      ...netPatch,
      match: {
        ...current.netPark.match,
        ...(netPatch.match && typeof netPatch.match === 'object' ? netPatch.match : {}),
      },
    },
  })
}

function loadConfig() {
  try {
    return sanitizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')))
  } catch {
    return sanitizeConfig(null)
  }
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(DSH_HOME, { recursive: true })
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
    return true
  } catch (err) {
    console.error(`[dsh-peak-gate] 配置写入失败: ${(err && err.message) || err}`)
    return false
  }
}

// ---------------------------------------------------------------------------
// 峰谷判定（北京时间 UTC+8，无夏令时）
// ---------------------------------------------------------------------------

/** 把任意时间戳映射为"北京墙钟"，按 UTC 字段读取即为北京日历/时刻。 */
function beijingDate(ts) {
  return new Date(ts + 8 * 3600 * 1000)
}

function isPeakAt(ts, cfg) {
  const bj = beijingDate(ts)
  const dow = bj.getUTCDay() // 0=周日 6=周六
  if (cfg.weekendsValley && (dow === 0 || dow === 6)) return false
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes()
  for (const [s, e] of cfg.windows) {
    if (minutes >= s * 60 && minutes < e * 60) return true
  }
  return false
}

/** 下一个"非高峰"时刻（毫秒时间戳）；最多向前扫描 72 小时。 */
function nextReleaseAt(ts, cfg) {
  const step = 60 * 1000
  const limit = 72 * 60
  for (let t = ts + step, i = 0; i < limit; i++, t += step) {
    if (!isPeakAt(t, cfg)) return t
  }
  return ts + 72 * 3600 * 1000
}

/** 北京时间 HH:MM（用于展示）。 */
function hhmm(ts) {
  const bj = beijingDate(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}`
}

/**
 * 把一条配置模式编译成判定函数（v0.4.2）。
 *
 * 语义（**默认精确**；模糊匹配必须显式写通配符）：
 *   `deepseek-official` → 精确相等（默认行为）
 *   `deepseek-*`        → 前缀匹配
 *   `*flash*`           → 子串匹配
 *   `re:^deepseek-`     → 正则（编译失败则永不匹配，不抛异常、不静默放大）
 *
 * ⚠️ 为什么必须改（事故 L-2026-09-24-02）：
 *   旧实现无条件用 `String.includes()`，配上默认值 `['deepseek']`，会把
 *   `deepseek-web`（网页版免费通道）也一起吃掉 —— 高峰期被静默挂起，
 *   用户看到的是"DSH 突然不出字"，日志里只有一条"高峰避让"，完全指不到根因。
 *   根子在于：**配置写的是"这个键"，执行的是"含这几个字"**，语义不对齐。
 *
 * 判定一律按小写比较（配置在 sanitize 阶段已经小写化）。
 */
export function compileMatcher(pattern) {
  const p = String(pattern ?? '').trim().toLowerCase()
  if (!p) return () => false
  if (p.startsWith('re:')) {
    let re
    try {
      re = new RegExp(p.slice(3))
    } catch {
      return () => false
    }
    return (value) => re.test(value)
  }
  if (!p.includes('*')) return (value) => value === p // 默认：精确相等
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  const re = new RegExp(`^${escaped}$`)
  return (value) => re.test(value)
}

/** 一组模式里任意一条命中即算命中；空数组 = 全部命中（沿用旧语义）。 */
function matchAny(patterns, value) {
  if (!Array.isArray(patterns) || patterns.length === 0) return true
  return patterns.some((pattern) => compileMatcher(pattern)(value))
}

function matchesGate(options, cfg) {
  const provider = String((options && options.provider) || '').toLowerCase()
  const model = String((options && options.model) || '').toLowerCase()
  const match = (cfg && cfg.match) || {}
  return matchAny(match.providers, provider) && matchAny(match.models, model)
}

// ---------------------------------------------------------------------------
// 网络故障判定与退避（纯逻辑，单测覆盖）
// ---------------------------------------------------------------------------

/**
 * 该失败是否应当"挂起等待"而不是"交回失败流程"。
 * @param failure DSH LlmFailure：{ code, message, status?, providerRetryAfterMs? }
 * @param cfg 已清洗的配置
 */
function shouldParkFailure(failure, cfg) {
  const code = String((failure && failure.code) || '').toUpperCase()
  const net = (cfg && cfg.netPark) || DEFAULT_CONFIG.netPark
  if (!net.enabled) return false
  if (code && net.codes.includes(code)) return true
  // 已知但不在白名单（鉴权/额度/上下文超限/主动中止…）：绝不接管。
  if (KNOWN_FAILURE_CODES.has(code)) return false
  // 失败码未知：只有报文带网络特征才接管。
  const message = String((failure && failure.message) || '')
  return NETWORK_MESSAGE_PATTERNS.some((re) => re.test(message))
}

/**
 * 第 cycle 次挂起等待多久再重试：指数退避（autoRetryMs 起），封顶 maxAutoRetryMs；
 * provider 给了 Retry-After 时至少等它。
 */
function computeNetDelay(cfg, cycle, failure) {
  const net = (cfg && cfg.netPark) || DEFAULT_CONFIG.netPark
  const base = Math.max(1000, net.autoRetryMs)
  const cap = Math.max(base, net.maxAutoRetryMs)
  const exp = Math.min(base * 2 ** Math.max(0, cycle - 1), cap)
  const after = failure && Number.isFinite(failure.providerRetryAfterMs) ? failure.providerRetryAfterMs : 0
  return Math.min(Math.max(exp, after), cap)
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

function apply(ctx) {
  let config = loadConfig()
  const stats = {
    parkedCalls: 0, // 累计高峰挂起次数（去重：同一请求只计一次）
    lastPark: null, // 最近一次高峰挂起 { at, releaseAt, releaseText, provider, model }
    lastSeen: null, // 最近一次经过闸门的请求 { ts, provider, model }（用于核对匹配规则）
    network: {
      parks: 0, // 累计网络挂起次数
      lastPark: null, // 最近一次网络挂起快照
    },
  }
  const activePeakParks = new Set() // 正在高峰挂起的请求（带身份，可单独放行）
  const activeNetParks = new Set() // 正在等待网络恢复的请求
  const bypasses = new Map() // sessionId → { until, label }：「忽略本次」免拦名单（滑动续期）
  const turnBypass = new Map() // sessionId → { until, label }：「放行本轮」免拦名单（回合结束即清）
  const netCycles = new Map() // 同一 turn/step 的连续网络挂起计数
  const recentRequests = new Map() // sessionId → 最近一次请求身份（给网络挂起贴标签用）
  const disposers = []
  let parkSeq = 0

  // ---- 「忽略本次」：某个对话在 bypassMs 内完全免拦 ------------------------------
  // 高峰不挂起（直接按原价发）、网络失败也不接管（走原生失败流程）。
  // 用途：正干活的那个对话别被闸门冻住，其它对话照旧省钱/保值。
  function pruneBypasses() {
    const now = Date.now()
    for (const [key, entry] of [...bypasses]) {
      if (!entry || entry.until <= now) bypasses.delete(key)
    }
  }

  /**
   * 查免拦状态，并把"还在活动"的免拦自动续期（滑动窗口）。
   * 返回 'turn'（放行本轮）/ 'ignore'（忽略 N 分钟）/ null（照常拦截）。
   *
   * 为什么要续期：高峰窗口一次 3 小时，若免拦是固定死期，用户每 N 分钟就得重点一次
   * （2026-09-24 实测报障）。改成"只要你还在这个对话里发请求就一直免拦，停手 N 分钟后
   * 自动恢复拦截"——既不用反复点，停止使用后又能立刻回到省钱状态。
   */
  function touchBypass(sessionKey) {
    if (!sessionKey) return null
    const now = Date.now()
    const turn = turnBypass.get(sessionKey)
    if (turn !== undefined) {
      if (turn.until <= now) turnBypass.delete(sessionKey)
      else {
        turn.until = now + config.turnBypassMs
        return 'turn'
      }
    }
    const ignore = bypasses.get(sessionKey)
    if (ignore !== undefined) {
      if (ignore.until <= now) bypasses.delete(sessionKey)
      else {
        ignore.until = now + config.bypassMs
        return 'ignore'
      }
    }
    return null
  }

  /** 是否处于免拦状态（查询时顺带滑动续期）。 */
  function isBypassedNow(sessionKey) {
    return touchBypass(sessionKey) !== null
  }

  /** 「放行」= 本轮不再拦（回合结束即清），见 touchBypass 的说明。 */  function addTurnBypass(sessionKey, label) {
    if (!sessionKey) return false
    turnBypass.set(sessionKey, {
      at: Date.now(),
      until: Date.now() + config.turnBypassMs,
      label: label || '对话请求',
    })
    return true
  }

  /** 「忽略本次」= 该对话限时免拦（滑动续期）。 */
  function addBypass(sessionKey, label) {
    if (!sessionKey) return false
    bypasses.set(sessionKey, {
      at: Date.now(),
      until: Date.now() + config.bypassMs,
      label: label || '对话请求',
    })
    return true
  }

  function clearBypass(sessionKey) {
    pruneBypasses()
    if (sessionKey === undefined) {
      const n = bypasses.size + turnBypass.size
      bypasses.clear()
      turnBypass.clear()
      return n
    }
    let n = 0
    if (bypasses.delete(sessionKey)) n += 1
    if (turnBypass.delete(sessionKey)) n += 1
    return n
  }

  function viewOf(map, mode, now) {
    return [...map.entries()].map(([sessionId, entry]) => ({
      // 内部用完整 id 做键，对外只给短 id（与 parks[].sessionId 一致）
      sessionId: shortSessionId(sessionId),
      key: sessionId,
      mode,
      label: entry.label,
      until: entry.until,
      remainMs: Math.max(0, entry.until - now),
    }))
  }

  function bypassView() {
    pruneBypasses()
    const now = Date.now()
    for (const [key, entry] of [...turnBypass]) {
      if (!entry || entry.until <= now) turnBypass.delete(key)
    }
    return [...viewOf(turnBypass, 'turn', now), ...viewOf(bypasses, 'ignore', now)]
  }

  /** 为一次模型调用建"挂起记录"：带身份信息，支持「针对个别对话放行」。 */
  function makePark(kind, extra) {
    parkSeq += 1
    return {
      id: `${kind === 'peak' ? 'pk' : 'net'}-${Date.now().toString(36)}-${parkSeq}`,
      kind,
      startedAt: Date.now(),
      released: false,
      label: '',
      provider: '',
      model: '',
      sessionId: '',
      sessionKey: '',
      releaseAt: null,
      releaseText: null,
      nextRetryAt: null,
      attempt: 0,
      code: '',
      message: '',
      __wake: null,
      ...extra,
    }
  }

  /**
   * 人类可读的请求身份：内部调用（生成会话标题 / 压缩上下文）直接标注；
   * 普通对话取"最后一条真人消息"开头 —— 用来分辨是哪个对话被挂住了。
   */
  function describeRequest(options) {
    const purpose = options && options.purpose
    if (purpose === 'session-title') return '生成会话标题'
    if (purpose === 'compaction') return '压缩上下文'
    const messages = (options && options.messages) || []
    let injected = '' // 插件注入的 user 角色消息（兜底用）
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (!message || message.role !== 'user') continue
      const blocks = Array.isArray(message.content) ? message.content : []
      // 工具结果也是 user 角色，不是"人说的话"
      if (blocks.some((b) => b && b.type === 'tool_result')) continue
      let text = ''
      for (const block of blocks) {
        if (block && block.type === 'text' && typeof block.text === 'string') {
          text = block.text.replace(/\s+/gu, ' ').trim()
          if (text) break
        }
      }
      if (!text) continue
      const kind = message.source && message.source.kind
      // 只认"真人"消息。DSH 的消息带 source.kind：后台任务完成通知、记忆块、
      // system-reminder 等虽然是 user 角色，却由插件注入（kind='plugin'）。
      // 之前只按 role 取，标签会显示成"background job bash-1…"，用户根本认不出
      // 哪一行才是自己的对话（2026-09-24 实测踩到）。
      if (kind === undefined || kind === 'user') {
        return text.length > 24 ? `${text.slice(0, 24)}…` : text
      }
      if (!injected) injected = text
    }
    // 整个会话里没有真人消息（例如纯后台任务通知唤醒的会话）：如实标注
    if (injected) return `后台通知 · ${injected.slice(0, 20)}${injected.length > 20 ? '…' : ''}`
    return '对话请求'
  }

  function shortSessionId(value) {
    const id = String(value || '')
    return id ? id.replace(/^session[:_-]?/iu, '').slice(0, 8) : ''
  }

  function sessionIdOf(options) {
    try {
      return shortSessionId(options && options.sessionId)
    } catch {
      return ''
    }
  }

  /** 完整 sessionId：内部用来做「忽略本次」的键（短 id 只用于展示）。 */
  function sessionKeyOf(options) {
    try {
      return String((options && options.sessionId) || '')
    } catch {
      return ''
    }
  }

  /** 放行一个挂起：高峰=不等了直接发；网络=马上重连。返回是否真的释放了。 */
  function releasePark(park) {
    if (!park || park.released) return false
    park.released = true
    try {
      if (park.__wake) park.__wake()
    } catch {}
    return true
  }

  // 可中止/可放行的睡眠：
  //  - AbortSignal（用户停止回合）→ 立即结束等待；
  //  - 用户点「放行」→ park.released=true 并唤醒 → 等待循环随即退出；
  //  - 插件 stop/update → 放行全部挂起，不阻塞任何会话。
  function sleep(ms, signal, park) {
    return new Promise((resolve) => {
      let settled = false
      let timer = null
      const done = () => {
        if (settled) return
        settled = true
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        if (signal && signal.removeEventListener) signal.removeEventListener('abort', onAbort)
        if (park && park.__wake === done) park.__wake = null
        resolve()
      }
      const onAbort = done
      if (park) park.__wake = done
      timer = setTimeout(done, ms)
      if (signal) {
        if (signal.aborted) {
          done()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  // 高峰等待循环：每 ≤15s 复查一次（响应配置切换/系统时钟变化/单请求放行），低谷即放行。
  // 返回后由 llm/stream 监听器调用 next() 继续原请求。
  async function waitForValley(options, park) {
    let counted = false
    while (true) {
      if (park.released) return // 用户已手动放行这一个
      if (!config.enabled) return
      if (!matchesGate(options, config)) return
      if (isBypassedNow(park.sessionKey)) return // 「放行本轮」/「忽略本次」：这个对话免拦，直接发
      if (options && options.signal && options.signal.aborted) return // 用户已中止：交下游
      const now = Date.now()
      if (!isPeakAt(now, config)) return
      if (!counted) {
        counted = true
        stats.parkedCalls += 1
        const releaseAt = nextReleaseAt(now, config)
        park.releaseAt = releaseAt
        // 全天高峰（配置里没有低谷）时 releaseAt 是 72 小时兜底值，
        // 显示成"今天 XX:XX 放行"会误导人（2026-09-23 演示时踩到）
        park.noValley = releaseAt - now > 24 * 3600 * 1000
        park.releaseText = park.noValley ? '' : hhmm(releaseAt)
        stats.lastPark = {
          at: now,
          releaseAt,
          releaseText: park.releaseText,
          provider: park.provider,
          model: park.model,
          label: park.label,
        }
        activePeakParks.add(park)
        console.log(
          `[dsh-peak-gate] 高峰避让：挂起 ${park.provider}/${park.model} 请求（${park.label}）` +
            `[会话 ${park.sessionId || '未知'}]，预计 ${park.releaseText} 放行（当前 ${hhmm(now)}）；` +
            `可在徽章里单独放行`,
        )
      }
      const releaseAt = nextReleaseAt(now, config)
      const delay = Math.min(Math.max(releaseAt - now, 1000), 15000)
      await sleep(delay, options && options.signal, park)
      if (park.released) return
    }
  }

  // ---- 闸门一：llm/stream 瀑布（每次模型调用的必经之路）----
  disposers.push(ctx.on('llm/stream', (options, next) => {
    const park = makePark('peak', {
      provider: String((options && options.provider) || ''),
      model: String((options && options.model) || ''),
      sessionId: sessionIdOf(options),
      sessionKey: sessionKeyOf(options),
      label: describeRequest(options),
    })
    try {
      stats.lastSeen = { ts: Date.now(), provider: park.provider, model: park.model, label: park.label }
      // 记下该会话最近一次请求的身份，网络挂起时按 sessionId 取回标签
      if (park.sessionId) {
        recentRequests.set(park.sessionId, {
          label: park.label,
          provider: park.provider,
          model: park.model,
          at: Date.now(),
        })
        if (recentRequests.size > 50) {
          const oldest = [...recentRequests.entries()].sort((a, b) => a[1].at - b[1].at)[0]
          if (oldest) recentRequests.delete(oldest[0])
        }
      }
    } catch {}
    return (async function* () {
      try {
        await waitForValley(options, park)
      } finally {
        activePeakParks.delete(park)
        park.__wake = null
      }
      yield* next()
    })()
  }))

  // -------------------------------------------------------------------------
  // 闸门二：agent/request-error 瀑布（"这次失败要不要重试"的决策点）
  // -------------------------------------------------------------------------

  /** 从请求失败载荷里取模型名（展示与匹配用，取不到就留空）。 */
  function modelOf(payload) {
    try {
      const opts = payload && payload.agent && payload.agent.options
      return String((opts && opts.model) || '')
    } catch {
      return ''
    }
  }

  /** 从请求失败载荷里取完整 sessionId（「忽略本次」的键）。 */
  function sessionKeyOfPayload(payload) {
    try {
      return String((payload && payload.agent && payload.agent.session && payload.agent.session.id) || '')
    } catch {
      return ''
    }
  }

  /** 同一 turn+step+provider 的连续网络挂起计数（重试成功后回合推进，键自然变化）。 */
  function nextNetCycle(payload) {
    const key = `${payload.turn}|${payload.step}|${payload.provider}`
    const cycle = (netCycles.get(key) || 0) + 1
    if (netCycles.size > 200) netCycles.clear()
    netCycles.set(key, cycle)
    return cycle
  }

  /** 等待唤醒：定时到点 / 用户点「立即重试」/ 用户中止回合 / 插件卸载，都算唤醒。 */
  function waitForWake(park, ms, signal) {
    return new Promise((resolve) => {
      let settled = false
      let timer = null
      const finish = (reason) => {
        if (settled) return
        settled = true
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        if (signal && signal.removeEventListener) signal.removeEventListener('abort', onAbort)
        park.__wake = null
        resolve(reason)
      }
      const onAbort = () => finish('abort')
      // 「取消挂起」= 立即结束等待并重试连接（走 manual 分支）。
      park.__wake = () => finish('manual')
      timer = setTimeout(() => finish('timer'), ms)
      if (signal) {
        if (signal.aborted) {
          finish('abort')
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  /**
   * 网络故障挂起：不把失败交回上层，等一会儿再让本轮回合重试。
   * 返回 { kind: 'retry' } → agent loop 原地重试；返回 next() → 交回原生失败流程。
   */
  async function parkForNetwork(payload, failure, next) {
    const net = config.netPark
    const cycle = nextNetCycle(payload)
    if (net.maxAttempts > 0 && cycle > net.maxAttempts) {
      console.log(
        `[dsh-peak-gate] 网络故障挂起：本回合已达上限 ${net.maxAttempts} 次，交回正常失败流程`,
      )
      return next()
    }
    const model = modelOf(payload)
    const delayMs = computeNetDelay(config, cycle, failure)
    const now = Date.now()
    const sessionId = (() => {
      try {
        return shortSessionId(payload && payload.agent && payload.agent.session && payload.agent.session.id)
      } catch {
        return ''
      }
    })()
    const sessionKey = sessionKeyOfPayload(payload)
    const recent = sessionId ? recentRequests.get(sessionId) : null
    const park = makePark('network', {
      startedAt: now,
      attempt: cycle,
      nextRetryAt: now + delayMs,
      delayMs,
      code: String((failure && failure.code) || ''),
      provider: String((payload && payload.provider) || ''),
      model,
      sessionId,
      sessionKey,
      label: (recent && recent.label) || '对话请求',
      message: String((failure && failure.message) || '').slice(0, 300),
    })
    stats.network.parks += 1
    stats.network.lastPark = {
      at: park.startedAt,
      attempt: park.attempt,
      code: park.code,
      provider: park.provider,
      model: park.model,
      sessionId: park.sessionId,
      label: park.label,
      message: park.message,
      delayMs,
    }
    activeNetParks.add(park)
    console.log(
      `[dsh-peak-gate] 网络中断挂起：${park.provider}/${park.model} ${park.code}（${park.label}）—— 第 ${cycle} 次，` +
        `${Math.round(delayMs / 1000)}s 后自动重试（可在徽章里立即重试）`,
    )
    try {
      const reason = await waitForWake(park, delayMs, payload && payload.signal)
      if (reason === 'abort') {
        // 用户已中止回合：不重试，交回流程让本轮正常收尾。
        return next()
      }
      console.log(
        `[dsh-peak-gate] 网络挂起结束（${reason === 'manual' ? '用户立即重试' : '自动重试'}）：` +
          `${park.provider}/${park.model} 重新发起请求`,
      )
      return { kind: 'retry' }
    } finally {
      activeNetParks.delete(park)
    }
  }

  async function handleRequestError(payload, next) {
    try {
      const failure = payload && payload.failure
      if (!failure) return next()
      if (!config.enabled || !config.netPark.enabled) return next()
      if (payload.signal && payload.signal.aborted) return next()
      if (!shouldParkFailure(failure, config)) return next()
      // 「忽略本次」：这个对话免拦，网络失败也走原生失败流程
      if (isBypassedNow(sessionKeyOfPayload(payload))) return next()
      // 只接管自己该管的 provider/model（netPark.match 默认为空 = 全部）。
      if (!matchesGate({ provider: payload.provider, model: modelOf(payload) }, { match: config.netPark.match })) {
        return next()
      }
      return await parkForNetwork(payload, failure, next)
    } catch (err) {
      console.error(`[dsh-peak-gate] 网络挂起处理异常，交回原生流程: ${(err && err.message) || err}`)
      return next()
    }
  }

  disposers.push(ctx.on('agent/request-error', (payload, next) => handleRequestError(payload, next)))

  // 回合结束 → 立刻清掉「放行本轮」的免拦，回到省钱状态（turnBypassMs 只是事件丢失时的兜底）。
  disposers.push(ctx.on('agent/turn-stopping', (payload) => {
    try {
      const key = sessionKeyOfPayload(payload)
      if (key && turnBypass.delete(key)) {
        console.log(`[dsh-peak-gate] 回合结束：${shortSessionId(key)} 的「放行本轮」已恢复拦截`)
      }
    } catch {}
  }))

  // ---- 派发探针：证明 agent 作用域事件确实能到达本插件（自检用，见 state.json.probe）----
  // 监听两个无副作用的普通派发事件：
  //   - tools/result：每次工具调用后触发 → 能在回合中途立刻证明派发链路通；
  //   - agent/status：回合状态翻转时触发。
  // 只要计数在涨，说明作用域派发链路通；网络挂起若"没生效"就该去查 match/codes 配置。
  const probe = { events: 0, lastStatus: null, toolResults: 0, firstAt: 0, lastAt: 0 }
  disposers.push(ctx.on('agent/status', (payload) => {
    probe.events += 1
    probe.lastStatus = String((payload && payload.status) || '')
    probe.lastAt = Date.now()
    if (!probe.firstAt) probe.firstAt = probe.lastAt
  }))
  disposers.push(ctx.on('tools/result', () => {
    probe.events += 1
    probe.toolResults += 1
    probe.lastAt = Date.now()
    if (!probe.firstAt) probe.firstAt = probe.lastAt
  }))

  // 放行挂起中的请求：
  //   - 不传 kind → 全部（高峰 + 网络）；
  //   - kind='peak' / 'network' → 只放行该类；
  //   - id → 只放行指定那一个（「针对个别对话放行」）；
  //   - action='bypass' → 「忽略本次」：放行它，并让**该对话**限时免拦（滑动续期）；
  //   - 默认（action 省略）→ 「放行本轮」：放行它，并让该对话在本轮内不再被拦（回合结束即恢复）。
  function releaseParks({ id, kind, action } = {}) {
    const pools = kind === 'peak'
      ? [activePeakParks]
      : kind === 'network'
        ? [activeNetParks]
        : [activePeakParks, activeNetParks]
    let released = 0
    let bypassed = 0
    for (const pool of pools) {
      for (const park of [...pool]) {
        if (id !== undefined && park.id !== id) continue
        const sticky = action === 'bypass'
          ? addBypass(park.sessionKey, park.label)
          : addTurnBypass(park.sessionKey, park.label)
        if (sticky) bypassed += 1
        if (releasePark(park)) {
          // 立刻从"挂起中"清单移除：等待循环的收尾在下一个微任务才跑，
          // 不先删的话，放行响应里的 state 会显示成"还在挂起"（实测踩到）。
          pool.delete(park)
          released += 1
        }
      }
    }
    return { released, bypassed }
  }

  function parkedView(park) {
    return {
      id: park.id,
      kind: park.kind,
      label: park.label,
      provider: park.provider,
      model: park.model,
      sessionId: park.sessionId,
      startedAt: park.startedAt,
      releaseAt: park.releaseAt,
      releaseText: park.releaseText,
      noValley: Boolean(park.noValley),
      nextRetryAt: park.nextRetryAt,
      delayMs: park.delayMs || null,
      attempt: park.attempt || 1,
      code: park.code,
      message: park.message,
    }
  }

  // ---- 状态快照 ----
  function statePayload() {
    const now = Date.now()
    const peak = isPeakAt(now, config)
    const releaseAt = peak ? nextReleaseAt(now, config) : null
    return {
      ok: true,
      enabled: config.enabled,
      phase: peak ? 'peak' : 'valley',
      tz: 'UTC+8 北京时间',
      now,
      releaseAt,
      releaseText: releaseAt ? hhmm(releaseAt) : null,
      noValley: Boolean(releaseAt && releaseAt - now > 24 * 3600 * 1000),
      parkedCalls: stats.parkedCalls,
      parkedNow: activePeakParks.size,
      lastPark: stats.lastPark,
      lastSeen: stats.lastSeen,
      match: config.match,
      windows: config.windows,
      weekendsValley: config.weekendsValley,
      position: config.ui.position,
      // 统一挂起清单（高峰 + 网络）：每条都能单独放行或「忽略本次」
      parks: [...activePeakParks, ...activeNetParks].map(parkedView),
      // 免拦名单（「放行本轮」+「忽略本次」），可随时恢复
      bypass: bypassView(),
      bypassMs: config.bypassMs,
      turnBypassMs: config.turnBypassMs,
      network: {
        enabled: config.enabled && config.netPark.enabled,
        codes: config.netPark.codes,
        match: config.netPark.match,
        parks: stats.network.parks,
        parkedNow: activeNetParks.size,
        parked: [...activeNetParks].map((p) => ({
          id: p.id,
          startedAt: p.startedAt,
          attempt: p.attempt,
          nextRetryAt: p.nextRetryAt,
          delayMs: p.delayMs,
          code: p.code,
          provider: p.provider,
          model: p.model,
          message: p.message,
        })),
        lastPark: stats.network.lastPark,
        autoRetryMs: config.netPark.autoRetryMs,
        maxAutoRetryMs: config.netPark.maxAutoRetryMs,
        maxAttempts: config.netPark.maxAttempts,
      },
      // 派发链路自检：计数在涨 = agent 作用域事件确实能到达本插件
      probe: {
        agentEvents: probe.events,
        toolResults: probe.toolResults,
        lastStatus: probe.lastStatus,
        firstAt: probe.firstAt,
        lastAt: probe.lastAt,
      },
    }
  }

  // ---- HTTP 路由 ----
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-peak-gate/state.json',
    handler: (req, res) => {
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify(statePayload()))
    },
  }))

  // 放行 / 忽略挂起中的请求：POST /dsh-peak-gate/release
  //   body 省略 / {}                        → 放行全部（高峰 + 网络）
  //   { "id": "pk-xxx" }                    → 只放行指定那一个（针对个别对话）
  //   { "kind": "peak" | "network" }        → 只放行某一类
  //   { "id": "pk-xxx", "action":"bypass" } → 「忽略本次」：放行它，且该对话在 bypassMs 内免拦
  //   { "action": "bypass", "kind":"peak" } → 这一类全部忽略本次
  //   { "undo": "bypass" }                  → 撤销全部「忽略本次」
  //   { "undo": "bypass", "sessionId":"…" } → 撤销某一个对话的免拦
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-peak-gate/release',
    handler: (req, res) => {
      if (req.method !== 'POST' && req.method !== 'PUT') {
        res.writeHead(405, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: 'use POST' }))
        return
      }
      const chunks = []
      req.on('data', (c) => {
        chunks.push(c)
        if (Buffer.concat(chunks).length > 8192) req.destroy()
      })
      req.on('end', () => {
        let body = {}
        try {
          const raw = Buffer.concat(chunks).toString('utf8').trim()
          if (raw) body = JSON.parse(raw)
        } catch {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }))
          return
        }
        if (body.undo === 'bypass') {
          // 撤销免拦：按短 id 匹配（对外只暴露短 id），不带 sessionId 就清空全部
          let cleared = 0
          if (typeof body.sessionId === 'string' && body.sessionId) {
            for (const map of [turnBypass, bypasses]) {
              for (const [key] of [...map]) {
                if (shortSessionId(key) === body.sessionId) {
                  map.delete(key)
                  cleared += 1
                }
              }
            }
          } else {
            cleared = clearBypass()
          }
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: true, cleared, state: statePayload() }))
          return
        }
        const { released, bypassed } = releaseParks({
          id: typeof body.id === 'string' && body.id ? body.id : undefined,
          kind: body.kind === 'peak' || body.kind === 'network' ? body.kind : undefined,
          action: body.action === 'bypass' ? 'bypass' : undefined,
        })
        if (bypassed > 0) {
          console.log(
            `[dsh-peak-gate] ${body.action === 'bypass' ? '忽略本次' : '放行本轮'}：` +
              `${bypassed} 个对话进入免拦（放行 ${released} 个请求）`,
          )
        }
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: true, released, bypassed, state: statePayload() }))
      })
      req.on('error', () => {})
    },
  }))

  // 取消挂起（立即重试连接）：POST /dsh-peak-gate/wake —— 等价于放行全部网络挂起
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-peak-gate/wake',
    handler: (req, res) => {
      if (req.method !== 'POST' && req.method !== 'PUT') {
        res.writeHead(405, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: 'use POST' }))
        return
      }
      req.on('data', (c) => {})
      req.on('end', () => {
        const { released: woke } = releaseParks({ kind: 'network' })
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: true, woke, state: statePayload() }))
      })
      req.on('error', () => {})
    },
  }))

  // 读配置 / 热更新配置（UI 开关、时段调整、网络挂起参数）
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-peak-gate/config.json',
    handler: (req, res) => {
      if (req.method !== 'PUT' && req.method !== 'POST') {
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({
          ok: true,
          config: {
            enabled: config.enabled,
            match: config.match,
            windows: config.windows,
            weekendsValley: config.weekendsValley,
            ui: config.ui,
            netPark: config.netPark,
          },
        }))
        return
      }
      const chunks = []
      req.on('data', (c) => {
        chunks.push(c)
        if (Buffer.concat(chunks).length > 8192) req.destroy()
      })
      req.on('end', () => {
        try {
          const patch = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          const next = mergeConfig(config, patch)
          if (!saveConfig(next)) {
            res.writeHead(500, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: 'config save failed' }))
            return
          }
          config = next
          // 关掉总开关 = 放行全部；只关网络挂起 = 只放行网络挂起（高峰避让照旧）
          if (!config.enabled) releaseParks()
          else if (!config.netPark.enabled) releaseParks({ kind: 'network' })
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: true, state: statePayload() }))
        } catch (err) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
        }
      })
      req.on('error', () => {})
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-peak-gate/widget.js',
    handler: (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(WIDGET_JS)
    },
  }))

  disposers.push(ctx.webServer.tapIndex((html) => {
    if (html.indexOf('/dsh-peak-gate/widget.js') !== -1) return html
    const tag = '<script defer src="/dsh-peak-gate/widget.js"></script>'
    if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
    return html + tag
  }))

  // ---- 生命周期清理 ----
  ctx.effect(() => () => {
    // 插件停止/更新：立即放行所有挂起请求（高峰 + 网络），闸门随插件移除，不阻塞任何会话
    releaseParks()
    for (const d of disposers) {
      try {
        d()
      } catch {}
    }
  })
}

// ---------------------------------------------------------------------------
// 浏览器徽章（经 /dsh-peak-gate/widget.js 注入；host 侧模板，纯 ES5 写法）
// ---------------------------------------------------------------------------

const WIDGET_JS = [
  '(function () {',
  '  if (window.__dshPeakGate) return',
  '  window.__dshPeakGate = true',
  "  var STATE_URL = '/dsh-peak-gate/state.json'",
  "  var CONFIG_URL = '/dsh-peak-gate/config.json'",
  "  var WAKE_URL = '/dsh-peak-gate/wake'",
  "  var RELEASE_URL = '/dsh-peak-gate/release'",
  '  var HIDE_KEY = "dsh-peak-gate:hidden"',
  '  var state = null',
  '  var root = null, dot = null, label = null, sub = null, btn = null',
  '  var panel = null, listBtn = null, expanded = false',
  '  var tick = 0',
  '',
  '  function make(tag, cls, text) {',
  '    var n = document.createElement(tag)',
  '    if (cls) n.className = cls',
  '    if (text != null) n.textContent = text',
  '    return n',
  '  }',
  '',
  '  function pad(n) { return n < 10 ? "0" + n : String(n) }',
  '  function fmtCountdown(ms) {',
  '    if (ms <= 0) return "00:00"',
  '    var s = Math.floor(ms / 1000)',
  '    var m = Math.floor(s / 60)',
  '    s = s % 60',
  '    if (m >= 60) return Math.floor(m / 60) + "小时" + pad(m % 60) + "分"',
  '    return pad(m) + ":" + pad(s)',
  '  }',
  '',
  '  function fmtBypassLabel() {',
  '    var ms = (state && state.bypassMs) || 600000',
  '    var min = Math.round(ms / 60000)',
  '    if (min >= 1) return "忽略 " + min + " 分钟"',
  '    return "忽略 " + Math.round(ms / 1000) + " 秒"',
  '  }',
  '',
  '  function posStyle(pos) {',
  '    var base = { position: "fixed", "z-index": "2147483000" }',
  // 本地适配（2026-09-07）：bottom 系列抬高到 104px，避开 macOS Dock/系统设置区
  '    if (pos === "bottom-right") return Object.assign(base, { right: "16px", bottom: "104px" })',
  '    if (pos === "top-left") return Object.assign(base, { left: "16px", top: "20px" })',
  '    if (pos === "top-right") return Object.assign(base, { right: "16px", top: "20px" })',
  '    return Object.assign(base, { left: "16px", bottom: "104px" })',
  '  }',
  '',
  '  function applyStyle(n, css) {',
  '    for (var k in css) {',
  '      if (Object.prototype.hasOwnProperty.call(css, k)) n.style[k] = css[k]',
  '    }',
  '  }',
  '',
  '  function mount() {',
  '    if (root || !document.body) return',
  '    root = make("div")',
  '    root.id = "dsh-peak-gate"',
  '    applyStyle(root, {',
  '      "font": "12px/1.5 -apple-system, BlinkMacSystemFont, \\"PingFang SC\\", \\"Microsoft YaHei\\", sans-serif",',
  '      "padding": "6px 12px",',
  '      "border-radius": "999px",',
  '      "background": "rgba(18,18,24,0.9)",',
  '      "color": "#eee",',
  '      "box-shadow": "0 2px 12px rgba(0,0,0,0.4)",',
  '      "display": "flex",',
  '      "align-items": "center",',
  '      "gap": "8px",',
  '      "user-select": "none",',
  '      "cursor": "default"',
  '    })',
  '    dot = make("span")',
  '    applyStyle(dot, { width: "8px", height: "8px", "border-radius": "50%", background: "#888", "flex": "none" })',
  '    label = make("span", null, "闸门初始化…")',
  '    sub = make("span", null, "")',
  '    applyStyle(sub, { color: "#9aa", "font-variant-numeric": "tabular-nums" })',
  '    btn = make("button", null, "停用")',
  '    applyStyle(btn, {',
  '      border: "1px solid #555", "border-radius": "6px", background: "transparent",',
  '      color: "#ddd", "font-size": "11px", padding: "1px 7px", cursor: "pointer"',
  '    })',
  '    btn.addEventListener("click", function () {',
  '      if (!state) return',
  '      var list = state.parks || []',
  '      var nets = 0, peaks = 0',
  '      for (var i = 0; i < list.length; i++) {',
  '        if (list[i].kind === "network") nets += 1; else peaks += 1',
  '      }',
  // 有网络挂起 → 立即重连；只有高峰挂起 → 全部放行；都没有 → 启停总开关
  '      if (nets > 0) { postWake(); return }',
  '      if (peaks > 0) { postRelease({ kind: "peak" }); return }',
  '      putConfig({ enabled: !state.enabled }, function () { fetchState() })',
  '    })',
  '    listBtn = make("button", null, "挂起列表")',
  '    applyStyle(listBtn, {',
  '      border: "1px solid #f5a623", "border-radius": "6px", background: "transparent",',
  '      color: "#f5a623", "font-size": "11px", padding: "1px 7px", cursor: "pointer", display: "none"',
  '    })',
  '    listBtn.addEventListener("click", function () { expanded = !expanded; render() })',
  '    panel = make("div")',
  '    applyStyle(panel, {',
  '      position: "absolute", left: "0",',
  '      "min-width": "330px", "max-width": "460px",',
  '      background: "rgba(18,18,24,0.97)", border: "1px solid #333",',
  '      "border-radius": "10px", padding: "8px 10px", "text-align": "left",',
  '      "box-shadow": "0 6px 24px rgba(0,0,0,0.5)", display: "none"',
  '    })',
  '    var close = make("button", null, "×")',
  '    applyStyle(close, { border: "none", background: "transparent", color: "#777", cursor: "pointer", "font-size": "13px", padding: "0 2px" })',
  '    close.addEventListener("click", function () {',
  '      // 仅隐藏到本次会话结束：刷新后自动回来，避免“叉掉一次就再也找不到开关”',
  '      try { sessionStorage.setItem(HIDE_KEY, "1") } catch (e) {}',
  '      if (root) root.parentNode && root.parentNode.removeChild(root)',
  '      root = null',
  '    })',
  '    root.appendChild(dot)',
  '    root.appendChild(label)',
  '    root.appendChild(sub)',
  '    root.appendChild(btn)',
  '    root.appendChild(listBtn)',
  '    root.appendChild(close)',
  '    root.appendChild(panel)',
  '    document.body.appendChild(root)',
  '  }',
  '',
  '  function render() {',
  '    mount()',
  '    if (!root) return',
  '    if (!state) {',
  '      dot.style.background = "#888"',
  '      label.textContent = "闸门状态获取失败"',
  '      sub.textContent = ""',
  '      if (listBtn) listBtn.style.display = "none"',
  '      if (panel) panel.style.display = "none"',
  '      return',
  '    }',
  '    var pos = state.position || "bottom-left"',
  '    applyStyle(root, posStyle(pos))',
  '    root.className = ""',
  '    var list = state.parks || []',
  '    var peakParks = [], netParks = []',
  '    for (var i = 0; i < list.length; i++) {',
  '      if (list[i].kind === "network") netParks.push(list[i]); else peakParks.push(list[i])',
  '    }',
  '    var parked = peakParks.length',
  '    var count = state.parkedCalls || 0',
  '    var bypInfo = state.bypass && state.bypass.length ? " · 免拦 " + state.bypass.length + " 个对话" : ""',
  // 「挂起列表」按钮：只要有挂起就出现，点开可针对个别对话放行
  '    if (listBtn) {',
  '      listBtn.style.display = list.length ? "" : "none"',
  '      listBtn.textContent = expanded ? "收起" : "挂起列表 " + list.length',
  '    }',
  // 网络故障挂起优先级最高：此刻用户最需要看到"为什么没反应"和怎么立刻重连。
  '    if (netParks.length > 0) {',
  '      root.className = "dpg-net"',
  '      dot.style.background = "#f5a623"',
  '      dot.style.boxShadow = "0 0 6px #f5a623"',
  '      label.textContent = "网络中断 · 已挂起 " + netParks.length + " 个请求"',
  '      var remain = netParks[0].nextRetryAt ? netParks[0].nextRetryAt - Date.now() : 0',
  '      sub.textContent = "第 " + (netParks[0].attempt || 1) + " 次 · " + fmtCountdown(remain) + "后自动重试" +',
  '        (netParks[0].code ? " · " + netParks[0].code : "")',
  '      btn.textContent = "立即重试"',
  '    } else if (!state.enabled) {',
  '      root.className = "dpg-off"',
  '      dot.style.background = "#888"',
  '      dot.style.boxShadow = "none"',
  '      label.textContent = "闸门已停用"',
  '      sub.textContent = count > 0 ? "曾挂起 " + count + " 次" : ""',
  '      btn.textContent = "启用"',
  '    } else if (state.phase === "peak") {',
  '      root.className = "dpg-peak"',
  '      dot.style.background = "#e5484d"',
  '      dot.style.boxShadow = "0 0 6px #e5484d"',
  '      label.textContent = parked > 0 ? "高峰避让 · 挂起中 " + parked : "高峰避让中"',
  '      var remain2 = state.releaseAt ? state.releaseAt - Date.now() : 0',
  '      sub.textContent = state.noValley',
  '        ? "全天高峰（没有低谷）· 不会自动放行"',
  '        : (state.releaseText || "??:??") + " 放行 · 距放行 " + fmtCountdown(remain2)',
  '      if (parked === 0) sub.textContent += bypInfo',
  '      btn.textContent = parked > 0 ? "全部放行" : "停用"',
  '    } else {',
  '      root.className = "dpg-valley"',
  '      dot.style.background = "#30a46c"',
  '      dot.style.boxShadow = "0 0 6px #30a46c"',
  '      label.textContent = state.weekendsValley ? "低谷 / 周末谷价" : "低谷时段"',
  '      var netInfo = state.network && state.network.parks ? " · 网络挂起 " + state.network.parks + " 次" : ""',
  '      sub.textContent = (count > 0 ? "今日已挂起 " + count + " 次" : "请求正常") + netInfo + bypInfo',
  '      btn.textContent = "停用"',
  '    }',
  '    renderPanel(pos)',
  '  }',
  '',
  '  function rowEl(p) {',
  '    var row = make("div")',
  '    applyStyle(row, { display: "flex", "align-items": "center", gap: "8px", padding: "6px 0", "border-top": "1px solid #2b2b33" })',
  '    var info = make("div")',
  '    applyStyle(info, { flex: "1 1 auto", "min-width": "0" })',
  '    var head = make("div", null, (p.kind === "network" ? "[网络] " : "[高峰] ") + (p.label || "对话请求"))',
  '    applyStyle(head, { overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap", color: "#eee" })',
  '    var metaText = p.model || p.provider || ""',
  '    if (p.sessionId) metaText += (metaText ? " · " : "") + p.sessionId',
  '    if (p.kind === "network") {',
  '      metaText += " · " + (p.code || "网络错误") + " · 第 " + (p.attempt || 1) + " 次 · " +',
  '        fmtCountdown((p.nextRetryAt || 0) - Date.now()) + "后自动重试"',
  '    } else {',
  '      metaText += " · " + (p.noValley ? "全天高峰，不会自动放行" : (p.releaseText || "低谷") + " 自动放行")',
  '    }',
  '    var meta = make("div", null, metaText)',
  '    applyStyle(meta, { color: "#9aa", "font-size": "11px", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" })',
  '    info.appendChild(head)',
  '    info.appendChild(meta)',
  '    var act = make("button", null, p.kind === "network" ? "重试" : "放行本轮")',
  '    applyStyle(act, {',
  '      flex: "none", border: "1px solid #555", "border-radius": "6px", background: "transparent",',
  '      color: "#ddd", "font-size": "11px", padding: "2px 8px", cursor: "pointer"',
  '    })',
  '    act.addEventListener("click", function () { postRelease({ id: p.id }) })',
  // 「忽略本次」：这个对话限时免拦，期间你在用就自动续期（可撤销）
  '    var skip = make("button", null, fmtBypassLabel())',
  '    applyStyle(skip, {',
  '      flex: "none", border: "1px solid #555", "border-radius": "6px", background: "transparent",',
  '      color: "#fc9", "font-size": "11px", padding: "2px 8px", cursor: "pointer"',
  '    })',
  '    skip.addEventListener("click", function () { postRelease({ id: p.id, action: "bypass" }) })',
  '    row.appendChild(info)',
  '    row.appendChild(act)',
  '    row.appendChild(skip)',
  '    return row',
  '  }',
  '',
  '  function bypassRowEl(b) {',
  '    var row = make("div")',
  '    applyStyle(row, { display: "flex", "align-items": "center", gap: "8px", padding: "6px 0" })',
  '    var info = make("div")',
  '    applyStyle(info, { flex: "1 1 auto", "min-width": "0" })',
  '    var head = make("div", null, (b.mode === "turn" ? "[本轮] " : "[忽略] ") + (b.label || "对话请求"))',
  '    applyStyle(head, { overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap", color: "#bbb" })',
  '    var meta = make("div", null, "免拦剩余 " + fmtCountdown(b.remainMs) + (b.sessionId ? " · " + b.sessionId : "") + " · 在用会自动续期")',
  '    applyStyle(meta, { color: "#9aa", "font-size": "11px" })',
  '    info.appendChild(head)',
  '    info.appendChild(meta)',
  '    var undo = make("button", null, "恢复")',
  '    applyStyle(undo, {',
  '      flex: "none", border: "1px solid #555", "border-radius": "6px", background: "transparent",',
  '      color: "#ddd", "font-size": "11px", padding: "2px 8px", cursor: "pointer"',
  '    })',
  '    undo.addEventListener("click", function () { postRelease({ undo: "bypass", sessionId: b.sessionId }) })',
  '    row.appendChild(info)',
  '    row.appendChild(undo)',
  '    return row',
  '  }',
  '',
  '  function renderPanel(pos) {',
  '    if (!panel) return',
  '    var list = (state && state.parks) || []',
  '    if (!expanded || !list.length) {',
  '      panel.style.display = "none"',
  '      panel.textContent = ""',
  '      return',
  '    }',
  '    panel.style.display = "block"',
  // 徽章在页面下方时列表朝上展开，在上方时朝下展开
  '    if (pos === "top-left" || pos === "top-right") {',
  '      panel.style.top = "100%"',
  '      panel.style.bottom = ""',
  '      panel.style["margin-top"] = "8px"',
  '      panel.style["margin-bottom"] = "0"',
  '    } else {',
  '      panel.style.bottom = "100%"',
  '      panel.style.top = ""',
  '      panel.style["margin-bottom"] = "8px"',
  '      panel.style["margin-top"] = "0"',
  '    }',
  '    panel.textContent = ""',
  '    var title = make("div", null, "挂起中的请求（" + list.length + "）")',
  '    applyStyle(title, { "font-weight": "bold", "margin-bottom": "2px" })',
  '    panel.appendChild(title)',
  '    var hint = make("div", null, "放行本轮=这个对话这一轮不再被拦（回合结束恢复）；" + fmtBypassLabel() + "=限时免拦，你还在用就自动续期")',
  '    applyStyle(hint, { color: "#9aa", "font-size": "11px", "margin-bottom": "2px" })',
  '    panel.appendChild(hint)',
  '    for (var i = 0; i < list.length; i++) panel.appendChild(rowEl(list[i]))',
  '    var foot = make("div")',
  '    applyStyle(foot, { display: "flex", "justify-content": "flex-end", "margin-top": "8px" })',
  '    var allBtn = make("button", null, "全部放行")',
  '    applyStyle(allBtn, {',
  '      border: "1px solid #555", "border-radius": "6px", background: "transparent",',
  '      color: "#ddd", "font-size": "11px", padding: "2px 8px", cursor: "pointer"',
  '    })',
  '    allBtn.addEventListener("click", function () { postRelease({}) })',
  '    foot.appendChild(allBtn)',
  '    panel.appendChild(foot)',
  // 免拦名单（「忽略本次」生效中）——可随时恢复
  '    var byp = (state && state.bypass) || []',
  '    if (byp.length) {',
  '      var sep = make("div", null, "已免拦 · 不再挂起（" + byp.length + "）")',
  '      applyStyle(sep, { "border-top": "1px solid #2b2b33", "margin-top": "8px", "padding-top": "6px", color: "#8fc", "font-weight": "bold" })',
  '      panel.appendChild(sep)',
  '      for (var j = 0; j < byp.length; j++) panel.appendChild(bypassRowEl(byp[j]))',
  '    }',
  '  }',
  '',
  '  function fetchState() {',
  '    try {',
  '      fetch(STATE_URL, { cache: "no-store" })',
  '        .then(function (r) { return r.json() })',
  '        .then(function (d) { if (d && d.ok) state = d })',
  '        .catch(function () {})',
  '        .then(function () { render() })',
  '    } catch (e) {}',
  '  }',
  '',
  '  function putConfig(patch, done) {',
  '    try {',
  '      fetch(CONFIG_URL, {',
  '        method: "PUT",',
  '        headers: { "Content-Type": "application/json" },',
  '        body: JSON.stringify(patch),',
  '      })',
  '        .then(function (r) { return r.json() })',
  '        .then(function (d) { if (d && d.ok && d.state) state = d.state })',
  '        .catch(function () {})',
  '        .then(function () { render(); if (done) done() })',
  '    } catch (e) {}',
  '  }',
  '',
  '  function postRelease(body) {',
  '    try {',
  '      fetch(RELEASE_URL, {',
  '        method: "POST",',
  '        headers: { "Content-Type": "application/json" },',
  '        body: JSON.stringify(body || {}),',
  '      })',
  '        .then(function (r) { return r.json() })',
  '        .then(function (d) { if (d && d.ok && d.state) state = d.state })',
  '        .catch(function () {})',
  '        .then(function () { render(); fetchState() })',
  '    } catch (e) {}',
  '  }',
  '',
  '  function postWake() {',
  '    try {',
  '      fetch(WAKE_URL, { method: "POST" })',
  '        .then(function (r) { return r.json() })',
  '        .then(function (d) { if (d && d.ok && d.state) state = d.state })',
  '        .catch(function () {})',
  '        .then(function () { render(); fetchState() })',
  '    } catch (e) {}',
  '  }',
  '',
  '  // 供设置中心等调用：清除隐藏标记并立即把徽章重新挂回页面',
  '  window.__dshPeakGateShow = function () {',
  '    try { sessionStorage.removeItem(HIDE_KEY) } catch (e) {}',
  '    if (!root) mount()',
  '    if (root) fetchState()',
  '  }',
  '',
  '  function boot() {',
  '    // 兼容旧版把隐藏写进 localStorage 的状态：新逻辑只在会话内隐藏',
  '    try { localStorage.removeItem(HIDE_KEY) } catch (e) {}',
  '    var hidden = false',
  '    try { hidden = sessionStorage.getItem(HIDE_KEY) === "1" } catch (e) {}',
  '    if (hidden) return',
  '    fetchState()',
  '    setInterval(fetchState, 5000)',
  '    setInterval(function () {',
  '      tick += 1',
  '      var parked = state && state.parks ? state.parks.length : 0',
  '      if (parked > 0) {',
  // 挂起中：秒级刷新倒计时，并每 3s 拉一次状态（等待/自动重试/放行都要看得见）
  '        render()',
  '        if (tick % 3 === 0) fetchState()',
  '        return',
  '      }',
  // 没挂起但面板开着（在看免拦名单）：秒级刷新剩余时间
  '      if (expanded && state && state.bypass && state.bypass.length) { render(); return }',
  '      if (state && state.enabled && state.phase === "peak") render()',
  '    }, 1000)',
  '    document.addEventListener("visibilitychange", function () { if (!document.hidden) fetchState() })',
  '  }',
  '',
  '  if (document.readyState === "loading") {',
  '    document.addEventListener("DOMContentLoaded", boot)',
  '  } else {',
  '    boot()',
  '  }',
  '})()',
].join('\n')

export { apply }

// 供单元测试使用的纯逻辑导出（loader 只消费 name/inject/apply，多余导出无副作用）
export const __internal = {
  isPeakAt,
  nextReleaseAt,
  hhmm,
  matchesGate,
  compileMatcher,
  sanitizeConfig,
  sanitizeNetPark,
  mergeConfig,
  shouldParkFailure,
  computeNetDelay,
  KNOWN_FAILURE_CODES,
  DEFAULT_CONFIG,
}
