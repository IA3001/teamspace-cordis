import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { runAgentExecutionGraph } from '../packages/impl/space-agent-runtime/src/execution-graph.ts'

const requestedFiles = ['helloworld.cpp', 'greeting.hpp', 'greeting.cpp', 'README.md', 'CMakeLists.txt']
const workspace = new Map<string, string>()
const toolDefinitions = [
  { id: 'tool.workspace.write', title: 'write', description: 'write a file', capabilities: ['workspace.write'], parameters: { type: 'object' } },
  { id: 'tool.workspace.verify', title: 'verify', description: 'check project completeness', capabilities: ['workspace.verify'], parameters: { type: 'object' } },
  { id: 'tool.workspace.run-cpp', title: 'run cpp', description: 'compile and run', capabilities: ['code.execute'], parameters: { type: 'object' } },
]

function response(toolCalls?: Array<{ toolId: string; args: Record<string, unknown> }>, final?: string): string {
  return JSON.stringify({ toolCalls: toolCalls ?? [], ...(final === undefined ? {} : { final }) })
}

async function run(script: string[], source: string, allowedToolIds = ['tool.workspace.write', 'tool.workspace.verify', 'tool.workspace.run-cpp']) {
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
        if (toolId === 'tool.workspace.run-cpp') {
          return { toolId, ok: true, output: args.target === 'bad' ? 'C++ 程序运行失败（退出码 1）' : 'C++ 程序运行通过：stdout: hello', costMs: 0 }
        }
        return { toolId, ok: false, code: 'unknown_tool', output: 'unexpected tool', costMs: 0 }
      },
    },
  })
  return runAgentExecutionGraph({
    ctx: ctx as never,
    agentId: 'a_project_completeness',
    allowedToolIds,
    messages: [{ role: 'user', content: source }],
  })
}

const projectPath = 'projects/qa-agent-collab/hello-cordis'
const task = `请创建多文件 C++ 工程：${requestedFiles.join('、')}`
const compileTask = `${task}，编译运行并回报原始 stdout。`
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

const sourceWrites = requestedFiles.filter((file) => file !== 'CMakeLists.txt').map((file) => ({
  toolId: 'tool.workspace.write', args: {
    path: `${projectPath}/${file}`,
    content: file === 'helloworld.cpp' ? '#include "greeting.hpp"\nint main() { greet(); }\n'
      : file === 'greeting.cpp' ? '#include "greeting.hpp"\nvoid greet() {}\n'
        : file === 'greeting.hpp' ? '#pragma once\nvoid greet();\n' : '# Project\n',
  },
}))
const writeSources = response(sourceWrites.slice(0, 3))
const writeRemaining = response(sourceWrites.slice(3))
const verifyComplete = response([{ toolId: 'tool.workspace.verify', args: { projectPath, requiredFiles: requestedFiles } }])
workspace.clear()
await assert.rejects(run([writeCmake, writeSources, writeRemaining, verifyComplete, '工程完整。'], compileTask),
  /尚未通过真实编译运行/u, 'a task requesting compilation and stdout cannot finish after static verification alone')

const runCpp = response([{ toolId: 'tool.workspace.run-cpp', args: { projectPath } }])
workspace.clear()
const compiledResult = await run([writeCmake, writeSources, writeRemaining, verifyComplete, runCpp, '程序输出已核验。'], compileTask)
assert.equal(compiledResult.answer, '程序输出已核验。', 'a successful compile/run result permits completion')

const rejectedRun = response([{ toolId: 'tool.workspace.run-cpp', args: { projectPath, target: 'bad' } }])
workspace.clear()
await assert.rejects(run([writeCmake, writeSources, writeRemaining, verifyComplete, rejectedRun, '程序已完成。'], compileTask),
  /尚未通过真实编译运行/u, 'nonzero program exits cannot satisfy the compile/run gate')

workspace.clear()
await assert.rejects(run([writeCmake, writeSources, writeRemaining, verifyComplete, '工程完整。'], compileTask,
  ['tool.workspace.write', 'tool.workspace.verify']), /尚未通过真实编译运行/u,
'the runtime does not silently skip compilation when the Agent lacks the C++ runner tool')
console.log('✓ C++ tasks requiring compilation and stdout are gated on a successful execution outcome')
