// MCP JSON-RPC 错误码
export const MCP_ERRORS = {
  INVALID_INPUT: { code: -32602, message: 'Invalid params' },
  NOT_FOUND: { code: -32601, message: 'Method not found' },
  INTERNAL_ERROR: { code: -32603, message: 'Internal error' },
  AI_ERROR: { code: -32001, message: 'AI service error' },
  DATABASE_ERROR: { code: -32002, message: 'Database error' },
  VECTOR_ERROR: { code: -32003, message: 'Vector service error' },
  NOT_CONFIGURED: { code: -32004, message: 'Service not configured' },
} as const

export type McpErrorType = keyof typeof MCP_ERRORS

/** 业务入参错误，API 层映射为 400 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

// 自定义错误类，携带结构化的错误码
export class McpError extends Error {
  code: number

  constructor(errorType: McpErrorType, details?: string) {
    const base = MCP_ERRORS[errorType]
    const message = details ? `${base.message}: ${details}` : base.message
    super(message)
    this.name = 'McpError'
    this.code = base.code
  }
}
