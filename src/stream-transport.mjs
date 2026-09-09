/**
 * Antigravity 交互式流传输协议（Interactive Stream Transport）核心编解码与行流解析器
 * 负责 Google Antigravity CLI stream-json 模式的 NDJSON 消息封包、拆包与流式状态缓冲
 */

/**
 * 将用户输入指令封装为 Antigravity 官方 headless stream-json 规范的 NDJSON user 消息
 * @param {string} content - 用户输入的指令或交互文本
 * @returns {string} 以换行符结尾的标准 NDJSON 字符串
 */
export function encodeStreamUserMessage(content) {
  const text = String(content ?? "");
  // 如果调用方已传入完整的 NDJSON user event 结构，则直接确保换行符闭合
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && parsed.event === "user" && parsed.message && typeof parsed.message.content === "string") {
        return text.endsWith("\n") ? text : `${text}\n`;
      }
    } catch {}
  }

  const payload = {
    event: "user",
    message: {
      content: text,
    },
  };
  return JSON.stringify(payload) + "\n";
}

/**
 * 结构化 NDJSON 行流解析器，解决 TCP 管道数据分包、粘包与断行问题
 */
export class StreamLineParser {
  /**
   * @param {(event: object, rawLine: string) => void} onLine - 每解析出一条完整 NDJSON 事件时的回调
   */
  constructor(onLine) {
    this.buffer = "";
    this.onLine = typeof onLine === "function" ? onLine : () => {};
  }

  /**
   * 灌入从 child.stdout 收到的原始数据块
   * @param {Buffer|string} chunk 
   */
  feed(chunk) {
    this.buffer += chunk.toString("utf8");
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const rawLine = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this._processLine(rawLine);
    }
  }

  /**
   * 刷新流尾部未换行的数据
   */
  flush() {
    if (this.buffer.trim()) {
      this._processLine(this.buffer);
    }
    this.buffer = "";
  }

  /**
   * 内部行解析
   * @private
   */
  _processLine(rawLine) {
    const trimmed = rawLine.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        this.onLine(parsed, trimmed);
      }
    } catch {
      // 忽略非 JSON 行（例如 CLI 内部调试行或 ANSI 控制符）
    }
  }
}
