// ctx.prompts 的 sqlite 实现（P8 机制层）。契约见 seam/space-prompt 类注释：
// get（未知 not_found）/ upsert（幂等整替换，ref/title/body 空白 → invalid_input）/
// list（按 ref 稳定排序）。DDL 唯一出处 migrations/0006（断言 ⑧）。
import type { DatabaseSync } from 'node:sqlite'
import { PromptError, PromptService } from 'space-prompt'
import type { PromptTemplate } from 'space-prompt'

type Row = Record<string, unknown>

function toTemplate(r: Row): PromptTemplate {
  return {
    ref: r.ref as string,
    title: r.title as string,
    body: r.body as string,
    updatedAt: r.updated_at as string,
  }
}

export class SqlitePromptStore extends PromptService {
  constructor(
    ctx: ConstructorParameters<typeof PromptService>[0],
    private readonly db: DatabaseSync,
  ) {
    super(ctx)
  }

  get(ref: string): PromptTemplate {
    const r = this.db.prepare(`SELECT * FROM prompt_templates WHERE ref = ?`).get(ref) as Row | undefined
    if (!r) {
      throw new PromptError('not_found', `提示词 "${ref}" 不存在（先 upsert 或跑 seed 预置）`)
    }
    return toTemplate(r)
  }

  upsert(ref: string, title: string, body: string): PromptTemplate {
    if (!ref.trim() || !title.trim() || !body.trim()) {
      throw new PromptError('invalid_input', `提示词三要素（ref/title/body）任一不能为空白`)
    }
    this.db
      .prepare(
        `INSERT INTO prompt_templates(ref, title, body, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(ref) DO UPDATE SET title = excluded.title, body = excluded.body, updated_at = excluded.updated_at`,
      )
      .run(ref, title, body, new Date().toISOString())
    return this.get(ref)
  }

  list(): PromptTemplate[] {
    return (this.db.prepare(`SELECT * FROM prompt_templates ORDER BY ref ASC`).all() as Row[]).map(toTemplate)
  }
}
