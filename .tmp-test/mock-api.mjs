// 模拟第三方服务商：Anthropic 兼容 /v1/messages
import http from 'node:http'
import { appendFileSync } from 'node:fs'

const PORT = Number(process.env.MOCK_PORT ?? 18080)
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
}

const anthropicStream = (res) => {
  res.writeHead(200, { ...CORS, 'Content-Type': 'text/event-stream' })
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  send('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_mock',
      model: 'claude-sonnet-5',
      usage: { input_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
    },
  })
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  for (const piece of ['根据', '搜索', '结果', '：DeepSeek 官方文档 [1]。']) {
    send('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: piece },
    })
  }
  send('content_block_stop', { type: 'content_block_stop', index: 0 })
  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { input_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 12 },
  })
  send('message_stop', { type: 'message_stop' })
  res.end()
}

http
  .createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS)
      res.end()
      return
    }
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      appendFileSync('/tmp/mock-requests.jsonl', JSON.stringify({ method: req.method, url: req.url, body }) + '\n')
      if (req.url === '/v1/models') {
        res.writeHead(404, { ...CORS, 'Content-Type': 'application/json' })
        res.end('{"error":{"message":"not found"}}')
        return
      }
      if (req.url === '/v1/messages') {
        anthropicStream(res)
        return
      }
      res.writeHead(404, CORS)
      res.end('{}')
    })
  })
  .listen(PORT, '127.0.0.1', () => console.log(`mock api on http://127.0.0.1:${PORT}`))
