// dsh-peak-gate 纯逻辑单元测试
// 运行：DSH_HOME=$(mktemp -d) node test/peak.test.mjs
// 注意：必须先在环境中设置 DSH_HOME（模块在 import 时读取），且避免真实挂载 apply()。

import assert from 'node:assert/strict'
import { __internal } from '../lib/index.js'

const {
  isPeakAt, nextReleaseAt, hhmm, matchesGate, sanitizeConfig, sanitizeNetPark, mergeConfig,
  shouldParkFailure, computeNetDelay, DEFAULT_CONFIG,
} = __internal
const cfg = DEFAULT_CONFIG

/** 构造一个"北京墙钟时刻"的时间戳。 */
function bj(month, day, h, min) {
  // 2026 年；Date.UTC 给的是 UTC 时刻，减去 8 小时即"该北京时刻"对应的时间戳
  return Date.UTC(2026, month - 1, day, h, min) - 8 * 3600 * 1000
}

let passed = 0
function t(name, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

console.log('isPeakAt —— 工作日窗口（2026-08-31 是周一）')
t('周一 09:00 高峰（窗口起点含）', () => assert.equal(isPeakAt(bj(8, 31, 9, 0), cfg), true))
t('周一 08:59 低谷', () => assert.equal(isPeakAt(bj(8, 31, 8, 59), cfg), false))
t('周一 11:59 高峰', () => assert.equal(isPeakAt(bj(8, 31, 11, 59), cfg), true))
t('周一 12:00 低谷（窗口终点不含）', () => assert.equal(isPeakAt(bj(8, 31, 12, 0), cfg), false))
t('周一 13:59 低谷（午间空档）', () => assert.equal(isPeakAt(bj(8, 31, 13, 59), cfg), false))
t('周一 14:00 高峰（下午窗口起点）', () => assert.equal(isPeakAt(bj(8, 31, 14, 0), cfg), true))
t('周一 17:59 高峰', () => assert.equal(isPeakAt(bj(8, 31, 17, 59), cfg), true))
t('周一 18:00 低谷', () => assert.equal(isPeakAt(bj(8, 31, 18, 0), cfg), false))
t('周一 23:00 低谷', () => assert.equal(isPeakAt(bj(8, 31, 23, 0), cfg), false))
t('周一 00:30 低谷（凌晨）', () => assert.equal(isPeakAt(bj(8, 31, 0, 30), cfg), false))

console.log('isPeakAt —— 周末全天谷价（2026-09-05 周六 / 09-06 周日）')
t('周六 10:00 低谷', () => assert.equal(isPeakAt(bj(9, 5, 10, 0), cfg), false))
t('周六 15:00 低谷', () => assert.equal(isPeakAt(bj(9, 5, 15, 0), cfg), false))
t('周日 09:30 低谷', () => assert.equal(isPeakAt(bj(9, 6, 9, 30), cfg), false))

console.log('isPeakAt —— weekendsValley=false 时周末按工作日窗口判定')
const cfgNoWeekend = { ...cfg, weekendsValley: false }
t('周六 10:00 高峰（关闭周末谷价后）', () => assert.equal(isPeakAt(bj(9, 5, 10, 0), cfgNoWeekend), true))
t('周六 13:00 低谷（午间空档）', () => assert.equal(isPeakAt(bj(9, 5, 13, 0), cfgNoWeekend), false))

console.log('nextReleaseAt —— 放行时刻')
t('周一 10:00 挂起 → 当日 12:00 放行', () => {
  const r = nextReleaseAt(bj(8, 31, 10, 0), cfg)
  assert.equal(hhmm(r), '12:00')
  assert.equal(r, bj(8, 31, 12, 0))
})
t('周一 15:00 挂起 → 当日 18:00 放行', () => {
  assert.equal(hhmm(nextReleaseAt(bj(8, 31, 15, 0), cfg)), '18:00')
})
t('周一 11:00 挂起 → 当日 12:00 放行', () => {
  assert.equal(hhmm(nextReleaseAt(bj(8, 31, 11, 0), cfg)), '12:00')
})
t('低谷时刻 nextReleaseAt 只前移 1 分钟（即立即放行语义）', () => {
  const r = nextReleaseAt(bj(8, 31, 20, 0), cfg)
  assert.equal(r, bj(8, 31, 20, 1))
})
t('周五 17:59 挂起 → 当日 18:00 放行（不会跳到周末）', () => {
  // 2026-09-04 是周五
  assert.equal(hhmm(nextReleaseAt(bj(9, 4, 17, 59), cfg)), '18:00')
})
t('放行时刻本身不是高峰', () => {
  const r = nextReleaseAt(bj(8, 31, 14, 30), cfg)
  assert.equal(isPeakAt(r, cfg), false)
})

console.log('matchesGate —— 匹配规则')
const m = (provider, model) => matchesGate({ provider, model }, cfg)
t('provider=deepseek, model=deepseek-v4-flash → 命中', () => assert.equal(m('deepseek', 'deepseek-v4-flash'), true))
t('provider=DeepSeek（大小写不敏感）→ 命中', () => assert.equal(m('DeepSeek', 'deepseek-chat'), true))
t('provider=anthropic → 不命中', () => assert.equal(m('anthropic', 'claude-sonnet'), false))
t('provider=deepseek, models=[] 全模型命中', () => assert.equal(m('deepseek', 'anything-model'), true))
const cfgM = sanitizeConfig({ match: { providers: [], models: ['chat'] } })
t('providers=[] 匹配全部 provider', () => assert.equal(matchesGate({ provider: 'openai', model: 'deepseek-chat' }, cfgM), true))
t('models=["chat"] 只命中含 chat 的模型', () => {
  assert.equal(matchesGate({ provider: 'openai', model: 'deepseek-chat' }, cfgM), true)
  assert.equal(matchesGate({ provider: 'openai', model: 'deepseek-reasoner' }, cfgM), false)
})

console.log('sanitizeConfig —— 清洗与默认')
t('空输入回退默认', () => {
  const c = sanitizeConfig(null)
  assert.deepEqual(c, DEFAULT_CONFIG)
})
t('非法窗口被过滤', () => {
  const c = sanitizeConfig({ windows: [[9, 12], [14, 18, 99], 'x', [20, 10]] })
  assert.deepEqual(c.windows, [[9, 12]])
})
t('enabled/开关类型校验', () => {
  assert.equal(sanitizeConfig({ enabled: 'yes' }).enabled, true)
  assert.equal(sanitizeConfig({ enabled: false }).enabled, false)
})

console.log('shouldParkFailure —— 网络故障挂起判定（2026-09-23 新增）')
t('TRANSPORT（断网/连接失败）→ 接管', () => {
  assert.equal(shouldParkFailure({ code: 'TRANSPORT', message: 'DeepSeek API request to https://api.deepseek.com failed' }, cfg), true)
})
t('TIMEOUT / SERVER / RATE_LIMIT → 接管', () => {
  assert.equal(shouldParkFailure({ code: 'TIMEOUT' }, cfg), true)
  assert.equal(shouldParkFailure({ code: 'SERVER' }, cfg), true)
  assert.equal(shouldParkFailure({ code: 'RATE_LIMIT' }, cfg), true)
})
t('QUOTA（额度不足）→ 不接管，照常失败', () => {
  assert.equal(shouldParkFailure({ code: 'QUOTA', message: 'DeepSeek API error (HTTP 402)' }, cfg), false)
})
t('INVALID_CREDENTIAL（密钥无效）→ 不接管，避免无限挂起', () => {
  assert.equal(shouldParkFailure({ code: 'INVALID_CREDENTIAL' }, cfg), false)
})
t('CONTEXT_WINDOW_EXCEEDED → 不接管', () => {
  assert.equal(shouldParkFailure({ code: 'CONTEXT_WINDOW_EXCEEDED' }, cfg), false)
})
t('ABORTED（用户主动中止）→ 不接管', () => {
  assert.equal(shouldParkFailure({ code: 'ABORTED' }, cfg), false)
})
t('未知失败码 + 报文含 fetch failed → 接管', () => {
  assert.equal(shouldParkFailure({ code: 'UNKNOWN_X', message: 'TypeError: fetch failed' }, cfg), true)
})
t('未知失败码 + 报文含 ECONNRESET → 接管', () => {
  assert.equal(shouldParkFailure({ code: '', message: 'read ECONNRESET' }, cfg), true)
})
t('未知失败码 + 普通报文 → 不接管', () => {
  assert.equal(shouldParkFailure({ code: 'UNKNOWN_X', message: 'tool schema invalid' }, cfg), false)
})
t('netPark.enabled=false → 一律不接管', () => {
  const off = sanitizeConfig({ netPark: { enabled: false } })
  assert.equal(shouldParkFailure({ code: 'TRANSPORT' }, off), false)
})
t('自定义白名单：只接管列出的码', () => {
  const only = sanitizeConfig({ netPark: { codes: ['SERVER'] } })
  assert.equal(shouldParkFailure({ code: 'SERVER' }, only), true)
  assert.equal(shouldParkFailure({ code: 'TRANSPORT' }, only), false)
})

console.log('computeNetDelay —— 退避与 Retry-After')
t('第 1 次 = autoRetryMs（默认 15s）', () => {
  assert.equal(computeNetDelay(cfg, 1, { code: 'TRANSPORT' }), 15000)
})
t('第 2/3 次指数递增（15s → 30s → 60s）', () => {
  assert.equal(computeNetDelay(cfg, 2, {}), 30000)
  assert.equal(computeNetDelay(cfg, 3, {}), 60000)
})
t('封顶 maxAutoRetryMs（第 10 次仍为 60s）', () => {
  assert.equal(computeNetDelay(cfg, 10, {}), 60000)
})
t('provider 给了 Retry-After（更长）→ 尊重它', () => {
  assert.equal(computeNetDelay(cfg, 1, { providerRetryAfterMs: 45000 }), 45000)
})
t('Retry-After 超过封顶 → 仍按封顶等待', () => {
  assert.equal(computeNetDelay(cfg, 1, { providerRetryAfterMs: 600000 }), 60000)
})
t('自定义 base/cap 生效', () => {
  const fast = sanitizeConfig({ netPark: { autoRetryMs: 3000, maxAutoRetryMs: 6000 } })
  assert.equal(computeNetDelay(fast, 1, {}), 3000)
  assert.equal(computeNetDelay(fast, 4, {}), 6000)
})

console.log('sanitizeNetPark / mergeConfig —— 配置')
t('netPark 默认值完整', () => {
  const c = sanitizeConfig(null)
  assert.deepEqual(c.netPark, DEFAULT_CONFIG.netPark)
  assert.equal(c.netPark.enabled, true)
  assert.equal(c.netPark.autoRetryMs, 15000)
  assert.equal(c.netPark.maxAttempts, 0)
})
t('netPark 部分更新保留其余字段（热更新不丢其他开关）', () => {
  const base = sanitizeConfig({ netPark: { autoRetryMs: 3000, match: { providers: ['deepseek'] } } })
  const next = mergeConfig(base, { netPark: { enabled: false } })
  assert.equal(next.netPark.enabled, false)
  assert.equal(next.netPark.autoRetryMs, 3000, 'autoRetryMs 应被保留')
  assert.deepEqual(next.netPark.match.providers, ['deepseek'], 'match 应被保留')
  assert.deepEqual(next.netPark.codes, DEFAULT_CONFIG.netPark.codes)
})
t('netPark.match 空数组 = 所有 provider（断网不分 provider）', () => {
  const c = sanitizeConfig(null)
  assert.equal(matchesGate({ provider: 'anthropic', model: 'x' }, { match: c.netPark.match }), true)
  assert.equal(matchesGate({ provider: 'anything', model: 'y' }, { match: c.netPark.match }), true)
})
t('netPark.match 可限定 provider', () => {
  const c = sanitizeConfig({ netPark: { match: { providers: ['deepseek'] } } })
  assert.equal(matchesGate({ provider: 'deepseek', model: 'x' }, { match: c.netPark.match }), true)
  assert.equal(matchesGate({ provider: 'anthropic', model: 'x' }, { match: c.netPark.match }), false)
})
t('非法参数被夹紧（间隔下限 1s、上限 1h）', () => {
  const c = sanitizeConfig({ netPark: { autoRetryMs: 10, maxAutoRetryMs: 999999999 } })
  assert.equal(c.netPark.autoRetryMs, 1000)
  assert.equal(c.netPark.maxAutoRetryMs, 3600000)
})
t('maxAutoRetryMs < autoRetryMs 时被抬到 autoRetryMs', () => {
  const c = sanitizeNetPark({ autoRetryMs: 30000, maxAutoRetryMs: 5000 }, DEFAULT_CONFIG.netPark)
  assert.equal(c.maxAutoRetryMs, 30000)
})
t('顶层开关热更新不丢失 netPark 配置', () => {
  const base = sanitizeConfig({ netPark: { maxAttempts: 7 } })
  const next = mergeConfig(base, { enabled: false })
  assert.equal(next.enabled, false)
  assert.equal(next.netPark.maxAttempts, 7)
})

console.log(`\n全部通过：${passed} 项`)
