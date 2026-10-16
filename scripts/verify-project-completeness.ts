import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { runAgentExecutionGraph } from '../packages/impl/space-agent-runtime/src/execution-graph.ts'

const requestedFiles = ['helloworld.cpp', 'greeting.hpp', 'greeting.cpp', 'README.md', 'CMakeLists.txt']
const workspace = new Map<string, string>()
const toolDefinitions = [
  { id: 'tool.workspace.write', title: 'write', description: 'write a file', capabilities: ['workspace.write'], parameters: { type: 'object' } },
  { id: 'tool.workspace.verify', title: 'verify', description: 'check project completeness', capabilities: ['workspace.verify'], parameters: { type: 'object' } },
]

function response(toolCalls?: Array<{ toolId: string; args: Record<string, unknown> }>, final?: string): string {
  return JSON.stringify({ toolCalls: toolCalls ?? [], ...(final === undefined ? {} : { final }) })
}

async function run(script: string[], source: string) {
  let index = 0
  const ctx = Object.assign(new Context(), {
    llm: {
      async chat(_messages: unknown, options?: { onToken?: (delta: string) => void }) {
        const raw = script[index++]
        if (!raw) throw new Error('unexpected model turn')
        options?.onToken?.(raw)
        return raw
      },
    },
    tools: {
      list: () => toolDefinitions,
      async invoke(toolId: string, argsText: string) {
        const args = JSON.parse(argsText) as Record<string, unknown>
        if (toolId === 'tool.workspace.write') {
          workspace.set(String(args.path), String(args.content))
          return { toolId, ok: true, output: `已写入 ${args.path}`, costMs: 0 }
        }
        if (toolId === 'tool.workspace.verify') {
          const required = Array.isArray(args.requiredFiles) ? args.requiredFiles.map(String) : []
          const cmake = workspace.get(`${args.projectPath}/CMakeLists.txt`) ?? ''
          const targetSources = [...cmake.matchAll(/\badd_executable\s*\([^)]*?\b([A-Za-z0-9_./-]+\.(?:cpp|cc|cxx|c))\b/giu)].map((match) => match[1]!)
          const missing = [...new Set([...required, ...targetSources])].filter((path) => !workspace.has(`${args.projectPath}/${path}`))
          return {
            toolId, ok: true,
            output: missing.length ? `工作区检查未通过（缺少文件）：\n${missing.join('\n')}` : '工作区检查通过：所有交付文件和 CMake 目标源文件均存在。',
            costMs: 0,
          }
        }
        return { toolId, ok: false, code: 'unknown_tool', output: 'unexpected tool', costMs: 0 }
      },
    },
  })
  return runAgentExecutionGraph({
    ctx: ctx as never,
    agentId: 'a_project_completeness',
    allowedToolIds: ['tool.workspace.write', 'tool.workspace.verify'],
    messages: [{ role: 'user', content: source }],
  })
}

const projectPath = 'projects/qa-agent-collab/hello-cordis'
const task = `请创建多文件 C++ 工程：${requestedFiles.join('、')}`
const writeCmake = response([{ toolId: 'tool.workspace.write', args: {
  path: `${projectPath}/CMakeLists.txt`,
  content: 'cmake_minimum_required(VERSION 3.20)\nproject(hello_cordis)\nadd_executable(hello_cordis helloworld.cpp greeting.cpp)\n',
} }])

workspace.clear()
await assert.rejects(
  run([writeCmake, '工程已完成。'], task),
  /尚未通过工作区完整性检查/u,
  'the runtime must not accept a final answer after writing a CMake project without verifying it',
)

workspace.clear()
const result = await run([
  writeCmake,
  response([{ toolId: 'tool.workspace.verify', args: { projectPath, requiredFiles: ['greeting.cpp', 'greeting.hpp', 'CMakeLists.txt'] } }]),
  response([
    { toolId: 'tool.workspace.write', args: { path: `${projectPath}/helloworld.cpp`, content: '#include "greeting.hpp"\nint main() { greet(); }\n' } },
    { toolId: 'tool.workspace.write', args: { path: `${projectPath}/greeting.cpp`, content: '#include "greeting.hpp"\nvoid greet() {}\n' } },
    { toolId: 'tool.workspace.write', args: { path: `${projectPath}/greeting.hpp`, content: '#pragma once\nvoid greet();\n' } },
  ]),
  response([
    { toolId: 'tool.workspace.write', args: { path: `${projectPath}/README.md`, content: '# Hello Cordis\n' } },
    { toolId: 'tool.workspace.verify', args: { projectPath, requiredFiles: ['greeting.cpp', 'greeting.hpp', 'CMakeLists.txt'] } },
  ]),
  '工作区检查通过，所有要求文件均已写入。',
], task)
assert.equal(result.answer, '工作区检查通过，所有要求文件均已写入。')
const verifyCall = result.modelTrace.flatMap((round) => round.toolCalls).find((call) => call.toolId === 'tool.workspace.verify')
assert.ok(verifyCall)
for (const file of requestedFiles) {
  assert.ok(JSON.parse(verifyCall.args).requiredFiles.includes(file), `the runtime injects the user's explicitly requested file: ${file}`)
}
console.log('✓ CMake project completion is gated on workspace verification, and user-requested files are included in the verification list')
