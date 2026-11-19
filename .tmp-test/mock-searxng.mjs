// 模拟 SearXNG 实例（CORS 放行），返回 JSON 结果
import http from 'node:http'

const PORT = Number(process.env.SEARXNG_PORT ?? 18081)
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
}

const results = [
  {
    title: 'DeepSeek 官方文档',
    url: 'https://api-docs.deepseek.com/zh-cn/',
    content: 'DeepSeek API 文档，包含对话补全、函数调用与上下文缓存说明。',
  },
  {
    title: 'DeepSeek 发布新模型',
    url: 'https://example.com/deepseek-news',
    content: 'DeepSeek 于本周发布了新模型，支持更长上下文。',
  },
]

http
  .createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS)
      res.end()
      return
    }
    console.log('searxng', req.method, req.url)
    if (req.url?.startsWith('/search')) {
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ query: 'q', results }))
      return
    }
    res.writeHead(404, CORS)
    res.end('{}')
  })
  .listen(PORT, '127.0.0.1', () => console.log(`mock searxng on http://127.0.0.1:${PORT}`))
