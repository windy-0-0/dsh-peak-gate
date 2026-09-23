// dsh-peak-gate 「按请求放行」—— 行为级集成测试
// 运行：DSH_HOME=$(mktemp -d) node test/release.test.mjs
//
// 用 mock ctx 挂载真实 apply()，把 windows 设为全天高峰，驱动 llm/stream 瀑布让请求挂起，
// 再验证：每个挂起都带身份（哪个对话/哪类调用），且能「针对个别对话放行」而不影响其他。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const DSH_HOME = process.env.DSH_HOME
if (!DSH_HOME) {
  console.error('必须设置 DSH_HOME（模块在 import 时读取）')
  process.exit(1)
}
// 全天高峰：让"挂起"在测试里必然发生（不管跑测试时是几点）
fs.writeFileSync(
  path.join(DSH_HOME, 'dsh-peak-gate.json'),
  JSON.stringify({
    enabled: true,
    windows: [[0, 24]],
    weekendsValley: false,
    netPark: { autoRetryMs: 60000, maxAutoRetryMs: 60000 },
  }),
  'utf8',
)

const { apply } = await import('../lib/index.js')

function makeCtx() {
  const listeners = new Map()
  const routes = new Map()
  return {
    listeners,
    routes,
    ctx: {
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
        fn()
      },
    },
  }
}

function callRoute(routes, url, method, body) {
  const route = routes.get(url)
  assert.ok(route, `路由未注册: ${url}`)
  const handlers = {}
  const req = {
    method,
    on(ev, fn) {
      handlers[ev] = fn
      return this
    },
    fire(ev, arg) {
      if (handlers[ev]) handlers[ev](arg)
    },
  }
  const res = {
    statusCode: 0,
    body: '',
    writeHead(code) {
      this.statusCode = code
    },
    end(chunk) {
      this.body += chunk === undefined ? '' : String(chunk)
    },
  }
  route.handler(req, res)
  if (method === 'POST' || method === 'PUT') {
    if (body !== undefined) req.fire('data', Buffer.from(JSON.stringify(body)))
    req.fire('end')
  }
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null }
}

const { ctx, listeners, routes } = makeCtx()
apply(ctx)

const onLlmStream = listeners.get('llm/stream')
assert.ok(onLlmStream, 'llm/stream 高峰闸门监听器未注册')

const state = () => callRoute(routes, '/dsh-peak-gate/state.json', 'GET').json
const release = (body) => callRoute(routes, '/dsh-peak-gate/release', 'POST', body).json
const putConfig = (patch) => callRoute(routes, '/dsh-peak-gate/config.json', 'PUT', patch).json
const wake = () => callRoute(routes, '/dsh-peak-gate/wake', 'POST').json
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 发起一次"模型调用"：返回 { started, done }，done 解析为下游产出的 chunk 列表。 */
function startCall({ sessionId, text, purpose }) {
  const chunks = []
  const next = () => (async function* () {
    yield { type: 'text', text: `来自 ${sessionId || '无会话'}` }
  })()
  const gen = onLlmStream(
    {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      sessionId,
      purpose,
      messages: text
        ? [{ id: 'm1', role: 'user', content: [{ type: 'text', text }] }]
        : [],
    },
    next,
  )
  const done = (async () => {
    for await (const chunk of gen) chunks.push(chunk)
    return chunks
  })()
  return { done, chunks }
}

let passed = 0
async function t(name, fn) {
  await fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

console.log('按请求放行 —— 行为验证（全天高峰模式下）')

await t('高峰挂起会登记身份：哪个对话、哪个模型、几点自动放行', async () => {
  const call = startCall({ sessionId: 'session:aaa111', text: '帮我改一下插件，让断网也不中断' })
  await sleep(120)
  const s = state()
  assert.equal(s.phase, 'peak', '测试配置应为全天高峰')
  assert.equal(s.parks.length, 1)
  const p = s.parks[0]
  assert.equal(p.kind, 'peak')
  assert.equal(p.label, '帮我改一下插件，让断网也不中断')
  assert.equal(p.model, 'deepseek-v4-flash')
  assert.equal(p.sessionId, 'aaa111')
  assert.ok(p.releaseAt > Date.now(), '应带自动放行时刻')
  assert.match(p.id, /^pk-/)
  assert.equal(s.parkedNow, 1)

  const r = release({ kind: 'peak' })
  assert.equal(r.released, 1)
  assert.equal((await call.done).length, 1, '放行后请求应继续走到下游')
  assert.equal(state().parks.length, 0)
})

await t('两个对话各自挂起，标签可区分', async () => {
  const a = startCall({ sessionId: 'session:aaa111', text: 'A 对话：帮我写周报' })
  const b = startCall({ sessionId: 'session:bbb222', text: 'B 对话：查一下磁盘占用' })
  await sleep(120)
  const s = state()
  assert.equal(s.parks.length, 2)
  const labels = s.parks.map((p) => p.label).sort()
  assert.deepEqual(labels, ['A 对话：帮我写周报', 'B 对话：查一下磁盘占用'])
  assert.deepEqual(s.parks.map((p) => p.sessionId).sort(), ['aaa111', 'bbb222'])
})

await t('按 id 放行只影响那一个对话，另一个继续挂着', async () => {
  const s = state()
  const target = s.parks.find((p) => p.sessionId === 'bbb222')
  const r = release({ id: target.id })
  assert.equal(r.released, 1, '只放行 1 个')
  await sleep(120)
  const after = state()
  assert.equal(after.parks.length, 1, '另一个仍在挂起')
  assert.equal(after.parks[0].sessionId, 'aaa111')
  assert.equal(release({ id: 'pk-不存在' }).released, 0, '未知 id 不误伤')
})

await t('/wake（取消网络挂起）不会误解高峰挂起', async () => {
  const w = wake()
  assert.equal(w.woke, 0, '高峰挂起不该被 /wake 放行')
  assert.equal(state().parks.length, 1, '高峰挂起仍在')
  assert.equal(release({}).released, 1, '「全部放行」能收掉它')
  await sleep(80) // 放行后生成器的收尾是异步的
  assert.equal(state().parks.length, 0)
})

await t('内部调用（生成会话标题）标注得出来，不与用户对话混淆', async () => {
  const call = startCall({ sessionId: 'session:ccc333', purpose: 'session-title' })
  await sleep(100)
  const p = state().parks[0]
  assert.equal(p.label, '生成会话标题')
  release({ id: p.id })
  await call.done
  assert.equal(state().parks.length, 0)
})

console.log('按请求放行 —— 与网络挂起共用同一份清单')

await t('高峰挂起与网络挂起同时存在时，统一清单区分 kind', async () => {
  const peakCall = startCall({ sessionId: 'session:aaa111', text: '高峰里挂着的对话' })
  await sleep(100)
  const onRequestError = listeners.get('agent/request-error')
  const netPending = onRequestError(
    {
      turn: 1,
      step: 1,
      provider: 'deepseek-official',
      agent: { options: { model: 'deepseek-v4-flash' }, session: { id: 'session:aaa111' } },
      failure: { code: 'TRANSPORT', message: 'DeepSeek API request to https://api.deepseek.com failed' },
    },
    async () => undefined,
  )
  await sleep(120)
  const s = state()
  assert.equal(s.parks.length, 2)
  assert.deepEqual(s.parks.map((p) => p.kind).sort(), ['network', 'peak'])
  const net = s.parks.find((p) => p.kind === 'network')
  assert.equal(net.label, '高峰里挂着的对话', '网络挂起能按 sessionId 取回对话标签')
  assert.match(net.id, /^net-/)
  assert.ok(net.nextRetryAt > Date.now())

  // 单单放行高峰那一条，网络那条不受影响
  assert.equal(release({ kind: 'peak' }).released, 1)
  await sleep(80)
  assert.equal(state().parks.length, 1)
  assert.equal(state().parks[0].kind, 'network')

  // 网络那条用「立即重试」放行
  assert.equal(release({ id: net.id }).released, 1)
  assert.deepEqual(await netPending, { kind: 'retry' })
  await peakCall.done
  assert.equal(state().parks.length, 0)
})

console.log('按请求放行 —— 边界')

await t('无挂起时放行返回 0，不报错', () => {
  const r = release({})
  assert.equal(r.ok, true)
  assert.equal(r.released, 0)
})

await t('非法 JSON body → 400 且不崩溃', () => {
  const route = routes.get('/dsh-peak-gate/release')
  const handlers = {}
  const req = {
    method: 'POST',
    on(ev, fn) {
      handlers[ev] = fn
      return this
    },
  }
  const res = {
    statusCode: 0,
    body: '',
    writeHead(code) {
      this.statusCode = code
    },
    end(chunk) {
      this.body += chunk === undefined ? '' : String(chunk)
    },
  }
  route.handler(req, res)
  handlers.data(Buffer.from('{ not json'))
  handlers.end()
  assert.equal(res.statusCode, 400)
  assert.equal(JSON.parse(res.body).ok, false)
})

await t('GET /release → 405（只接受 POST）', () => {
  const r = callRoute(routes, '/dsh-peak-gate/release', 'GET')
  assert.equal(r.status, 405)
})

await t('累计计数保留：放行不清空统计', () => {
  const s = state()
  assert.ok(s.parkedCalls >= 5, `累计挂起次数应保留（实际 ${s.parkedCalls}）`)
  assert.equal(s.parkedNow, 0)
})

console.log('「忽略本次」—— 该对话在有效期内免拦')

await t('忽略本次：放行这一个，并让该对话进入免拦名单', async () => {
  const call = startCall({ sessionId: 'session:ddd444', text: '这个对话我在干活，别拦' })
  await sleep(120)
  const p = state().parks[0]
  assert.equal(p.sessionId, 'ddd444')
  const r = release({ id: p.id, action: 'bypass' })
  assert.equal(r.ok, true)
  assert.equal(r.released, 1, '当前这条被放行')
  assert.equal(r.bypassed, 1, '该对话进入免拦名单')
  await call.done
  const s = state()
  assert.equal(s.parks.length, 0)
  assert.equal(s.bypass.length, 1)
  assert.equal(s.bypass[0].sessionId, 'ddd444')
  assert.equal(s.bypass[0].label, '这个对话我在干活，别拦')
  assert.ok(s.bypass[0].remainMs > 0, '应带免拦剩余时间')
  assert.equal(s.bypassMs, 600000, '默认有效期 10 分钟')
})

await t('免拦生效：该对话的高峰挂起直接放行（不再等待）', async () => {
  const call = startCall({ sessionId: 'session:ddd444', text: '免拦后的第二次请求' })
  await sleep(150)
  assert.equal(state().parks.length, 0, '不应该再被挂起')
  const chunks = await call.done // 直接走到下游
  assert.equal(chunks.length, 1, '请求没有等待，直接发出')
})

await t('免拦只针对那个对话：别的对话照旧被挂起', async () => {
  const other = startCall({ sessionId: 'session:eee555', text: '另一个对话照旧省钱' })
  await sleep(150)
  const s = state()
  assert.equal(s.parks.length, 1, '别的对话仍被挂起')
  assert.equal(s.parks[0].sessionId, 'eee555')
  assert.equal(release({ id: s.parks[0].id }).released, 1)
  await other.done
})

await t('免拦下网络失败也不接管（走原生失败流程）', async () => {
  const onRequestError = listeners.get('agent/request-error')
  let nextCalled = false
  const decision = await onRequestError(
    {
      turn: 9,
      step: 1,
      provider: 'deepseek-official',
      agent: { options: { model: 'deepseek-v4-flash' }, session: { id: 'session:ddd444' } },
      failure: { code: 'TRANSPORT', message: 'DeepSeek API request to https://api.deepseek.com failed' },
    },
    async () => {
      nextCalled = true
      return undefined
    },
  )
  assert.equal(decision, undefined, '免拦对话的网络失败不该被挂起')
  assert.equal(nextCalled, true, '应交回原生失败流程')
  assert.equal(state().parks.length, 0)
})

await t('撤销免拦后，该对话重新被闸门管住', async () => {
  const r = release({ undo: 'bypass', sessionId: 'ddd444' })
  assert.equal(r.ok, true)
  assert.equal(r.cleared, 1)
  assert.equal(state().bypass.length, 0)

  const call = startCall({ sessionId: 'session:ddd444', text: '恢复后应该又被挂起' })
  await sleep(150)
  const s = state()
  assert.equal(s.parks.length, 1, '撤销后应重新挂起')
  assert.equal(release({ id: s.parks[0].id }).released, 1)
  await call.done
})

await t('免拦有效期到点自动失效（bypassMs 可配）', async () => {
  assert.equal(putConfig({ bypassMs: 1000 }).state.bypassMs, 1000)

  const call = startCall({ sessionId: 'session:fff666', text: '短效免拦' })
  await sleep(120)
  const p = state().parks[0]
  assert.equal(release({ id: p.id, action: 'bypass' }).bypassed, 1)
  await call.done
  assert.equal(state().bypass.length, 1)

  await sleep(1200) // 超过 1 秒有效期
  assert.equal(state().bypass.length, 0, '过期的免拦应被清理')

  const again = startCall({ sessionId: 'session:fff666', text: '过期后应重新被拦' })
  await sleep(150)
  assert.equal(state().parks.length, 1, '过期后重新挂起')
  assert.equal(release({}).released, 1)
  await again.done

  assert.equal(putConfig({ bypassMs: 600000 }).state.bypassMs, 600000)
})

console.log(`\n全部通过：${passed} 项`)
