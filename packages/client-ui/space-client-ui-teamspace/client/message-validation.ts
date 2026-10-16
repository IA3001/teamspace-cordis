export const MESSAGE_TEXT_LIMIT = 5000

/** Keep composer feedback aligned with the server's JavaScript string-length boundary. */
export function messageLengthNotice(text: string): string | null {
  if (text.length <= MESSAGE_TEXT_LIMIT) return null
  return `消息超过 ${MESSAGE_TEXT_LIMIT} 字符，请使用文件附件发送长内容。`
}
