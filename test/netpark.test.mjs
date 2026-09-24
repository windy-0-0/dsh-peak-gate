// dsh-peak-gate 网络故障挂起 —— 行为级集成测试
// 运行：DSH_HOME=$(mktemp -d) node test/netpark.test.mjs
//
// 用 mock ctx 挂载真实 apply()，然后按 DSH 的方式驱动 agent/request-error 瀑布：
//   listener(payload, next) → 期望返回 { kind: 'retry' }（原地重试，会话不中断）
// 并驱动 HTTP 路由（state.json / wake / config.json）验证可观测与「立即重试」。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const DSH_HOME = process.env.DSH_HOME
if (!DSH_HOME) {
  console.error('必须设置 DSH_HOME（模块在 import 时读取）')
  process.exit(1)
}
// 让等待时间可测：1s 间隔（配置下限），封顶 1s
fs.writeFileSync(
  path.join(DSH_HOME, 'dsh-peak-gate.json'),
  JSON.stringify({ enabled: true, netPark: { autoRetryMs: 1000, maxAutoRetryMs: 1000 } }),
  'utf8',
)

const { apply, __internal } = await import('../lib/index.js')

// ---------------------------------------------------------------------------
// mock 运行时
// ---------------------------------------------------------------------------

function makeCtx() {
  const listeners = new Map()
  const routes = new Map()
  const disposers = []
  const ctx = {
    on(event, fn) {
      listeners.set(event, fn)
      return () => listeners.delete(event)
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
      tapIndex() {
        return () => {}
      },
    },
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
    },
  }
  return { ctx, listeners, routes, disposers }
}

function makeReq(method, body) {
  const handlers = {}
  return {
    method,
    on(ev, fn) {
      handlers[ev] = fn
      return this
    },
    fire(ev, arg) {
      if (handlers[ev]) handlers[ev](arg)
    },
    body,
  }
}

function callRoute(routes, url, method, body) {
  const route = routes.get(url)
  assert.ok(route, `路由未注册: ${url}`)
  const chunks = []
  const req = makeReq(method || 'GET', body)
  const res = {
    statusCode: 0,
    body: '',
    writeHead(code) {
      this.statusCode = code
    },
    end(chunk) {
      this.body += chunk === undefined ? '' : String(chunk)
      chunks.push(this.body)
    },
  }
  route.handler(req, res)
  if (method === 'PUT' || method === 'POST') {
    if (body !== undefined) req.fire('data', Buffer.from(JSON.stringify(body)))
    req.fire('end')
  }
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null }
}

const { ctx, listeners, routes } = makeCtx()
apply(ctx)

const onRequestError = listeners.get('agent/request-error')
assert.ok(onRequestError, 'agent/request-error 监听器未注册')
assert.ok(listeners.get('llm/stream'), 'llm/stream 高峰闸门监听器仍在（原有能力未回归）')

const state = () => callRoute(routes, '/dsh-peak-gate/state.json', 'GET').json
const putConfig = (patch) => callRoute(routes, '/dsh-peak-gate/config.json', 'PUT', patch).json
const wake = () => callRoute(routes, '/dsh-peak-gate/wake', 'POST')

const transportPayload = (turn) => ({
  turn,
  step: 1,
  provider: 'deepseek-official',
  agent: { options: { model: 'deepseek-v4-flash' } },
  failure: {
    code: 'TRANSPORT',
    message: 'DeepSeek API request to https://api.deepseek.com failed',
  },
})

const passthroughNext = () => {
  let called = false
  const next = async () => {
    called = true
    return undefined
  }
  return { next, wasCalled: () => called }
}

let passed = 0
async function t(name, fn) {
  await fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------

console.log('网络故障挂起 —— 行为验证')

await t('TRANSPORT 失败 → 挂起等待后返回 { kind: "retry" }（本轮不失败）', async () => {
  const { next, wasCalled } = passthroughNext()
  const started = Date.now()
  const decision = await onRequestError(transportPayload(1), next)
  const elapsed = Date.now() - started
  assert.deepEqual(decision, { kind: 'retry' }, '必须返回 retry 决策')
  assert.equal(wasCalled(), false, '不应把失败交回原生流程')
  assert.ok(elapsed >= 900, `应等待约 1s 再重试（实际 ${elapsed}ms）`)
})

await t('挂起详情可观测：state.json 记录失败码/provider/报文', () => {
  const s = state()
  assert.equal(s.network.enabled, true)
  assert.equal(s.network.parks, 1)
  assert.equal(s.network.parkedNow, 0, '等待结束后不再处于挂起中')
  assert.equal(s.network.lastPark.code, 'TRANSPORT')
  assert.equal(s.network.lastPark.provider, 'deepseek-official')
  assert.match(s.network.lastPark.message, /api\.deepseek\.com/)
})

await t('「立即重试」POST /wake：马上结束等待去重连，不等满退避', async () => {
  const { next } = passthroughNext()
  const started = Date.now()
  const pending = onRequestError(transportPayload(2), next)
  await sleep(150)
  const during = state()
  assert.equal(during.network.parkedNow, 1, '此刻应有 1 个请求挂起中')
  assert.equal(during.network.parked[0].attempt, 1)
  assert.ok(during.network.parked[0].nextRetryAt > Date.now(), '应有下次自动重试时刻')

  const w = wake()
  assert.equal(w.status, 200)
  assert.equal(w.json.woke, 1, '应唤醒 1 个挂起请求')

  const decision = await pending
  const elapsed = Date.now() - started
  assert.deepEqual(decision, { kind: 'retry' })
  assert.ok(elapsed < 900, `应被立即唤醒而非等满 1s（实际 ${elapsed}ms）`)
})

await t('取消后仍不通 → 同一回合再次挂起，次数递增（第 2 次）', async () => {
  const { next } = passthroughNext()
  const first = onRequestError(transportPayload(3), next)
  await sleep(120)
  assert.equal(state().network.parked[0].attempt, 1)
  wake()
  await first

  const second = onRequestError(transportPayload(3), next) // 同一 turn/step 再失败
  await sleep(120)
  assert.equal(state().network.parked[0].attempt, 2, '同一回合第二次挂起应记为第 2 次')
  wake()
  assert.deepEqual(await second, { kind: 'retry' })
})

await t('自动重试：无人操作也会到点重连（倒计时归零即重试）', async () => {
  const { next } = passthroughNext()
  const started = Date.now()
  const decision = await onRequestError(transportPayload(4), next)
  const elapsed = Date.now() - started
  assert.deepEqual(decision, { kind: 'retry' })
  assert.ok(elapsed >= 900 && elapsed < 2500, `应在 1s 左右自动重试（实际 ${elapsed}ms）`)
})

await t('额度不足（QUOTA）→ 不接管，交回原生失败流程', async () => {
  const { next, wasCalled } = passthroughNext()
  const decision = await onRequestError(
    { ...transportPayload(5), failure: { code: 'QUOTA', message: 'DeepSeek API error (HTTP 402)' } },
    next,
  )
  assert.equal(decision, undefined)
  assert.equal(wasCalled(), true, '应调用 next() 交回下游')
})

await t('未知失败码 + 报文无网络特征 → 不接管', async () => {
  const { next, wasCalled } = passthroughNext()
  const decision = await onRequestError(
    { ...transportPayload(6), failure: { code: 'WEIRD', message: 'tool schema invalid' } },
    next,
  )
  assert.equal(decision, undefined)
  assert.equal(wasCalled(), true)
})

await t('用户中止回合（signal aborted）→ 挂起中立即退出，不重试', async () => {
  const { next, wasCalled } = passthroughNext()
  const ac = new AbortController()
  const pending = onRequestError({ ...transportPayload(7), signal: ac.signal }, next)
  await sleep(150)
  assert.equal(state().network.parkedNow, 1)
  ac.abort()
  const decision = await pending
  assert.equal(decision, undefined, '中止后不应再 retry')
  assert.equal(wasCalled(), true)
  assert.equal(state().network.parkedNow, 0, '挂起应立即清空')
})

await t('总开关关闭 → 完全不接管（且网络挂起随之失效）', async () => {
  const body = putConfig({ enabled: false })
  assert.equal(body.ok, true)
  assert.equal(body.state.enabled, false)
  assert.equal(body.state.network.enabled, false)

  const { next, wasCalled } = passthroughNext()
  const decision = await onRequestError(transportPayload(8), next)
  assert.equal(decision, undefined)
  assert.equal(wasCalled(), true)
})

await t('局部热更新 netPark 不丢失其它字段（autoRetryMs 保留）', async () => {
  const body = putConfig({ enabled: true, netPark: { enabled: false } })
  assert.equal(body.state.enabled, true, '总开关应重新打开')
  assert.equal(body.state.network.enabled, false)
  assert.equal(body.state.network.autoRetryMs, 1000, '未提交的字段应被保留')
})

await t('只关网络挂起 → 高峰避让不受影响', async () => {
  const { next, wasCalled } = passthroughNext()
  const decision = await onRequestError(transportPayload(9), next)
  assert.equal(decision, undefined)
  assert.equal(wasCalled(), true)
  const s = state()
  assert.equal(s.enabled, true)
  // 时段取决于跑测试时的真实钟点（本用例不必断言 phase），只验证高峰避让的配置仍在
  assert.deepEqual(s.windows, [[9, 12], [14, 18]], '高峰窗口配置应保持')
  assert.equal(s.match.providers.includes('deepseek'), true, '高峰匹配规则应保持')
})

await t('重新打开网络挂起 → 立刻恢复接管', async () => {
  const body = putConfig({ netPark: { enabled: true } })
  assert.equal(body.state.network.enabled, true)
  assert.equal(body.state.network.autoRetryMs, 1000, '仍然保留测试用间隔')

  const { next } = passthroughNext()
  const pending = onRequestError(transportPayload(10), next)
  await sleep(150)
  assert.equal(state().network.parkedNow, 1)
  assert.equal(wake().json.woke, 1)
  assert.deepEqual(await pending, { kind: 'retry' })
})

await t('上限保护：maxAttempts=1 时第二次失败交回原生流程（不无限挂起）', async () => {
  putConfig({ netPark: { maxAttempts: 1 } })
  const { next } = passthroughNext()
  const first = onRequestError(transportPayload(11), next)
  await sleep(120)
  wake()
  assert.deepEqual(await first, { kind: 'retry' })

  const second = passthroughNext()
  const decision = await onRequestError(transportPayload(11), second.next)
  assert.equal(decision, undefined, '超过上限应放弃接管')
  assert.equal(second.wasCalled(), true)

  const restored = putConfig({ netPark: { maxAttempts: 0 } })
  assert.equal(restored.state.network.maxAttempts, 0)
})

await t('纯逻辑导出可用（供单元测试/排查）', () => {
  assert.equal(__internal.shouldParkFailure({ code: 'TRANSPORT' }, undefined), true)
  assert.equal(__internal.computeNetDelay({ netPark: { autoRetryMs: 20000, maxAutoRetryMs: 60000 } }, 2, {}), 40000)
})

console.log(`\n全部通过：${passed} 项`)
